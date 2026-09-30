# safari-motion

iPhone motion client for start-my-workout (Safari). Next.js 15.

Pocket motion-sensor squat counter: session deep-link auto-join
(`?session=..&token=..`), `rep_detected` / `cadence_hz` ingest to the
session hub, 1.5s fused-state polling, per-rep SpeechSynthesis cues,
standalone counter mode without a session.

Vercel: deploy from the `99cBagel/pose-v1` monorepo with Root Directory `safari-motion`.
