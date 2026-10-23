import type { AffectCopy } from '../i18n/types.ts';

const DAY_MS = 86_400_000;

type TimeOfDay = keyof AffectCopy['timeOfDay'];
type Season = keyof AffectCopy['seasons'];

interface LocalDate {
  year: number;
  month: number;
  day: number;
  hour: number;
}

/** Calendar definitions, not tuning knobs: [5,11) morning, [11,13) noon, [13,18) afternoon, [18,22) evening, else night. */
function bucketFor(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 13) return 'noon';
  if (hour >= 13 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night';
}

/** Meteorological seasons by local month (northern hemisphere, same as the solar-term table). */
function seasonFor(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

/** Wall-clock date and hour in the zone. Throws RangeError for an unknown zone. */
function localDate(now: number, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') % 24 };
}

/** Nearest approximate solar term within ±windowDays; neighbouring years cover the year boundary. */
function solarTermNear(date: LocalDate, windowDays: number, terms: AffectCopy['solarTerms']): string | undefined {
  const today = Date.UTC(date.year, date.month - 1, date.day);
  let best: { name: string; days: number } | undefined;
  for (const term of terms) {
    for (const year of [date.year - 1, date.year, date.year + 1]) {
      const days = Math.abs(Date.UTC(year, term.month - 1, term.day) - today) / DAY_MS;
      if (days <= windowDays && (!best || days < best.days)) best = { name: term.name, days };
    }
  }
  return best?.name;
}

/** Localized time words for planner small talk; every value comes from AffectCopy. */
export function timeContext(
  now: number,
  timeZone: string,
  windowDays: number,
  copy: AffectCopy,
): { timeOfDay: string; season: string; solarTerm?: string } {
  const date = localDate(now, timeZone);
  const solarTerm = solarTermNear(date, windowDays, copy.solarTerms);
  return {
    timeOfDay: copy.timeOfDay[bucketFor(date.hour)],
    season: copy.seasons[seasonFor(date.month)],
    ...(solarTerm ? { solarTerm } : {}),
  };
}
