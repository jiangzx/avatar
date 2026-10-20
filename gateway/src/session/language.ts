import type { Language } from '@anyidea/protocol';

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// M1 keeps the phrase and acknowledgement lists in code; M2 moves them to language config.
const SHORT_ACKS = new Set([
  '嗯', '嗯嗯', '哦', '好', '好的', '好好', '行', '行吧', '对对', '是是',
  'ok', 'okay', 'yes', 'yeah', 'yep', 'no', 'nope',
  'はい', 'うん', 'ええ', 'いいえ', 'そう', 'そうですね',
]);

const EDGE_PUNCTUATION = /^[\s\p{P}]+|[\s\p{P}]+$/gu;
const QUESTION_MARK = /[?？]\s*$/u;
const QUESTION_PARTICLE = /[吗呢么嘛][\p{P}\s]*$/u;

// Language names used by request patterns; M1 keeps them in code.
const LANGUAGE_NAMES: Record<Language, string> = {
  en: '英文|英语|english',
  ja: '日语|日文|日本語|japanese',
  zh: '中文|汉语|普通话|chinese',
};

const CHINESE_REQUEST_TAIL = '说|讲|回答|聊天|跟我说话|跟我聊天|跟我交流|跟我讲';

/** Request forms anchored to the whole utterance, so mentions ("我在学英语") do not switch. */
function requestPatterns(names: string): readonly RegExp[] {
  return [
    // Bare language name: "中文", "English".
    new RegExp(`^(?:${names})$`, 'iu'),
    // "English please".
    new RegExp(`^(?:${names})\\s+please$`, 'iu'),
    // "speak English", "talk in Japanese", "switch to Chinese".
    new RegExp(
      `^(?:please\\s+)?(?:speak|talk|reply|answer|switch)(?:\\s+(?:to|in))?(?:\\s+in)?\\s+(?:${names})(?:\\s+please)?$`,
      'iu',
    ),
    // "请用英语说", "说英语", "用日语", "请说中文", "用普通话".
    new RegExp(
      `^(?:请|麻烦)?(?:用|说|讲|切换(?:到|成)?)(?:${names})(?:${CHINESE_REQUEST_TAIL})?$`,
      'u',
    ),
  ];
}

const EXPLICIT: readonly { language: Language; patterns: readonly RegExp[] }[] = [
  { language: 'en', patterns: requestPatterns(LANGUAGE_NAMES.en) },
  {
    language: 'ja',
    patterns: [...requestPatterns(LANGUAGE_NAMES.ja), /^日本語で(?:お願いします)?$/u],
  },
  { language: 'zh', patterns: requestPatterns(LANGUAGE_NAMES.zh) },
];

/** A question about a language ("你会说日语吗") is not a request to switch. */
function isQuestion(text: string): boolean {
  return QUESTION_MARK.test(text) || QUESTION_PARTICLE.test(text);
}

/** Match request patterns against the utterance with edge punctuation and whitespace trimmed. */
function explicitRequest(text: string): Language | null {
  const trimmed = text.replace(EDGE_PUNCTUATION, '');
  for (const rule of EXPLICIT) {
    for (const pattern of rule.patterns) if (pattern.test(trimmed)) return rule.language;
  }
  return null;
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
    const requested = explicitRequest(text);
    if (requested) return requested;
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
