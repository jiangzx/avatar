import { fileURLToPath } from 'node:url';
import { loadSharedSafety } from '../config.ts';

const safety = loadSharedSafety(fileURLToPath(new URL('../../config/safety.json', import.meta.url)));

function isDigitChar(ch: string): boolean {
  return safety.chineseDigits[ch] !== undefined || (ch >= '0' && ch <= '9');
}

function asciiDigit(ch: string): string {
  return safety.chineseDigits[ch] ?? ch;
}

/** Fold a digit run longer than one character to ASCII. A lone numeral stays. */
export function normalizeChineseDigits(text: string): string {
  let out = '';
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    if (!isDigitChar(chars[i]!)) {
      out += chars[i++]!;
      continue;
    }
    const start = i;
    while (i < chars.length && isDigitChar(chars[i]!)) i++;
    const run = chars.slice(start, i);
    out += run.length > 1 ? run.map(asciiDigit).join('') : run[0]!;
  }
  return out;
}

/** Mask a contiguous digit run only when it reaches minMaskedDigits. */
export function redact(text: string): string {
  let out = '';
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    if (!isDigitChar(chars[i]!)) {
      out += chars[i++]!;
      continue;
    }
    const start = i;
    while (i < chars.length && isDigitChar(chars[i]!)) i++;
    const run = chars.slice(start, i).join('');
    out += i - start >= safety.minMaskedDigits ? '*'.repeat(i - start) : run;
  }
  return out;
}
