"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SquatCounter } from "../lib/squat-counter";
import {
  SessionParams,
  WorkoutState,
  fetchState,
  postMotionEvent,
  sessionFromUrl,
} from "../lib/session-client";
import { speakCue, stopSpeech, unlockSpeech } from "../lib/speech";

type Phase = "idle" | "armed" | "counting";
type MotionClass = "consistent" | "too fast" | "too slow" | null;

const PHASE_LABEL: Record<Phase, string> = {
  idle: "waiting for motion",
  armed: "motion detected…",
  counting: "counting",
};

const POLL_MS = 1500;
const CADENCE_UPLOAD_MS = 15000;

export function MotionClientView() {
  const params = useSearchParams();
  const counterRef = useRef<SquatCounter | null>(null);
  if (!counterRef.current) counterRef.current = new SquatCounter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const listenerRef = useRef<((e: DeviceMotionEvent) => void) | null>(null);
  const samplesRef = useRef(0);
  const firstSampleAtRef = useRef(0);
  const lastCueIdRef = useRef(0);
  const sessionRef = useRef<SessionParams | null>(null);

  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [cadence, setCadence] = useState(0);
  const [hz, setHz] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [permState, setPermState] = useState<"unknown" | "needed" | "granted">("unknown");

  // ---- session mode ------------------------------------------------------
  const [session, setSession] = useState<SessionParams | null>(null);
  const [serverReps, setServerReps] = useState<number | null>(null);
  const [motionClass, setMotionClass] = useState<MotionClass>(null);
  const [lastCue, setLastCue] = useState<string | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [joinId, setJoinId] = useState("");
  const [joinToken, setJoinToken] = useState("");

  useEffect(() => {
    // Re-read on mount: useSearchParams is stable, but sessionFromUrl
    // reads the raw query string so pasted links just work.
    const s = sessionFromUrl();
    sessionRef.current = s;
    setSession(s);
    void params;
  }, [params]);

  const endSessionLocally = useCallback((msg: string) => {
    setSessionEnded(true);
    setError(msg);
    stopSpeech();
  }, []);

  // ---- chart -----------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const c = counterRef.current;
    if (!canvas || !wrap || !c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = wrap.clientWidth;
    const h = 190;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const now = performance.now() / 1000;
    const WIN = 12;
    const t0 = now - WIN;
    const hist = c.history.filter((p) => p.t >= t0);
    let peak = 1.5;
    for (const p of hist) peak = Math.max(peak, Math.abs(p.x));
    const midY = h / 2;
    const yOf = (v: number) => midY - (v / peak) * (h / 2 - 14);
    const xOf = (t: number) => ((t - t0) / WIN) * w;

    ctx.strokeStyle = "#2c5960";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    if (hist.length > 1) {
      ctx.strokeStyle = "#70e2e6";
      ctx.lineWidth = 2;
      ctx.beginPath();
      hist.forEach((p, i) => {
        const x = xOf(p.t);
        const y = yOf(p.x);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    ctx.strokeStyle = "#8af0be";
    ctx.fillStyle = "#8af0be";
    ctx.lineWidth = 1.5;
    for (const t of c.repTimes) {
      if (t < t0) continue;
      const x = xOf(t);
      ctx.beginPath();
      ctx.moveTo(x, 8);
      ctx.lineTo(x, h - 8);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, 12, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#5f8891";
    ctx.font = "11px system-ui";
    ctx.fillText(`vertical accel (m/s²) · ±${peak.toFixed(1)}`, 8, h - 8);
  }, []);

  useEffect(() => {
    const loop = () => {
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  // ---- sensor ----------------------------------------------------------
  const stop = useCallback(() => {
    if (listenerRef.current) {
      window.removeEventListener("devicemotion", listenerRef.current);
      listenerRef.current = null;
    }
    stopSpeech();
    setRunning(false);
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setError(null);
    setSessionEnded(false);
    const counter = counterRef.current!;
    try {
      if (typeof DeviceMotionEvent === "undefined" || !("DeviceMotionEvent" in window)) {
        throw new Error("This device/browser has no motion sensor API.");
      }
      const DM = DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<string>;
      };
      if (typeof DM.requestPermission === "function") {
        setPermState("needed");
        const res = await DM.requestPermission();
        if (res !== "granted") throw new Error("Motion permission was not granted.");
      }
      setPermState("granted");
      unlockSpeech(); // iOS: speech must start inside the tap gesture

      const sess = sessionRef.current;
      counter.onRep = (_rep, n) => {
        setCount(n);
        setPhase("counting");
        if (sess) {
          postMotionEvent(sess, "rep_detected").catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            if (/40[19]|404/.test(msg)) {
              endSessionLocally("Session ended or invalid — ask the coach to start a new workout.");
              stop();
            }
          });
        }
      };
      samplesRef.current = 0;
      firstSampleAtRef.current = 0;
      lastCueIdRef.current = 0;

      const onMotion = (e: DeviceMotionEvent) => {
        const a = e.accelerationIncludingGravity;
        if (!a || a.x == null || a.y == null || a.z == null) return;
        const t = performance.now() / 1000;
        if (samplesRef.current === 0) firstSampleAtRef.current = t;
        samplesRef.current += 1;
        counter.push({ t, ax: a.x, ay: a.y, az: a.z });
      };
      listenerRef.current = onMotion;
      window.addEventListener("devicemotion", onMotion);
      setRunning(true);

      setTimeout(() => {
        if (listenerRef.current && samplesRef.current === 0) {
          setError("No motion data arrived. Keep the page in the foreground and try again.");
          stop();
        }
      }, 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the motion sensor.");
      stop();
    }
  }, [stop, endSessionLocally]);

  const reset = useCallback(() => {
    counterRef.current!.reset();
    setCount(0);
    setPhase("idle");
    setCadence(0);
    setHz(0);
    setError(null);
    setServerReps(null);
    setMotionClass(null);
    setLastCue(null);
    setSessionEnded(false);
    stopSpeech();
  }, []);

  // stats ticker
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const c = counterRef.current!;
      setPhase(c.phase);
      setCadence(c.cadence());
      const n = samplesRef.current;
      const dt = performance.now() / 1000 - firstSampleAtRef.current;
      setHz(n > 10 && dt > 0 ? Math.round(n / dt) : 0);
    }, 500);
    return () => clearInterval(id);
  }, [running]);

  // ---- session poll: fused state + audio cues ---------------------------
  useEffect(() => {
    if (!running || !session || sessionEnded) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const st: WorkoutState = await fetchState(session);
        if (cancelled) return;
        setServerReps(st.reps_completed);
        setMotionClass(st.motion);
        if (st.status === "ended") {
          endSessionLocally("Session ended by the coach. Nice work.");
          stop();
          return;
        }
        const cue = st.cue;
        if (cue && cue.id !== lastCueIdRef.current) {
          lastCueIdRef.current = cue.id;
          setLastCue(cue.text);
          speakCue(cue.text);
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (/40[19]|404/.test(msg)) {
          endSessionLocally("Session ended or invalid — ask the coach to start a new workout.");
          stop();
        }
        // transient network blip: keep counting locally, retry next poll
      }
    };
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running, session, sessionEnded, stop, endSessionLocally]);

  // ---- periodic cadence upload ------------------------------------------
  useEffect(() => {
    if (!running || !session || sessionEnded) return;
    const id = setInterval(() => {
      const hzVal = counterRef.current!.cadence() / 60;
      if (hzVal > 0) {
        postMotionEvent(session, { type: "cadence_hz", value: hzVal }).catch(() => {});
      }
    }, CADENCE_UPLOAD_MS);
    return () => clearInterval(id);
  }, [running, session, sessionEnded]);

  const join = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const id = joinId.trim();
      const tok = joinToken.trim();
      if (!id || !tok) {
        setError("Enter the session code and token from the coach.");
        return;
      }
      window.location.href = `?session=${encodeURIComponent(id)}&token=${encodeURIComponent(tok)}`;
    },
    [joinId, joinToken],
  );

  const motionChipClass =
    motionClass === "consistent" ? "chip ok" : motionClass ? "chip warn" : "chip";

  return (
    <div className="shell">
      <div className="phone">
        <div className="heading">
          <h1>pose motion</h1>
          <p>iPhone motion client · start-my-workout</p>
          {session && <span className="session-chip">session {session.id}</span>}
        </div>

        <div className="count-card">
          <div className="count-label"># of Counts</div>
          <div className="count-num">{count}</div>
          <div className="count-unit">{count === 1 ? "squat" : "squats"}</div>
        </div>

        {session && lastCue && <div className="cue-card">{lastCue}</div>}

        {session && (
          <div className="chips">
            <span className={motionChipClass}>
              motion: {motionClass ?? "—"}
            </span>
            <span className="chip">hub reps: {serverReps ?? "—"}</span>
          </div>
        )}

        <div className="chart-card" ref={wrapRef}>
          <canvas ref={canvasRef} style={{ width: "100%", height: 190, display: "block" }} />
        </div>

        <div className="stats">
          <span className={phase === "counting" ? "ok" : "warn"}>{running ? PHASE_LABEL[phase] : "stopped"}</span>
          <span>{cadence > 0 ? `${Math.round(cadence)}/min` : "—/min"}</span>
          <span>{hz > 0 ? `${hz} Hz` : "no sensor"}</span>
        </div>

        {error && <div className="message">{error}</div>}

        <div className="controls">
          {running ? (
            <button onClick={stop}>Stop</button>
          ) : (
            <button onClick={start}>Start</button>
          )}
          <button className="secondary" onClick={reset}>
            Reset
          </button>
        </div>

        <p className="hint">
          Put the phone in your pocket or strap it to your thigh, then tap Start and squat.
          {permState === "needed" && " Your phone will ask for motion permission."}
          {session && " Coaching cues play out loud while you work."}
        </p>

        {!session && (
          <form className="join" onSubmit={join}>
            <h2>Join a workout session</h2>
            <p>No link? Type the session code and token the coach gave you.</p>
            <div className="row">
              <input
                value={joinId}
                onChange={(e) => setJoinId(e.target.value)}
                placeholder="session code"
                autoCapitalize="off"
                autoCorrect="off"
              />
              <input
                value={joinToken}
                onChange={(e) => setJoinToken(e.target.value)}
                placeholder="token"
                autoCapitalize="off"
                autoCorrect="off"
              />
              <button type="submit">Join</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
