/**
 * quack.ts — the alert sound. A duck quack synthesized with WebAudio (no audio
 * asset needed): a sawtooth burst swept downward through a nasal bandpass
 * formant, repeated a few times.
 *
 * Browsers block audio until a user gesture, so `ensureAudio()` is also called
 * from the Alt+A keydown that creates an alert — that gesture unlocks the
 * AudioContext for later playback when the alert actually fires.
 */

let ctx: AudioContext | null = null;

export function ensureAudio(): void {
  if (!ctx) {
    try { ctx = new AudioContext(); } catch { return; }
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

function quackAt(c: AudioContext, t0: number): void {
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(310, t0);
  osc.frequency.exponentialRampToValueAtTime(185, t0 + 0.16);

  // Nasal "duck" formant + a lowpass to tame the sawtooth buzz.
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 950;
  bp.Q.value = 4;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2600;

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.015);
  g.gain.setValueAtTime(0.5, t0 + 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);

  osc.connect(bp); bp.connect(lp); lp.connect(g); g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + 0.2);
}

/** Quack `times` times (default: a classic triple quack). */
export function playQuack(times = 3): void {
  ensureAudio();
  if (!ctx) return;
  const t = ctx.currentTime + 0.02;
  for (let i = 0; i < times; i++) quackAt(ctx, t + i * 0.24);
}

// Per-alert fire dedupe: several panels can show the same symbol and would all
// detect the same cross within milliseconds — only the first one quacks.
const lastFired = new Map<string, number>();

export function shouldFire(id: string, minGapMs = 1500): boolean {
  const now = Date.now();
  if (now - (lastFired.get(id) ?? 0) < minGapMs) return false;
  lastFired.set(id, now);
  return true;
}
