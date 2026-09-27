# pose-v1 — squat counter

Mobile-first Next.js app that counts squats using the phone's motion sensor.
No camera, no video, no pose model — just the accelerometer and a rep-detection
algorithm, all on-device.

## Run

```sh
pnpm install
pnpm dev
```

Open the app over HTTPS (or `localhost`) on Android/iOS, put the phone in your
pocket or strap it to your thigh, and tap **Start**.

## How it counts

`app/lib/squat-counter.ts`:

1. Gravity is estimated with a slow per-axis EMA.
2. Linear acceleration is taken along the gravity-dominant axis (the axis most
   aligned with "down") — the vertical motion channel, robust to phone orientation.
3. A band-pass (fast EMA minus slow EMA) turns each squat rep into one
   oscillation lobe centered on zero, and attenuates fast content
   (footsteps, shaking) below the counting floor.
4. Humps in the signal are confirmed as lobes via a hysteresis drop so each
   hump counts exactly once. A lobe is kept when it clears an adaptive
   threshold, follows a deep valley (one full oscillation per count), and is
   at least 0.9 s after the previous lobe.
5. Lobes with no deep valley between them belong to the same rep
   (bottom-turnaround spike + ascent): the tallest wins, the rep counts once.
   A deep valley after the candidate closes the rep; a candidate that never
   sees its closing valley is discarded, never counted.
6. Arming: the first closed rep only arms the counter; a second rep inside
   the cadence window retro-counts both and starts counting. A long pause
   disarms (set ended), so walking or fidgeting between sets isn't counted.

The chart shows the live vertical-acceleration signal with a marker on every
counted rep.
