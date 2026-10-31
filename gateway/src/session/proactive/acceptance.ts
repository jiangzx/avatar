// Q25 acceptance window. Opens when a scored line starts; runs from when it ends.
import type { ScoredKind } from './config.ts';

export type Verdict = 'light' | 'decline' | 'content';
export interface PendingLine { kind: ScoredKind; threadId?: string; topicKey?: string }
export interface Resolved { line: PendingLine; outcome: 'accepted' | 'rejected' }

export class AcceptanceTracker {
  private line: PendingLine | null = null;
  private endsAt: number | null = null;

  constructor(private readonly windowMs: number) {}

  get pending(): PendingLine | null {
    return this.line;
  }

  /** A new scored line; an unanswered previous one is rejected. */
  open(line: PendingLine): Resolved | null {
    const previous = this.flush();
    this.line = line;
    this.endsAt = null;
    return previous;
  }

  /** Playback ended or was cut: the window starts now. */
  ended(now: number): void {
    if (this.line && this.endsAt === null) this.endsAt = now + this.windowMs;
  }

  expire(now: number): Resolved | null {
    return this.line && this.endsAt !== null && now > this.endsAt ? this.flush() : null;
  }

  /** Light replies do not count and keep the window open. A barge-in (window not started) counts. */
  onUserFinal(now: number, verdict: Verdict): Resolved | null {
    const expired = this.expire(now);
    if (expired) return expired;
    if (!this.line || verdict === 'light') return null;
    const line = this.line;
    this.line = null;
    this.endsAt = null;
    return { line, outcome: verdict === 'decline' ? 'rejected' : 'accepted' };
  }

  /** No reply at all: rejected. */
  flush(): Resolved | null {
    if (!this.line) return null;
    const line = this.line;
    this.line = null;
    this.endsAt = null;
    return { line, outcome: 'rejected' };
  }
}
