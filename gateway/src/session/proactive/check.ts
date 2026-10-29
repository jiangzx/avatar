// Post-hoc check of a spoken proactive line (spec 事后核对). Counts only; never blocks or re-speaks.
import { containsPhrase } from '../../i18n/text.ts';
import type { SilenceRules } from '../../i18n/types.ts';
import { findUngrounded } from './grounding.ts';

export interface CheckSpec { material: readonly string[]; allowQuestion: boolean; mustExpress: 'presence' | null }
export interface CheckRules { healthWords: readonly string[]; silence: Pick<SilenceRules, 'listening' | 'anytime'> }
export interface SpokenCheck { titles: number; numbers: number; health: number; question: boolean; presenceMissing: boolean }
export type ViolationKind = 'title' | 'number' | 'health' | 'question' | 'presence';

const QUESTION = /[？?]/;

export function checkSpoken(text: string, spec: CheckSpec, rules: CheckRules): SpokenCheck {
  const { titles, numbers } = findUngrounded(text, spec.material);
  const source = spec.material.join('\n');
  const health = rules.healthWords.filter((word) => containsPhrase(text, word) && !containsPhrase(source, word)).length;
  const has = (words: readonly string[]) => words.some((word) => containsPhrase(text, word));
  return {
    titles: titles.length,
    numbers: numbers.length,
    health,
    question: !spec.allowQuestion && QUESTION.test(text),
    presenceMissing: spec.mustExpress === 'presence' && !(has(rules.silence.listening) && has(rules.silence.anytime)),
  };
}

/** One entry per violated rule, for content-free logging. */
export function violationsOf(check: SpokenCheck): Array<{ kind: ViolationKind; count: number }> {
  const out: Array<{ kind: ViolationKind; count: number }> = [];
  if (check.titles > 0) out.push({ kind: 'title', count: check.titles });
  if (check.numbers > 0) out.push({ kind: 'number', count: check.numbers });
  if (check.health > 0) out.push({ kind: 'health', count: check.health });
  if (check.question) out.push({ kind: 'question', count: 1 });
  if (check.presenceMissing) out.push({ kind: 'presence', count: 1 });
  return out;
}
