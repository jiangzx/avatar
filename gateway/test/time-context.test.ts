import { LANGUAGES } from '@anyidea/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import type { AffectCopy } from '../src/i18n/types.ts';
import { timeContext } from '../src/session/timeContext.ts';

const copy: AffectCopy = {
  lines: {
    crisis: 'C',
    mood: { low: 'L', sad: 'S', happy: 'H', love: 'V', neutral: 'N' },
    trend: { better: 'B', worse: 'W' },
    need: { vent: 'v', share_joy: 'j', help: 'h', chat: 'c', topic_exhausted: 'd' },
    strategy: { comfort: 'co', reflect: 're', affirm: 'af', ask: 'as', disclose: 'di', suggest: 'su' },
    mismatch: 'M',
    exhaustedHint: 'X',
    tail: 'T',
  },
  declinePhrases: [],
  solarTerms: [{ name: '霜降', month: 10, day: 23 }, { name: '冬至', month: 12, day: 22 }, { name: '小寒', month: 1, day: 5 }],
  seasons: { spring: '春天', summer: '夏天', autumn: '秋天', winter: '冬天' },
  timeOfDay: { morning: '早上', noon: '中午', afternoon: '下午', evening: '傍晚', night: '夜里' },
};
const SH = 'Asia/Shanghai';
/** UTC instant for a Shanghai wall-clock time (UTC+8, no DST). */
const shanghai = (month: number, day: number, hour: number, year = 2026) => Date.UTC(year, month - 1, day, hour - 8);

describe('timeContext', () => {
  it('buckets the local hour', () => {
    const at = (hour: number, day = 23) => timeContext(shanghai(10, day, hour), SH, 3, copy).timeOfDay;
    expect(at(4)).toBe('夜里');
    expect(at(5)).toBe('早上');
    expect(at(10)).toBe('早上');
    expect(at(11)).toBe('中午');
    expect(at(12)).toBe('中午');
    expect(at(13)).toBe('下午');
    expect(at(17)).toBe('下午');
    expect(at(18)).toBe('傍晚');
    expect(at(21)).toBe('傍晚');
    expect(at(22)).toBe('夜里');
    expect(at(23)).toBe('夜里');
  });

  it('reads the wall clock in the configured zone', () => {
    // 08:30 in Shanghai is 20:30 the evening before in New York (EDT in late October).
    const instant = shanghai(10, 23, 8) + 30 * 60_000;
    expect(timeContext(instant, SH, 3, copy).timeOfDay).toBe('早上');
    expect(timeContext(instant, 'America/New_York', 3, copy).timeOfDay).toBe('傍晚');
  });

  it('maps the local month to a season', () => {
    const season = (month: number) => timeContext(shanghai(month, 15, 12), SH, 0, copy).season;
    expect([1, 2, 12].map(season)).toEqual(['冬天', '冬天', '冬天']);
    expect([3, 4, 5].map(season)).toEqual(['春天', '春天', '春天']);
    expect([6, 7, 8].map(season)).toEqual(['夏天', '夏天', '夏天']);
    expect([9, 10, 11].map(season)).toEqual(['秋天', '秋天', '秋天']);
  });

  it('names a solar term only within the window, across the year boundary too', () => {
    expect(timeContext(shanghai(10, 23, 12), SH, 3, copy).solarTerm).toBe('霜降');
    expect(timeContext(shanghai(10, 26, 12), SH, 3, copy).solarTerm).toBe('霜降');
    const outside = timeContext(shanghai(10, 27, 12), SH, 3, copy);
    expect(outside.solarTerm).toBeUndefined();
    expect('solarTerm' in outside).toBe(false);
    expect(timeContext(shanghai(12, 31, 12), SH, 5, copy).solarTerm).toBe('小寒');
    expect(timeContext(shanghai(12, 31, 12), SH, 3, copy).solarTerm).toBeUndefined();
  });

  it('picks the nearest term when two are inside the window', () => {
    const near = { ...copy, solarTerms: [{ name: 'A', month: 10, day: 20 }, { name: 'B', month: 10, day: 24 }] };
    expect(timeContext(shanghai(10, 23, 12), SH, 3, near).solarTerm).toBe('B');
  });

  it('rejects an unknown time zone', () => {
    expect(() => timeContext(0, 'Not/AZone', 3, copy)).toThrow(RangeError);
  });

  it('returns localized words from the shipped copy of every language', () => {
    for (const language of LANGUAGES) {
      const shipped = DEFAULT_I18N.affect[language];
      const result = timeContext(shanghai(10, 23, 15), SH, 3, shipped);
      expect(Object.values(shipped.timeOfDay)).toContain(result.timeOfDay);
      expect(Object.values(shipped.seasons)).toContain(result.season);
      if (result.solarTerm !== undefined) expect(shipped.solarTerms.map((term) => term.name)).toContain(result.solarTerm);
    }
  });
});
