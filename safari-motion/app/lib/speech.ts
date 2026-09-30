// SpeechSynthesis audio cues for the motion client.
//
// Server-side the worker already throttles cues (>= 3.5 s apart, form
// correction at most once per two reps, priority form > pacing >
// encouragement). The client enforces the 3.5 s gap too, so a slow
// poll loop can never double-speak, and cancels a stale utterance before
// speaking the new one.

const MIN_GAP_MS = 3500;
let lastSpokeAt = 0;

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  const s = window.speechSynthesis;
  return s ?? null;
}

/**
 * Unlock speech on iOS: call from the Start tap gesture. iOS Safari
 * refuses to speak until speechSynthesis is used inside a user gesture.
 */
export function unlockSpeech(): void {
  try {
    const s = synth();
    if (!s) return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    s.speak(u);
  } catch {
    /* speech unsupported: cues stay visual */
  }
}

/** Speak a cue if the 3.5 s gap has cleared. Returns true when spoken. */
export function speakCue(text: string): boolean {
  try {
    const s = synth();
    if (!s) return false;
    const now = Date.now();
    if (now - lastSpokeAt < MIN_GAP_MS) return false;
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    s.speak(u);
    lastSpokeAt = now;
    return true;
  } catch {
    return false;
  }
}

export function stopSpeech(): void {
  try {
    synth()?.cancel();
  } catch {
    /* ignore */
  }
}
