// LogStore dual-mode test: memory fallback vs R2-like backend.
// Run:  npx tsc && node scripts/test-logstore.mjs
import { strict as assert } from "node:assert";
import { LogStore } from "../dist/logstore.js";
import { createSession } from "../dist/session.js";

function fakeR2() {
  const m = new Map();
  return {
    _map: m,
    put: async (k, v) => {
      m.set(k, v);
    },
    get: async (k) =>
      m.has(k) ? { text: async () => (typeof m.get(k) === "string" ? m.get(k) : "") } : null,
    list: async () => ({ objects: [...m.keys()].map((key) => ({ key })) }),
  };
}

function makeSession() {
  const s = createSession("squat", 3);
  s.reps = 2;
  s.rep_history = [
    { n: 1, form: "good", motion: "consistent", period_s: 3.5, min_knee: 100, ts: 1 },
    { n: 2, form: "poor", motion: "too fast", period_s: 2.4, min_knee: 168, ts: 2 },
  ];
  s.poor_flags = [
    {
      rep: 2,
      step: 2,
      step_name: "squat.down",
      annotation: "rep 2 step 2: depth short (knee 168° vs <150° truth)",
      frame_id: "f-42",
      ts: 2,
    },
  ];
  s.last_jpeg = Buffer.from("fakejpeg").toString("base64");
  s.status = "ended";
  s.ended_at = s.created_at + 125000;
  return s;
}

function checkMarkdown(md, label) {
  assert.ok(md.includes("# Workout"), `${label}: title`);
  assert.ok(md.includes("— Squat"), `${label}: exercise`);
  assert.ok(md.includes("Reps: 2"), `${label}: rep count`);
  assert.ok(md.includes("1 good / 0 fair / 1 poor"), `${label}: form counts`);
  assert.ok(md.includes("depth short"), `${label}: poor-form annotation`);
  assert.ok(md.includes("not professional coaching"), `${label}: disclaimer`);
  console.log(`ok - ${label} markdown matches plan §10`);
}

// memory mode
const memStore = LogStore.fromEnv({});
assert.equal(memStore.mode, "memory");
const s1 = makeSession();
const { key: key1 } = await memStore.save(s1);
assert.match(key1, /^\d{4}-\d{2}-\d{2}-[a-z0-9]{6}\.md$/);
const md1 = memStore.getMemoryMarkdown(key1);
checkMarkdown(md1, "memory");
const listed1 = await memStore.list(10);
assert.ok(listed1.some((l) => l.key === key1 && l.reps === 2), "memory: list");
console.log("ok - memory list_workout_logs");

// R2 mode (fake)
const r2 = fakeR2();
const r2Store = new LogStore(r2);
assert.equal(r2Store.mode, "r2");
const s2 = makeSession();
const { key: key2 } = await r2Store.save(s2);
assert.equal(key1 === key2, false); // different session ids
const md2 = await r2.get(key2).then((o) => o.text());
checkMarkdown(md2, "r2");
assert.ok(md2.includes("poor-form.jpg"), "r2: markdown references stored jpeg");
assert.ok(!md1.includes("poor-form.jpg"), "memory: no image refs without R2");
assert.equal(
  md2.replace(/ → \S+poor-form\.jpg/g, ""),
  md1,
  "both modes produce identical markdown apart from image refs",
);
const imgKeys = [...r2._map.keys()].filter((k) => k.endsWith(".jpg"));
assert.equal(imgKeys.length, 1, "r2: poor-form jpeg stored");
const listed2 = await r2Store.list(10);
assert.ok(listed2.some((l) => l.key === key2 && l.exercise === "squat"), "r2: list via sidecar");
console.log("ok - r2 list_workout_logs (metadata sidecar)");

// forced memory even with a binding present
const forced = LogStore.fromEnv({ WORKOUT_LOGS: r2, FORCE_MEMORY_STORE: "1" });
assert.equal(forced.mode, "memory");
console.log("ok - FORCE_MEMORY_STORE=1 overrides binding");

console.log("\nALL LOGSTORE CHECKS PASSED");
