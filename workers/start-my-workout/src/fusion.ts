// Pose/motion fusion for start-my-workout (P1).
//
// Squat truth template (plan §9):
//   steps:  stand.start -> squat.down -> complete   (3 steps)
//   knee angle < 150°  => down ; >= 150° => stand
//   motion band: 3.0 - 4.0 s/rep => consistent

export type StepName = "stand.start" | "squat.down" | "complete";
export type FormClass = "good" | "fair" | "poor";
export type MotionClass = "consistent" | "too fast" | "too slow";
export type CuePriority = "form" | "pacing" | "encouragement" | "info";

export interface Cue {
  id: number;
  text: string;
  priority: CuePriority;
}

export const DOWN_THRESHOLD = 150; // plan §9
export const GOOD_DEPTH = 135; // min knee angle over a rep for "good"
export const MOTION_BAND_S: [number, number] = [3.0, 4.0];
export const CUE_MIN_GAP_MS = 3500; // plan §7b
export const FORM_CUE_REP_GAP = 2; // form corrections at most 1 per 2 reps
export const POOR_FLAG_CAP = 8; // plan §9
export const STREAK_MILESTONE = 5;

// COCO-17 keypoint indices
const LEFT = { hip: 11, knee: 13, ankle: 15 };
const RIGHT = { hip: 12, knee: 14, ankle: 16 };
const MIN_CONF = 0.3;

// Hysteresis around DOWN_THRESHOLD so the step machine doesn't chatter
// on frames that hover near 150°.
const DOWN_ENTER = 148;
const DOWN_EXIT = 152;

export interface KneeReading {
  angle: number;
  side: "left" | "right";
}

/** Knee angle (degrees) at the knee joint, left side preferred, right fallback. */
export function kneeAngle(coco17: number[][]): KneeReading | null {
  if (!Array.isArray(coco17) || coco17.length < 17) return null;
  const sides: Array<["left" | "right", typeof LEFT]> = [
    ["left", LEFT],
    ["right", RIGHT],
  ];
  for (const [side, idx] of sides) {
    const h = coco17[idx.hip];
    const k = coco17[idx.knee];
    const a = coco17[idx.ankle];
    if (!h || !k || !a) continue;
    if (
      (h[2] ?? 0) < MIN_CONF ||
      (k[2] ?? 0) < MIN_CONF ||
      (a[2] ?? 0) < MIN_CONF
    ) {
      continue;
    }
    const v1x = (h[0] ?? 0) - (k[0] ?? 0);
    const v1y = (h[1] ?? 0) - (k[1] ?? 0);
    const v2x = (a[0] ?? 0) - (k[0] ?? 0);
    const v2y = (a[1] ?? 0) - (k[1] ?? 0);
    const n1 = Math.hypot(v1x, v1y);
    const n2 = Math.hypot(v2x, v2y);
    if (n1 < 1e-9 || n2 < 1e-9) return null;
    const cos = Math.max(
      -1,
      Math.min(1, (v1x * v2x + v1y * v2y) / (n1 * n2)),
    );
    return { angle: (Math.acos(cos) * 180) / Math.PI, side };
  }
  return null;
}

/** Advance the 3-step machine from the latest knee angle. */
export function nextStep(current: StepName, angle: number): StepName {
  const isDown =
    angle < DOWN_ENTER || (angle < DOWN_EXIT && current === "squat.down");
  if (current === "stand.start") return isDown ? "squat.down" : "stand.start";
  if (current === "squat.down") return isDown ? "squat.down" : "complete";
  // "complete" holds until the next rep resets it to stand.start
  return "complete";
}

export function stepIndex(step: StepName): number {
  return step === "stand.start" ? 1 : step === "squat.down" ? 2 : 3;
}

/** Form for a finished rep from its minimum knee angle. */
export function classifyForm(minKneeAngle: number | null): FormClass {
  if (minKneeAngle === null) return "fair"; // no pose frames this rep: neutral
  if (minKneeAngle < GOOD_DEPTH) return "good";
  if (minKneeAngle < DOWN_THRESHOLD) return "fair";
  return "poor";
}

/** Motion class from rep period (seconds). */
export function classifyMotion(periodS: number | null): MotionClass {
  if (periodS === null) return "consistent"; // not enough data yet: neutral
  if (periodS < MOTION_BAND_S[0]) return "too fast";
  if (periodS > MOTION_BAND_S[1]) return "too slow";
  return "consistent";
}

const WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
  "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

function repWord(n: number): string {
  if (n >= 1 && n <= 20) return WORDS[n]!;
  return String(n);
}

export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

const PRIORITY_RANK: Record<CuePriority, number> = {
  form: 4,
  pacing: 3,
  encouragement: 2,
  info: 1,
};

export function rankPriority(p: CuePriority): number {
  return PRIORITY_RANK[p];
}

/** Build the rep-complete cue per plan §7b priority: form > pacing > encouragement. */
export function repCompleteCue(args: {
  rep: number;
  form: FormClass;
  motion: MotionClass;
  motionChanged: boolean;
  goodStreak: number;
  formCueAllowed: boolean; // respects the 1-per-2-reps cap
}): { text: string; priority: CuePriority; isFormCorrection: boolean } | null {
  const { rep, form, motion, motionChanged, goodStreak, formCueAllowed } = args;
  const w = repWord(rep);
  if (form === "poor" && formCueAllowed) {
    return { text: "Deeper on the next one.", priority: "form", isFormCorrection: true };
  }
  if (motionChanged && motion === "too fast") {
    return { text: "Slow down.", priority: "pacing", isFormCorrection: false };
  }
  if (motionChanged && motion === "too slow") {
    return { text: "Pick up the pace.", priority: "pacing", isFormCorrection: false };
  }
  if (form === "good" && goodStreak > 0 && goodStreak % STREAK_MILESTONE === 0) {
    return { text: "Looking strong, keep it up.", priority: "encouragement", isFormCorrection: false };
  }
  if (form === "good") {
    return { text: `${capitalize(w)}, good.`, priority: "info", isFormCorrection: false };
  }
  if (form === "fair") {
    return { text: `${capitalize(w)}, almost — a touch deeper.`, priority: "info", isFormCorrection: false };
  }
  // poor form but throttled by the rep-gap cap: stay silent this rep
  return null;
}

/** Annotation for a poor-form flag, matching the plan §9 example format. */
export function poorFormAnnotation(rep: number, minKneeAngle: number): string {
  return `rep ${rep} step 2: depth short (knee ${Math.round(minKneeAngle)}° vs <${DOWN_THRESHOLD}° truth)`;
}
