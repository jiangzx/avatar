import type { Language } from '@anyidea/protocol';
import { KANA } from '../i18n/language.ts';
import type { LanguageRules } from '../i18n/types.ts';
const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

const EDGE_PUNCTUATION = /^[\s\p{P}]+|[\s\p{P}]+$/gu;
const QUESTION_MARK = /[?？]\s*$/u;
/** Pure Han at or above this length is Chinese; short pure-kanji text stays with the previous language. */
const PURE_HAN_ZH_MIN = 4;

/** Fallback for callers without loaded config: detection uses the script heuristic only. */
export const EMPTY_LANGUAGE_RULES: LanguageRules = {
  shortAcks: new Set(),
  explicitRequests: [],
  questionSuffixes: [],
};

/** A question about a language ("你会说日语吗") is not a request to switch. */
function isQuestion(text: string, rules: LanguageRules): boolean {
  if (QUESTION_MARK.test(text)) return true;
  const trimmed = text.replace(EDGE_PUNCTUATION, '');
  return rules.questionSuffixes.some((suffix) => suffix.length > 0 && trimmed.endsWith(suffix));
}

/** Match configured request templates against the utterance with edge punctuation and whitespace trimmed. */
function explicitRequest(text: string, rules: LanguageRules): Language | null {
  const trimmed = text.replace(EDGE_PUNCTUATION, '');
  for (const rule of rules.explicitRequests) if (rule.pattern.test(trimmed)) return rule.language;
  return null;
}

/** A whole-utterance request to change language. Questions do not count. Null means no request. */
export function explicitLanguage(text: string, rules: LanguageRules = EMPTY_LANGUAGE_RULES): Language | null {
  if (isQuestion(text, rules)) return null;
  return explicitRequest(text, rules);
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
export function detectLanguage(text: string, previous: Language = 'zh', rules: LanguageRules = EMPTY_LANGUAGE_RULES): Language {
  // Explicit requests win over every other rule, except when phrased as a question.
  if (!isQuestion(text, rules)) {
    const requested = explicitRequest(text, rules);
    if (requested) return requested;
  }

  // Short acknowledgements keep the previous language even when their script would switch.
  if (rules.shortAcks.has(ackKey(text))) return previous;

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
  if (han > 0 && latin === 0) {
    // Japanese speech almost always carries kana. Keeping every pure-Han line in ja would make
    // a ja session unable to return to Chinese, so only short pure-kanji text keeps the previous language.
    return previous === 'ja' && han < PURE_HAN_ZH_MIN ? 'ja' : 'zh';
  }
  return latin > han ? 'en' : previous;
}

// Batch-language detection lives in the i18n layer so memory code never imports session code.
export { dominantLanguage } from '../i18n/language.ts';
