import type { Language } from '@anyidea/protocol';

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// M1 keeps the phrase and acknowledgement lists in code; M2 moves them to language config.
const SHORT_ACKS = new Set([
  '嗯', '哦', '好', '好的', '行', '行吧',
  'ok', 'okay', 'yes', 'yeah', 'yep', 'no', 'nope',
  'はい', 'うん', 'ええ', 'いいえ', 'そう', 'そうですね',
]);

const EDGE_PUNCTUATION = /^[\s\p{P}]+|[\s\p{P}]+$/gu;
const QUESTION_MARK = /[?？]\s*$/u;
const QUESTION_PARTICLE = /[吗呢么嘛][\p{P}\s]*$/u;

const EXPLICIT: readonly { language: Language; pattern: RegExp }[] = [
  { language: 'en', pattern: /英文|英语|\benglish\b/iu },
  { language: 'ja', pattern: /日语|日文|日本語|\bjapanese\b/iu },
  { language: 'zh', pattern: /中文|汉语|普通话|\bchinese\b/iu },
];

/** A question about a language ("你会说日语吗") is not a request to switch. */
function isQuestion(text: string): boolean {
  return QUESTION_MARK.test(text) || QUESTION_PARTICLE.test(text);
}

function ackKey(text: string): string {
  return text.replace(EDGE_PUNCTUATION, '').toLowerCase();
}

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
  // Explicit requests win over every other rule, except when phrased as a question.
  if (!isQuestion(text)) {
    for (const rule of EXPLICIT) if (rule.pattern.test(text)) return rule.language;
  }

  // Short acknowledgements keep the previous language even when their script would switch.
  if (SHORT_ACKS.has(ackKey(text))) return previous;

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
