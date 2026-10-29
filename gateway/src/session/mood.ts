import type { AffectEmotion, MoodSummaryInput } from '../memory/store.ts';
import type { AffectCard, AffectSummary } from './affect.ts';

// Ties go to the emotion that matters most for care; same order as the lexicon tagger.
const PRIORITY: readonly AffectEmotion[] = ['sad', 'love', 'happy', 'neutral'];

const clamp = (value: number): 1 | 2 | 3 => (value >= 3 ? 3 : value <= 1 ? 1 : 2);

/** Labels only, from this session's accepted cards. Null when none was accepted. */
export function summarizeMood(summary: AffectSummary, last: AffectCard | null, peak: number, sessionId: string): MoodSummaryInput | null {
  const accepted = PRIORITY.reduce((n, emotion) => n + summary.byEmotion[emotion], 0);
  if (accepted === 0) return null;
  const dominant = PRIORITY.reduce((best, emotion) => (summary.byEmotion[emotion] > summary.byEmotion[best] ? emotion : best), PRIORITY[0]!);
  return {
    sessionId,
    dominant,
    peakIntensity: clamp(Math.max(peak, last?.intensity ?? 1)),
    endEmotion: last?.emotion ?? dominant,
    endIntensity: last ? last.intensity : 1,
    endTrend: last?.trend ?? 'flat',
    crisis: summary.crisis === 1,
  };
}
