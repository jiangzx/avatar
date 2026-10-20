import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const EMOTIONS = ['neutral', 'happy', 'sad', 'love'] as const;
export type Emotion = (typeof EMOTIONS)[number];

const Words = z.array(z.string().min(1).max(10)).max(200);

export const EmotionLexiconSchema = z.object({ neutral: Words, happy: Words, sad: Words, love: Words }).strict();
export type EmotionLexicon = z.infer<typeof EmotionLexiconSchema>;

const EmotionConfigSchema = z.object({
  defaultEmotion: z.enum(EMOTIONS),
  debounceMs: z.number().int().min(0).max(10_000),
  revertAfterMs: z.number().int().min(500).max(60_000),
  firstSentenceMaxChars: z.number().int().min(4).max(60),
  priority: z.array(z.enum(EMOTIONS)).min(1),
  lexicon: EmotionLexiconSchema,
}).strict().refine((c) => c.revertAfterMs > c.debounceMs, { message: 'revertAfterMs must exceed debounceMs' });

export type EmotionConfig = z.infer<typeof EmotionConfigSchema>;

export function loadEmotionConfig(path: string): EmotionConfig {
  return EmotionConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Shared emotion settings. The lexicon is optional here until it moves to config/i18n entirely. */
export interface SharedEmotionConfig {
  defaultEmotion: Emotion;
  debounceMs: number;
  revertAfterMs: number;
  firstSentenceMaxChars: number;
  priority: Emotion[];
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

/** Merge the shared lexicon (if still present) with every language pack, deduplicating each emotion list. */
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

/** First emotion in priority order whose word list matches. Negation is not handled (POC). */
export function tagEmotion(text: string, cfg: EmotionConfig): Emotion | null {
  for (const e of cfg.priority) if (cfg.lexicon[e].some((w) => text.includes(w))) return e;
  return null;
}

const SENTENCE_END = /[。！？!?；;\n]/;

/** Maps user finals and the first sentence of each reply to an avatar emotion, with debounce and revert. */
export class EmotionTagger {
  private current: Emotion;
  private lastChangeAt = Number.NEGATIVE_INFINITY;
  private revertTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<number, string>();
  private readonly done = new Set<number>();

  constructor(
    private readonly cfg: EmotionConfig,
    private readonly emit: (e: Emotion) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.current = cfg.defaultEmotion;
  }

  onUserFinal(text: string): void {
    const e = tagEmotion(text, this.cfg);
    if (e) this.apply(e);
  }

  onResponseStart(seq: number): void {
    // Audio-only replies never reach done(); bound both sets as the session grows.
    const keepFrom = seq - 64;
    for (const id of this.pending.keys()) if (id < keepFrom) this.pending.delete(id);
    for (const id of this.done) if (id < keepFrom) this.done.delete(id);
    this.pending.set(seq, '');
  }

  onAssistantDelta(seq: number, delta: string): void {
    if (this.done.has(seq)) return;
    const text = (this.pending.get(seq) ?? '') + delta;
    const end = text.search(SENTENCE_END);
    if (end < 0 && text.length < this.cfg.firstSentenceMaxChars) {
      this.pending.set(seq, text);
      return;
    }
    this.pending.delete(seq);
    this.done.add(seq);
    const e = tagEmotion(end < 0 ? text : text.slice(0, end), this.cfg);
    if (e) this.apply(e);
  }

  dispose(): void {
    if (this.revertTimer) clearTimeout(this.revertTimer);
    this.revertTimer = null;
  }

  private apply(e: Emotion): void {
    if (e === this.current) {
      this.scheduleRevert(); // same mood again: keep it a little longer
      return;
    }
    const t = this.now();
    if (t - this.lastChangeAt < this.cfg.debounceMs) return;
    this.current = e;
    this.lastChangeAt = t;
    this.emit(e);
    this.scheduleRevert();
  }

  private scheduleRevert(): void {
    if (this.revertTimer) clearTimeout(this.revertTimer);
    this.revertTimer = null;
    if (this.current === this.cfg.defaultEmotion) return;
    this.revertTimer = setTimeout(() => {
      this.revertTimer = null;
      this.current = this.cfg.defaultEmotion;
      this.lastChangeAt = this.now();
      this.emit(this.current);
    }, this.cfg.revertAfterMs);
  }
}
