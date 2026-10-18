export interface TextModelClient {
  complete(input: { system: string; user: string; maxTokens: number; signal: AbortSignal }): Promise<string>;
}

export interface QwenTextClientOptions {
  apiKey: string;
  endpoint: string;
  model: string;
}

/** OpenAI-compatible chat call. The key stays in env; nothing here is logged. */
export class QwenTextClient implements TextModelClient {
  constructor(private readonly opts: QwenTextClientOptions) {
    if (!opts.apiKey) throw new Error('DASHSCOPE_API_KEY is required');
    if (!opts.endpoint) throw new Error('SUMMARIZER_ENDPOINT is required');
    if (!opts.model) throw new Error('extract_model_required');
  }

  async complete(input: { system: string; user: string; maxTokens: number; signal: AbortSignal }): Promise<string> {
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
          temperature: 0,
          max_tokens: input.maxTokens,
        }),
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error('extract_timeout');
      throw new Error('extract_network_error');
    }
    if (!response.ok) throw new Error(`extract_http_${response.status}`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error('extract_invalid_json'); }
    const content = messageContent(payload);
    if (!content) throw new Error('extract_invalid_response');
    return content;
  }
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
