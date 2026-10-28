export interface PushRequest {
  /** Re-read and send the current instructions when flushed. */
  instructions?: boolean;
  /** Present = change voice; value undefined = adapter default. */
  voice?: { value: string | undefined };
}

export interface PushGateDeps {
  /** Session seam: slimSeamOpen() && !modelGenerating && !ended. */
  seamOpen: () => boolean;
  /** Called at most once per flush with the merged request. */
  send: (update: PushRequest) => void;
  now: () => number;
  minIntervalMs: number;
}

/**
 * Holds session changes until a safe seam (blockers #48: a session.update during a reply can
 * silence the next turn). Merges requests, sends at most one per user turn and per interval.
 */
export class PushGate {
  private pending: PushRequest | null = null;
  private lastSentAt: number | null = null;
  private pushedThisTurn = false;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly deps: PushGateDeps) {}

  get hasPending(): boolean {
    return this.pending !== null;
  }

  /** Merge into the pending update, then try to flush. */
  request(update: PushRequest): void {
    if (this.disposed || (!update.instructions && !update.voice)) return;
    const merged: PushRequest = { ...this.pending };
    if (update.instructions) merged.instructions = true;
    // Latest voice wins; instructions are re-read at send time.
    if (update.voice) merged.voice = { value: update.voice.value };
    this.pending = merged;
    this.flush();
  }

  /** Send the pending update if the seam is open, the interval has passed, and this turn has not pushed yet. */
  flush(): void {
    if (this.disposed || !this.pending || this.pushedThisTurn || !this.deps.seamOpen()) return;
    const waitMs = this.lastSentAt === null ? 0 : this.lastSentAt + this.deps.minIntervalMs - this.deps.now();
    if (waitMs > 0) {
      this.armTimer(waitMs);
      return;
    }
    const update = this.pending;
    this.pending = null;
    this.pushedThisTurn = true;
    this.lastSentAt = this.deps.now();
    this.clearTimer();
    this.deps.send(update);
  }

  /** A new user turn begins: allow one more push this turn. */
  onUserFinal(): void {
    this.pushedThisTurn = false;
  }

  /** Drop pending work (after a successful reconnect). The fresh session may take one push. */
  clearPending(): void {
    this.pending = null;
    this.pushedThisTurn = false;
    this.clearTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.clearTimer();
  }

  /** Retry when the interval ends; the seam is checked again then. */
  private armTimer(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
