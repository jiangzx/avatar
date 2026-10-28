/** Wall clock for multi-day evals: jumps to a scripted time, then keeps ticking with the real clock. */
export class SimClock {
  private offset = 0;

  constructor(private readonly base: () => number = Date.now) {}

  /** Arrow property so it can be passed as a bare `() => number` dependency. */
  readonly now = (): number => this.base() + this.offset;

  setTo(at: number): void {
    this.offset = at - this.base();
  }
}
