// In-memory session store with TTL sweep.
//
// NOTE: a single Worker isolate holds this Map. If the worker ever runs
// multi-instance or needs sessions to survive evictions, replace this with
// a Durable Object (one per session_id) — the Session type below maps
// 1:1 onto DO storage.

import {
  Cue,
  FormClass,
  MotionClass,
  StepName,
  rankPriority,
  CUE_MIN_GAP_MS,
  FORM_CUE_REP_GAP,
  POOR_FLAG_CAP,
  classifyForm,
  classifyMotion,
  kneeAngle,
  nextStep,
  poorFormAnnotation,
  repCompleteCue,
  stepIndex,
} from "./fusion.js";

export interface RepRecord {
  n: number;
  form: FormClass;
  motion: MotionClass;
  period_s: number | null;
  min_knee: number | null;
  ts: number;
}

export interface PoorFlag {
  rep: number;
  step: number;
  step_name: StepName;
  annotation: string;
  frame_id: string;
  ts: number;
}

export interface Session {
  id: string;
  // Session-scoped client token (minted at creation, dies with the session).
  // Browser clients authenticate ingest/state with this via X-Client-Token
  // or ?token= -- the global WORKOUT_SHARED_SECRET never ships to clients.
  client_token: string;
  exercise: string;
  rounds: number;
  created_at: number;
  last_active: number;
  status: "active" | "ended";
  // pose side
  step: StepName;
  last_knee_angle: number | null;
  min_knee_this_rep: number | null;
  last_frame_id: string | null;
  last_jpeg: string | null; // latest frame only, memory-only, never logged
  // motion side
  reps: number;
  last_rep_ts: number | null;
  cadence_s: number | null;
  motion_class: MotionClass;
  still: boolean;
  rep_history: RepRecord[];
  // audio cues (plan §7b)
  cue_seq: number;
  current_cue: Cue | null;
  pending_cue: Cue | null;
  last_cue_at: number;
  last_form_cue_rep: number;
  good_streak: number;
  // poor-form flags (cap POOR_FLAG_CAP)
  poor_flags: PoorFlag[];
  // end-of-session
  ended_at: number | null;
  log_key: string | null;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2h inactivity
const SWEEP_EVERY_REQUESTS = 50;

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}

export function newClientToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `wct_${hex}`;
}

export function createSession(exercise: string, rounds: number): Session {
  const now = Date.now();
  return {
    id: newSessionId(),
    client_token: newClientToken(),
    exercise,
    rounds,
    created_at: now,
    last_active: now,
    status: "active",
    step: "stand.start",
    last_knee_angle: null,
    min_knee_this_rep: null,
    last_frame_id: null,
    last_jpeg: null,
    reps: 0,
    last_rep_ts: null,
    cadence_s: null,
    motion_class: "consistent",
    still: false,
    rep_history: [],
    cue_seq: 0,
    current_cue: null,
    pending_cue: null,
    last_cue_at: 0,
    last_form_cue_rep: -FORM_CUE_REP_GAP,
    good_streak: 0,
    poor_flags: [],
    ended_at: null,
    log_key: null,
  };
}

export class SessionStore {
  private map = new Map<string, Session>();
  private requests = 0;

  get(id: string): Session | null {
    const s = this.map.get(id) ?? null;
    if (s && Date.now() - s.last_active > SESSION_TTL_MS) {
      this.map.delete(id);
      return null;
    }
    return s;
  }

  put(s: Session): void {
    this.map.set(s.id, s);
    if (++this.requests % SWEEP_EVERY_REQUESTS === 0) this.sweep();
  }

  create(exercise: string, rounds: number): Session {
    this.sweep();
    const s = createSession(exercise, rounds);
    this.map.set(s.id, s);
    return s;
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.map) {
      if (now - s.last_active > SESSION_TTL_MS) this.map.delete(id);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

// ---- ingestion -----------------------------------------------------------

export interface PoseFrame {
  ts: number;
  frame_id: string;
  jpeg_base64?: string;
  coco17: number[][];
}

export function ingestPose(
  s: Session,
  f: PoseFrame,
): { step: StepName; knee_angle: number | null; side: string | null } {
  const reading = kneeAngle(f.coco17);
  s.last_active = Date.now();
  s.last_frame_id = f.frame_id;
  if (f.jpeg_base64) s.last_jpeg = f.jpeg_base64;
  if (!reading) {
    return { step: s.step, knee_angle: null, side: null };
  }
  s.last_knee_angle = reading.angle;
  s.step = nextStep(s.step, reading.angle);
  if (s.min_knee_this_rep === null || reading.angle < s.min_knee_this_rep) {
    s.min_knee_this_rep = reading.angle;
  }
  return { step: s.step, knee_angle: reading.angle, side: reading.side };
}

export type MotionEvent =
  | { type: "rep_detected" }
  | { type: "rep_count"; value: number }
  | { type: "cadence_hz"; value: number }
  | { type: "stillness" };

export function parseMotionEvent(raw: unknown): MotionEvent | null {
  if (typeof raw === "string") {
    if (raw === "rep_detected" || raw === "stillness") return { type: raw };
    return null;
  }
  if (typeof raw === "object" && raw !== null) {
    const o = raw as Record<string, unknown>;
    if (o["type"] === "rep_detected") return { type: "rep_detected" };
    if (o["type"] === "stillness") return { type: "stillness" };
    if (o["type"] === "rep_count" && typeof o["value"] === "number") {
      return { type: "rep_count", value: o["value"] };
    }
    if (o["type"] === "cadence_hz" && typeof o["value"] === "number") {
      return { type: "cadence_hz", value: o["value"] };
    }
  }
  return null;
}

/** Queue-or-deliver an audio cue honoring the 3.5 s throttle (plan §7b). */
function emitCue(
  s: Session,
  text: string,
  priority: Cue["priority"],
  now: number,
): void {
  const make = (): Cue => ({ id: ++s.cue_seq, text, priority });
  if (now - s.last_cue_at >= CUE_MIN_GAP_MS) {
    s.current_cue = make();
    s.last_cue_at = now;
    s.pending_cue = null;
  } else if (!s.pending_cue || rankPriority(priority) > rankPriority(s.pending_cue.priority)) {
    s.pending_cue = make();
  }
}

/** Promote a throttled pending cue once the gap has cleared. Call on state reads. */
export function pumpCues(s: Session, now: number = Date.now()): void {
  if (s.pending_cue && now - s.last_cue_at >= CUE_MIN_GAP_MS) {
    s.current_cue = s.pending_cue;
    s.pending_cue = null;
    s.last_cue_at = now;
  }
}

export function ingestMotion(
  s: Session,
  ts: number,
  event: MotionEvent,
): { reps: number; motion: MotionClass } {
  const now = Date.now();
  s.last_active = now;
  s.still = false;

  switch (event.type) {
    case "stillness":
      s.still = true;
      return { reps: s.reps, motion: s.motion_class };

    case "cadence_hz": {
      if (event.value > 0) {
        s.cadence_s = 1 / event.value;
        s.motion_class = classifyMotion(s.cadence_s);
      }
      return { reps: s.reps, motion: s.motion_class };
    }

    case "rep_count":
      if (event.value > s.reps) s.reps = Math.floor(event.value);
      return { reps: s.reps, motion: s.motion_class };

    case "rep_detected": {
      const periodS =
        s.last_rep_ts !== null ? (ts - s.last_rep_ts) / 1000 : null;
      const prevMotion = s.motion_class;
      if (periodS !== null && periodS > 0) {
        s.motion_class = classifyMotion(periodS);
        s.cadence_s = periodS;
      }
      const form = classifyForm(s.min_knee_this_rep);
      s.reps += 1;
      s.last_rep_ts = ts;
      s.good_streak = form === "good" ? s.good_streak + 1 : 0;

      s.rep_history.push({
        n: s.reps,
        form,
        motion: s.motion_class,
        period_s: periodS,
        min_knee: s.min_knee_this_rep,
        ts,
      });

      if (form === "poor" && s.poor_flags.length < POOR_FLAG_CAP) {
        s.poor_flags.push({
          rep: s.reps,
          step: 2,
          step_name: "squat.down",
          annotation: poorFormAnnotation(s.reps, s.min_knee_this_rep ?? 180),
          frame_id: s.last_frame_id ?? "none",
          ts,
        });
      }

      const cue = repCompleteCue({
        rep: s.reps,
        form,
        motion: s.motion_class,
        motionChanged: s.motion_class !== prevMotion,
        goodStreak: s.good_streak,
        formCueAllowed: s.reps - s.last_form_cue_rep >= FORM_CUE_REP_GAP,
      });
      if (cue) {
        if (cue.isFormCorrection) s.last_form_cue_rep = s.reps;
        emitCue(s, cue.text, cue.priority, now);
      }

      // Reset for the next rep; the pose machine re-arms at stand.start.
      s.min_knee_this_rep = null;
      s.step = "stand.start";
      return { reps: s.reps, motion: s.motion_class };
    }
  }
}

/** Fused per-rep truth snapshot (plan §4.1) for clients and the coach agent. */
export function fusedState(s: Session): Record<string, unknown> {
  pumpCues(s);
  return {
    session_id: s.id,
    status: s.status,
    exercise: s.exercise,
    rounds: s.rounds,
    rep: s.reps,
    reps_completed: s.reps,
    step: stepIndex(s.step),
    step_name: s.step,
    form: s.rep_history.length > 0 ? s.rep_history[s.rep_history.length - 1]!.form : "fair",
    motion: s.motion_class,
    cadence_s_per_rep: s.cadence_s,
    last_knee_angle_deg:
      s.last_knee_angle === null ? null : Math.round(s.last_knee_angle * 10) / 10,
    still: s.still,
    cue: s.current_cue,
    pending_cue: s.pending_cue !== null,
    poor_form_count: s.poor_flags.length,
    good_streak: s.good_streak,
  };
}
