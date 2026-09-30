# start-my-workout worker (P1)

Cloudflare Worker: workout **session hub + MCP server**.

- Ingests pose frames (`POST /ingest/pose`: jpeg + COCO-17) and motion events
  (`POST /ingest/motion`) from the two web clients.
- Fuses them into per-rep truth — round/step, `form` (good/fair/poor),
  `motion` (consistent/too fast/too slow) — plus throttled audio cues
  (plan §7b).
- Serves 5 MCP tools over Streamable HTTP (`POST /mcp`) for the tablet coach
  agent: `start_workout_session`, `get_workout_state`, `get_poor_form_log`,
  `list_workout_logs`, `end_workout_session`.
- Persists the session markdown log (plan §10) to R2, with a transparent
  in-memory fallback when no R2 binding exists (local dev without account).

All endpoints require auth (constant-time compare):
- `POST /mcp` — `X-Workout-Secret` only (coach agent / admin).
- `POST /ingest/pose`, `POST /ingest/motion`, `GET /state/:id` —
  `X-Workout-Secret`, **or** the session's client token via `X-Client-Token`
  header or `?token=` query param. `start_workout_session` mints one token
  per session (`wct_<64 hex>`, dies with the session) and embeds it in the
  client deep links (`?session=..&token=..`). Browser clients authenticate
  with the token and never see the global secret.

## Layout

```
src/
  index.ts     fetch router + auth
  mcp.ts       JSON-RPC 2.0 / SSE framing + 5 tool implementations
  session.ts   in-memory session store (TTL sweep) + ingestion + fused state
  fusion.ts    knee-angle math, 3-step state machine, rep eval, cue derivation
  logstore.ts  markdown builder + R2-or-memory persistence
scripts/
  test.sh            end-to-end test (spins up wrangler dev, bash + curl)
  test-logstore.mjs  storage dual-mode test (node, no server needed)
```

## Local dev

```bash
cd ~/workspace/start-my-workout/worker
npm install

# dev secret (gitignored, dev-only) — already generated once:
#   openssl rand -hex 32  ->  .dev.vars as WORKOUT_SHARED_SECRET=<hex>
npx wrangler dev --port 8787
```

`wrangler dev` without a Cloudflare login serves a **local** R2 bucket for
the `WORKOUT_LOGS` binding (see dev log: `R2 Bucket … local`). To force the
in-memory fallback instead, set `FORCE_MEMORY_STORE = "1"` in `wrangler.toml`
`[vars]` (dev-only).

## Tests

```bash
npm test                                   # full e2e: MCP + ingestion + fusion + auth (16 checks)
npx tsc && node scripts/test-logstore.mjs  # storage: memory vs R2 backends
npx tsc --noEmit                           # strict typecheck
```

The e2e test drives a synthetic session: standing (180°) vs deep-squat
(~100°) COCO-17 frames, `rep_detected` motion events at 3.5 s (consistent)
and 2.0 s (too fast) periods, a poor-form rep (never below 150°), then
`end_workout_session` and asserts the markdown log matches plan §10.
It also asserts 401s for missing/wrong `X-Workout-Secret` on MCP and REST,
and that client tokens open ingest/state (?token=/header) but not /mcp.

## Deploy (via API — no wrangler login needed here)

```bash
~/workspace/skills/cloudflare/bin/cf-worker-deploy \
  --dir ~/workspace/start-my-workout/worker \
  --r2 workout-logs --verify
# first deploy also needs: --gen-secret WORKOUT_SHARED_SECRET
# (production secret is set on the worker; the value is never printed
#  or retained — rotate it when wiring up the browser clients)
```

Result: `https://start-my-workout.<your-subdomain>.workers.dev/mcp`
(the plan's `start-my-workout.99-cent-bagel.workers.dev` needs the
`99-cent-bagel` account / custom setup at deploy time).

## Notes / simplifications (P1)

- **Sessions are in-memory** with a 2 h idle TTL. One Worker isolate = one
  map. If this ever needs multi-instance or crash-proof sessions, move
  `Session` into a Durable Object (one per session id) — the type maps 1:1.
- **Poor-form jpegs:** only the latest frame's jpeg is kept in memory; on
  save, R2 mode stores it once as `<date>-<id>/poor-form.jpg` and references
  it from each flag. Per-flag images are a P5 refinement.
- **Form with no pose data** in a rep evaluates as `fair` (neutral), so a
  motion-only session never false-flags poor form.
- **Step machine** uses ±2° hysteresis around the 150° threshold to avoid
  chatter; classification thresholds (good < 135°) are in `fusion.ts`.
- **Cue throttle:** 3.5 s minimum gap, form corrections max 1 per 2 reps,
  priority form > pacing > encouragement; throttled cues wait as a single
  pending slot and are promoted on the next state read.
