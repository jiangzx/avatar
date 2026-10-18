export type ToolTurnEnd =
  | 'continuation_audio'
  | 'continuation_silent'
  | 'cancelled'
  | 'rebuild'
  | 'user_speaking'
  | 'timeout';

/**
 * One tool turn, from the origin reply until the continuation ends.
 * Timeouts are observed by tick() against the injected clock.
 */
export class ToolTurn {
  private turnActive = false;
  private sawOriginAudio = false;
  private originDone = false;
  private originPlaybackEnded = false;
  private continuationRequested = false;
  private continuationStarted = false;
  private originSeq: number | null = null;
  private startedAt = 0;

  constructor(
    private readonly now: () => number,
    private readonly timeoutMs: number,
  ) {}

  get active(): boolean {
    return this.turnActive;
  }

  start(originSeq: number): void {
    // A nested call keeps the first deadline.
    if (this.turnActive) return;
    this.reset();
    this.turnActive = true;
    this.originSeq = originSeq;
    this.startedAt = this.now();
  }

  onOriginAudio(): void {
    if (!this.turnActive) return;
    this.sawOriginAudio = true;
  }

  onOriginDone(): void {
    if (!this.turnActive) return;
    this.originDone = true;
  }

  onOriginPlaybackEnded(): void {
    if (this.originSeq === null) return;
    this.originPlaybackEnded = true;
  }

  /** Origin reply is done, and any audio it produced has played out. */
  readyForContinuation(): boolean {
    if (!this.turnActive || this.originSeq === null || !this.originDone) return false;
    return !this.sawOriginAudio || this.originPlaybackEnded;
  }

  /** Marks the continuation request. Does not mean the model has replied. */
  onContinuationRequested(): void {
    if (!this.turnActive) return;
    this.continuationRequested = true;
  }

  /** Marks the first continuation audio or done. Does not end the turn. */
  onContinuationStarted(): void {
    if (!this.turnActive) return;
    this.continuationStarted = true;
  }

  onContinuationAudio(): ToolTurnEnd | null {
    if (!this.turnActive) return null;
    // Requested marks the ask; started marks the model's first event. Either may come first.
    if (!this.continuationRequested && !this.continuationStarted) return null;
    return this.finish('continuation_audio');
  }

  onContinuationDone(hasAudio: boolean): ToolTurnEnd | null {
    if (!this.turnActive) return null;
    return this.finish(hasAudio ? 'continuation_audio' : 'continuation_silent');
  }

  onCancel(): ToolTurnEnd | null {
    if (!this.turnActive) return null;
    return this.finish('cancelled');
  }

  onRebuild(): ToolTurnEnd | null {
    if (!this.turnActive) return null;
    return this.finish('rebuild');
  }

  onUserSpeaking(): ToolTurnEnd | null {
    if (!this.turnActive) return null;
    return this.finish('user_speaking');
  }

  tick(): ToolTurnEnd | null {
    if (!this.turnActive) return null;
    if (this.now() - this.startedAt < this.timeoutMs) return null;
    return this.finish('timeout');
  }

  private finish(reason: ToolTurnEnd): ToolTurnEnd {
    this.reset();
    return reason;
  }

  private reset(): void {
    this.turnActive = false;
    this.sawOriginAudio = false;
    this.originDone = false;
    this.originPlaybackEnded = false;
    this.continuationRequested = false;
    this.continuationStarted = false;
    this.originSeq = null;
    this.startedAt = 0;
  }
}
