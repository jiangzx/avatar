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
