import type { Language } from '@anyidea/protocol';
import { PROMPT_LABELS, type PromptLabels } from '../roles/labels.ts';

export interface LedgerEntry {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  interrupted?: boolean;
}

export interface Summarizer {
  summarize(previous: string, entries: readonly LedgerEntry[], language?: Language): Promise<string>;
}

export interface LedgerOptions {
  keepRecentTurns: number;
  summarizeAfterTurns: number;
  summarizeAfterTokens: number;
}

export const DEFAULT_LEDGER_OPTIONS: LedgerOptions = {
  keepRecentTurns: 8,
  summarizeAfterTurns: 16,
  summarizeAfterTokens: 6000,
};

/** Conservative estimate: roughly one token per CJK character. */
export function estimateTokens(text: string): number {
  return text.length;
}

const label = (e: LedgerEntry, labels: PromptLabels) => (e.role === 'user' ? labels.user : labels.assistant);

/** In-memory, model-agnostic conversation record. Never persisted, never logged. */
export class ConversationLedger {
  private entries: LedgerEntry[] = [];
  private summaryText = '';
  private summarizing = false;
  private generation = 0;
  private summarizeAfterTokens: number;

  constructor(private readonly opts: LedgerOptions = DEFAULT_LEDGER_OPTIONS) {
    this.summarizeAfterTokens = opts.summarizeAfterTokens;
  }

  get summary(): string {
    return this.summaryText;
  }

  get summarizeThreshold(): number {
    return this.summarizeAfterTokens;
  }

  /** Only lower it: a later language switch must never postpone summarization. */
  setSummarizeAfterTokens(tokens: number): void {
    if (!Number.isFinite(tokens)) return;
    this.summarizeAfterTokens = Math.min(this.summarizeAfterTokens, tokens);
  }

  get recent(): readonly LedgerEntry[] {
    return this.entries;
  }

  addUser(text: string, ts: number): void {
    if (text.trim()) this.entries.push({ role: 'user', text, ts });
  }

  addAssistant(text: string, ts: number, interrupted = false): void {
    if (!text.trim()) return;
    this.entries.push(interrupted ? { role: 'assistant', text, ts, interrupted } : { role: 'assistant', text, ts });
  }

  userTurns(): number {
    return this.entries.filter((e) => e.role === 'user').length;
  }

  needsSummary(): boolean {
    const tokens = estimateTokens(this.summaryText) + this.entries.reduce((n, e) => n + estimateTokens(e.text), 0);
    return this.userTurns() > this.opts.summarizeAfterTurns || tokens > this.summarizeAfterTokens;
  }

  /** Compresses everything before the last `keepRecentTurns` user turns. Returns true if applied. */
  async summarize(summarizer: Summarizer, language: Language = 'zh'): Promise<boolean> {
    if (this.summarizing) return false;
    const cut = this.keepFromIndex();
    if (cut === 0) return false;
    this.summarizing = true;
    const generation = this.generation;
    try {
      const next = await summarizer.summarize(this.summaryText, this.entries.slice(0, cut), language);
      if (generation !== this.generation) return false;
      this.summaryText = next;
      this.entries.splice(0, cut);
      return true;
    } finally {
      this.summarizing = false;
    }
  }

  buildInstructions(persona: string, labels: PromptLabels = PROMPT_LABELS.zh): string {
    const lines = this.entries.map((e) => `${label(e, labels)}${labels.separator}${e.text}`);
    return [
      persona.trim(),
      labels.summaryHeader,
      this.summaryText || labels.empty,
      labels.recentHeader,
      lines.length > 0 ? lines.join('\n') : labels.empty,
    ].join('\n\n');
  }

  clear(): void {
    this.entries = [];
    this.summaryText = '';
    this.generation++;
  }

  /**
   * Forget one topic: drop the summary and any line naming it, keep the rest of this
   * session so unrelated context survives. The generation bump discards a summary in flight.
   */
  forget(query: string, triggerText?: string | null): void {
    const forgotten = (text: string) => text.includes(query) || (triggerText != null && text === triggerText);
    this.entries = this.entries.filter((entry) => !forgotten(entry.text));
    this.summaryText = '';
    this.generation++;
  }

  private keepFromIndex(): number {
    let seen = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].role === 'user' && ++seen === this.opts.keepRecentTurns) return i;
    }
    return 0;
  }
}

/** Key-free stand-in for the LLM summarizer used in Plan 2. */
export class MockSummarizer implements Summarizer {
  async summarize(previous: string, entries: readonly LedgerEntry[], language: Language = 'zh'): Promise<string> {
    const labels = PROMPT_LABELS[language];
    const joined = [previous, ...entries.map((e) => `${label(e, labels)}${labels.separator}${e.text}`)]
      .filter(Boolean)
      .join(labels.summaryJoiner);
    return joined.length > 800 ? joined.slice(joined.length - 800) : joined;
  }
}
