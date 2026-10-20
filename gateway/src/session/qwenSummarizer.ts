import type { LedgerEntry, Summarizer } from './ledger.ts';

export type SummaryLanguage = 'zh' | 'ja';

export interface QwenSummarizerOptions {
  apiKey: string;
  endpoint: string;
  model: string;
  language?: SummaryLanguage;
  timeoutMs?: number;
}

const SYSTEM_PROMPTS: Record<SummaryLanguage, string> = {
  zh: '将给定的一组用户原话压缩成简洁的中文摘要。只记录用户明确说过的信息、经历和偏好，不要推断、评价或编造细节，记不清的不写。保留称呼、人和事、明确表达的情绪以及未完成话题。只输出摘要正文，不要添加标题或解释。',
  ja: '会話を簡潔な日本語の要約にしてください。呼び名、自己紹介、人や出来事、気持ち、未完の話題を残してください。要約本文だけを出力してください。',
};

export class QwenSummarizer implements Summarizer {
  private readonly opts: Required<QwenSummarizerOptions>;

  constructor(options: QwenSummarizerOptions) {
    if (!options.apiKey) throw new Error('DASHSCOPE_API_KEY is required');
    if (!options.endpoint) throw new Error('SUMMARIZER_ENDPOINT is required');
    if (!options.model) throw new Error('SUMMARIZER_MODEL is required');
    this.opts = { language: 'zh', timeoutMs: 10000, ...options };
    if (!this.opts.language) this.opts.language = 'zh';
  }

  async summarize(previous: string, entries: readonly LedgerEntry[]): Promise<string> {
    // Only user lines are evidence for user memory; assistant replies never enter the summary source.
    const users = entries.filter((entry) => entry.role === 'user');
    if (users.length === 0) return previous;
    const transcript = [
      previous ? `已有摘要：${previous}` : '',
      ...users.map((entry) => `用户：${entry.text}`),
    ].filter(Boolean).join('\n');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(this.opts.endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.opts.model, messages: [{ role: 'system', content: SYSTEM_PROMPTS[this.opts.language] }, { role: 'user', content: transcript }], temperature: 0, max_tokens: 600 }),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw new Error('summarizer_timeout');
        throw new Error('summarizer_network_error');
      }
      if (!response.ok) throw new Error(`summarizer_http_${response.status}`);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new Error('summarizer_invalid_json'); }
      const content = extractContent(payload);
      if (!content) throw new Error('summarizer_invalid_response');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as { message?: unknown }).message : null;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' && content.trim() ? content.trim() : null;
}
