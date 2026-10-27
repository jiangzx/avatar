import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QwenTextClient, parseChatUsage, withUsageTag, type TextModelClient } from '../src/memory/textClient.ts';
import { QwenSummarizer } from '../src/session/qwenSummarizer.ts';
import type { UsageRecord, UsageRecorder, UsageTag } from '../src/usage/types.ts';

function recorder(): UsageRecorder & { rows: UsageRecord[] } {
  const rows: UsageRecord[] = [];
  return { rows, record: (r) => { rows.push(r); }, flush: () => {} };
}

const tag: UsageTag = { kind: 'memory_extract', attribution: { ownerId: 'o1', agentId: 'a1', sessionId: null, characterId: null } };

afterEach(() => { vi.unstubAllGlobals(); });

describe('parseChatUsage', () => {
  it('maps OpenAI-compatible usage to text tokens', () => {
    expect(parseChatUsage({ usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }))
      .toEqual({ inputTokens: 120, outputTokens: 30, inputTextTokens: 120, outputTextTokens: 30 });
    expect(parseChatUsage({ usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } }))
      .toEqual({ inputTokens: 120, outputTokens: 30, inputTextTokens: 120, outputTextTokens: 30, cachedTokens: 100 });
  });

  it('returns null when counts are missing or not numbers', () => {
    expect(parseChatUsage({})).toBeNull();
    expect(parseChatUsage({ usage: { prompt_tokens: '1', completion_tokens: 2 } })).toBeNull();
    expect(parseChatUsage(null)).toBeNull();
  });
});

describe('QwenTextClient usage', () => {
  it('records usage only when both a recorder and a tag are present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 50, completion_tokens: 7 },
    }), { status: 200 })));
    const r = recorder();
    const client = new QwenTextClient({ apiKey: 'k', endpoint: 'https://example.test/chat', model: 'qwen-plus', recorder: r });
    const signal = new AbortController().signal;
    await expect(client.complete({ system: 's', user: 'u', maxTokens: 10, signal })).resolves.toBe('ok');
    expect(r.rows).toHaveLength(0);
    await expect(client.complete({ system: 's', user: 'u', maxTokens: 10, signal, usage: tag })).resolves.toBe('ok');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      kind: 'memory_extract', adapter: 'text', model: 'qwen-plus', errorCode: null,
      attribution: tag.attribution,
      usage: { inputTokens: 50, outputTokens: 7, inputTextTokens: 50, outputTextTokens: 7 },
    });
    expect(typeof r.rows[0]!.genMs).toBe('number');
  });

  it('records a failed call with its error code and rethrows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    const r = recorder();
    const client = new QwenTextClient({ apiKey: 'k', endpoint: 'https://example.test/chat', model: 'qwen-plus', recorder: r });
    await expect(client.complete({ system: 's', user: 'u', maxTokens: 10, signal: new AbortController().signal, usage: tag }))
      .rejects.toThrow('extract_http_429');
    expect(r.rows).toEqual([expect.objectContaining({ usage: null, errorCode: 'extract_http_429', model: 'qwen-plus' })]);
  });

  it('withUsageTag adds the tag unless the caller already set one', async () => {
    const seen: Array<UsageTag | undefined> = [];
    const inner: TextModelClient = { complete: async (input) => { seen.push(input.usage); return 'x'; } };
    const tagged = withUsageTag(inner, tag);
    const signal = new AbortController().signal;
    await tagged.complete({ system: 's', user: 'u', maxTokens: 1, signal });
    const other: UsageTag = { kind: 'care', attribution: tag.attribution };
    await tagged.complete({ system: 's', user: 'u', maxTokens: 1, signal, usage: other });
    expect(seen).toEqual([tag, other]);
  });
});

describe('QwenSummarizer usage', () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('records summarize usage with the constructor tag', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'sum' } }], usage: { prompt_tokens: 80, completion_tokens: 20 } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const r = recorder();
    const summarizeTag: UsageTag = { kind: 'summarize', attribution: { ownerId: 'o1', agentId: 'a1', sessionId: 's1', characterId: 'xiaonuan' } };
    const summarizer = new QwenSummarizer({ apiKey: 'k', endpoint: `http://127.0.0.1:${port}/chat`, model: 'qwen-flash', recorder: r, tag: summarizeTag });
    await expect(summarizer.summarize('', [{ role: 'user', text: 'u', ts: 1 }])).resolves.toBe('sum');
    expect(r.rows).toEqual([expect.objectContaining({
      kind: 'summarize', adapter: 'text', model: 'qwen-flash', attribution: summarizeTag.attribution, errorCode: null,
      usage: { inputTokens: 80, outputTokens: 20, inputTextTokens: 80, outputTextTokens: 20 },
    })]);
  });
});
