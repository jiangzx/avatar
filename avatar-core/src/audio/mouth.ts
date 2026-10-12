import type { AudioFeatures } from './pcm.ts';

export interface MouthShape {
  jawOpen: number;
  /** Rounded lips (o/u). */
  funnel: number;
  /** Spread lips (i/e, fricatives). */
  stretch: number;
}

export interface MouthOptions {
  noiseFloor: number;
  gain: number;
  attackMs: number;
  releaseMs: number;
}

/** TUNABLE (estimates), tuned on device in Task 18. */
export const DEFAULT_MOUTH: MouthOptions = { noiseFloor: 0.01, gain: 6, attackMs: 30, releaseMs: 80 };

// TUNABLE: zcr band mapped to "bright" (spread lips) and "dark" (rounded lips).
export const ZCR_BRIGHT_START = 0.08;
export const ZCR_BRIGHT_RANGE = 0.12;
export const ZCR_DARK_START = 0.06;
export const ZCR_DARK_RANGE = 0.04;
// TUNABLE: mouth-shape gains applied to the smoothed jaw level.
export const JAW_OPEN_GAIN = 0.7;
export const FUNNEL_GAIN = 0.6;
export const STRETCH_GAIN = 0.5;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Approximate Mandarin lip-sync from loudness and brightness of the audio being played. */
export class MouthAnalyzer {
  private jaw = 0;

  constructor(private readonly o: MouthOptions = DEFAULT_MOUTH) {}

  update(f: AudioFeatures, dtMs: number): MouthShape {
    const target = clamp01((f.rms - this.o.noiseFloor) * this.o.gain);
    const tau = target > this.jaw ? this.o.attackMs : this.o.releaseMs;
    this.jaw += (target - this.jaw) * (1 - Math.exp(-dtMs / tau));
    if (this.jaw < 1e-4) this.jaw = 0;
    const bright = clamp01((f.zcr - ZCR_BRIGHT_START) / ZCR_BRIGHT_RANGE);
    const dark = clamp01((ZCR_DARK_START - f.zcr) / ZCR_DARK_RANGE);
    return { jawOpen: this.jaw * JAW_OPEN_GAIN, funnel: this.jaw * dark * FUNNEL_GAIN, stretch: this.jaw * bright * STRETCH_GAIN };
  }

  reset(): void {
    this.jaw = 0;
  }
}
