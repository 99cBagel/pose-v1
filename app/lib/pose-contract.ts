export type Point = { name: string; x: number; y: number; score: number };
export type Frame = { at: number; width: number; height: number; points: Point[] };
export type WorkerMessage = { type: "begin" } | { type: "frame"; frame: Frame };
export type WorkerEvent = { type: "state"; label: string; checks: Record<string, boolean> } | { type: "speak"; text: string } | { type: "ready" };
