import { describe, expect, it } from 'vitest';
import { rangeBounds, shanghaiDay, shanghaiDayStart, sqlShanghaiDay } from '../src/admin/days.ts';
import { openDatabase } from '../src/memory/db.ts';

describe('Shanghai days', () => {
  it('cuts days at 00:00 +08:00', () => {
    expect(shanghaiDay(Date.parse('2026-10-27T23:59:59+08:00'))).toBe('2026-10-27');
    expect(shanghaiDay(Date.parse('2026-10-27T16:00:00Z'))).toBe('2026-10-28');
    expect(shanghaiDayStart(Date.parse('2026-10-27T12:00:00+08:00'))).toBe(Date.parse('2026-10-27T00:00:00+08:00'));
  });

  it('builds today / 7d / 30d ranges ending now', () => {
    const now = Date.parse('2026-10-27T12:00:00+08:00');
    const today = rangeBounds('today', now);
    expect(today.from).toBe(Date.parse('2026-10-27T00:00:00+08:00'));
    expect(today.to).toBe(now + 1);
    expect(today.prevFrom).toBe(Date.parse('2026-10-26T00:00:00+08:00'));
    expect(today.prevTo).toBe(now + 1 - 86_400_000);
    expect(today.days).toEqual(['2026-10-27']);
    const week = rangeBounds('7d', now);
    expect(week.from).toBe(Date.parse('2026-10-21T00:00:00+08:00'));
    expect(week.days).toHaveLength(7);
    expect(week.days.at(-1)).toBe('2026-10-27');
    expect(rangeBounds('30d', now).days[0]).toBe('2026-09-28');
  });

  it('matches the SQL expression', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    for (const ts of [Date.parse('2026-10-27T15:59:59Z'), Date.parse('2026-10-27T16:00:00Z'), Date.parse('2026-01-01T00:00:00+08:00')]) {
      const row = db.prepare(`SELECT ${sqlShanghaiDay('$ts')} AS day`).get({ ts }) as { day: string };
      expect(row.day).toBe(shanghaiDay(ts));
    }
  });
});
