// start-my-workout worker: session hub + MCP server (P1).
//
// Auth:
//   POST /mcp             X-Workout-Secret only (coach agent / admin).
//   POST /ingest/pose     X-Workout-Secret, or the session's client token
//   POST /ingest/motion   via X-Client-Token header / ?token= query param.
//   GET  /state/:id       (tokens are minted per session by
//                         start_workout_session and die with it; the global
//                         secret never ships to browser clients.)
// Secrets are constant-time compared.

import { handleMcp } from "./mcp.js";
import {
  Session,
  SessionStore,
  ingestPose,
  ingestMotion,
  parseMotionEvent,
  fusedState,
  PoseFrame,
} from "./session.js";
import { LogStore } from "./logstore.js";

export interface Env {
  WORKOUT_SHARED_SECRET: string;
  WORKOUT_LOGS?: R2Bucket;
  FORCE_MEMORY_STORE?: string;
}

const store = new SessionStore();

/** Constant-time string comparison (length check first). */
function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Browser clients (pose-v1, pose-motion) call ingest/state cross-origin.
const CORS_PREFLIGHT = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Workout-Secret, X-Client-Token",
  "Access-Control-Max-Age": "86400",
};

function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

let frameSeq = 0;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_PREFLIGHT });
    }

    const logs = LogStore.fromEnv(env);
    const ctx = { store, logs };
    const url = new URL(req.url);
    const path = url.pathname;

    const providedSecret = req.headers.get("X-Workout-Secret") ?? "";
    const expectedSecret = env.WORKOUT_SHARED_SECRET ?? "";
    const hasGlobalSecret =
      expectedSecret.length > 0 &&
      secretsEqual(providedSecret, expectedSecret);

    // MCP stays global-secret-only: it can start/end sessions and read logs.
    if (req.method === "POST" && path === "/mcp") {
      if (!hasGlobalSecret) return unauthorized();
      return handleMcp(req, ctx);
    }

    // Client endpoints: global secret, or the session's own client token
    // (X-Client-Token header or ?token= query param). Tokens are looked up
    // against the target session, so a token only ever opens its own session.
    const authorizeSession = (s: Session): boolean => {
      if (hasGlobalSecret) return true;
      const token =
        req.headers.get("X-Client-Token") ?? url.searchParams.get("token") ?? "";
      return (
        token.length > 0 &&
        s.client_token.length > 0 &&
        secretsEqual(token, s.client_token)
      );
    };

    if (req.method === "POST" && path === "/ingest/pose") {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return badRequest("invalid JSON");
      }
      const sid = body["session_id"];
      const coco17 = body["coco17"];
      if (typeof sid !== "string" || sid.length === 0) {
        return badRequest("session_id is required");
      }
      if (!Array.isArray(coco17)) {
        return badRequest("coco17 ([17x3]) is required");
      }
      const s = store.get(sid);
      if (!s) return json({ error: `unknown or expired session: ${sid}` }, 404);
      if (!authorizeSession(s)) return unauthorized();
      if (s.status !== "active") {
        return json({ error: "session has ended" }, 409);
      }
      const frame: PoseFrame = {
        ts: typeof body["ts"] === "number" ? body["ts"] : Date.now(),
        frame_id:
          typeof body["frame_id"] === "string" && body["frame_id"].length > 0
            ? body["frame_id"]
            : `f-${++frameSeq}`,
        coco17: coco17 as number[][],
      };
      if (typeof body["jpeg_base64"] === "string") {
        frame.jpeg_base64 = body["jpeg_base64"];
      }
      const r = ingestPose(s, frame);
      store.put(s);
      return json({ ok: true, ...r });
    }

    if (req.method === "POST" && path === "/ingest/motion") {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return badRequest("invalid JSON");
      }
      const sid = body["session_id"];
      if (typeof sid !== "string" || sid.length === 0) {
        return badRequest("session_id is required");
      }
      const event = parseMotionEvent(body["event"]);
      if (!event) {
        return badRequest(
          "event must be one of rep_detected | rep_count | cadence_hz | stillness (string or {type, value})",
        );
      }
      const s = store.get(sid);
      if (!s) return json({ error: `unknown or expired session: ${sid}` }, 404);
      if (!authorizeSession(s)) return unauthorized();
      if (s.status !== "active") {
        return json({ error: "session has ended" }, 409);
      }
      const ts = typeof body["ts"] === "number" ? body["ts"] : Date.now();
      const r = ingestMotion(s, ts, event);
      store.put(s);
      return json({ ok: true, ...r });
    }

    if (req.method === "GET" && path.startsWith("/state/")) {
      const sid = decodeURIComponent(path.slice("/state/".length));
      const s = store.get(sid);
      if (!s) return json({ error: `unknown or expired session: ${sid}` }, 404);
      if (!authorizeSession(s)) return unauthorized();
      return json(fusedState(s));
    }

    return json({ error: "not found" }, 404);
  },
};
