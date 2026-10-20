import type { Language } from '@anyidea/protocol';

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

const EXPLICIT: readonly { language: Language; pattern: RegExp }[] = [
  {
    language: 'en',
    pattern: /(?:请|麻烦)(?:用|说|讲)\s*(?:英文|英语|english)|切换(?:到|成)?\s*(?:英文|英语|english)|(?:speak|reply|answer|switch to)\s+(?:in\s+)?english/iu,
  },
  {
    language: 'ja',
    pattern: /(?:请|麻烦)(?:用|说|讲)\s*(?:日语|日文|日本語)|切换(?:到|成)?\s*(?:日语|日文|日本語)|日本語で/u,
  },
  {
    language: 'zh',
    pattern: /(?:请|麻烦)(?:用|说|讲)\s*(?:中文|汉语|普通话)|切换(?:到|成)?\s*(?:中文|汉语|普通话)|(?:speak|reply|answer|switch to)\s+(?:in\s+)?chinese/iu,
  },
];

export function isLanguage(value: unknown): value is Language {
  return value === 'zh' || value === 'ja' || value === 'en';
}

export function resolveLanguage(value: unknown, fallback: Language = 'zh'): Language {
  return isLanguage(value) ? value : fallback;
}

/**
 * Script heuristic for system copy only. It never overrides the model's own reply language.
 * Short/ambiguous utterances keep the previous language.
 */
export function detectLanguage(text: string, previous: Language = 'zh'): Language {
  for (const rule of EXPLICIT) if (rule.pattern.test(text)) return rule.language;

  const chars = [...text];
  if (chars.filter((ch) => LETTER_OR_DIGIT.test(ch)).length < 2) return previous;

  let kana = 0;
  let han = 0;
  let latin = 0;
  for (const ch of chars) {
    if (KANA.test(ch)) kana++;
    else if (HAN.test(ch)) han++;
    else if (LATIN.test(ch)) latin++;
  }
  if (kana > 0) return 'ja';
  if (latin > 0 && han === 0) return 'en';
  if (han > 0 && latin === 0) return previous === 'ja' ? 'ja' : 'zh';
  return latin > han ? 'en' : previous;
}
