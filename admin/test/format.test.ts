import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatCount,
  formatDateTime,
  formatDayLabel,
  formatDuration,
  formatMoney,
  formatPercent,
  formatSeconds,
  formatTimeOfDay,
  formatYuan,
  rangeStart,
  shanghaiDay,
} from '../src/format.ts';

describe('money', () => {
  it('converts micro-yuan to yuan with two decimals', () => {
    expect(formatYuan(4_300_000)).toBe('4.30 元');
    expect(formatYuan(10_000)).toBe('0.01 元');
    expect(formatYuan(9_999)).toBe('不到 0.01 元');
    expect(formatYuan(0)).toBe('0 元');
  });

  it('says 未定价 instead of 0 when nothing was priced', () => {
    expect(formatMoney({ tokens: 900, costMicroYuan: 0, unpricedCalls: 3 })).toBe('未定价');
    expect(formatMoney({ tokens: 900, costMicroYuan: 4_300_000, unpricedCalls: 3 })).toBe('4.30 元（3 次未定价）');
    expect(formatMoney({ tokens: 900, costMicroYuan: 4_300_000, unpricedCalls: 0 })).toBe('4.30 元');
    expect(formatMoney({ tokens: 0, costMicroYuan: 0, unpricedCalls: 0 })).toBe('0 元');
  });
});

describe('numbers and durations', () => {
  it('formats counts with 万 above ten thousand', () => {
    expect(formatCount(8231)).toBe('8,231');
    expect(formatCount(412_000)).toBe('41.2 万');
    expect(formatCount(3_456_789)).toBe('346 万');
  });

  it('formats durations and seconds in plain Chinese', () => {
    expect(formatDuration(760_000)).toBe('12 分 40 秒');
    expect(formatDuration(42_000)).toBe('42 秒');
    expect(formatDuration(3_900_000)).toBe('1 小时 5 分');
    expect(formatSeconds(1100)).toBe('1.1 秒');
    expect(formatSeconds(2000)).toBe('2 秒');
    expect(formatSeconds(null)).toBe('—');
    expect(formatPercent(0.123)).toBe('12%');
    expect(formatClock(195_400)).toBe('3:15');
    expect(formatClock(0)).toBe('0:00');
  });
});

describe('dates in Asia/Shanghai', () => {
  // 2026-10-26T16:30:00Z is 2026-10-27 00:30 in Shanghai.
  const justAfterMidnight = Date.parse('2026-10-26T16:30:00Z');

  it('cuts days at Shanghai midnight', () => {
    expect(shanghaiDay(justAfterMidnight)).toBe('2026-10-27');
    expect(shanghaiDay(Date.parse('2026-10-26T15:59:00Z'))).toBe('2026-10-26');
  });

  it('labels today', () => {
    expect(formatDayLabel('2026-10-27', '2026-10-27')).toBe('10月27日（今天）');
    expect(formatDayLabel('2026-10-03', '2026-10-27')).toBe('10月3日');
  });

  it('formats a timestamp as month, day and 24h time', () => {
    expect(formatDateTime(Date.parse('2026-10-27T06:02:00Z'))).toBe('10月27日 14:02');
  });

  it('formats the time of day', () => {
    const ts = Date.parse('2026-10-27T06:02:31Z');
    expect(formatTimeOfDay(ts)).toBe('14:02');
    expect(formatTimeOfDay(ts, true)).toBe('14:02:31');
  });

  it('starts ranges at Shanghai midnight', () => {
    expect(rangeStart('today', justAfterMidnight)).toBe(Date.parse('2026-10-26T16:00:00Z'));
    expect(rangeStart('7d', justAfterMidnight)).toBe(Date.parse('2026-10-20T16:00:00Z'));
    expect(rangeStart('30d', justAfterMidnight)).toBe(Date.parse('2026-09-27T16:00:00Z'));
  });
});
