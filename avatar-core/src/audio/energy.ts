import { rmsInt16 } from './pcm.ts';

/** Counts sustained loud segments. Used by the AEC spike to compare capture paths A and B. */
export class EnergyTrigger {
  count = 0;
  private aboveMs = 0;
  private armed = true;

  constructor(
    private readonly thresholdRms = 1200,
    private readonly minMs = 150,
    private readonly frameMs = 20,
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
