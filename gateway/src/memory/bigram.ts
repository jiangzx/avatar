import { normalizeChineseDigits } from './redact.ts';

// Han, Hiragana, and Katakana form one adjacent-pair run; Latin and digits keep their run-per-token shape.
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u;
const LATIN_OR_DIGIT = /^[A-Za-z0-9]$/;

/** Adjacent CJK pairs, and each Latin or digit run, joined by spaces. Digit runs are folded first, not masked. */
export function bigrams(text: string): string {
  const tokens: string[] = [];
  const chars = [...normalizeChineseDigits(text)];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (CJK.test(ch)) {
      const run: string[] = [];
      while (i < chars.length && CJK.test(chars[i]!)) run.push(chars[i++]!);
      for (let j = 0; j < run.length - 1; j++) tokens.push(run[j]! + run[j + 1]!);
      continue;
    }
    if (LATIN_OR_DIGIT.test(ch)) {
      let run = '';
      while (i < chars.length && LATIN_OR_DIGIT.test(chars[i]!)) run += chars[i++]!;
      tokens.push(run);
      continue;
    }
    i++;
  }
  return tokens.join(' ');
}
