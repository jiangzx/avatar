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

/** Everything one language needs for memory and evidence handling. */
export interface MemoryCopy {
  noticeKeywords: readonly string[];
  forgetConfirmText: string;
  declineConfirmPrompt: string;
  declineConfirmedText: string;
  recall: RecallTextCopy;
  performAction: PerformActionCopy;
  evidence: EvidenceRules;
  addressingPatterns: readonly RegExp[];
  extractLabels: ExtractLabels;
}

/** Substring checks that keep a planned check-in on stage. */
export interface SilenceRules {
  greeting: readonly string[];
  listening: readonly string[];
  anytime: readonly string[];
  maxCheckinChars: number;
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
}
