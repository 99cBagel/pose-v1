// MCP relay: forwards to the start-my-workout worker's /mcp, injecting the
// worker secret server-side. Bearer-token gated so the public internet
// can't mint sessions or read workout logs.
//
// Why this exists: the coach agent's backend runs on Cloudflare's network,
// and the Cloudflare edge refuses same-account workers.dev calls from inside
// its own network (error 1042). Vercel is off that network, so this relay
// gives the agent a working path to the worker.
//
// Env (set in the Vercel dashboard, never in chat or git):
//   WORKOUT_SHARED_SECRET  must match the worker's secret (set it yourself
//                          in the Cloudflare dashboard too)
//   MCP_PROXY_TOKEN        bearer token the MCP client sends as
//                          `Authorization: Bearer <token>`
//   WORKOUT_WORKER_MCP_URL override for the upstream (default: production)

const WORKER_MCP_URL =
  process.env.WORKOUT_WORKER_MCP_URL ??
  "https://start-my-workout.99-cent-bagel.workers.dev/mcp";

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function authorized(req: Request): boolean {
  const expected = process.env.MCP_PROXY_TOKEN;
  if (!expected) return false;
  return req.headers.get("authorization") === `Bearer ${expected}`;
}

async function forward(req: Request): Promise<Response> {
  if (!authorized(req)) return jsonError(401, "unauthorized");

  const secret = process.env.WORKOUT_SHARED_SECRET;
  if (!secret) return jsonError(500, "proxy misconfigured");

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const accept = req.headers.get("accept");
  if (accept) headers.set("Accept", accept);
  headers.set("X-Workout-Secret", secret);

  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await req.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(WORKER_MCP_URL, { method: req.method, headers, body });
  } catch {
    return jsonError(502, "upstream unreachable");
  }

  const outHeaders = new Headers();
  const outContentType = upstream.headers.get("content-type");
  if (outContentType) outHeaders.set("Content-Type", outContentType);
  outHeaders.set("Access-Control-Allow-Origin", "*");
  outHeaders.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");

  // Stream the SSE body straight through; never log or buffer secrets.
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

export async function POST(req: Request): Promise<Response> {
  return forward(req);
}

export async function GET(req: Request): Promise<Response> {
  return forward(req);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    },
  });
}

// Every call must reach the worker live — never prerender or cache.
export const dynamic = "force-dynamic";
