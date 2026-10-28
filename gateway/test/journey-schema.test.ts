import { describe, expect, it } from 'vitest';
import { SimClock } from '../src/eval/simClock.ts';
import { DAY_MS, parseJourneys, sessionStartAt } from '../src/eval/journey.ts';

const journey = (overrides: Record<string, unknown> = {}) => ({
  id: 'checkup-week',
  title: '复查前后',
  character: 'xiaonuan',
  start: '2026-11-02',
  sessions: [
    { day: 0, time: '09:00', turns: ['你好'] },
    { day: 2, time: '19:30', turns: ['我回来了'], note: '事件后回访' },
  ],
  ...overrides,
});

describe('SimClock', () => {
  it('jumps to a time and keeps ticking with the base clock', () => {
    let base = 1_000;
    const clock = new SimClock(() => base);
    expect(clock.now()).toBe(1_000);
    clock.setTo(5_000_000);
    expect(clock.now()).toBe(5_000_000);
    base += 250;
    expect(clock.now()).toBe(5_000_250);
    const unbound = clock.now;
    expect(unbound()).toBe(5_000_250);
  });
});

describe('journey scripts', () => {
  it('parses a valid journey and defaults nothing silently', () => {
    const [j] = parseJourneys([journey()]);
    expect(j!.sessions[1]!.note).toBe('事件后回访');
    expect(j!.sessions[0]!.character).toBeUndefined();
  });

  it('computes the Asia/Shanghai wall time of a session', () => {
    const [j] = parseJourneys([journey()]);
    expect(sessionStartAt(j!, j!.sessions[0]!)).toBe(Date.parse('2026-11-02T09:00:00+08:00'));
    expect(sessionStartAt(j!, j!.sessions[1]!)).toBe(Date.parse('2026-11-02T19:30:00+08:00') + 2 * DAY_MS);
  });

  it('rejects sessions that are not in strictly increasing time order', () => {
    expect(() => parseJourneys([journey({ sessions: [
      { day: 1, time: '09:00', turns: ['a'] },
      { day: 1, time: '09:00', turns: ['b'] },
    ] })])).toThrow(/strictly increasing/);
    expect(() => parseJourneys([journey({ sessions: [
      { day: 2, time: '09:00', turns: ['a'] },
      { day: 1, time: '23:00', turns: ['b'] },
    ] })])).toThrow(/strictly increasing/);
  });

  it('rejects duplicate ids, unknown characters, bad times and unknown keys', () => {
    expect(() => parseJourneys([journey(), journey()])).toThrow(/duplicate journey id/);
    expect(() => parseJourneys([journey({ character: 'lily' })])).toThrow();
    expect(() => parseJourneys([journey({ sessions: [{ day: 0, time: '24:00', turns: [] }, { day: 1, time: '09:00', turns: [] }] })])).toThrow();
    expect(() => parseJourneys([journey({ extra: 1 })])).toThrow();
    expect(() => parseJourneys([journey({ start: '2026-13-40' })])).toThrow(/start/);
  });

  it('allows a session where the user says nothing and only listens', () => {
    const [j] = parseJourneys([journey({ sessions: [
      { day: 0, time: '09:00', turns: [] , silenceAfterMs: 40_000 },
      { day: 1, time: '09:00', turns: ['在呢'] },
    ] })]);
    expect(j!.sessions[0]!.turns).toEqual([]);
  });
});
