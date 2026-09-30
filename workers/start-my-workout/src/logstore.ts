// Activity log: session markdown + metadata sidecars.
//
// Storage: R2 when the WORKOUT_LOGS binding is present (and not forced off),
// otherwise an in-memory Map (wrangler dev without an account). Both modes
// produce the identical markdown log per plan §10; poor-form jpegs are
// written to R2 only when a binding exists.

import { Session, PoorFlag } from "./session.js";
import { capitalize } from "./fusion.js";

export interface LogMeta {
  key: string;
  date: string; // YYYY-MM-DD
  exercise: string;
  rounds: number;
  reps: number;
  created_at: number;
}

/** Minimal R2 surface we use, so the store is unit-testable without Workers. */
export interface R2Like {
  put(key: string, value: string | Uint8Array): Promise<void>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(opts?: {
    limit?: number;
    cursor?: string | undefined;
  }): Promise<{
    objects: Array<{ key: string }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

function dateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function avg(nums: Array<number | null>): number | null {
  const xs = nums.filter((n): n is number => n !== null && n > 0);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Session markdown log, plan §10 format. */
export function buildSessionMarkdown(s: Session, imageRefs: string[]): string {
  const date = dateKey(s.created_at);
  const ended = s.ended_at ?? Date.now();
  const formCounts = { good: 0, fair: 0, poor: 0 };
  const motionCounts: Record<string, number> = {};
  for (const r of s.rep_history) {
    formCounts[r.form] += 1;
    motionCounts[r.motion] = (motionCounts[r.motion] ?? 0) + 1;
  }
  const motionParts = Object.entries(motionCounts).map(
    ([k, v]) => `${v} ${k}`,
  );
  const cad = avg(s.rep_history.map((r) => r.period_s));
  const cadenceLine =
    cad === null ? "n/a" : `${(Math.round(cad * 10) / 10).toFixed(1)} s/rep`;

  const lines: string[] = [
    `# Workout ${date} — ${capitalize(s.exercise)}`,
    ``,
    `Rounds: ${s.rounds} · Reps: ${s.reps} · Duration: ${fmtDuration(ended - s.created_at)}`,
    `Form: ${formCounts.good} good / ${formCounts.fair} fair / ${formCounts.poor} poor · Motion: ${motionParts.join(" / ") || "n/a"}`,
    `Avg cadence: ${cadenceLine}`,
  ];

  if (s.poor_flags.length > 0) {
    lines.push(``, `## Poor form`);
    s.poor_flags.forEach((f: PoorFlag, i: number) => {
      const img = imageRefs[i] ? ` → ${imageRefs[i]}` : "";
      lines.push(`- ${f.annotation}${img}`);
    });
  } else {
    lines.push(``, `## Poor form`, `- none flagged`);
  }

  lines.push(
    ``,
    `## Note`,
    `General fitness information only — not professional coaching.`,
    ``,
  );
  return lines.join("\n");
}

export class LogStore {
  private mem = new Map<string, { markdown: string; meta: LogMeta }>();

  constructor(private r2: R2Like | null) {}

  static fromEnv(env: {
    WORKOUT_LOGS?: unknown;
    FORCE_MEMORY_STORE?: string;
  }): LogStore {
    const forced = env.FORCE_MEMORY_STORE === "1";
    const r2 =
      !forced && env.WORKOUT_LOGS ? (env.WORKOUT_LOGS as R2Like) : null;
    return new LogStore(r2);
  }

  get mode(): "r2" | "memory" {
    return this.r2 ? "r2" : "memory";
  }

  /** Persist a finished session. Returns the log key and markdown. */
  async save(s: Session): Promise<{ key: string; markdown: string }> {
    const date = dateKey(s.created_at);
    const key = `${date}-${s.id}.md`;
    const metaKey = `${key}.meta.json`;

    // Poor-form jpegs go to R2 only (memory mode skips images; the markdown
    // still references the frame ids). P1 keeps only the latest jpeg in
    // memory, so we store that single image once alongside the flags.
    const imageRefs: string[] = [];
    if (this.r2 && s.last_jpeg && s.poor_flags.length > 0) {
      const imgKey = `${date}-${s.id}/poor-form.jpg`;
      const bin = Uint8Array.from(atob(s.last_jpeg), (c) => c.charCodeAt(0));
      await this.r2.put(imgKey, bin);
      imageRefs.push(...s.poor_flags.map(() => imgKey));
    }

    const markdown = buildSessionMarkdown(s, imageRefs);
    const meta: LogMeta = {
      key,
      date,
      exercise: s.exercise,
      rounds: s.rounds,
      reps: s.reps,
      created_at: s.created_at,
    };
    if (this.r2) {
      await this.r2.put(key, markdown);
      await this.r2.put(metaKey, JSON.stringify(meta));
    } else {
      this.mem.set(key, { markdown, meta });
    }
    return { key, markdown };
  }

  async list(limit = 20): Promise<LogMeta[]> {
    const metas: LogMeta[] = [];
    if (this.r2) {
      // R2 list() is lexicographic and paginated: walk pages with the
      // cursor until we have `limit` metas (sidecar .meta.json objects
      // share the listing, and newest keys sort last).
      let cursor: string | undefined;
      for (;;) {
        const res = await this.r2.list({ limit: 100, cursor });
        for (const o of res.objects) {
          if (!o.key.endsWith(".md") || o.key.endsWith(".meta.json")) continue;
          const m = await this.r2.get(o.key + ".meta.json");
          if (m) {
            try {
              metas.push(JSON.parse(await m.text()) as LogMeta);
            } catch {
              /* skip corrupt sidecar */
            }
          }
          if (metas.length >= limit) break;
        }
        if (metas.length >= limit || !res.truncated) break;
        cursor = res.cursor;
      }
    } else {
      for (const { meta } of this.mem.values()) metas.push(meta);
    }
    metas.sort((a, b) => b.created_at - a.created_at);
    return metas.slice(0, limit);
  }

  /** Dev/test helper: read back a stored markdown (memory mode). */
  getMemoryMarkdown(key: string): string | null {
    return this.mem.get(key)?.markdown ?? null;
  }
}
