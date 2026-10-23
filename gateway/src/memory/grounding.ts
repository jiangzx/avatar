// High-risk recall contract: read docs/project/roadmap.md "记忆与回忆：已踩过的坑" before changing.
import { bigrams } from './bigram.ts';

/** Comparison form shared by sameUtterance and quote checks: no whitespace, sentence punctuation, or quote marks. */
export function normalizeForMatch(text: string): string {
  return text.replace(/[\s，。！？、,.!?~～…—「」『』“”"'・]/g, '');
}

/** Punctuation-insensitive comparison so the current question never becomes its own memory hit. */
export function sameUtterance(a: string, b: string): boolean {
  return normalizeForMatch(a) === normalizeForMatch(b);
}

export function parsePhrase(raw: string): string | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value = JSON.parse(text) as { text?: unknown };
    return typeof value.text === 'string' && value.text.trim() ? value.text.trim() : null;
  } catch {
    return null;
  }
}

/** Reject a phrasing that adds a new quoted title or loses every content bigram from the source. */
export function grounded(text: string, source: string): boolean {
  if (sameUtterance(text, source)) return false;
  for (const match of text.matchAll(/[《「『“"]([^》」』”"]{1,20})[》」』”"]/g)) {
    if (!source.includes(match[1]!)) return false;
  }
  // Latin bigrams are whole words, so the two-character Han gate does not apply to them.
  const tokens = bigrams(source).split(' ').filter((token) => token.length >= 2);
  return tokens.some((token) => text.includes(token));
}
