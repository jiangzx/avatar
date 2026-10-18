const HAN = /^\p{Script=Han}$/u;
const LATIN_OR_DIGIT = /^[A-Za-z0-9]$/;

/** Adjacent Han pairs, and each Latin or digit run, joined by spaces. */
export function bigrams(text: string): string {
  const tokens: string[] = [];
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (HAN.test(ch)) {
      const run: string[] = [];
      while (i < chars.length && HAN.test(chars[i]!)) run.push(chars[i++]!);
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
