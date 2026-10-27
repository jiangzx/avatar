import type { TokenUsage } from '../adapters/types.ts';
import { defaultLogger, type Logger } from '../log/logger.ts';
import type { UsageRecorder, UsageTag } from '../usage/types.ts';

export interface TextCompleteInput {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  jsonMode?: boolean;
  signal: AbortSignal;
  /** Who this call is billed to. Recorded only when the client also has a recorder. */
  usage?: UsageTag;
}

export interface TextModelClient {
  /** Ask the provider for one bare JSON object when jsonMode is set. */
  complete(input: TextCompleteInput): Promise<string>;
}

export interface QwenTextClientOptions {
  apiKey: string;
  endpoint: string;
  model: string;
  /** Usage sink. Eval and probe scripts leave it unset, so their calls are never counted. */
  recorder?: UsageRecorder;
  /** Logs upstream HTTP failures (status, code, request id). Omitted in tests and scripts: stdout default. */
  logger?: Logger;
}

/** Response headers that may carry the upstream request id (P1-T1 probe A4: only x-request-id was observed). */
export const UPSTREAM_REQUEST_ID_HEADERS: readonly string[] = ['x-request-id'];

/** OpenAI-compatible chat call. The key stays in env; nothing here is logged. */
export class QwenTextClient implements TextModelClient {
  constructor(private readonly opts: QwenTextClientOptions) {
    if (!opts.apiKey) throw new Error('DASHSCOPE_API_KEY is required');
    if (!opts.endpoint) throw new Error('SUMMARIZER_ENDPOINT is required');
    if (!opts.model) throw new Error('extract_model_required');
  }

  async complete(input: TextCompleteInput): Promise<string> {
    const started = Date.now();
    try {
      const { content, usage } = await this.request(input);
      this.record(input.usage, usage, Date.now() - started, null);
      return content;
    } catch (error) {
      this.record(input.usage, null, Date.now() - started, error instanceof Error ? error.message : 'extract_unknown');
      throw error;
    }
  }

  private record(tag: UsageTag | undefined, usage: TokenUsage | null, genMs: number, errorCode: string | null): void {
    if (!tag || !this.opts.recorder) return;
    this.opts.recorder.record({ kind: tag.kind, adapter: 'text', model: this.opts.model, usage, attribution: tag.attribution, genMs, errorCode });
  }

  private async request(input: TextCompleteInput): Promise<{ content: string; usage: TokenUsage | null }> {
    let response: Response;
    try {
      response = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.opts.model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          temperature: input.temperature ?? 0,
          max_tokens: input.maxTokens,
          // Supported by the OpenAI-compatible endpoint; keeps planning output parseable.
          ...(input.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error('extract_timeout');
      throw new Error('extract_network_error');
    }
    if (!response.ok) {
      const code = `extract_http_${response.status}`;
      const requestId = UPSTREAM_REQUEST_ID_HEADERS.map((name) => response.headers.get(name)).find((value): value is string => Boolean(value));
      const fields = { source: 'text', model: this.opts.model, code, http_status: response.status, ...(requestId ? { upstream_request_id: requestId } : {}) };
      const logger = this.opts.logger ?? defaultLogger();
      if (response.status === 429 || response.status >= 500) logger.warn('upstream_error', fields);
      else logger.error('upstream_error', fields);
      throw new Error(code);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error('extract_invalid_json'); }
    const content = messageContent(payload);
    if (!content) throw new Error('extract_invalid_response');
    return { content, usage: parseChatUsage(payload) };
  }
}

/** Wraps a client so every call carries `tag` unless the caller set its own. */
export function withUsageTag(client: TextModelClient, tag: UsageTag): TextModelClient {
  return { complete: (input) => client.complete(input.usage ? input : { ...input, usage: tag }) };
}

/** OpenAI-compatible `usage` → TokenUsage. Text models have no audio, so totals are text tokens. */
export function parseChatUsage(payload: unknown): TokenUsage | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as { usage?: unknown }).usage;
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') return null;
  const usage: TokenUsage = { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, inputTextTokens: u.prompt_tokens, outputTextTokens: u.completion_tokens };
  const details = u.prompt_tokens_details;
  if (details && typeof details === 'object') {
    const cached = (details as Record<string, unknown>).cached_tokens;
    if (typeof cached === 'number' && cached >= 0) usage.cachedTokens = cached;
  }
  return usage;
}

function messageContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as { message?: unknown }).message : null;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' && content.trim() ? content.trim() : null;
}
