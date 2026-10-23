import type { Language } from '@anyidea/protocol';
import type { AffectCopy } from '../i18n/types.ts';
import { AFFECT_EMOTIONS, AFFECT_NEEDS, AFFECT_STRATEGIES, AFFECT_TRENDS, isLow, type AffectCard } from './affect.ts';
import type { InstructionBudget } from './instructions.ts';

export interface AffectRenderFlags {
  /** The topic-exhaustion hint is armed (T4). */
  exhaustedArmed: boolean;
  /** Same threshold as AffectConfig.lowIntensity. */
  lowIntensity: number;
}

/** Priority crisis > low > emotion (spec §2): crisis and low share the low line; mild sadness has its own. */
function moodLine(card: AffectCard, lines: AffectCopy['lines'], low: boolean): string {
  if (card.crisis || low) return lines.mood.low;
  switch (card.emotion) {
    case 'happy': return lines.mood.happy;
    case 'love': return lines.mood.love;
    case 'neutral': return lines.mood.neutral;
    case 'sad': return lines.mood.sad;
  }
}

/**
 * Deterministic affect section built only from fixed copy lines; model free text never enters it.
 * Order: crisis, mood, trend, need, strategy, mismatch, exhaustion hint, tail.
 */
export function renderAffect(card: AffectCard | null, copy: AffectCopy, flags: AffectRenderFlags): string {
  const lines = copy.lines;
  if (!card) return flags.exhaustedArmed ? [lines.exhaustedHint, lines.tail].join('\n') : '';
  const low = isLow(card, flags.lowIntensity);
  const parts: string[] = [];
  if (card.crisis) parts.push(lines.crisis);
  parts.push(moodLine(card, lines, low));
  if (card.trend === 'better' || card.trend === 'worse') parts.push(lines.trend[card.trend]);
  parts.push(lines.need[card.need], lines.strategy[card.strategy]);
  if (card.mismatch) parts.push(lines.mismatch);
  // A low or crisis turn never gets the change-topic hint.
  if (flags.exhaustedArmed && !low) parts.push(lines.exhaustedHint);
  parts.push(lines.tail);
  return parts.join('\n');
}

/** Longest render over every card and flag combination; the startup budget check uses it. */
export function maxAffectRender(copy: AffectCopy): number {
  // An infinite threshold lets the most cards carry the hint, so this bounds every real lowIntensity.
  const lowIntensity = Number.POSITIVE_INFINITY;
  let max = renderAffect(null, copy, { exhaustedArmed: true, lowIntensity }).length;
  for (const crisis of [false, true]) {
    for (const emotion of AFFECT_EMOTIONS) {
      for (const trend of AFFECT_TRENDS) {
        for (const need of AFFECT_NEEDS) {
          for (const strategy of AFFECT_STRATEGIES) {
            for (const mismatch of [false, true]) {
              for (const exhaustedArmed of [false, true]) {
                const card: AffectCard = { emotion, intensity: 1, trend, need, strategy, mismatch, crisis };
                max = Math.max(max, renderAffect(card, copy, { exhaustedArmed, lowIntensity }).length);
              }
            }
          }
        }
      }
    }
  }
  return max;
}

/** Startup check: each language's longest render must fit that language's reserved affect room. */
export function checkAffectBudgets(
  budgets: Partial<Record<Language, InstructionBudget>>,
  copies: Record<Language, AffectCopy>,
): void {
  for (const [language, budget] of Object.entries(budgets) as Array<[Language, InstructionBudget | undefined]>) {
    if (!budget) continue;
    const need = maxAffectRender(copies[language]);
    const room = budget.affectMaxChars ?? 0;
    if (need > room) throw new Error(`affect_budget_too_small:${language}: render ${need} > max ${room}`);
  }
}
