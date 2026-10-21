/** ASCII phrase: match whole words only, so "hi" does not hit "this" and "no" does not hit "nothing". */
const ASCII = /^[\x20-\x7E]+$/;
const WORD_CHAR = /[a-z0-9]/i;

/**
 * Case-insensitive phrase check shared by silence stages, Director quiet phrases,
 * and memory-notice keywords. Pure CJK phrases stay substring matches.
 */
export function containsPhrase(text: string, phrase: string): boolean {
  const needle = phrase.toLowerCase();
  if (!needle) return false;
  const hay = text.toLowerCase();
  if (!ASCII.test(needle)) return hay.includes(needle);
  let index = hay.indexOf(needle);
  while (index >= 0) {
    if (!isWordChar(hay[index - 1]) && !isWordChar(hay[index + needle.length])) return true;
    index = hay.indexOf(needle, index + 1);
  }
  return false;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

/** Filler config may contain multi-word phrases; matching is token-based. */
export function fillerWords(phrases: readonly string[]): Set<string> {
  return new Set(phrases.flatMap((phrase) => phrase.toLowerCase().split(/\s+/)).filter(Boolean));
}

/** Key for a bare vague question: strip punctuation/marks, bounded leading fillers, bounded trailing fillers. */
export function vagueKey(text: string, leading: ReadonlySet<string>, trailing: ReadonlySet<string>): string {
  const words = text
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{M}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 0 && leading.has(words[0]!)) words.shift();
  // Keep at least one token so a configured pattern can never normalize to an empty key.
  while (words.length > 1 && trailing.has(words[words.length - 1]!)) words.pop();
  return words.join('');
}
