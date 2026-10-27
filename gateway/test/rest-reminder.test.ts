import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@anyidea/protocol';
import { loadI18n } from '../src/i18n/load.ts';
import { loadPacing } from '../src/session/pacing.ts';
import { RestReminderClock, nextReminderAt, type RestReminderConfig } from '../src/session/restReminder.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const HOUR = 3_600_000;
const cfg: RestReminderConfig = { firstAfterMs: HOUR, everyMs: HOUR, continuityGapMs: 600_000 };

/** Injected timers: the clock never touches real time. */
function manualTimers(start = 0) {
  let now = start;
  let nextId = 1;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const first = timers[0];
        if (!first || first.at > end) break;
        timers.shift();
        now = first.at;
        first.fn();
      }
      now = end;
    },
    pending: () => timers.length,
  };
}

describe('nextReminderAt', () => {
  it('returns the first boundary, then every interval, always strictly after now', () => {
    expect(nextReminderAt(0, 0, cfg)).toBe(HOUR);
    expect(nextReminderAt(0, HOUR - 1, cfg)).toBe(HOUR);
    expect(nextReminderAt(0, HOUR, cfg)).toBe(2 * HOUR);
    expect(nextReminderAt(0, 1.5 * HOUR, cfg)).toBe(2 * HOUR);
    expect(nextReminderAt(0, HOUR, { ...cfg, everyMs: HOUR / 2 })).toBe(1.5 * HOUR);
  });

  it('counts from the start of the continuous stretch, across sessions', () => {
    const now = 10 * HOUR;
    expect(nextReminderAt(now - 59 * 60_000, now, cfg)).toBe(now + 60_000);
  });
});

describe('RestReminderClock', () => {
  it('fires at each boundary and stops cleanly', () => {
    const timers = manualTimers(0);
    let due = 0;
    const clock = new RestReminderClock(-50 * 60_000, cfg, { ...timers, onDue: () => { due++; } });
    clock.start();
    timers.advance(10 * 60_000 - 1);
    expect(due).toBe(0);
    timers.advance(1);
    expect(due).toBe(1);
    timers.advance(HOUR);
    expect(due).toBe(2);
    clock.stop();
    expect(timers.pending()).toBe(0);
    timers.advance(5 * HOUR);
    expect(due).toBe(2);
  });

  it('moves to the next boundary when a timer runs early, instead of firing the same one again', () => {
    let now = 0;
    const queue: Array<() => void> = [];
    const delays: number[] = [];
    let due = 0;
    const clock = new RestReminderClock(0, cfg, {
      now: () => now,
      setTimer: (fn, ms) => { queue.push(fn); delays.push(ms); return queue.length; },
      clearTimer: () => {},
      onDue: () => { due++; },
    });
    clock.start();
    expect(delays).toEqual([HOUR]);
    now = HOUR - 1; // the timer fires 1 ms early
    queue.shift()!();
    expect(due).toBe(1);
    expect(delays).toEqual([HOUR, HOUR + 1]); // the 2 h boundary, not 1 ms later
    clock.stop();
  });
});

describe('restReminder config', () => {
  it('ships one-hour reminders with a ten-minute continuity gap', () => {
    expect(loadPacing(join(root, 'config/pacing.json')).restReminder).toEqual({
      firstAfterMs: 3_600_000, everyMs: 3_600_000, continuityGapMs: 600_000,
    });
  });

  it('rejects a missing block, bad ranges, extra keys, and everyMs below half of firstAfterMs', () => {
    const shipped = JSON.parse(readFileSync(join(root, 'config/pacing.json'), 'utf8')) as Record<string, unknown>;
    const dir = mkdtempSync(join(tmpdir(), 'rest-'));
    const write = (restReminder: unknown) => {
      const next: Record<string, unknown> = { ...shipped, restReminder };
      if (restReminder === undefined) delete next.restReminder;
      writeFileSync(join(dir, 'pacing.json'), JSON.stringify(next));
    };
    for (const restReminder of [
      undefined,
      { firstAfterMs: 3_600_000, everyMs: 1_799_999, continuityGapMs: 600_000 },
      { firstAfterMs: 9_999, everyMs: 3_600_000, continuityGapMs: 600_000 },
      { firstAfterMs: 3_600_000, everyMs: 3_600_000, continuityGapMs: 0 },
      { firstAfterMs: 3_600_000, everyMs: 3_600_000, continuityGapMs: 600_000, extra: 1 },
    ]) {
      write(restReminder);
      expect(() => loadPacing(join(dir, 'pacing.json'))).toThrow();
    }
    write({ firstAfterMs: 60_000, everyMs: 30_000, continuityGapMs: 600_000 });
    expect(loadPacing(join(dir, 'pacing.json')).restReminder.everyMs).toBe(30_000);
  });
});

describe('restReminderText', () => {
  const i18n = loadI18n(join(root, 'config'));

  it('ships the appendix B zh line and a line in every language', () => {
    expect(i18n.memory.zh.restReminderText).toBe('咱们聊了一个钟头了，要不要起来活动活动、喝口水？我在这儿等您。');
    for (const language of LANGUAGES) expect(i18n.memory[language].restReminderText.length).toBeGreaterThan(0);
  });
});
