export interface LedgerEntry {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  interrupted?: boolean;
}

export interface Summarizer {
  summarize(previous: string, entries: readonly LedgerEntry[]): Promise<string>;
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

const label = (e: LedgerEntry) => (e.role === 'user' ? '用户' : '助手');

/** In-memory, model-agnostic conversation record. Never persisted, never logged. */
export class ConversationLedger {
  private entries: LedgerEntry[] = [];
  private summaryText = '';
  private summarizing = false;
  private generation = 0;

  constructor(private readonly opts: LedgerOptions = DEFAULT_LEDGER_OPTIONS) {}

  get summary(): string {
    return this.summaryText;
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
    return this.userTurns() > this.opts.summarizeAfterTurns || tokens > this.opts.summarizeAfterTokens;
  }

  /** Compresses everything before the last `keepRecentTurns` user turns. Returns true if applied. */
  async summarize(summarizer: Summarizer): Promise<boolean> {
    if (this.summarizing) return false;
    const cut = this.keepFromIndex();
    if (cut === 0) return false;
    this.summarizing = true;
    const generation = this.generation;
    try {
      const next = await summarizer.summarize(this.summaryText, this.entries.slice(0, cut));
      if (generation !== this.generation) return false;
      this.summaryText = next;
      this.entries.splice(0, cut);
      return true;
    } finally {
      this.summarizing = false;
    }
  }

  buildInstructions(persona: string): string {
    const lines = this.entries.map((e) => `${label(e)}：${e.text}`);
    return [
      persona.trim(),
      '## 对话摘要',
      this.summaryText || '（暂无）',
      '## 最近对话',
      lines.length > 0 ? lines.join('\n') : '（暂无）',
    ].join('\n\n');
  }

  clear(): void {
    this.entries = [];
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
  async summarize(previous: string, entries: readonly LedgerEntry[]): Promise<string> {
    const joined = [previous, ...entries.map((e) => `${label(e)}：${e.text}`)].filter(Boolean).join('；');
    return joined.length > 800 ? joined.slice(joined.length - 800) : joined;
  }
}
