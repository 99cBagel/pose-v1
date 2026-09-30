// Streamable HTTP MCP endpoint (POST /mcp), JSON-RPC 2.0.
//
// Speaks the same framing as the homelab OCR worker: responses are SSE
// (`data: <json>\n\n`) with Content-Type: text/event-stream, accepted
// alongside application/json. Notifications get 202 with no body.

import {
  SessionStore,
  Session,
  fusedState,
  pumpCues,
} from "./session.js";
import { LogStore } from "./logstore.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "start-my-workout", version: "0.1.0" };

const POSE_CLIENT = "https://pose-v1.vercel.app";
const MOTION_CLIENT = "https://pose-motion.vercel.app";

interface Ctx {
  store: SessionStore;
  logs: LogStore;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function ok(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function err(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

function sse(payload: unknown): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

const TOOL_DEFS = [
  {
    name: "start_workout_session",
    description:
      "Start a workout session. Returns a session id, a session-scoped " +
      "client token, and deep links for the tablet camera client (pose-v1) " +
      "and the iPhone motion client (pose-motion). The deep links carry the " +
      "client token (?session=..&token=..); browser clients authenticate " +
      "with it and never see the global worker secret.",
    inputSchema: {
      type: "object",
      properties: {
        exercise: {
          type: "string",
          description: "Exercise name (v1: squat only).",
          default: "squat",
        },
        rounds: {
          type: "integer",
          description: "Target rounds.",
          default: 3,
        },
      },
    },
  },
  {
    name: "get_workout_state",
    description:
      "Latest fused per-rep truth for a session: rep, step, form, motion, " +
      "cadence, pending audio cue, poor-form count.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id." },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_poor_form_log",
    description:
      "Flagged poor-form frames for a session (rep, step, annotation, frame id).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id." },
      },
      required: ["session_id"],
    },
  },
  {
    name: "list_workout_logs",
    description: "List persisted workout session logs, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Max logs to return.",
          default: 20,
        },
      },
    },
  },
  {
    name: "end_workout_session",
    description:
      "End a session, persist the markdown activity log, and return the summary.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id." },
      },
      required: ["session_id"],
    },
  },
];

function textResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function activeSession(
  ctx: Ctx,
  id: string | number | null | undefined,
  args: Record<string, unknown>,
): Session | { __error: string } {
  const sid = args["session_id"];
  if (typeof sid !== "string" || sid.length === 0) {
    return { __error: "missing required argument: session_id" };
  }
  const s = ctx.store.get(sid);
  if (!s) return { __error: `unknown or expired session: ${sid}` };
  void id;
  return s;
}

function isError(
  s: Session | { __error: string },
): s is { __error: string } {
  return "__error" in s;
}

async function callTool(
  ctx: Ctx,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "start_workout_session": {
      const exercise =
        typeof args["exercise"] === "string" && args["exercise"].length > 0
          ? args["exercise"]
          : "squat";
      const rounds =
        typeof args["rounds"] === "number" && args["rounds"] > 0
          ? Math.floor(args["rounds"])
          : 3;
      const s = ctx.store.create(exercise, rounds);
      return textResult({
        session_id: s.id,
        client_token: s.client_token,
        exercise: s.exercise,
        rounds: s.rounds,
        pose_url: `${POSE_CLIENT}?session=${s.id}&token=${s.client_token}`,
        motion_url: `${MOTION_CLIENT}?session=${s.id}&token=${s.client_token}`,
      });
    }

    case "get_workout_state": {
      const s = activeSession(ctx, null, args);
      if (isError(s)) throw new Error(s.__error);
      pumpCues(s);
      return textResult(fusedState(s));
    }

    case "get_poor_form_log": {
      const s = activeSession(ctx, null, args);
      if (isError(s)) throw new Error(s.__error);
      return textResult({
        session_id: s.id,
        count: s.poor_flags.length,
        flags: s.poor_flags,
      });
    }

    case "list_workout_logs": {
      const limit =
        typeof args["limit"] === "number" && args["limit"] > 0
          ? Math.min(Math.floor(args["limit"]), 100)
          : 20;
      const logs = await ctx.logs.list(limit);
      return textResult({ count: logs.length, logs });
    }

    case "end_workout_session": {
      const s = activeSession(ctx, null, args);
      if (isError(s)) throw new Error(s.__error);
      if (s.status === "ended" && s.log_key) {
        return textResult({
          session_id: s.id,
          status: "already_ended",
          log_key: s.log_key,
        });
      }
      s.status = "ended";
      s.ended_at = Date.now();
      const { key, markdown } = await ctx.logs.save(s);
      s.log_key = key;
      const formCounts = { good: 0, fair: 0, poor: 0 };
      for (const r of s.rep_history) formCounts[r.form] += 1;
      return textResult({
        session_id: s.id,
        status: "ended",
        log_key: key,
        storage: ctx.logs.mode,
        summary: {
          exercise: s.exercise,
          rounds: s.rounds,
          reps: s.reps,
          form: formCounts,
          motion_final: s.motion_class,
          poor_form_flags: s.poor_flags.length,
        },
        log_markdown: markdown,
      });
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function handleMcp(req: Request, ctx: Ctx): Promise<Response> {
  let body: RpcRequest;
  try {
    body = (await req.json()) as RpcRequest;
  } catch {
    return sse(err(null, -32700, "parse error: invalid JSON"));
  }

  const { id = null, method, params = {} } = body;

  if (method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }

  if (body.jsonrpc !== "2.0" || typeof method !== "string") {
    return sse(err(id, -32600, "invalid request"));
  }

  try {
    switch (method) {
      case "initialize":
        return sse(
          ok(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          }),
        );

      case "tools/list":
        return sse(ok(id, { tools: TOOL_DEFS }));

      case "tools/call": {
        const name = params["name"];
        if (typeof name !== "string") {
          return sse(err(id, -32602, "invalid params: name is required"));
        }
        const args =
          params["arguments"] !== undefined && params["arguments"] !== null
            ? (params["arguments"] as Record<string, unknown>)
            : {};
        if (typeof args !== "object" || Array.isArray(args)) {
          return sse(err(id, -32602, "invalid params: arguments must be an object"));
        }
        try {
          const result = await callTool(ctx, name, args);
          return sse(ok(id, result));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return sse(err(id, -32000, msg));
        }
      }

      default:
        return sse(err(id, -32601, `method not found: ${method}`));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return sse(err(id, -32603, `internal error: ${msg}`));
  }
}
