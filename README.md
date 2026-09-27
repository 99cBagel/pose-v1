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

The app tries the bundled local model first. If it is absent, it uses the TensorFlow.js default hosted MoveNet model so a Vercel preview can still start; inference itself always runs in the browser. For an offline release, download the **TensorFlow.js** variation of Google MoveNet SinglePose Lightning v4 from [Kaggle Models](https://www.kaggle.com/models/google/movenet), unpack `model.json` and every referenced `group*-shard*.bin` file into `public/models/movenet-lightning/`, then commit and redeploy them.

The current thresholds implement the supplied V1 framing and viewpoint gates. Tune them only against calibrated V1-labelled video, not a dead-frontal camera angle.
