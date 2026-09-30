# pose-v1 — start-my-workout monorepo

One repo, three deployables for the start-my-workout fitness form coach
(see `~/workspace/your_files/start-my-workout-plan.md` for the full plan).

| Folder | What | Deploys as |
|---|---|---|
| `web-pose/` | Tablet web client (Next.js): `/` session launcher with client links + QR codes, `/pose` MoveNet camera client | `pose-v1.vercel.app` (Vercel Root Directory `web-pose`) |
| `safari-motion/` | iPhone motion client (Next.js): pocket squat counter, session deep-link, hub ingest/poll, speech cues | `pose-motion.vercel.app` (Vercel Root Directory `safari-motion`) |
| `workers/start-my-workout/` | Cloudflare Worker: session hub + MCP server, pose/motion fusion, R2 session logs | `start-my-workout.99-cent-bagel.workers.dev` |

Each folder builds and deploys independently; there is no root workspace.

## Quick verify

```bash
(cd web-pose && npm install && npm run build)
(cd safari-motion && npm install && npm run build)
(cd workers/start-my-workout && npm install && bash scripts/test.sh)  # needs .dev.vars (gitignored)
```
