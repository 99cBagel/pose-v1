import type { Frame, Point, WorkerEvent, WorkerMessage } from "../lib/pose-contract";

// V1 readiness loop. Coordinates arrive in the mirrored selfie space the app
// feeds us (flipHorizontal: true on a mirrored display), so on screen
// right = the student's right. Every prompt is student-relative
// ("your left"), which stays correct under mirroring.

let armed = false, stableSince = 0, completed = false;
let lastPrompt = "", lastPromptAt = 0;
const send = (event: WorkerEvent) => postMessage(event);
const get = (f: Frame, name: string) => f.points.find((p) => p.name === name)!;
const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: {x:number;y:number}, b: {x:number;y:number}) => Math.hypot(a.x-b.x, a.y-b.y);
const meanScore = (f: Frame) => f.points.reduce((s, p) => s + p.score, 0) / Math.max(f.points.length, 1);
function say(prompt: string, now: number) { if (prompt !== lastPrompt || now - lastPromptAt >= 3000) { lastPrompt = prompt; lastPromptAt = now; send({ type: "speak", text: prompt }); } }

function metrics(f: Frame) {
  if (f.points.length !== 17 || meanScore(f) <= .4)
    return { visible: false, framing: false, viewpoint: false, prompt: "stand in front of the camera" };
  const personHeight = Math.max(...f.points.map(p => p.y)) - Math.min(...f.points.map(p => p.y));
  const nearEdge = f.points.some(p => p.x < .03 || p.x > .97 || p.y < .03 || p.y > .97);
  const hips = mid(get(f, "left_hip"), get(f, "right_hip"));
  const shoulders = mid(get(f, "left_shoulder"), get(f, "right_shoulder"));
  const torso = distance(shoulders, hips) || 1e-6;
  const ratio = distance(get(f, "left_shoulder"), get(f, "right_shoulder")) / torso;
  const nose = get(f, "nose");
  const noseOffset = Math.abs(nose.x - shoulders.x) / torso;
  // Mirrored: nose right of the shoulder midpoint means the head is turned
  // toward the student's right, so prompt a turn back to their left.
  const turnPrompt = nose.x > shoulders.x ? "turn to your left" : "turn to your right";

  let prompt: string | null = null;
  if (personHeight < .6) prompt = "step forward";
  else if (personHeight > .8 || nearEdge) prompt = "step backward";
  else if (hips.x < .4) prompt = "move to your right";
  else if (hips.x > .6) prompt = "move to your left";
  else if (ratio < .5) prompt = turnPrompt;
  else if (ratio > .8) prompt = "step backward";
  else if (noseOffset > .35) prompt = turnPrompt;

  const framing = personHeight >= .6 && personHeight <= .8 && !nearEdge && Math.abs(hips.x - .5) <= .1;
  const viewpoint = ratio >= .5 && ratio <= .8 && noseOffset <= .35;
  return { visible: true, framing, viewpoint, prompt: prompt ?? "hold position" };
}

self.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
  if (data.type === "begin") { armed = true; completed = false; stableSince = 0; lastPrompt = ""; lastPromptAt = 0; send({ type: "state", label: "Finding V1 target", checks: {} }); return; }
  if (!armed || completed || data.type !== "frame") return;
  const now = data.frame.at, result = metrics(data.frame);
  const checks = { visible: result.visible, framing: result.framing, viewpoint: result.viewpoint };
  if (!result.visible || !result.framing || !result.viewpoint) { stableSince = 0; say(result.prompt, now); send({ type: "state", label: result.prompt, checks }); return; }
  stableSince ||= now;
  if (now - stableSince < 1000) { send({ type: "state", label: "Hold position", checks }); return; }
  completed = true;
  send({ type: "state", label: "V1 ready", checks });
  send({ type: "speak", text: "Stop. Ready now." });
  send({ type: "ready" });
};
