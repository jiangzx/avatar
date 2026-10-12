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
    const bright = clamp01((f.zcr - 0.08) / 0.12);
    const dark = clamp01((0.06 - f.zcr) / 0.04);
    return { jawOpen: this.jaw * 0.7, funnel: this.jaw * dark * 0.6, stretch: this.jaw * bright * 0.5 };
  }

  reset(): void {
    this.jaw = 0;
  }
}
