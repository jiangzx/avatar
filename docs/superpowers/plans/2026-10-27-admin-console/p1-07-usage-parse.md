# P1-T7: 解析用量（Qwen details、文本模型 usage、Mock 模拟用量）

**目标：** 让每一次模型调用都能拿到「文本输入 / 音频输入 / 文本输出 / 音频输出 / 缓存」五类 token：Qwen realtime 从 `response.done.response.usage` 的 details 拆分；文本客户端和摘要器从 OpenAI 兼容响应的 `usage` 取；Mock 在打开开关时按回复长度发一条模拟用量。本任务只负责「解析出来」，不写库（写库在 P1-T9）。

**实现的 spec 章节：** 「架构 / 用量记录」第 1、5 条；决策 Q8、Q22、Q36；「价格」中 usage 结构说明。

**前置：** P1-T1 已完成，`docs/testing/2026-10-27-admin-usage-probe.md` 已记录真实字段名。开始前在仓库根目录跑一次 `npm test -w gateway && npm run typecheck -w gateway`，确认基线全绿。

**行号说明：** P1-T5、P1-T6 会改动 `session.ts`、`worker.ts` 的 `log(...)` 调用，行号可能偏移。下文行号是 2026-10-27 的位置，执行时按符号名定位。

**Files:**
- Modify: `gateway/src/adapters/types.ts:31-34`（`TokenUsage` 扩展，C3）
- Modify: `gateway/src/adapters/qwen.ts:200-204`（`parseUsage` 解析 details）
- Modify: `gateway/src/adapters/mock.ts:31-44`（`MockOptions.emitUsage`）、`gateway/src/adapters/mock.ts:196-200`（`streamReply` 完成时发用量）
- Modify: `gateway/src/memory/textClient.ts`（整文件：返回前解析 usage；`withUsageTag`；`parseChatUsage`；记录接口留给 P1-T9 接线）
- Modify: `gateway/src/session/qwenSummarizer.ts`（解析 usage，暴露给 P1-T9）
- Test: `gateway/test/qwen.test.ts`（追加）
- Test: `gateway/test/mock.test.ts`（追加）
- Test: `gateway/test/usage-parse.test.ts`（新建）

**Interfaces:**
- Consumes：无（只读 P1-T1 的探针记录）。
- Produces：
  - C3 `TokenUsage`（逐字）：
    ```ts
    export interface TokenUsage {
      inputTokens: number;
      outputTokens: number;
      inputTextTokens?: number;
      inputAudioTokens?: number;
      outputTextTokens?: number;
      outputAudioTokens?: number;
      cachedTokens?: number;
      estimated?: boolean;
    }
    ```
  - `gateway/src/memory/textClient.ts`：
    ```ts
    export function parseChatUsage(payload: unknown): TokenUsage | null;
    export function withUsageTag(client: TextModelClient, tag: UsageTag): TextModelClient;
    export interface TextCompleteInput { system: string; user: string; maxTokens: number; temperature?: number; jsonMode?: boolean; signal: AbortSignal; usage?: UsageTag }
    export interface TextModelClient { complete(input: TextCompleteInput): Promise<string> }
    export interface QwenTextClientOptions { apiKey: string; endpoint: string; model: string; recorder?: UsageRecorder }
    ```
    `QwenTextClient` 在本任务里已经接收 `recorder`、在 `input.usage` 与 `recorder` 同时存在时调用 `recorder.record(...)`（C3 规则）。`UsageRecorder`、`UsageTag` 的类型文件 `gateway/src/usage/types.ts` 由本任务创建（P1-T9 只实现 `SqliteUsageRecorder`）。
  - `gateway/src/usage/types.ts`（C3 逐字）：`UsageKind`、`UsageAttribution`、`SYSTEM_ATTRIBUTION`、`UsageRecord`、`UsageRecorder`、`UsageTag`。
  - `QwenSummarizerOptions` 新增 `recorder?: UsageRecorder; tag?: UsageTag`（两者都有才记录）。
  - `MockOptions.emitUsage?: boolean`，默认 `false`。

## 字段名分支（读 P1-T1 探针记录后决定）

| 探针结论 | 本任务做法 |
|---|---|
| `response.done.response.usage` 有 `input_tokens_details.{text_tokens,audio_tokens}` 与 `output_tokens_details.{text_tokens,audio_tokens}`（官方文档写法） | 按下文代码原样实现 |
| details 键名是 `input_token_details` / `output_token_details`（OpenAI 写法） | 下文 `detailsOf` 已同时兼容两种写法，不用改 |
| 有缓存字段（如 `input_tokens_details.cached_tokens`） | `cachedTokens` 取该值；探针显示没有就保持 undefined |
| 文本模型 `usage.prompt_tokens_details.cached_tokens` 不存在 | `cachedTokens` 保持 undefined |
| 探针显示字段完全不同 | 停下，按 AGENTS.md 第 7 条报告，不要猜 |

## Steps

- [x] **Step 1: 新建用量类型文件**

新建 `gateway/src/usage/types.ts`：

```ts
import type { TokenUsage } from '../adapters/types.ts';

/** Which kind of model call a usage row belongs to. */
export type UsageKind = 'realtime_reply' | 'memory_extract' | 'summarize' | 'care' | 'affect' | 'silence_plan' | 'recall_wrap';

/** Who a call is billed to. Null fields mean "system" (no owner or session). */
export interface UsageAttribution { ownerId: string | null; agentId: string | null; sessionId: string | null; characterId: string | null }

export const SYSTEM_ATTRIBUTION: UsageAttribution = Object.freeze({ ownerId: null, agentId: null, sessionId: null, characterId: null });

export interface UsageRecord {
  kind: UsageKind;
  adapter: 'qwen' | 'mock' | 'text';
  model: string;
  usage: TokenUsage | null;
  attribution: UsageAttribution;
  firstAudioMs?: number | null;
  genMs?: number | null;
  errorCode?: string | null;
  ts?: number;
}

/** Content-free usage sink. record() must never throw. */
export interface UsageRecorder { record(record: UsageRecord): void; flush(): void }

export interface UsageTag { kind: UsageKind; attribution: UsageAttribution }
```

- [x] **Step 2: 写失败的 Qwen 解析测试**

在 `gateway/test/qwen.test.ts` 的 `describe` 块末尾（现有 `'emits speech stop and token usage from server events'` 之后）追加：

```ts
  it('splits realtime usage into text and audio tokens', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as { type: string };
      if (e.type !== 'session.update') return;
      ws.send(JSON.stringify({ type: 'session.updated' }));
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'r1' } }));
      ws.send(JSON.stringify({ type: 'response.done', response: { id: 'r1', status: 'completed', usage: {
        input_tokens: 300, output_tokens: 90,
        input_tokens_details: { text_tokens: 260, audio_tokens: 40, cached_tokens: 0 },
        output_tokens_details: { text_tokens: 15, audio_tokens: 75 },
      } } }));
      ws.send(JSON.stringify({ type: 'response.created', response: { id: 'r2' } }));
      ws.send(JSON.stringify({ type: 'response.done', response: { id: 'r2', status: 'completed', usage: {
        input_tokens: 10, output_tokens: 5,
        input_token_details: { text_tokens: 8, audio_tokens: 2 },
        output_token_details: { text_tokens: 1, audio_tokens: 4 },
      } } }));
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'fixture' });
    const seen: unknown[] = [];
    a.on('responseUsage', (id, usage) => seen.push([id, usage]));
    await a.connect({ instructions: 'fixture', tools: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([
      ['r1', { inputTokens: 300, outputTokens: 90, inputTextTokens: 260, inputAudioTokens: 40, cachedTokens: 0, outputTextTokens: 15, outputAudioTokens: 75 }],
      ['r2', { inputTokens: 10, outputTokens: 5, inputTextTokens: 8, inputAudioTokens: 2, outputTextTokens: 1, outputAudioTokens: 4 }],
    ]);
    a.close();
  });
```

- [x] **Step 3: 运行，确认失败**

Run: `npm test -w gateway -- test/qwen.test.ts`
Expected: FAIL，新测试的期望对象多出 `inputTextTokens` 等字段（实际只有两个总数）。现有 `'emits speech stop and token usage from server events'` 仍 PASS。

- [x] **Step 4: 扩展 `TokenUsage` 并实现 `parseUsage`**

`gateway/src/adapters/types.ts:31-34` 替换为：

```ts
/** Token counts for one model call. Detail fields are present only when the provider reports them. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  inputTextTokens?: number;
  inputAudioTokens?: number;
  outputTextTokens?: number;
  outputAudioTokens?: number;
  cachedTokens?: number;
  /** True when the counts are synthetic or derived, not provider-reported. */
  estimated?: boolean;
}
```

`gateway/src/adapters/qwen.ts:200-204` 的 `parseUsage` 替换为：

```ts
function parseUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Json;
  if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null;
  const usage: TokenUsage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
  // Qwen documents input_tokens_details; the OpenAI spelling is accepted too.
  const input = detailsOf(u.input_tokens_details ?? u.input_token_details);
  const output = detailsOf(u.output_tokens_details ?? u.output_token_details);
  if (input.text !== undefined) usage.inputTextTokens = input.text;
  if (input.audio !== undefined) usage.inputAudioTokens = input.audio;
  if (input.cached !== undefined) usage.cachedTokens = input.cached;
  if (output.text !== undefined) usage.outputTextTokens = output.text;
  if (output.audio !== undefined) usage.outputAudioTokens = output.audio;
  return usage;
}

function detailsOf(raw: unknown): { text?: number; audio?: number; cached?: number } {
  if (!raw || typeof raw !== 'object') return {};
  const d = raw as Json;
  const pick = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return { text: pick(d.text_tokens), audio: pick(d.audio_tokens), cached: pick(d.cached_tokens) };
}
```

注意：`exactOptionalPropertyTypes` 下不能把 `undefined` 赋给可选字段，所以用 `if` 逐个赋值。

- [x] **Step 5: 运行，确认通过**

Run: `npm test -w gateway -- test/qwen.test.ts`
Expected: PASS（含原有用量测试，原测试期望 `{ inputTokens: 321, outputTokens: 45 }` 不受影响）。

- [x] **Step 6: 写失败的 Mock 模拟用量测试**

在 `gateway/test/mock.test.ts` 末尾追加（文件顶部已有 `MockAdapter` 的 import；若没有 `vi` 的 import，在现有 vitest import 里加上）：

```ts
describe('MockAdapter synthetic usage', () => {
  const script = { greeting: '你好呀', followup: '还在吗', fallbackReply: '我在听', turns: [] };

  it('emits estimated usage before responseDone only when enabled', async () => {
    vi.useFakeTimers();
    try {
      const on = new MockAdapter({ script, replyDelayMs: 10, charMs: 100, chunkMs: 100, paceFactor: 1, emitUsage: true });
      const off = new MockAdapter({ script, replyDelayMs: 10, charMs: 100, chunkMs: 100, paceFactor: 1 });
      const seen: string[] = [];
      const usages: unknown[] = [];
      on.on('responseUsage', (_id, usage) => { seen.push('usage'); usages.push(usage); });
      on.on('responseDone', () => seen.push('done'));
      let offUsage = 0;
      off.on('responseUsage', () => offUsage++);
      await on.connect({ instructions: '1234567890', tools: [] });
      await off.connect({ instructions: '1234567890', tools: [] });
      on.createResponse();
      off.createResponse();
      await vi.advanceTimersByTimeAsync(2000);
      expect(seen).toEqual(['usage', 'done']);
      // '你好呀' = 3 chars → 300 ms of audio at charMs 100 → round(0.3 * 12.5) = 4 audio tokens.
      expect(usages).toEqual([{ inputTokens: 5, outputTokens: 7, inputTextTokens: 5, outputTextTokens: 3, outputAudioTokens: 4, estimated: true }]);
      expect(offUsage).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [x] **Step 7: 运行，确认失败**

Run: `npm test -w gateway -- test/mock.test.ts`
Expected: FAIL，`seen` 为 `['done']`（还没有 `emitUsage`），并且 typecheck 层面 `emitUsage` 不是已知选项（vitest 不做类型检查，所以表现为断言失败）。

- [x] **Step 8: 实现 Mock 模拟用量**

`gateway/src/adapters/mock.ts` 的 `MockOptions`（:31-44）末尾、`cancelGapMs` 之后加：

```ts
  /** Emit a synthetic, estimated responseUsage before responseDone (admin pipeline without a model key). */
  emitUsage?: boolean;
```

文件顶部的类型 import 改为同时引入 `TokenUsage`：

```ts
import type { AdapterEvents, ProactiveCue, ProactiveRequest, RealtimeAdapter, SessionConfig, TokenUsage } from './types.ts';
```

`streamReply` 中完成分支（:196-200）：

```ts
      if (i >= chunks) {
        this.active = null;
        this.emit('responseDone', handle.id);
        return;
      }
```

替换为：

```ts
      if (i >= chunks) {
        this.active = null;
        if (this.opts.emitUsage) this.emit('responseUsage', handle.id, this.syntheticUsage(text, totalMs));
        this.emit('responseDone', handle.id);
        return;
      }
```

在 `cancelActive()` 方法之前加私有方法：

```ts
  /** Deterministic fake counts: ~2 instruction chars per token, 1 token per reply char, 12.5 audio tokens per second. */
  private syntheticUsage(text: string, totalMs: number): TokenUsage {
    const inputTextTokens = Math.ceil(this.instructions.length / 2);
    const outputTextTokens = text.length;
    const outputAudioTokens = Math.round((totalMs / 1000) * 12.5);
    return {
      inputTokens: inputTextTokens,
      outputTokens: outputTextTokens + outputAudioTokens,
      inputTextTokens,
      outputTextTokens,
      outputAudioTokens,
      estimated: true,
    };
  }
```

- [x] **Step 9: 运行，确认通过**

Run: `npm test -w gateway -- test/mock.test.ts`
Expected: PASS。

- [x] **Step 10: 写失败的文本客户端用量测试**

新建 `gateway/test/usage-parse.test.ts`：

```ts
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
```

- [x] **Step 11: 运行，确认失败**

Run: `npm test -w gateway -- test/usage-parse.test.ts`
Expected: FAIL，`parseChatUsage`、`withUsageTag` 不存在（import 报错）。

- [x] **Step 12: 实现文本客户端用量**

`gateway/src/memory/textClient.ts` 整文件替换为：

```ts
import type { TokenUsage } from '../adapters/types.ts';
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
}

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
    if (!response.ok) throw new Error(`extract_http_${response.status}`);
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
```

`gateway/src/memory/extract.ts:11` 现在 `export type { TextModelClient } from './textClient.ts';` 保持不变。其他实现 `TextModelClient` 的测试桩（`complete: async (input) => ...`）因为 input 类型只是多了可选字段，不需要改。

- [x] **Step 13: 实现摘要器用量**

`gateway/src/session/qwenSummarizer.ts`：

1. 顶部 import 改为：

```ts
import type { Language } from '@anyidea/protocol';
import type { TokenUsage } from '../adapters/types.ts';
import { parseChatUsage } from '../memory/textClient.ts';
import { PROMPT_LABELS } from '../roles/labels.ts';
import type { UsageRecorder, UsageTag } from '../usage/types.ts';
import type { LedgerEntry, Summarizer } from './ledger.ts';
```

2. `QwenSummarizerOptions` 改为：

```ts
export interface QwenSummarizerOptions {
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs?: number;
  /** Usage sink and the session it bills; both are needed to record. */
  recorder?: UsageRecorder;
  tag?: UsageTag;
}
```

3. 字段类型 `private readonly opts: Required<QwenSummarizerOptions>;` 改为：

```ts
  private readonly opts: QwenSummarizerOptions & { timeoutMs: number };
```

4. `summarize` 方法体中从 `const controller = new AbortController();` 到方法结束替换为：

```ts
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const started = Date.now();
    try {
      const { content, usage } = await this.request(language, transcript, controller.signal);
      this.record(usage, Date.now() - started, null);
      return content;
    } catch (error) {
      this.record(null, Date.now() - started, error instanceof Error ? error.message : 'summarizer_unknown');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private record(usage: TokenUsage | null, genMs: number, errorCode: string | null): void {
    const { recorder, tag } = this.opts;
    if (!recorder || !tag) return;
    recorder.record({ kind: tag.kind, adapter: 'text', model: this.opts.model, usage, attribution: tag.attribution, genMs, errorCode });
  }

  private async request(language: Language, transcript: string, signal: AbortSignal): Promise<{ content: string; usage: TokenUsage | null }> {
    let response: Response;
    try {
      response = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.opts.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPTS[language] },
            { role: 'user', content: transcript },
          ],
          temperature: 0,
          max_tokens: 600,
        }),
        signal,
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
    return { content, usage: parseChatUsage(payload) };
  }
```

`extractContent` 函数保持不变。

- [x] **Step 14: 运行新测试与相关旧测试**

Run: `npm test -w gateway -- test/usage-parse.test.ts test/summarizer.test.ts test/extract.test.ts`
Expected: 全部 PASS。

- [x] **Step 15: 全量回归与类型检查**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS；typecheck 无错误。若有测试桩因 `TextModelClient` 签名报类型错误，只把桩的参数类型改为 `TextCompleteInput`，不改行为。

- [x] **Step 16: 提交**

```bash
git add gateway/src/usage/types.ts gateway/src/adapters/types.ts gateway/src/adapters/qwen.ts gateway/src/adapters/mock.ts \
  gateway/src/memory/textClient.ts gateway/src/session/qwenSummarizer.ts \
  gateway/test/qwen.test.ts gateway/test/mock.test.ts gateway/test/usage-parse.test.ts
git commit -m "feat(gateway): parse text and audio token usage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收

- Qwen `response.done` 的 details 被拆成 5 个字段；只有总数时行为与原来一致。
- 文本客户端、摘要器在「recorder + tag」同时存在时各记录一次，失败也记录（`usage: null`、带错误码），并照常抛错。
- Mock 只有 `emitUsage: true` 才发模拟用量，且 `estimated: true`。
- 本任务没有任何写库代码；`gateway/src/usage/types.ts` 与 C3 逐字一致。
