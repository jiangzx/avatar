# P1-T1: 用量探针（A1 / A4 / A5）

**目标：** 用真实 Qwen 验证 spec「未验证假设」里的 A1、A4、A5，把**键名和数字**（绝不含文本）记到 `docs/testing/2026-10-27-admin-usage-probe.md`。后续 P1-T6（上游错误请求 id）和 P1-T7（usage 解析）按这里的结论写代码。

**实现的 spec 章节：** 「未验证假设」A1、A4、A5；「测试与验收」探针一节；「价格」中 usage 结构一段。

**前置：** 无。需要 `gateway/.env` 里有 `DASHSCOPE_API_KEY`、`QWEN_ENDPOINT`、`QWEN_SUMMARIZER_ENDPOINT`（不要打印文件内容）。开始前跑一次 `npm test -w gateway && npm run typecheck -w gateway`，确认基线全绿。

**Files:**
- Create: `gateway/scripts/lib/usage-probe.ts`（纯函数：只输出结构和数字）
- Create: `gateway/scripts/probe-admin-usage.ts`（探针入口）
- Create: `docs/testing/2026-10-27-admin-usage-probe.md`（结果记录）
- Test: `gateway/test/usageProbe.test.ts`（新建）

**Interfaces:**
- Consumes：`gateway/scripts/lib/qwen-raw.ts` 的 `QwenRaw`、`baseSession`、`userText`、`probeEnv`、`readWavPcm16`、`sleep`、`type Json`（现有，不改）。
- Produces（只给人看，不被运行时代码 import）：
  - `leafShape(value: unknown, prefix?: string): Record<string, number | string>`
  - `usagePaths(value: unknown, prefix?: string): string[]`
  - `idLikePaths(value: unknown, prefix?: string): string[]`
  - `idLikeHeaderNames(names: Iterable<string>): string[]`
  - `expectedAudioTokens(seconds: number, perSecond: number): number`
  - 结果文档里的三条结论，P1-T6、P1-T7 直接引用。

## 隐私规则（本任务硬约束）

- 探针输入只用下面写死的合成句子和你自己生成的合成音频，**不用任何真实用户数据**。
- 输出只允许：事件类型、键路径、数字、布尔、字符串**长度**。模型回复文本、转写文本、错误 message 一律不打印（`leafShape` 把字符串替换成 `string(<长度>)`）。
- 结果文档同样只记键名和数字。

## Steps

- [ ] **Step 1: 写失败的辅助函数测试**

新建 `gateway/test/usageProbe.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { expectedAudioTokens, idLikeHeaderNames, idLikePaths, leafShape, usagePaths } from '../scripts/lib/usage-probe.ts';

describe('usage probe helpers', () => {
  it('keeps numbers and replaces every string with its length only', () => {
    const shape = leafShape({ usage: { input_tokens: 12, input_tokens_details: { audio_tokens: 7, text_tokens: 5 } }, note: '秘密内容', ok: true, none: null });
    expect(shape).toEqual({
      'usage.input_tokens': 12,
      'usage.input_tokens_details.audio_tokens': 7,
      'usage.input_tokens_details.text_tokens': 5,
      note: 'string(4)',
      ok: 'boolean',
      none: 'null',
    });
    expect(JSON.stringify(shape)).not.toContain('秘密');
  });

  it('describes arrays by length and the shape of their first element', () => {
    expect(leafShape({ choices: [{ index: 0, message: { content: '你好' } }, { index: 1 }] })).toEqual({
      'choices.length': 2,
      'choices[0].index': 0,
      'choices[0].message.content': 'string(2)',
    });
  });

  it('finds every nested usage object path', () => {
    expect(usagePaths({ type: 'response.done', response: { usage: { total_tokens: 3 } } })).toEqual(['response.usage']);
    expect(usagePaths({ usage: { a: 1 }, item: { usage: { b: 2 } } })).toEqual(['usage', 'item.usage']);
    expect(usagePaths({ type: 'x' })).toEqual([]);
  });

  it('lists id-like keys that carry a non-empty string, without values', () => {
    expect(idLikePaths({ event_id: 'evt_1', error: { request_id: 'r1', code: 'bad', message: 'secret' }, id: '' })).toEqual(['event_id', 'error.request_id']);
  });

  it('keeps only request or trace header names', () => {
    expect(idLikeHeaderNames(['content-type', 'X-Request-Id', 'x-dashscope-request-id', 'eagleeye-traceid', 'date'])).toEqual([
      'x-request-id', 'x-dashscope-request-id', 'eagleeye-traceid',
    ]);
  });

  it('rounds partial seconds up like the official audio token rule', () => {
    expect(expectedAudioTokens(2.1, 7)).toBe(21);
    expect(expectedAudioTokens(3, 12.5)).toBe(38);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -w gateway -- test/usageProbe.test.ts`
Expected: FAIL，报错 `Failed to resolve import "../scripts/lib/usage-probe.ts"`。

- [ ] **Step 3: 实现辅助函数**

新建 `gateway/scripts/lib/usage-probe.ts`：

```ts
// Shape-only helpers for the admin usage probe. Output never contains string content.

/** Dotted leaf paths: numbers keep their value, strings become `string(<length>)`, arrays show length + first element. */
export function leafShape(value: unknown, prefix = ''): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  walk(value, prefix, out);
  return out;
}

function walk(value: unknown, path: string, out: Record<string, number | string>): void {
  if (typeof value === 'number') { out[path] = value; return; }
  if (typeof value === 'string') { out[path] = `string(${[...value].length})`; return; }
  if (typeof value === 'boolean') { out[path] = 'boolean'; return; }
  if (value === null || value === undefined) { out[path] = 'null'; return; }
  if (Array.isArray(value)) {
    out[`${path}.length`] = value.length;
    if (value.length > 0) walk(value[0], `${path}[0]`, out);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) walk(child, path ? `${path}.${key}` : key, out);
  }
}

/** Paths of every object stored under a `usage` key, depth-first in key order. */
export function usagePaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (key === 'usage' && child && typeof child === 'object') found.push(path);
    found.push(...usagePaths(child, path));
  }
  return found;
}

const ID_KEY = /(^|_)(id|request_?id|trace_?id)$/i;

/** Paths of id-like keys holding a non-empty string. Values are never returned. */
export function idLikePaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (ID_KEY.test(key) && typeof child === 'string' && child.length > 0) found.push(path);
    found.push(...idLikePaths(child, path));
  }
  return found;
}

const ID_HEADER = /(request|trace)/i;

/** Lower-cased header names that look like upstream request or trace ids. */
export function idLikeHeaderNames(names: Iterable<string>): string[] {
  return [...names].map((name) => name.toLowerCase()).filter((name) => ID_HEADER.test(name));
}

/** Official rule: partial seconds count as a full second. */
export function expectedAudioTokens(seconds: number, perSecond: number): number {
  return Math.ceil(Math.ceil(seconds) * perSecond);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -w gateway -- test/usageProbe.test.ts`
Expected: PASS，6 个用例全过。

- [ ] **Step 5: 写探针入口**

新建 `gateway/scripts/probe-admin-usage.ts`：

```ts
// Live probe for the admin plan (P1-T1). Synthetic input only; prints event types, key paths and numbers, never text.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-admin-usage.ts --wav /tmp/probe-16k.wav
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { baseSession, probeEnv, QwenRaw, readWavPcm16, sleep, userText, type Json } from './lib/qwen-raw.ts';
import { expectedAudioTokens, idLikeHeaderNames, idLikePaths, leafShape, usagePaths } from './lib/usage-probe.ts';

const env = probeEnv();
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);
const SYNTHETIC_INSTRUCTIONS = '你是测试助手。每次只用一句很短的中文回答。';
const SYNTHETIC_QUESTION = '请用一句话打个招呼。';
const QWEN_INPUT_AUDIO_TOKENS_PER_SECOND = 7; // official, help.aliyun.com/zh/model-studio/qwen3-8-omni-flash-realtime
const memoryConfig = JSON.parse(readFileSync(fileURLToPath(new URL('../config/memory.json', import.meta.url)), 'utf8')) as { extractModel?: string };

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Realtime text turn: usage shape of response.done. */
async function realtimeText(): Promise<void> {
  const c = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(SYNTHETIC_INSTRUCTIONS, env.voice) });
  const r = await c.collect(() => { c.send(userText(SYNTHETIC_QUESTION)); c.send({ type: 'response.create' }); });
  out({ probe: 'realtime_text', status: r.status, error: r.error, usage: leafShape(r.usage) });
  c.close();
}

/** A1: realtime audio turn. Which events carry usage, and do audio tokens match the per-second rule? */
async function realtimeAudio(wavPath: string): Promise<void> {
  const pcm = readWavPcm16(wavPath);
  const seconds = pcm.length / 16_000;
  const c = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(SYNTHETIC_INSTRUCTIONS, env.voice) });
  const done = c.waitFor((e) => e.type === 'response.done' || e.type === 'error', 60_000);
  const frame = 1_600; // 100 ms at 16 kHz
  for (let offset = 0; offset < pcm.length; offset += frame) {
    c.sendPcm16k(pcm.subarray(offset, offset + frame));
    await sleep(100);
  }
  // 1.5 s of silence lets semantic VAD close the turn.
  for (let i = 0; i < 15; i++) { c.sendPcm16k(new Int16Array(frame)); await sleep(100); }
  const final = await done;
  await sleep(2_000); // late events (e.g. transcription usage) still land in c.events
  const carriers = c.events
    .map(({ event }) => ({ type: String(event.type ?? ''), paths: usagePaths(event) }))
    .filter((row) => row.paths.length > 0);
  const response = (final?.response ?? {}) as Json;
  const details = (response.usage as Json | undefined)?.input_tokens_details as Json | undefined;
  out({
    probe: 'realtime_audio',
    seconds: Math.round(seconds * 100) / 100,
    finalType: final?.type ?? 'timeout',
    usageCarriers: carriers,
    usage: leafShape(response.usage),
    expectedInputAudioTokens: expectedAudioTokens(seconds, QWEN_INPUT_AUDIO_TOKENS_PER_SECOND),
    reportedInputAudioTokens: typeof details?.audio_tokens === 'number' ? details.audio_tokens : null,
    eventTypes: [...new Set(c.events.map(({ event }) => String(event.type ?? '')))],
  });
  c.close();
}

/** A4: handshake header names, and the id-like fields of a provoked error event. */
async function realtimeError(): Promise<void> {
  const url = new URL(env.endpoint);
  url.searchParams.set('model', env.model);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${env.apiKey}` }, perMessageDeflate: false });
  const headerNames = await new Promise<string[]>((resolve, reject) => {
    ws.once('upgrade', (res) => resolve(Object.keys(res.headers)));
    ws.once('error', reject);
  });
  await new Promise<void>((resolve) => ws.once('open', () => resolve()));
  const errorEvent = await new Promise<Json | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    ws.on('message', (data) => {
      let e: Json;
      try { e = JSON.parse(data.toString()) as Json; } catch { return; }
      if (e.type === 'error') { clearTimeout(timer); resolve(e); }
    });
    ws.send(JSON.stringify({ type: 'probe.invalid_event' }));
  });
  out({
    probe: 'realtime_error',
    handshakeIdHeaders: idLikeHeaderNames(headerNames),
    errorShape: errorEvent ? leafShape(errorEvent) : null,
    errorIdPaths: errorEvent ? idLikePaths(errorEvent) : [],
  });
  ws.close();
}

/** A5 (+A4 for text): OpenAI-compatible usage shape, id headers, and an error body shape. */
async function textModel(model: string): Promise<void> {
  const endpoint = process.env.QWEN_SUMMARIZER_ENDPOINT ?? '';
  if (!endpoint) throw new Error('QWEN_SUMMARIZER_ENDPOINT must be set (gateway/.env)');
  const call = (body: Json) => fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ok = await call({ model, messages: [{ role: 'system', content: SYNTHETIC_INSTRUCTIONS }, { role: 'user', content: SYNTHETIC_QUESTION }], max_tokens: 30, temperature: 0 });
  const okBody = await ok.json() as Json;
  out({
    probe: 'text_ok',
    model,
    status: ok.status,
    idHeaders: idLikeHeaderNames(ok.headers.keys()),
    bodyIdPaths: idLikePaths(okBody),
    usage: leafShape(okBody.usage),
  });
  const bad = await call({ model: 'probe-invalid-model', messages: [{ role: 'user', content: SYNTHETIC_QUESTION }], max_tokens: 5 });
  const badBody = await bad.json().catch(() => ({})) as Json;
  out({ probe: 'text_error', status: bad.status, idHeaders: idLikeHeaderNames(bad.headers.keys()), bodyIdPaths: idLikePaths(badBody), errorShape: leafShape(badBody) });
}

const wav = argValue('--wav');
if (!wav) throw new Error('usage: probe-admin-usage.ts --wav <16 kHz mono 16-bit wav of a synthetic sentence>');
await realtimeText();
await realtimeAudio(wav);
await realtimeError();
await textModel(memoryConfig.extractModel ?? 'qwen-plus');
await textModel(process.env.QWEN_SUMMARIZER_MODEL ?? 'qwen-flash');
```

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck -w gateway`
Expected: 无输出，退出码 0。

- [ ] **Step 7: 提交辅助函数和探针**

```bash
git add gateway/scripts/lib/usage-probe.ts gateway/scripts/probe-admin-usage.ts gateway/test/usageProbe.test.ts
git commit -m "test(gateway): add the admin usage probe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: 生成合成音频**

只用合成句子。macOS：

```bash
say -v Tingting -o /tmp/probe-16k.wav --data-format=LEI16@16000 "今天天气不错，我们下午出去走走吧。"
```

Linux 没有 `say` 时，用任何 TTS 生成同一句话，并转成 16 kHz、单声道、16 位 PCM WAV（例如 `ffmpeg -i in.wav -ar 16000 -ac 1 -sample_fmt s16 /tmp/probe-16k.wav`）。两种都不行就停下，按 AGENTS.md 第 7 条记 blocker。

- [ ] **Step 9: 运行真实探针**

Run（cwd: `gateway/`）：

```bash
node --env-file-if-exists=.env --import tsx scripts/probe-admin-usage.ts --wav /tmp/probe-16k.wav | tee /tmp/admin-usage-probe.jsonl
```

Expected：输出 7 行 JSON，`probe` 依次是 `realtime_text`、`realtime_audio`、`realtime_error`、`text_ok`、`text_error`、`text_ok`、`text_error`（两个文本模型各一对）。核对输出里**没有**任何中文句子（只应出现 `string(<n>)`）：

```bash
grep -c '天气\|打个招呼' /tmp/admin-usage-probe.jsonl
```

Expected：`0`。

- [ ] **Step 10: 写结果文档**

新建 `docs/testing/2026-10-27-admin-usage-probe.md`，按下面模板填写真实值（只填键路径和数字）：

```markdown
# 后台用量探针（P1-T1）

- 日期：2026-10-27 起（填实际日期）
- 命令：`node --env-file-if-exists=.env --import tsx scripts/probe-admin-usage.ts --wav /tmp/probe-16k.wav`
- 模型：realtime `<QWEN_MODEL 实际值>`；文本 `<extractModel>`、`<QWEN_SUMMARIZER_MODEL>`
- 输入：合成句子与合成音频（时长 <seconds> 秒），不含真实用户数据。

## A1 实时转写是否单独计费 / 计入 usage

| 项 | 结果 |
|---|---|
| 携带 usage 的事件类型 | `<usageCarriers 里的 type 列表>` |
| response.done usage 键路径 | `<realtime_audio.usage 的键>` |
| 输入音频 token：期望 / 实报 | `<expected>` / `<reported>` |
| 结论 | 见下方判定规则 |
| 账单核对（次日，用户在阿里云费用中心查看 `qwen3-asr-flash-realtime` 是否单列） | 用户确认 / 未核对 |

## A4 上游请求 id

| 来源 | 结果 |
|---|---|
| WS 握手响应头 | `<handshakeIdHeaders>` |
| realtime error 事件 id 路径 | `<errorIdPaths>` |
| 文本接口响应头 | `<text_ok.idHeaders>` |
| 文本接口错误体 id 路径 | `<text_error.bodyIdPaths>` |

## A5 文本模型 usage

| 模型 | usage 键路径与数值 |
|---|---|
| `<extractModel>` | `<text_ok.usage>` |
| `<summarizer model>` | `<text_ok.usage>` |

## 对后续任务的结论

- P1-T6 上游请求 id 取值路径：`<按 A4 填写>`
- P1-T7 realtime details 字段名：`<input_tokens_details.*, output_tokens_details.*>`
- P1-T7 文本 usage 字段名：`<prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens ...>`
```

判定规则（照此写「结论」）：

| 假设 | 成立条件 | 不成立时 |
|---|---|---|
| A1 | 只有 `response.done` 携带 usage，且实报输入音频 token 在期望值 ±30% 内 | 有其他事件（如转写完成事件）携带 usage，或实报与期望差距超过 30%：**停下报告**。P1-T7 需要新增用量类型（改 C3 的 `UsageKind`），要由协调者改总览 |
| A4 | 至少一处出现请求 id（响应头或 error 事件里的 id 路径） | 都没有：P1-T6 只记 `event_id`（realtime）或不记 id（文本），在 blockers 记一条 |
| A5 | `text_ok.usage` 含 `prompt_tokens` 和 `completion_tokens` 两个数字 | 缺任一个：**停下报告**。P1-T7 的文本 usage 解析无法按计划实现 |
| realtime details | `realtime_text.usage` 含 `input_tokens_details.text_tokens`、`input_tokens_details.audio_tokens`、`output_tokens_details.text_tokens`、`output_tokens_details.audio_tokens` | 字段名不同：**停下报告**，由协调者更新 P1-T7 的解析代码 |

- [ ] **Step 11: 提交结果文档**

```bash
git add docs/testing/2026-10-27-admin-usage-probe.md
git commit -m "docs: record the admin usage probe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 12: 回归**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected：全部通过，typecheck 无输出。
