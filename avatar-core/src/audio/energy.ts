import { rmsInt16 } from './pcm.ts';

// TUNABLE: defaults for the AEC spike energy trigger.
export const ENERGY_THRESHOLD_RMS = 1200;
export const ENERGY_MIN_MS = 150;
export const ENERGY_FRAME_MS = 20;

/** Counts sustained loud segments. Used by the AEC spike to compare capture paths A and B. */
export class EnergyTrigger {
  count = 0;
  private aboveMs = 0;
  private armed = true;

  constructor(
    private readonly thresholdRms = ENERGY_THRESHOLD_RMS,
    private readonly minMs = ENERGY_MIN_MS,
    private readonly frameMs = ENERGY_FRAME_MS,
  ) {}

  /** Returns true when a new trigger fires; re-arms after a quiet frame. */
  push(frame: Int16Array): boolean {
    if (rmsInt16(frame) >= this.thresholdRms) {
      this.aboveMs += this.frameMs;
      if (this.armed && this.aboveMs >= this.minMs) {
        this.armed = false;
        this.count++;
        return true;
      }
      return false;
    }
    this.aboveMs = 0;
    this.armed = true;
    return false;
  }
}
