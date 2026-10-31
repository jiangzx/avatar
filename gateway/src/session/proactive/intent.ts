// Model-agnostic intent contract (spec 意图契约). P3 back half builds it from a Decision and renders it per adapter.
import type { Language } from '@anyidea/protocol';
import type { IntentKind } from './config.ts';
import type { CareStage, Familiarity, Moment } from './engine.ts';

export type QuestionMode = 'forbidden' | 'allowed' | 'required';

export interface ProactiveIntent {
  moment: Moment;
  kind: IntentKind;
  /** Locked material: verbatim user words (with when they were said) and prompt-safe facts. Empty = speak from purpose only. */
  material: {
    quotes: ReadonlyArray<{ text: string; said: string | null }>;
    facts: readonly string[];
    /** The one question this line must (or may) ask; already locked, never in the session prompt. */
    question?: { text: string; said: string | null; topic: boolean };
  };
  tone: { familiarity: Familiarity; stage: CareStage | null; allowJoke: boolean };
  constraints: { maxChars: number; question: QuestionMode; mustExpress: 'presence' | null };
  language: Language;
  /** Key of the fallback line group in director.json when the adapter fails or stays silent. */
  fallbackKey: string;
  /** card:/fact:/pin:/thread:/stmt: key for negative-preference tracking. */
  questionKey?: string;
}
