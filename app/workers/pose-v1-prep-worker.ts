import type { Frame, Point, WorkerEvent, WorkerMessage } from "../lib/pose-contract";

let armed = false, stableSince = 0, completed = false;
let lastPrompt = "", lastPromptAt = 0;
const send = (event: WorkerEvent) => postMessage(event);
const get = (f: Frame, name: string) => f.points.find((p) => p.name === name)!;
const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: {x:number;y:number}, b: {x:number;y:number}) => Math.hypot(a.x-b.x, a.y-b.y);
function say(prompt: string, now: number) { if (prompt !== lastPrompt || now - lastPromptAt >= 3000) { lastPrompt = prompt; lastPromptAt = now; send({ type: "speak", text: prompt }); } }
function metrics(f: Frame) {
  const visible = f.points.length === 17 && f.points.reduce((sum, p) => sum + p.score, 0) / Math.max(f.points.length, 1) > .4;
  if (!visible) return { visible, frame: false, view: false, prompt: "step forward" };
  const minY=Math.min(...f.points.map(p=>p.y)), maxY=Math.max(...f.points.map(p=>p.y)), personHeight=maxY-minY;
  const nearEdge=f.points.some(p=>p.x<.03||p.x>.97||p.y<.03||p.y>.97);
  const hips=mid(get(f,"left_hip"),get(f,"right_hip"));
  const frame=personHeight>=.6&&personHeight<=.8&&!nearEdge&&Math.abs(hips.x-.5)<=.1;
  const shoulders=mid(get(f,"left_shoulder"),get(f,"right_shoulder")), torso=distance(shoulders,hips);
  const ratio=distance(get(f,"left_shoulder"),get(f,"right_shoulder"))/torso;
  const nose=get(f,"nose"), noseOffset=Math.abs(nose.x-shoulders.x)/torso;
  const view=ratio>=.5&&ratio<=.8&&noseOffset<=.35;
  let prompt: string;
  if (personHeight < .6) prompt="step forward";
  else if (personHeight > .8 || nearEdge) prompt="step backward";
  else if (!view) prompt=nose.x>shoulders.x ? "turn to right" : "turn to left";
  else prompt=hips.x<.4 ? "turn to right" : "turn to left";
  return { visible, frame, view, prompt };
}
self.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
  if (data.type === "begin") { armed=true; completed=false; stableSince=0; lastPrompt=""; send({type:"state",label:"Finding V1 target",checks:{}}); return; }
  if (!armed || completed) return;
  const now=data.frame.at, result=metrics(data.frame), checks={ visible:result.visible, framing:result.frame, viewpoint:result.view };
  if (!result.visible || !result.frame || !result.view) { stableSince=0; say(result.prompt,now); send({type:"state",label:result.prompt,checks}); return; }
  stableSince ||= now;
  if (now-stableSince<1000) { send({type:"state",label:"Hold position",checks}); return; }
  completed=true; send({type:"state",label:"V1 ready",checks}); send({type:"speak",text:"Stop. Ready now."}); send({type:"ready"});
};
