import type { Language } from '@anyidea/protocol';

export const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;

/** Batch language for extraction: any kana means ja; otherwise the dominant script decides. */
export function dominantLanguage(texts: readonly string[]): Language {
  let han = 0;
  let latin = 0;
  for (const text of texts) {
    if (KANA.test(text)) return 'ja';
    for (const ch of text) {
      if (HAN.test(ch)) han++;
      else if (LATIN.test(ch)) latin++;
    }
  }
  return latin > han ? 'en' : 'zh';
}
