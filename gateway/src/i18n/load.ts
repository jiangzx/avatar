import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, type Language } from '@anyidea/protocol';
import { z } from 'zod';
import { loadSharedSafety, mergeSafety, type SafetyPhrases } from '../config.ts';
import { unique } from '../unique.ts';
import { fillerWords, vagueKey } from './text.ts';
import {
  EmotionLexiconSchema,
  loadSharedEmotion,
  mergeEmotion,
  type EmotionLexicon,
} from './emotion.ts';
import type {
  AffectCopy,
  EvidenceRules,
  I18nBundle,
  LanguageRules,
  MemoryCopy,
  SilenceRules,
} from './types.ts';

const EDGE_PUNCTUATION = /^[\s\p{P}]+|[\s\p{P}]+$/gu;

const StringList = z.array(z.string().min(1));
const PhraseList = StringList.min(1);

const LanguageFileSchema = z.object({
  names: PhraseList,
  shortAcks: StringList,
  questionSuffixes: StringList,
  // Complete anchored M1 regex sources, grouped by the language they request.
  explicitRequestPatterns: z.array(z.object({
    language: z.enum(LANGUAGES),
    pattern: z.string().min(1),
  }).strict()),
}).strict();

const MemoryFileSchema = z.object({
  noticeKeywords: PhraseList,
  forgetConfirmText: z.string().min(1),
  declineConfirmPrompt: z.string().min(1),
  declineConfirmedText: z.string().min(1),
  restReminderText: z.string().min(1).max(160),
  recall: z.object({
    emptyText: z.string().min(1),
    foundPrefix: z.string().min(1),
    wrapText: z.string().min(1),
    toolDescription: z.string().min(1),
    queryDescription: z.string().min(1),
    forgetToolDescription: z.string().min(1),
    forgetQueryDescription: z.string().min(1),
    consentToolDescription: z.string().min(1),
    skipPatterns: StringList,
    lightAcks: StringList,
    recentQueryPatterns: StringList,
    recentQueryExactPatterns: StringList.optional(),
    recentQueryLeadingFillers: StringList.optional(),
    recentQueryTrailingFillers: StringList.optional(),
    queryFramePatterns: StringList.min(1),
    phraseMaxChars: z.number().int().min(1).max(1000),
  }).strict(),
  performAction: z.object({
    toolDescription: z.string().min(1),
    actionDescription: z.string().min(1),
  }).strict(),
  weather: z.object({
    toolDescription: z.string().min(1),
    locationDescription: z.string().min(1),
    line: z.string().min(1),
    missingLocationText: z.string().min(1),
    notFoundText: z.string().min(1),
    unavailableText: z.string().min(1),
    conditions: z.object({
      clear: z.string().min(1),
      mainlyClear: z.string().min(1),
      partlyCloudy: z.string().min(1),
      overcast: z.string().min(1),
      fog: z.string().min(1),
      drizzle: z.string().min(1),
      rain: z.string().min(1),
      freezingRain: z.string().min(1),
      snow: z.string().min(1),
      showers: z.string().min(1),
      snowShowers: z.string().min(1),
      thunder: z.string().min(1),
      unknown: z.string().min(1),
    }).strict(),
  }).strict(),
  evidence: z.object({
    questionPatterns: StringList,
    // Optional: default to the recall lists when a language keeps one copy.
    skipPatterns: StringList.optional(),
    lightAcks: StringList.optional(),
  }).strict(),
  addressingPatterns: StringList,
  extractLabels: z.object({
    memoryHeader: z.string().min(1),
    agent: z.string().min(1),
    fact: z.string().min(1),
    relationship: z.string().min(1),
    episode: z.string().min(1),
    followup: z.string().min(1),
    reason: z.string().min(1),
    now: z.string().min(1),
    newDialogueHeader: z.string().min(1),
    user: z.string().min(1),
    separator: z.string().min(1),
  }).strict(),
  pin: z.object({
    confirmText: z.string().min(1).max(80),
    emptyText: z.string().min(1).max(80),
    fullText: z.string().min(1).max(120),
    tooLongText: z.string().min(1).max(80),
    declinedText: z.string().min(1).max(80),
    noticePendingText: z.string().min(1).max(80),
    triggerPrefixes: PhraseList,
    trailingWords: StringList,
    toolDescription: z.string().min(1),
    targetDescription: z.string().min(1),
  }).strict(),
  list: z.object({
    introText: z.string().min(1).max(40),
    itemJoiner: z.string().min(1).max(4),
    itemEnd: z.string().min(1).max(4),
    sensitiveHint: z.string().min(1).max(80),
    emptyText: z.string().min(1).max(80),
    toolDescription: z.string().min(1),
  }).strict(),
  healthWords: PhraseList,
}).strict();

const SafetyFileSchema = z.object({
  rejectPhrases: PhraseList,
  degradePhrases: PhraseList,
  markPhrases: PhraseList,
}).strict();

const SilenceFileSchema = z.object({
  greeting: PhraseList,
  listening: PhraseList,
  anytime: PhraseList,
  maxCheckinChars: z.number().int().min(1).max(500),
  tierDown: PhraseList, tierUp: PhraseList, farewell: PhraseList, familyWords: PhraseList,
}).strict();

const AffectLine = z.string().min(1).max(200);
/** Leap-year February so 2/29 is accepted; approximate dates never need it. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const dateKey = (term: { month: number; day: number }) => term.month * 100 + term.day;

const SolarTermSchema = z.object({
  name: z.string().min(1).max(30),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
}).strict().refine((term) => term.day <= DAYS_IN_MONTH[term.month - 1]!, { message: 'day out of range' });

const AffectFileSchema = z.object({
  lines: z.object({
    crisis: AffectLine,
    mood: z.object({ low: AffectLine, sad: AffectLine, happy: AffectLine, love: AffectLine, neutral: AffectLine }).strict(),
    trend: z.object({ better: AffectLine, worse: AffectLine }).strict(),
    need: z.object({
      vent: AffectLine, share_joy: AffectLine, help: AffectLine, chat: AffectLine, topic_exhausted: AffectLine,
    }).strict(),
    strategy: z.object({
      comfort: AffectLine, reflect: AffectLine, affirm: AffectLine, ask: AffectLine, disclose: AffectLine, suggest: AffectLine,
    }).strict(),
    mismatch: AffectLine,
    exhaustedHint: AffectLine,
    tail: AffectLine,
  }).strict(),
  declinePhrases: PhraseList,
  // Calendar order with unique names, so a date lookup never depends on file order quirks.
  solarTerms: z.array(SolarTermSchema).length(24)
    .refine((terms) => terms.every((term, i) => i === 0 || dateKey(term) > dateKey(terms[i - 1]!)), { message: 'solar terms out of order' })
    .refine((terms) => new Set(terms.map((term) => term.name)).size === terms.length, { message: 'duplicate solar term' }),
  seasons: z.object({ spring: AffectLine, summer: AffectLine, autumn: AffectLine, winter: AffectLine }).strict(),
  timeOfDay: z.object({
    morning: AffectLine, noon: AffectLine, afternoon: AffectLine, evening: AffectLine, night: AffectLine,
  }).strict(),
}).strict();

type LanguageFile = z.infer<typeof LanguageFileSchema>;
type MemoryFile = z.infer<typeof MemoryFileSchema>;

function readConfigFile(configRoot: string, language: Language, file: string): unknown {
  let text: string;
  try {
    text = readFileSync(join(configRoot, 'i18n', language, `${file}.json`), 'utf8');
  } catch {
    throw new Error(`i18n_missing:${language}:${file}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`i18n_invalid:${language}:${file}`);
  }
}

function parseFile<T>(schema: z.ZodType<T>, configRoot: string, language: Language, file: string): T {
  const parsed = schema.safeParse(readConfigFile(configRoot, language, file));
  if (!parsed.success) throw new Error(`i18n_invalid:${language}:${file}`);
  return parsed.data;
}

/** Patterns never carry `g`: RegExp.test would then keep lastIndex between calls. */
function compilePattern(source: string, language: Language, field: string): RegExp {
  try {
    return new RegExp(source, 'iu');
  } catch {
    throw new Error(`i18n_pattern_invalid:${language}:${field}`);
  }
}

function normalizeAck(text: string): string {
  return text.replace(EDGE_PUNCTUATION, '').toLowerCase();
}

function uniquePatterns(patterns: readonly RegExp[]): RegExp[] {
  const seen = new Set<string>();
  const kept: RegExp[] = [];
  for (const pattern of patterns) {
    const key = `${pattern.source}/${pattern.flags}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(pattern);
  }
  return kept;
}

function loadLanguageFiles(configRoot: string): Record<Language, LanguageFile> {
  const files = {} as Record<Language, LanguageFile>;
  for (const language of LANGUAGES) files[language] = parseFile(LanguageFileSchema, configRoot, language, 'language');
  return files;
}

/** Short acknowledgements and question suffixes are unions; requests come from every pack. */
function mergeLanguageRules(files: Record<Language, LanguageFile>): LanguageRules {
  const shortAcks = new Set<string>();
  const questionSuffixes: string[] = [];
  const explicitRequests: { language: Language; pattern: RegExp }[] = [];
  for (const language of LANGUAGES) {
    const file = files[language];
    for (const ack of file.shortAcks) {
      const key = normalizeAck(ack);
      if (key) shortAcks.add(key);
    }
    for (const suffix of file.questionSuffixes) {
      if (!questionSuffixes.includes(suffix)) questionSuffixes.push(suffix);
    }
    for (const request of file.explicitRequestPatterns) {
      try {
        explicitRequests.push({ language: request.language, pattern: new RegExp(request.pattern, 'iu') });
      } catch {
        throw new Error(`i18n_pattern_invalid:${language}:explicitRequestPatterns`);
      }
    }
  }
  return { shortAcks, explicitRequests, questionSuffixes };
}

function loadMemoryCopy(configRoot: string, language: Language): MemoryCopy {
  const raw = parseFile(MemoryFileSchema, configRoot, language, 'memory');
  return {
    noticeKeywords: raw.noticeKeywords,
    forgetConfirmText: raw.forgetConfirmText,
    declineConfirmPrompt: raw.declineConfirmPrompt,
    declineConfirmedText: raw.declineConfirmedText,
    restReminderText: raw.restReminderText,
    recall: {
      ...raw.recall,
      recentQueryExactPatterns: raw.recall.recentQueryExactPatterns ?? [],
      recentQueryLeadingFillers: raw.recall.recentQueryLeadingFillers ?? [],
      recentQueryTrailingFillers: raw.recall.recentQueryTrailingFillers ?? [],
      // Stored as sources in JSON; recall matches text and needs compiled patterns.
      queryFramePatterns: raw.recall.queryFramePatterns.map((source) => compilePattern(source, language, 'queryFramePatterns')),
    },
    performAction: raw.performAction,
    weather: raw.weather,
    evidence: {
      questionPatterns: raw.evidence.questionPatterns.map((source) => compilePattern(source, language, 'questionPatterns')),
      skipPatterns: raw.evidence.skipPatterns ?? raw.recall.skipPatterns,
      lightAcks: raw.evidence.lightAcks ?? raw.recall.lightAcks,
    },
    addressingPatterns: raw.addressingPatterns.map((source) => compilePattern(source, language, 'addressingPatterns')),
    extractLabels: raw.extractLabels,
    pin: raw.pin,
    list: raw.list,
    healthWords: raw.healthWords,
  };
}

function loadSafety(configRoot: string): SafetyPhrases {
  const phrases = { rejectPhrases: [] as string[], degradePhrases: [] as string[], markPhrases: [] as string[] };
  for (const language of LANGUAGES) {
    const raw = parseFile(SafetyFileSchema, configRoot, language, 'safety');
    phrases.rejectPhrases.push(...raw.rejectPhrases);
    phrases.degradePhrases.push(...raw.degradePhrases);
    phrases.markPhrases.push(...raw.markPhrases);
  }
  return phrases;
}

function loadEmotion(configRoot: string): EmotionLexicon[] {
  return LANGUAGES.map((language) => parseFile(EmotionLexiconSchema, configRoot, language, 'emotion'));
}

function loadSilence(configRoot: string): Record<Language, SilenceRules> {
  const rules = {} as Record<Language, SilenceRules>;
  for (const language of LANGUAGES) rules[language] = parseFile(SilenceFileSchema, configRoot, language, 'silence');
  return rules;
}

/** Every pack must name the same 24 dates, so a solar term never moves with the language. */
function loadAffect(configRoot: string): Record<Language, AffectCopy> {
  const copy = {} as Record<Language, AffectCopy>;
  for (const language of LANGUAGES) copy[language] = parseFile(AffectFileSchema, configRoot, language, 'affect');
  const reference = copy.zh.solarTerms;
  for (const language of LANGUAGES) {
    const terms = copy[language].solarTerms;
    if (terms.some((term, i) => dateKey(term) !== dateKey(reference[i]!))) {
      throw new Error(`i18n_affect_parity:${language}:solarTerms`);
    }
  }
  return copy;
}

/** Load and validate every language pack plus the shared scan lists. Fails fast on any gap. */
export function loadI18n(configRoot: string): I18nBundle {
  const language = mergeLanguageRules(loadLanguageFiles(configRoot));

  const memory = {} as Record<Language, MemoryCopy>;
  for (const code of LANGUAGES) memory[code] = loadMemoryCopy(configRoot, code);
  // Exact patterns must stay reachable after the configured filler lists are applied.
  for (const code of LANGUAGES) {
    const copy = memory[code];
    const leading = fillerWords(copy.recall.recentQueryLeadingFillers);
    const trailing = fillerWords(copy.recall.recentQueryTrailingFillers);
    for (const pattern of copy.recall.recentQueryExactPatterns) {
      if (vagueKey(pattern, leading, trailing).length === 0) {
        throw new Error(`i18n_pattern_empty:${code}:recentQueryExactPatterns`);
      }
    }
  }

  const evidence: EvidenceRules = {
    questionPatterns: uniquePatterns(LANGUAGES.flatMap((code) => memory[code].evidence.questionPatterns)),
    skipPatterns: unique(LANGUAGES.flatMap((code) => memory[code].evidence.skipPatterns)),
    lightAcks: unique(LANGUAGES.flatMap((code) => memory[code].evidence.lightAcks)),
  };
  const recentQueries = unique(LANGUAGES.flatMap((code) => memory[code].recall.recentQueryPatterns));

  const safety = mergeSafety(loadSharedSafety(join(configRoot, 'safety.json')), loadSafety(configRoot));
  const emotion = mergeEmotion(loadSharedEmotion(join(configRoot, 'emotion.json')), loadEmotion(configRoot));

  return { language, memory, evidence, recentQueries, safety, emotion, silence: loadSilence(configRoot), affect: loadAffect(configRoot) };
}

/** Loaded once for tests and default parameters; production startup calls loadI18n explicitly. */
export const DEFAULT_I18N: I18nBundle = loadI18n(fileURLToPath(new URL('../../config', import.meta.url)));
