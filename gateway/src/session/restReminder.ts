import { z } from 'zod';

export interface RestReminderConfig {
  firstAfterMs: number;
  everyMs: number;
  /** Sessions closer than this count as one continuous stretch (across characters). */
  continuityGapMs: number;
}

/** pacing.json restReminder. Lower bounds allow short thresholds for phone acceptance. */
export const RestReminderSchema = z.object({
  firstAfterMs: z.number().int().min(10_000).max(14_400_000),
  everyMs: z.number().int().min(10_000).max(14_400_000),
  continuityGapMs: z.number().int().min(1_000).max(3_600_000),
}).strict().refine((r) => r.everyMs >= r.firstAfterMs / 2, { message: 'restReminder.everyMs must be >= firstAfterMs / 2' });

/** First boundary strictly after `now`: since + firstAfterMs, then every everyMs. */
export function nextReminderAt(continuousSince: number, now: number, cfg: RestReminderConfig): number {
  const first = continuousSince + cfg.firstAfterMs;
  if (now < first) return first;
  return first + (Math.floor((now - first) / cfg.everyMs) + 1) * cfg.everyMs;
}

export interface RestReminderClockDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** A boundary was reached; the Director decides when the line is actually spoken. */
  onDue: () => void;
}

/** One timer per session; calls onDue at every boundary until stopped. Holds no content. */
export class RestReminderClock {
  private handle: unknown = null;
  private stopped = false;

  constructor(
    private readonly continuousSince: number,
    private readonly cfg: RestReminderConfig,
    private readonly deps: RestReminderClockDeps,
  ) {}

  start(): void {
    this.arm(this.deps.now());
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) this.deps.clearTimer(this.handle);
    this.handle = null;
  }

  /** Schedules the boundary after `after`. A timer that fires early still moves to the next one. */
  private arm(after: number): void {
    if (this.stopped) return;
    const dueAt = nextReminderAt(this.continuousSince, after, this.cfg);
    this.handle = this.deps.setTimer(() => {
      this.handle = null;
      if (this.stopped) return;
      this.deps.onDue();
      this.arm(Math.max(this.deps.now(), dueAt));
    }, Math.max(0, dueAt - this.deps.now()));
  }
}
