import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, type Language } from '@anyidea/protocol';
import { z } from 'zod';
import { loadSafetyConfig, mergeSafety, type SafetyPhrases } from '../config.ts';
import {
  EmotionLexiconSchema,
  loadEmotionConfig,
  mergeEmotion,
  type EmotionLexicon,
} from '../session/emotion.ts';
import type {
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
    phraseMaxChars: z.number().int().min(1).max(1000),
  }).strict(),
  performAction: z.object({
    toolDescription: z.string().min(1),
    actionDescription: z.string().min(1),
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

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
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
    recall: raw.recall,
    performAction: raw.performAction,
    evidence: {
      questionPatterns: raw.evidence.questionPatterns.map((source) => compilePattern(source, language, 'questionPatterns')),
      skipPatterns: raw.evidence.skipPatterns ?? raw.recall.skipPatterns,
      lightAcks: raw.evidence.lightAcks ?? raw.recall.lightAcks,
    },
    addressingPatterns: raw.addressingPatterns.map((source) => compilePattern(source, language, 'addressingPatterns')),
    extractLabels: raw.extractLabels,
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

/** Load and validate every language pack plus the shared scan lists. Fails fast on any gap. */
export function loadI18n(configRoot: string): I18nBundle {
  const language = mergeLanguageRules(loadLanguageFiles(configRoot));

  const memory = {} as Record<Language, MemoryCopy>;
  for (const code of LANGUAGES) memory[code] = loadMemoryCopy(configRoot, code);

  const evidence: EvidenceRules = {
    questionPatterns: uniquePatterns(LANGUAGES.flatMap((code) => memory[code].evidence.questionPatterns)),
    skipPatterns: unique(LANGUAGES.flatMap((code) => memory[code].evidence.skipPatterns)),
    lightAcks: unique(LANGUAGES.flatMap((code) => memory[code].evidence.lightAcks)),
  };
  const recentQueries = unique(LANGUAGES.flatMap((code) => memory[code].recall.recentQueryPatterns));

  const safety = mergeSafety(loadSafetyConfig(join(configRoot, 'safety.json')), loadSafety(configRoot));
  const emotion = mergeEmotion(loadEmotionConfig(join(configRoot, 'emotion.json')), loadEmotion(configRoot));

  return { language, memory, evidence, recentQueries, safety, emotion, silence: loadSilence(configRoot) };
}

/** Loaded once for tests and default parameters; production startup calls loadI18n explicitly. */
export const DEFAULT_I18N: I18nBundle = loadI18n(fileURLToPath(new URL('../../config', import.meta.url)));
