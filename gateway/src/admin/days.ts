import type { AdminRange } from '@anyidea/protocol';

/** China has had no DST since 1991, so a fixed +08:00 equals Asia/Shanghai and needs no tz data (SQLite has none). */
export const SHANGHAI_OFFSET_MS = 28_800_000;
export const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<AdminRange, number> = { today: 1, '7d': 7, '30d': 30 };

export function shanghaiDay(ts: number): string {
  return new Date(ts + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function shanghaiDayStart(ts: number): number {
  return Math.floor((ts + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
}

export interface RangeBounds { from: number; to: number; prevFrom: number; prevTo: number; days: string[] }

/** [from, to) with `to` just after now; prev is the same span one range earlier. */
export function rangeBounds(range: AdminRange, now: number): RangeBounds {
  const n = RANGE_DAYS[range];
  const from = shanghaiDayStart(now) - (n - 1) * DAY_MS;
  const to = now + 1;
  return {
    from, to,
    prevFrom: from - n * DAY_MS,
    prevTo: to - n * DAY_MS,
    days: Array.from({ length: n }, (_, i) => shanghaiDay(from + i * DAY_MS)),
  };
}

/** Same cut as shanghaiDay(); integer division drops milliseconds. */
export function sqlShanghaiDay(column: string): string {
  return `strftime('%Y-%m-%d', (${column} + ${SHANGHAI_OFFSET_MS}) / 1000, 'unixepoch')`;
}
