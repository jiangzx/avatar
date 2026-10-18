import type { SafetyRules } from '../config.ts';

export type ScanVerdict = 'allow' | 'reject' | 'degrade' | 'mark';

/** Reject wins, then degrade, then mark. A degrade verdict does not throw. */
export function scanText(text: string, rules: SafetyRules): ScanVerdict {
  if (containsCodePoint(text, rules.invisibleCodePoints) || containsPhrase(text, rules.rejectPhrases)) return 'reject';
  if (containsPhrase(text, rules.degradePhrases)) return 'degrade';
  if (containsPhrase(text, rules.markPhrases)) return 'mark';
  return 'allow';
}

function containsPhrase(text: string, phrases: readonly string[]): boolean {
  const hay = text.toLowerCase();
  return phrases.some((phrase) => phrase.length > 0 && hay.includes(phrase.toLowerCase()));
}

function containsCodePoint(text: string, codePoints: readonly number[]): boolean {
  const banned = new Set(codePoints);
  for (const ch of text) {
    const point = ch.codePointAt(0);
    if (point !== undefined && banned.has(point)) return true;
  }
  return false;
}
