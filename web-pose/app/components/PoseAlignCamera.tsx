"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as posedetection from "@tensorflow-models/pose-detection";
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-webgl";
import type { Point, WorkerEvent } from "../lib/pose-contract";

const LINKS: [number, number][] = [[0,1],[0,2],[1,3],[2,4],[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];
const names = ["nose","left_eye","right_eye","left_ear","right_ear","left_shoulder","right_shoulder","left_elbow","right_elbow","left_wrist","right_wrist","left_hip","right_hip","left_knee","right_knee","left_ankle","right_ankle"];

// Voice guidance needs ~15fps; anything faster burns battery for no benefit.
const FRAME_INTERVAL_MS = 66;
const LOCAL_MODEL_URL = "/models/movenet-lightning/model.json";

export function PoseAlignCamera() {
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null), worker = useRef<Worker | null>(null), detector = useRef<posedetection.PoseDetector | null>(null), raf = useRef(0), stream = useRef<MediaStream | null>(null), lastInferAt = useRef(0), inferring = useRef(false);
  const [active, setActive] = useState(false), [message, setMessage] = useState("Tap Begin, then follow the voice guidance."), [stage, setStage] = useState("Ready"), [checks, setChecks] = useState<Record<string,boolean>>({}), [error, setError] = useState("");
  const speak = useCallback((text: string) => { try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch { /* speech unavailable */ } setMessage(text); }, []);
  const sizeCanvas = useCallback(() => { const c = canvas.current, v = video.current; if (c && v && v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; } }, []);
  const draw = useCallback((points: Point[]) => {
    const c = canvas.current; if (!c) return;
    const x = c.getContext("2d")!; x.clearRect(0, 0, c.width, c.height);
    x.strokeStyle = "#72e5e4"; x.fillStyle = "#fff"; x.lineWidth = 4;
    for (const [a, b] of LINKS) { const p = points[a], q = points[b]; if (p && q && p.score > .25 && q.score > .25) { x.beginPath(); x.moveTo(p.x * c.width, p.y * c.height); x.lineTo(q.x * c.width, q.y * c.height); x.stroke(); } }
    for (const p of points) if (p.score > .25) { x.beginPath(); x.arc(p.x * c.width, p.y * c.height, 5, 0, Math.PI * 2); x.fill(); }
  }, []);
  const loop = useCallback(async () => {
    const v = video.current, d = detector.current, w = worker.current;
    if (v && d && w && v.readyState >= 2 && !inferring.current && performance.now() - lastInferAt.current >= FRAME_INTERVAL_MS) {
      inferring.current = true; lastInferAt.current = performance.now();
      try {
        // flipHorizontal matches the mirrored selfie display (see globals.css).
        const poses = await d.estimatePoses(v, { flipHorizontal: true });
        const kp = poses[0]?.keypoints ?? [];
        const points: Point[] = kp.map((k, i) => ({ name: names[i], x: k.x / v.videoWidth, y: k.y / v.videoHeight, score: k.score ?? 0 }));
        if (kp.length) draw(points);
        // Always post, even with no pose, so the worker can prompt "stand in front of the camera".
        w.postMessage({ type: "frame", frame: { at: performance.now(), width: v.videoWidth, height: v.videoHeight, points } });
      } catch { /* transient inference failure; next frame retries */ }
      inferring.current = false;
    }
    raf.current = requestAnimationFrame(loop);
  }, [draw]);
  const begin = async () => {
    try {
      setError("");
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 1280 } }, audio: false });
      const v = video.current!;
      v.srcObject = stream.current;
      v.onloadedmetadata = sizeCanvas;
      await v.play(); sizeCanvas();
      // Initialize the TF.js backend before any TF call: pose-detection
      // registers the WebGPU backend (async init), so creating the detector
      // without awaiting tf.ready() throws "backend 'webgpu' has not yet
      // been initialized". ready() uses WebGPU where available, else WebGL.
      await tf.ready();
      const config = { modelType: posedetection.movenet.modelType.SINGLEPOSE_LIGHTNING, enableSmoothing: true };
      try { detector.current = await posedetection.createDetector(posedetection.SupportedModels.MoveNet, { ...config, modelUrl: LOCAL_MODEL_URL }); }
      catch { detector.current = await posedetection.createDetector(posedetection.SupportedModels.MoveNet, config); }
      // Warmup: compile WebGL shaders now so the first guided frame isn't slow.
      try { await detector.current.estimatePoses(v, { flipHorizontal: true }); } catch { /* warmup best-effort */ }
      worker.current = new Worker(new URL("../workers/pose-v1-prep-worker.ts", import.meta.url));
      worker.current.onmessage = ({ data }: { data: WorkerEvent }) => { if (data.type === "speak") speak(data.text); if (data.type === "state") { setStage(data.label); setChecks(data.checks); } if (data.type === "ready") setMessage("Stop. Ready now."); };
      worker.current.postMessage({ type: "begin" });
      setActive(true);
      raf.current = requestAnimationFrame(loop);
    } catch (e) { setError(e instanceof Error ? e.message : "Camera access failed"); }
  };
  useEffect(() => () => { cancelAnimationFrame(raf.current); worker.current?.terminate(); detector.current?.dispose(); stream.current?.getTracks().forEach(t => t.stop()); }, []);
  return <main className="shell"><section className="phone"><header className="heading"><h1>Get Ready, V1 Target</h1><p>follow instruction to get yourself in ready pose</p></header><div className="camera"><video ref={video} playsInline muted /><canvas ref={canvas} /><div className="hud"><span className="pill">{stage}</span><div className="message">{error || message}</div></div></div><div className="controls"><button onClick={begin} disabled={active}>{active ? "Camera active" : "Begin"}</button></div><div className="checklist">{Object.entries(checks).map(([key, ok]) => <span className={ok ? "ok" : "warn"} key={key}>● {key}</span>)}</div></section></main>;
}
