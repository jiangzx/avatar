import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Avatar emotions. Priority decides which one wins when one sentence matches several lists. */
export const EMOTIONS = ['neutral', 'happy', 'sad', 'love'] as const;
export type Emotion = (typeof EMOTIONS)[number];

const Words = z.array(z.string().min(1).max(10)).max(200);

/** One language's word lists, loaded from config/i18n/<language>/emotion.json. */
export const EmotionLexiconSchema = z.object({ neutral: Words, happy: Words, sad: Words, love: Words }).strict();
export type EmotionLexicon = z.infer<typeof EmotionLexiconSchema>;

/** Merged emotion settings: shared timing plus every language's lexicon. */
export interface EmotionConfig {
  defaultEmotion: Emotion;
  debounceMs: number;
  revertAfterMs: number;
  firstSentenceMaxChars: number;
  priority: Emotion[];
  lexicon: EmotionLexicon;
}

/** Shared emotion settings from config/emotion.json. The lexicon lives in the language packs. */
export interface SharedEmotionConfig {
  defaultEmotion: Emotion;
  debounceMs: number;
  revertAfterMs: number;
  firstSentenceMaxChars: number;
  priority: Emotion[];
  /** Accepted for older fixtures; production shared config no longer carries a lexicon. */
  lexicon?: EmotionLexicon;
}

const SharedEmotionConfigSchema = z.object({
  defaultEmotion: z.enum(EMOTIONS),
  debounceMs: z.number().int().min(0).max(10_000),
  revertAfterMs: z.number().int().min(500).max(60_000),
  firstSentenceMaxChars: z.number().int().min(4).max(60),
  priority: z.array(z.enum(EMOTIONS)).min(1),
  lexicon: EmotionLexiconSchema.optional(),
}).strict().refine((c) => c.revertAfterMs > c.debounceMs, { message: 'revertAfterMs must exceed debounceMs' });

export function loadSharedEmotion(path: string): SharedEmotionConfig {
  return SharedEmotionConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Merge the shared lexicon (if still present) with every language pack, deduplicating each list. */
export function mergeEmotion(shared: SharedEmotionConfig, lexicons: readonly EmotionLexicon[]): EmotionConfig {
  const lexicon: EmotionLexicon = { neutral: [], happy: [], sad: [], love: [] };
  for (const source of [shared.lexicon, ...lexicons]) {
    if (!source) continue;
    for (const emotion of EMOTIONS) lexicon[emotion] = unique([...lexicon[emotion], ...source[emotion]]);
  }
  return {
    defaultEmotion: shared.defaultEmotion,
    debounceMs: shared.debounceMs,
    revertAfterMs: shared.revertAfterMs,
    firstSentenceMaxChars: shared.firstSentenceMaxChars,
    priority: shared.priority,
    lexicon,
  };
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
