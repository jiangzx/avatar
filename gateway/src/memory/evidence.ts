import type { EvidenceRules } from '../i18n/types.ts';

export type { EvidenceRules };

/** No skip lists: only the language-independent question-mark check applies. */
export const EMPTY_EVIDENCE_RULES: EvidenceRules = { questionPatterns: [], skipPatterns: [], lightAcks: [] };

/**
 * A user line is memory evidence only when it is a statement.
 * Questions, challenges, denials, and configured skip phrases never become recalled facts.
 * Production callers pass I18nBundle.evidence; the default keeps only the question-mark check.
 */
export function isMemoryEvidence(text: string, rules: EvidenceRules = EMPTY_EVIDENCE_RULES): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (/[？?]\s*$/.test(cleaned)) return false;
  // ASR often drops the question mark: the configured suffix/prefix patterns catch that.
  if (rules.questionPatterns.some((pattern) => pattern.test(cleaned))) return false;
  // Light acknowledgements only count when they are the whole utterance; "好的，我喜欢听京剧" is a statement.
  const normalized = normalizeUtterance(cleaned);
  if (rules.lightAcks.some((ack) => normalizeUtterance(ack) === normalized)) return false;
  return !rules.skipPatterns.some((pattern) => pattern.length > 0 && cleaned.includes(pattern));
}

/** Whitespace and sentence punctuation are not evidence-bearing. */
function normalizeUtterance(text: string): string {
  return text.replace(/[\s。！？!?，,、.~～…]+/gu, '');
}
