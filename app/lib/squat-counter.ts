/**
 * Squat rep counter driven purely by the motion sensor (accelerometer).
 *
 * Pipeline per sample:
 *   1. Estimate gravity with a slow per-axis EMA (seeded from the first
 *      sample, so there is no convergence transient on Start).
 *   2. Take linear acceleration along the gravity-dominant axis, sign-flipped
 *      so "up" is always positive — the vertical motion channel, robust to
 *      phone orientation.
 *   3. Band-pass via fast EMA minus slow EMA: each squat becomes an
 *      oscillation centered on zero; sustained 1.5Hz+ content (walking,
 *      shaking) is attenuated below the counting floor.
 *   4. Local maxima are confirmed as lobes once safely in the past.
 *   5. A lobe is kept when it is tall enough (adaptive threshold), at least
 *      0.9 s after the previous lobe (chatter gate), and a deep valley
 *      happened since the last counted rep (one full oscillation per count).
 *   6. Lobes with no deep valley between them belong to the same rep
 *      (bottom-turnaround spike + ascent); the tallest wins, the rep counts
 *      once. A deep valley after the candidate finalizes the rep.
 *   7. Arming: the first finalized rep only arms; the second inside the
 *      cadence window retro-counts both. A long pause disarms (set ended).
 *      Candidates that never see their closing valley (timeout) are
 *      discarded, never counted.
 */

export interface MotionSample {
  /** seconds, monotonic (e.g. performance.now() / 1000) */
  t: number;
  ax: number;
  ay: number;
  az: number;
}

export interface SquatCounterOptions {
  gravityTau?: number; // s, default 0.8
  fastTau?: number; // s, default 0.25
  slowTau?: number; // s, default 0.8
  minPeakValue?: number; // m/s^2, default 0.7
  adaptFactor?: number; // default 0.35
  adaptWindowSec?: number; // default 8
  valleyFraction?: number; // default 0.4 (lobe validation)
  finalizeValleyFraction?: number; // default 0.5 (rep-closing valley)
  lobeSpacingSec?: number; // default 0.9 (chatter gate)
  minPeriodSec?: number; // default 1.2 (arming)
  maxPeriodSec?: number; // default 8 (arming / disarm)
  finalizeTimeoutSec?: number; // default 2.5
  historySec?: number; // default 12
}

export type CounterPhase = "idle" | "armed" | "counting";

export interface RepEvent {
  t: number;
  value: number;
}

const D = {
  gravityTau: 0.8,
  fastTau: 0.25,
  slowTau: 0.8,
  minPeakValue: 0.7,
  adaptFactor: 0.35,
  adaptWindowSec: 8,
  valleyFraction: 0.4,
  finalizeValleyFraction: 0.5,
  lobeSpacingSec: 0.9,
  minPeriodSec: 1.2,
  maxPeriodSec: 8,
  finalizeTimeoutSec: 2.5,
  historySec: 12,
};

export class SquatCounter {
  count = 0;
  phase: CounterPhase = "idle";
  repTimes: number[] = [];
  /** scrolling signal history for the chart: band-passed vertical accel */
  history: { t: number; x: number }[] = [];
  onRep: ((rep: RepEvent, count: number) => void) | null = null;

  private o: Required<SquatCounterOptions>;
  private g = [0, 0, 0];
  private fast = 0;
  private slow = 0;
  private axis = 1;
  private lastT = -1;
  private initialized = false;
  private trackMaxV = -Infinity;
  private trackMaxT = -1;

  private candidateT = -1;
  private candidateV = 0;
  private lastLobeT = -1;
  private lastValleyT = -Infinity;
  private lastCountT = -1;
  private peakVals: { t: number; v: number }[] = [];
  private pendingT = -1;
  private pendingV = 0;

  constructor(opts: SquatCounterOptions = {}) {
    this.o = { ...D, ...opts };
  }

  reset() {
    this.count = 0;
    this.phase = "idle";
    this.repTimes = [];
    this.history = [];
    this.g = [0, 0, 0];
    this.fast = 0;
    this.slow = 0;
    this.axis = 1;
    this.lastT = -1;
    this.initialized = false;
    this.trackMaxV = -Infinity;
    this.trackMaxT = -1;
    this.candidateT = -1;
    this.candidateV = 0;
    this.lastLobeT = -1;
    this.lastValleyT = -Infinity;
    this.lastCountT = -1;
    this.peakVals = [];
    this.pendingT = -1;
    this.pendingV = 0;
  }

  /** cadence in reps/min from the last few intervals, 0 when unknown */
  cadence(): number {
    const n = this.repTimes.length;
    if (n < 2) return 0;
    const k = Math.min(n, 6);
    const dt = this.repTimes[n - 1] - this.repTimes[n - k];
    return dt > 0 ? (60 * (k - 1)) / dt : 0;
  }

  push(s: MotionSample) {
    const o = this.o;
    const dt = this.lastT < 0 ? 1 / 60 : Math.min(Math.max(s.t - this.lastT, 1 / 240), 0.5);
    this.lastT = s.t;
    const raw = [s.ax, s.ay, s.az];

    // 1. gravity estimate, seeded from the first sample
    if (!this.initialized) {
      this.g = [raw[0], raw[1], raw[2]];
      this.fast = 0;
      this.slow = 0;
      this.initialized = true;
    }
    const ag = dt / (o.gravityTau + dt);
    for (let i = 0; i < 3; i++) this.g[i] += ag * (raw[i] - this.g[i]);

    // 2. dominant axis with hysteresis; sign-flip so up is positive
    let best = this.axis;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(this.g[i]) > Math.abs(this.g[best]) * (i === this.axis ? 1 : 1.15)) best = i;
    }
    this.axis = best;
    const up = this.g[this.axis] >= 0 ? 1 : -1;
    const vert = up * (raw[this.axis] - this.g[this.axis]);

    // 3. band-pass: fast EMA minus slow EMA
    const af = dt / (o.fastTau + dt);
    const as = dt / (o.slowTau + dt);
    this.fast += af * (vert - this.fast);
    this.slow += as * (vert - this.slow);
    const x = this.fast - this.slow;

    this.history.push({ t: s.t, x });
    while (this.history.length && s.t - this.history[0].t > o.historySec) this.history.shift();

    const thresh = this.threshold(s.t);
    if (x < -thresh * o.valleyFraction) this.lastValleyT = s.t;

    // 6. finalize a pending candidate: deep valley after it = rep over;
    //    no valley for a while = it never completed -> discard
    if (this.candidateT > 0) {
      const age = s.t - this.candidateT;
      if (age > 0.35 && x < -thresh * o.finalizeValleyFraction) {
        this.finalizeCandidate();
      } else if (age > o.finalizeTimeoutSec) {
        this.candidateT = -1; // incomplete rep: drop it, count nothing
      }
    }

    // 4. lobe confirmation: track the running max; when the signal drops
    //    a hysteresis below it, the hump is over -> confirm it exactly once.
    //    (A global window-max would let a tall hump shadow its neighbors.)
    const hyst = Math.max(0.25, 0.3 * thresh);
    if (x > this.trackMaxV) {
      this.trackMaxV = x;
      this.trackMaxT = s.t;
    } else if (
      this.trackMaxT > 0 &&
      this.trackMaxV - x > hyst &&
      s.t - this.trackMaxT > 0.15 &&
      this.trackMaxT > this.lastLobeT
    ) {
      const pt = this.trackMaxT;
      const pv = this.trackMaxV;
      this.trackMaxV = x;
      this.trackMaxT = s.t;
      this.considerLobe(pt, pv, s.t);
    }
  }

  private threshold(now: number): number {
    const o = this.o;
    while (this.peakVals.length && now - this.peakVals[0].t > o.adaptWindowSec) this.peakVals.shift();
    let mx = 0;
    for (const p of this.peakVals) mx = Math.max(mx, p.v);
    return Math.max(o.minPeakValue, o.adaptFactor * mx);
  }

  /** 5. lobe validation + merge into the pending rep candidate */
  private considerLobe(t: number, v: number, now: number) {
    const o = this.o;
    const thresh = this.threshold(now);
    if (v < thresh) return;
    // one full oscillation per count: a deep valley since the last rep
    if (!(this.lastCountT < 0 || this.lastValleyT > this.lastCountT)) return;
    // chatter gate: ignore lobes too close to the previous one
    if (this.lastLobeT > 0 && t - this.lastLobeT < o.lobeSpacingSec) return;
    this.lastLobeT = t;
    // merge: no deep valley between this lobe and the pending candidate
    // means same rep -> keep the tallest
    if (this.candidateT < 0 || v > this.candidateV) {
      this.candidateT = t;
      this.candidateV = v;
    }
  }

  private currentRefractory(): number {
    const n = this.repTimes.length;
    if (n >= 3) {
      const iv: number[] = [];
      for (let i = Math.max(1, n - 3); i < n; i++) iv.push(this.repTimes[i] - this.repTimes[i - 1]);
      iv.sort((a, b) => a - b);
      const med = iv[Math.floor(iv.length / 2)];
      return Math.min(3.0, Math.max(0.8, 0.5 * med));
    }
    return 1.2;
  }

  private finalizeCandidate() {
    const o = this.o;
    const t = this.candidateT;
    const v = this.candidateV;
    this.candidateT = -1;
    const thresh = this.threshold(t);
    if (v < thresh) return;
    this.peakVals.push({ t, v });

    if (this.phase === "counting") {
      const lastR = this.repTimes[this.repTimes.length - 1];
      if (t - lastR > o.maxPeriodSec) {
        this.phase = "idle"; // set ended; fall through to re-arm
      } else if (t - lastR >= this.currentRefractory()) {
        this.register(t, v);
        return;
      } else {
        return; // too soon after the last rep: drop
      }
    }
    // 7. arming: two finalized reps inside the cadence window
    if (this.pendingT > 0) {
      const dtp = t - this.pendingT;
      if (dtp >= o.minPeriodSec && dtp <= o.maxPeriodSec) {
        this.phase = "counting";
        this.register(this.pendingT, this.pendingV);
        this.register(t, v);
      } else {
        this.pendingT = t;
        this.pendingV = v;
      }
    } else {
      this.pendingT = t;
      this.pendingV = v;
    }
    if (this.phase !== "counting") this.phase = this.pendingT > 0 ? "armed" : "idle";
  }

  private register(t: number, v: number) {
    this.count += 1;
    this.lastCountT = t;
    this.repTimes.push(t);
    while (this.repTimes.length && t - this.repTimes[0] > this.o.historySec) this.repTimes.shift();
    if (this.onRep) this.onRep({ t, value: v }, this.count);
  }
}
