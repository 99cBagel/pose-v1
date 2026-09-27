# pose-v1-prep-worker

Mobile-first Next.js camera worker for reaching the V1 squat-camera viewpoint. It runs MoveNet inference, direction selection, and speech entirely in the browser; camera frames and keypoints are never sent to a server.

## Run

```powershell
cd C:\002-workspace\pose-trainer\pose-v1-prep
pnpm install
pnpm dev
```

Open the app over HTTPS (or `localhost`) on Android/iOS, allow the front camera, and tap **Begin**. For a native shell, use the same local web bundle in a Capacitor/WebView container and route `speak` events to the platform TTS implementation.

## Model

The MoveNet SinglePose Lightning v4 weights are bundled in `public/models/movenet-lightning/` (TF.js graph-model format, downloaded from TFHub), so the app runs fully offline with zero model-download latency. If the bundled files are ever missing, the app falls back to the TensorFlow.js default hosted model. To refresh the bundle, download the **TensorFlow.js** variation of Google MoveNet SinglePose Lightning v4 (a tarball containing `model.json` + `group*-shard*.bin`) and unpack it into `public/models/movenet-lightning/`.

## Architecture

- `app/components/PoseAlignCamera.tsx` owns camera acquisition, MoveNet Lightning inference, the video overlay, and local speech playback. Inference is capped at ~15fps (plenty for voice guidance, kind to batteries), the model is warmed up once at startup, and frames are always forwarded to the worker — even with no pose detected — so it can prompt "stand in front of the camera".
- `app/workers/pose-v1-prep-worker.ts` owns the V1 readiness loop: presence → framing → viewpoint → 1s hold → `Stop. Ready now.`

## Conventions

- The front-camera display is a mirrored selfie view (`scaleX(-1)` on both video and canvas) and inference runs with `flipHorizontal: true`, so keypoints match what the student sees.
- All spoken directions are student-relative ("your left" / "your right") and computed in that mirrored space, so they stay correct on front and rear cameras.
- Prompt vocabulary: `stand in front of the camera`, `step forward`, `step backward`, `move to your left`, `move to your right` (translation), `turn to your left`, `turn to your right` (rotation). Translation and rotation are never conflated.
- V1 viewpoint gates: shoulder-width/torso ratio 0.50–0.80, nose offset ≤ 0.35. These reproduce the V1 source-video camera angle (slightly off-frontal, which is what makes the squat knee-angle rule work). Tune them only against calibrated V1-labelled video, not a dead-frontal camera angle.
