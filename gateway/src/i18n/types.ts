import type { Language } from '@anyidea/protocol';
import type { SafetyRules } from '../config.ts';
import type { EmotionConfig } from './emotion.ts';

/** Language detection rules, merged across every loaded language pack. */
export interface LanguageRules {
  shortAcks: ReadonlySet<string>;
  explicitRequests: readonly { language: Language; pattern: RegExp }[];
  questionSuffixes: readonly string[];
}

/** Rules that decide whether a user line is memory evidence. */
export interface EvidenceRules {
  questionPatterns: readonly RegExp[];
  skipPatterns: readonly string[];
  lightAcks: readonly string[];
}

/** Labels for the extractor input rendered in worker.renderInput. */
export interface ExtractLabels {
  memoryHeader: string;
  agent: string;
  fact: string;
  relationship: string;
  episode: string;
  followup: string;
  reason: string;
  now: string;
  newDialogueHeader: string;
  user: string;
  /** Label/value separator: full-width for CJK, colon-space for English. */
  separator: string;
}

/** Spoken and tool copy for memory recall and consent. */
export interface RecallTextCopy {
  emptyText: string;
  foundPrefix: string;
  wrapText: string;
  toolDescription: string;
  queryDescription: string;
  forgetToolDescription: string;
  forgetQueryDescription: string;
  consentToolDescription: string;
  skipPatterns: readonly string[];
  lightAcks: readonly string[];
  recentQueryPatterns: readonly string[];
  /** Bare vague questions; bounded leading/trailing filler words do not make them specific. */
  recentQueryExactPatterns: readonly string[];
  /** Bounded filler words ignored before a bare vague question (multi-word entries allowed). */
  recentQueryLeadingFillers: readonly string[];
  /** Bounded filler/time words ignored after a bare vague question (multi-word entries allowed). */
  recentQueryTrailingFillers: readonly string[];
  /** First-person "I said" frames stripped from the query before FTS tokenization. */
  queryFramePatterns: readonly RegExp[];
  phraseMaxChars: number;
}

/** Tool and action copy for perform_action. */
export interface PerformActionCopy {
  toolDescription: string;
  actionDescription: string;
}

/** Spoken weather copy. The line uses {place} {condition} {temp} {max} {min}. */
export interface WeatherCopy {
  toolDescription: string;
  locationDescription: string;
  line: string;
  missingLocationText: string;
  notFoundText: string;
  unavailableText: string;
  conditions: Record<
    'clear' | 'mainlyClear' | 'partlyCloudy' | 'overcast' | 'fog' | 'drizzle' | 'rain' | 'freezingRain' | 'snow' | 'showers' | 'snowShowers' | 'thunder' | 'unknown',
    string
  >;
}

/** pin_memory copy and word lists (spec 附录 B). */
export interface PinCopy {
  confirmText: string;
  emptyText: string;
  fullText: string;
  tooLongText: string;
  declinedText: string;
  noticePendingText: string;
  /** Removed from the start of a "this" line, longest first, repeatedly. */
  triggerPrefixes: readonly string[];
  /** Trigger and filler words removed from the end of a "this" line, longest first, repeatedly. */
  trailingWords: readonly string[];
  toolDescription: string;
  targetDescription: string;
}

/** list_memory template copy (spec 附录 B). */
export interface ListCopy {
  introText: string;
  itemJoiner: string;
  /** Closes the item run before an optional hint ("。" / ". "). */
  itemEnd: string;
  sensitiveHint: string;
  emptyText: string;
  toolDescription: string;
}

/** Everything one language needs for memory and evidence handling. */
export interface MemoryCopy {
  noticeKeywords: readonly string[];
  forgetConfirmText: string;
  declineConfirmPrompt: string;
  declineConfirmedText: string;
  recall: RecallTextCopy;
  performAction: PerformActionCopy;
  weather: WeatherCopy;
  evidence: EvidenceRules;
  addressingPatterns: readonly RegExp[];
  extractLabels: ExtractLabels;
  pin: PinCopy;
  list: ListCopy;
  /** A pinned line that contains one of these is sensitive (kept out of greeting/proactive views). */
  healthWords: readonly string[];
}

/** Substring checks that keep a planned check-in on stage. */
export interface SilenceRules {
  greeting: readonly string[];
  listening: readonly string[];
  anytime: readonly string[];
  maxCheckinChars: number;
}

/** Fixed state-card copy and time words for one language (config/i18n/<lang>/affect.json). */
export interface AffectCopy {
  lines: {
    crisis: string;
    /** low = crisis or isLow; sad = mild sadness that is not low. */
    mood: { low: string; sad: string; happy: string; love: string; neutral: string };
    trend: { better: string; worse: string };
    need: Record<'vent' | 'share_joy' | 'help' | 'chat' | 'topic_exhausted', string>;
    strategy: Record<'comfort' | 'reflect' | 'affirm' | 'ask' | 'disclose' | 'suggest', string>;
    mismatch: string;
    exhaustedHint: string;
    tail: string;
  };
  declinePhrases: readonly string[];
  /** Approximate dates; month 1-12, day 1-31. */
  solarTerms: readonly { name: string; month: number; day: number }[];
  seasons: { spring: string; summer: string; autumn: string; winter: string };
  timeOfDay: { morning: string; noon: string; afternoon: string; evening: string; night: string };
}

/** Loaded localization bundle: per-language copy plus merged scan lists. */
export interface I18nBundle {
  language: LanguageRules;
  memory: Record<Language, MemoryCopy>;
  evidence: EvidenceRules;
  /** Union of substring vague-recall phrases; exact per-language patterns stay in MemoryCopy. */
  recentQueries: readonly string[];
  safety: SafetyRules;
  emotion: EmotionConfig;
  silence: Record<Language, SilenceRules>;
  affect: Record<Language, AffectCopy>;
}
