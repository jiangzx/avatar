import type { UserFinal } from '../memory/store.ts';
import { runWithPolicy } from '../reliability/policy.ts';
import type { LedgerEntry } from './ledger.ts';

/** What a tool may read about the user's own words in its turn (spec §6). */
export interface TurnAccess {
  /** Resolves when this turn's user final has arrived; null on timeout or interruption. */
  currentFinal(timeoutMs: number): Promise<UserFinal | null>;
  /** The user final before this turn's, read from the ledger; null when unknown. */
  previousFinal(): UserFinal | null;
}

/** For tool calls outside a live session turn (unit tests, probes). */
export const NO_TURN: TurnAccess = {
  currentFinal: () => Promise.resolve(null),
  previousFinal: () => null,
};

interface SeenFinal extends UserFinal {
  /** False when dropUserFinals kept the line out of the ledger and the transcript. */
  inLedger: boolean;
}

type Waiter = (final: SeenFinal | null) => void;

/**
 * Session-side record of user finals. Qwen often sends the transcript after the tool call,
 * so a tool may have to wait for its own turn's final. Holds text in memory only; never logs it.
 */
export class TurnFinals {
  /** Final of the turn in progress; cleared where Session clears turnUserText. */
  private current: SeenFinal | null = null;
  /** Last two finals that entered the ledger, oldest first. */
  private readonly recent: SeenFinal[] = [];
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly ledger: () => readonly LedgerEntry[]) {}

  /** Every user final, stored or dropped. messageId is null when nothing was written. */
  onFinal(text: string, messageId: string | null, inLedger: boolean): void {
    const final: SeenFinal = { text, messageId, inLedger };
    this.current = final;
    if (inLedger) {
      this.recent.push(final);
      if (this.recent.length > 2) this.recent.shift();
    }
    this.settle(final);
  }

  /** The reply for this turn is over: the next tool call belongs to a new turn. */
  onTurnClosed(): void {
    this.current = null;
  }

  /** New utterance, rebuild, or session end: waiting tools get null instead of hanging. */
  interrupt(): void {
    this.settle(null);
  }

  /** Binds to the turn in progress at tool-call time. */
  access(): TurnAccess {
    let mine = this.current;
    return {
      currentFinal: async (timeoutMs) => {
        if (!mine) mine = await this.next(timeoutMs);
        return mine ? { text: mine.text, messageId: mine.messageId } : null;
      },
      previousFinal: () => (mine ? this.previousOf(mine) : null),
    };
  }

  /** Waits through the shared policy helper, so the timeout is logged like every other one. */
  private async next(timeoutMs: number): Promise<SeenFinal | null> {
    const box: { waiter?: Waiter } = {};
    const result = await runWithPolicy(
      'turn_final',
      { timeoutMs, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      () => new Promise<SeenFinal | null>((resolve) => {
        box.waiter = resolve;
        this.waiters.add(resolve);
      }),
    );
    if (box.waiter) this.waiters.delete(box.waiter);
    return result.ok ? result.value : null;
  }

  private settle(final: SeenFinal | null): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiting) resolve(final);
  }

  /** A stored final is the newest ledger user line, so previous is the one before it. */
  private previousOf(mine: SeenFinal): UserFinal | null {
    const users = this.ledger().filter((entry) => entry.role === 'user');
    const entry = users.at(mine.inLedger ? -2 : -1);
    if (!entry) return null;
    const match = [...this.recent].reverse().find((final) => final !== mine && final.text === entry.text);
    return { text: entry.text, messageId: match?.messageId ?? null };
  }
}
