# web-pose

Tablet web client for start-my-workout. Next.js 15.

- `/` — session launcher: join-by-code forms and QR codes for the pose
  camera (this app) and the iPhone motion client (`NEXT_PUBLIC_MOTION_URL`,
  default `https://pose-motion.vercel.app`).
- `/pose` — MoveNet camera client (restored from pose-v1 history `ae655c0`):
  mirrored selfie view, pose overlay, voice guidance. Session deep-link and
  pose ingest wiring land in P3.

Vercel: deploy from the `99cBagel/pose-v1` monorepo with Root Directory `web-pose`.
