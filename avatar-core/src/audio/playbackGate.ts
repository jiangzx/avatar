/** Decides which response's audio may be played. Guarantees no stale audio after cancel/resume. */
export class PlaybackGate {
  private activeSeq: number | null = null;
  private readonly cancelledSeqs = new Set<number>();
  private floor = 0;

  get active(): number | null {
    return this.activeSeq;
  }

  start(seq: number): void {
    if (seq <= this.floor || this.cancelledSeqs.has(seq)) return;
    this.activeSeq = seq;
  }

  accepts(seq: number): boolean {
    return seq === this.activeSeq && seq > this.floor && !this.cancelledSeqs.has(seq);
  }

  cancel(seq: number): void {
    this.cancelledSeqs.add(seq);
    if (this.activeSeq === seq) this.activeSeq = null;
  }

  finish(seq: number): void {
    if (this.activeSeq === seq) this.activeSeq = null;
  }

  resetBelow(lastSeq: number): void {
    this.floor = Math.max(this.floor, lastSeq);
    this.activeSeq = null;
  }

  /** New gateway session: sequence numbers start again from 1. */
  reset(): void {
    this.activeSeq = null;
    this.cancelledSeqs.clear();
    this.floor = 0;
  }
}
