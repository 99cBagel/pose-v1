# pose-v1-prep-worker

Mobile-first Next.js camera worker for reaching the V1 squat-camera viewpoint. It runs MoveNet inference, direction selection, and speech entirely in the browser; camera frames and keypoints are never sent to a server.

## Run

```powershell
cd C:\002-workspace\pose-trainer\pose-v1-prep
pnpm install
pnpm dev
```

Open the app over HTTPS (or `localhost`) on Android/iOS, allow the front camera, and tap **Begin**. For a native shell, use the same local web bundle in a Capacitor/WebView container and route `speak` events to the platform TTS implementation.

## Architecture

- `app/components/PoseAlignCamera.tsx` owns camera acquisition, MoveNet Lightning inference, the video overlay, and local speech playback.
- `app/workers/pose-v1-prep-worker.ts` owns the V1 readiness loop. It emits only `turn to right`, `turn to left`, `step forward`, or `step backward`, then `Stop. Ready now.` after one stable second.

The current thresholds implement the supplied V1 framing, viewpoint and neutral-pose gates. Tune them only against calibrated V1-labelled video, not a dead-frontal camera angle.
