export type CancelSource = 'local' | 'model';

export interface InterruptDeps {
  cancel(seq: number, source: CancelSource): void;
  confirmWindowMs: number;
}

/**
 * Decides when an assistant response must be cancelled.
 * A response is "active" from response.start until the client reports playback ended.
 */
export class InterruptCoordinator {
  private activeSeq: number | null = null;
  private readonly cancelled = new Set<number>();
  private localSpeaking = false;
  private pending: NodeJS.Timeout | null = null;
  private falseCount = 0;

  constructor(private readonly deps: InterruptDeps) {}

  get isLocalSpeaking(): boolean {
    return this.localSpeaking;
  }

  get active(): number | null {
    return this.activeSeq;
  }

  get falseInterruptions(): number {
    return this.falseCount;
  }

  isCancelled(seq: number): boolean {
    return this.cancelled.has(seq);
  }

  /** Returns the previous response if it was still active (superseded); it is marked cancelled but not cancelled upstream. */
  onResponseStart(seq: number): number | null {
    this.clearPending();
    const previous = this.activeSeq;
    this.activeSeq = seq;
    if (previous === null || previous === seq || this.cancelled.has(previous)) return null;
    this.cancelled.add(previous);
    return previous;
  }

  onResponseFinished(seq: number): void {
    if (this.activeSeq !== seq) return;
    this.activeSeq = null;
    this.clearPending();
  }

  onLocalVad(speaking: boolean): void {
    this.localSpeaking = speaking;
    if (speaking && this.pending) {
      this.clearPending();
      this.cancelActive('model');
    }
  }

  onClientInterrupted(seq: number): void {
    if (seq === this.activeSeq) this.cancelActive('local');
  }

  onModelSpeechStarted(): void {
    if (this.activeSeq === null) return;
    if (this.localSpeaking) {
      this.cancelActive('model');
      return;
    }
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
    }, this.deps.confirmWindowMs);
  }

  /** The model cancelled on its own (auto-interrupt we could not disable). Returns false if already handled. */
  onModelAutoCancelled(seq: number): boolean {
    if (this.cancelled.has(seq)) return false;
    this.cancelled.add(seq);
    if (!this.localSpeaking) this.falseCount++;
    if (this.activeSeq === seq) this.activeSeq = null;
    return true;
  }

  cancelActive(source: CancelSource): void {
    const seq = this.activeSeq;
    if (seq === null || this.cancelled.has(seq)) return;
    this.cancelled.add(seq);
    this.activeSeq = null;
    this.deps.cancel(seq, source);
  }

  dispose(): void {
    this.clearPending();
  }

  private clearPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending);
    this.pending = null;
  }
}
