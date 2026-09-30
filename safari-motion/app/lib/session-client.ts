// Client for the start-my-workout session hub.
//
// Auth: every request carries the session-scoped client token as ?token=
// (query param, so no CORS preflight for custom headers). The token is
// minted per session by start_workout_session and dies with the session;
// the global WORKOUT_SHARED_SECRET never ships to this client.

export const WORKER_BASE =
  "https://start-my-workout.99-cent-bagel.workers.dev";

export interface SessionParams {
  id: string;
  token: string;
}

/** Read ?session= & ?token= from the current URL (deep link or typed entry). */
export function sessionFromUrl(): SessionParams | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const id = (q.get("session") ?? "").trim();
  const token = (q.get("token") ?? "").trim();
  return id && token ? { id, token } : null;
}

function tokenQuery(p: SessionParams): string {
  return `token=${encodeURIComponent(p.token)}`;
}

export type MotionEvent =
  | "rep_detected"
  | "stillness"
  | { type: "rep_count"; value: number }
  | { type: "cadence_hz"; value: number };

export async function postMotionEvent(
  p: SessionParams,
  event: MotionEvent,
  ts: number = Date.now(),
): Promise<{ reps: number; motion: string }> {
  const res = await fetch(
    `${WORKER_BASE}/ingest/motion?${tokenQuery(p)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: p.id, ts, event }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`motion ingest failed: ${res.status} ${body}`);
  }
  return res.json();
}

export interface Cue {
  id: number;
  text: string;
  priority: string;
}

export interface WorkoutState {
  session_id: string;
  status: "active" | "ended";
  exercise: string;
  rounds: number;
  rep: number;
  reps_completed: number;
  step: number;
  step_name: string;
  form: "good" | "fair" | "poor";
  motion: "consistent" | "too fast" | "too slow";
  cadence_s_per_rep: number | null;
  still: boolean;
  cue: Cue | null;
  pending_cue: boolean;
  poor_form_count: number;
  good_streak: number;
}

export async function fetchState(p: SessionParams): Promise<WorkoutState> {
  const res = await fetch(
    `${WORKER_BASE}/state/${encodeURIComponent(p.id)}?${tokenQuery(p)}`,
    { cache: "no-store" },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`state fetch failed: ${res.status} ${body}`);
  }
  return res.json();
}
