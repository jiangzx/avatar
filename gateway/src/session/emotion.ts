// Shared emotion types and config loading live in the neutral i18n layer, so
// memory-side modules never import the session layer.
export {
  EMOTIONS,
  EmotionLexiconSchema,
  loadSharedEmotion,
  mergeEmotion,
} from '../i18n/emotion.ts';
export type {
  Emotion,
  EmotionConfig,
  EmotionLexicon,
  SharedEmotionConfig,
} from '../i18n/emotion.ts';

import type { Emotion, EmotionConfig } from '../i18n/emotion.ts';
import { containsPhrase } from '../i18n/text.ts';

/** First emotion in priority order whose word list matches. Negation is not handled (POC). */
export function tagEmotion(text: string, cfg: EmotionConfig): Emotion | null {
  for (const e of cfg.priority) if (cfg.lexicon[e].some((w) => containsPhrase(text, w))) return e;
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
