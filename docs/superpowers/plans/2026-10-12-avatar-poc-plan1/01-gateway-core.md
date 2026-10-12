# Plan 1 · 01 网关核心模块（Task 2–6）

> 先读 [00-overview.md](00-overview.md) 的 Global Constraints。所有测试用 vitest 假时钟（`vi.useFakeTimers()`），不依赖真实时间。

---

### Task 2: 网关骨架、RealtimeAdapter 接口与 MockAdapter

**Files:**
- Create: `gateway/package.json`, `gateway/tsconfig.json`, `gateway/.env.example`, `gateway/src/log.ts`, `gateway/src/audio.ts`, `gateway/src/adapters/types.ts`, `gateway/src/adapters/mock.ts`, `gateway/mock/script.json`
- Test: `gateway/test/mock.test.ts`

**Depends on:** Task 1。本任务会 `npm install`（改 `package-lock.json`），不要与 Task 9 并行。`RealtimeAdapter`、`AdapterEvents`、`MockScript` 完成后冻结（Plan 2 的真实适配器也实现同一接口）。

**Interfaces:**
- Consumes: `@anyidea/protocol` 的 `ACTION_NAMES`、`AI_SAMPLE_RATE`、`MIC_SAMPLE_RATE`
- Produces:
  - `log(event: string, fields?: Record<string, string | number | boolean | null>): void`
  - `rmsInt16(pcm: Int16Array): number`
  - `type AdapterEvents`（`userSpeechStarted` / `userTranscript(text, final)` / `responseStarted(id)` / `audioDelta(id, pcm24k)` / `textDelta(id, text)` / `toolCall(id, callId, name, args)` / `responseDone(id)` / `responseCancelled(id)` / `error(code, retryable)` / `closed`）
  - `interface RealtimeAdapter`：`supportsPlaybackTruncate`、`connect(config)`、`sendAudio(pcm16k)`、`sendUserText(text)`、`updateInstructions(text)`、`createResponse(instructions?)`、`cancelResponse()`、`sendToolResult(callId, result)`、`injectContextNote(text)`、`close()`
  - `type AdapterFactory = () => RealtimeAdapter`；`interface SessionConfig { instructions: string; tools: ToolSpec[] }`；`PERFORM_ACTION_TOOL`
  - `class MockAdapter`（额外公开：`instructions`、`notes`、`toolResults`、`simulateDrop()`）；`loadMockScript(path)`、`loadMockSpeech(path)`；`interface MockScript`（可选 `idleNotice`、`resume` 台词）；`MockOptions.instructionReplies?: ReadonlyMap<string, string>`（Director 指令 → 台词；Task 8 入口按 `director.json` 构造）
  - Mock 行为约定（真机验收按此理解）：Mock **不识别语音内容**——检测到一段说话（RMS ≥ `speechThreshold` 后静默 800 ms）就按 `turns` 顺序取下一条作为识别结果；`createResponse(instructions)` 先查 `instructionReplies`，查不到时第一次用 `greeting`、之后用 `followup`

- [ ] **Step 1: 包配置**

`gateway/package.json`:

```json
{
  "name": "@anyidea/gateway",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch --env-file-if-exists=.env --import tsx src/index.ts",
    "start": "node --env-file-if-exists=.env --import tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@anyidea/protocol": "*",
    "tsx": "4.23.15",
    "ws": "8.22.0",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/node": "26.6.4",
    "@types/ws": "8.18.2",
    "typescript": "7.0.2",
    "vitest": "5.0.3"
  }
}
```

`gateway/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test"]
}
```

`gateway/.env.example`:

```
# Copy to .env (git-ignored). Never commit real secrets.
PORT=8787
APP_SECRET=change-me-to-a-random-32-char-string
ADAPTER=mock
ALLOW_DEBUG_TEXT=1
# Comma-separated extra CORS origins for desktop debugging
DEV_ORIGINS=http://localhost:5173
# MockAdapter speech detection threshold (RMS of 16-bit PCM). Raise it if speaker echo triggers fake turns.
MOCK_SPEECH_THRESHOLD=800
```

```bash
npm install
```

- [ ] **Step 2: 日志与音频工具**

`gateway/src/log.ts`:

```ts
type Field = string | number | boolean | null;

/**
 * Structured log line. NEVER pass conversation content (audio, ASR text, replies):
 * only event names, ids, counts, durations and error codes.
 */
export function log(event: string, fields: Record<string, Field> = {}): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}
```

`gateway/src/audio.ts`:

```ts
export function rmsInt16(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}
```

- [ ] **Step 3: 适配器接口**

`gateway/src/adapters/types.ts`:

```ts
import type { EventEmitter } from 'node:events';
import { ACTION_NAMES } from '@anyidea/protocol';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SessionConfig {
  instructions: string;
  tools: ToolSpec[];
}

export type AdapterEvents = {
  userSpeechStarted: [];
  userTranscript: [text: string, final: boolean];
  responseStarted: [id: string];
  audioDelta: [id: string, pcm24k: Int16Array];
  textDelta: [id: string, text: string];
  toolCall: [id: string, callId: string, name: string, args: unknown];
  responseDone: [id: string];
  responseCancelled: [id: string];
  error: [code: string, retryable: boolean];
  closed: [];
};

/** Model-agnostic realtime speech session. One instance = one upstream model connection. */
export interface RealtimeAdapter extends EventEmitter<AdapterEvents> {
  /** True if the model can trim its own context to the played portion after an interruption. */
  readonly supportsPlaybackTruncate: boolean;
  connect(config: SessionConfig): Promise<void>;
  sendAudio(pcm16k: Int16Array): void;
  /** Debug path: treat text as a finished user turn and reply to it. */
  sendUserText(text: string): void;
  updateInstructions(text: string): void;
  createResponse(instructions?: string): void;
  cancelResponse(): void;
  sendToolResult(callId: string, result: unknown): void;
  injectContextNote(text: string): void;
  /** Intentional close; must not emit `closed`. */
  close(): void;
}

export type AdapterFactory = () => RealtimeAdapter;

export const PERFORM_ACTION_TOOL: ToolSpec = {
  name: 'perform_action',
  description: '当用户请求虚拟人做动作时调用。只能做列出的动作；调用后用一句话自然回应，不要描述动作过程。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTION_NAMES],
        description: 'wave=挥手, nod=点头, smile=微笑, turn=转身, heart=比心',
      },
    },
    required: ['action'],
  },
};
```

- [ ] **Step 4: Mock 脚本**

`gateway/mock/script.json`:

```json
{
  "greeting": "你好呀！我是小暖，很高兴见到你。今天过得怎么样？",
  "followup": "刚才聊到这儿，你还想多说说吗？",
  "idleNotice": "我在这儿呢，想聊随时叫我。",
  "resume": "刚才网络断了一下，我们接着聊吧。",
  "fallbackReply": "嗯嗯，我在听，你接着说。",
  "turns": [
    { "user": "挺好的，刚吃完午饭", "reply": "吃饱了心情就好！今天吃的什么呀？" },
    { "user": "吃了饺子，我女儿包的", "reply": "女儿包的饺子，听着就香！她常回来看你吗？" },
    { "match": "挥", "user": "你跟我挥挥手", "reply": "好呀，来，挥挥手！", "tool": { "name": "perform_action", "args": { "action": "wave" } } },
    { "match": "比心", "user": "给我比个心", "reply": "给你比个心！", "tool": { "name": "perform_action", "args": { "action": "heart" } } },
    { "match": "点头", "user": "点点头", "reply": "嗯嗯，我同意。", "tool": { "name": "perform_action", "args": { "action": "nod" } } },
    { "match": "笑", "user": "对我笑一下", "reply": "嘿嘿，笑一个！", "tool": { "name": "perform_action", "args": { "action": "smile" } } },
    { "match": "转", "user": "转个身看看", "reply": "好嘞，转一圈！", "tool": { "name": "perform_action", "args": { "action": "turn" } } },
    { "user": "你还记得我中午吃了什么吗", "reply": "记得呀，你吃的是女儿包的饺子。" }
  ]
}
```

- [ ] **Step 5: 写失败的测试**

`gateway/test/mock.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';

const script: MockScript = {
  greeting: '你好',
  followup: '还在吗',
  fallbackReply: '我在听',
  turns: [
    { user: '吃了饺子', reply: '真香啊' },
    { match: '挥', user: '挥挥手', reply: '好呀', tool: { name: 'perform_action', args: { action: 'wave' } } },
  ],
};
const loud = () => new Int16Array(320).fill(3000);
const quiet = () => new Int16Array(320);

function collect(m: MockAdapter) {
  const events: string[] = [];
  let text = '';
  let audioSamples = 0;
  m.on('userSpeechStarted', () => events.push('speech'));
  m.on('userTranscript', (t, final) => events.push(`asr:${final ? 'final' : 'partial'}:${t}`));
  m.on('responseStarted', (id) => events.push(`start:${id}`));
  m.on('textDelta', (_id, t) => { text += t; });
  m.on('audioDelta', (_id, pcm) => { audioSamples += pcm.length; });
  m.on('toolCall', (_id, _c, name, args) => events.push(`tool:${name}:${JSON.stringify(args)}`));
  m.on('responseDone', (id) => events.push(`done:${id}`));
  m.on('responseCancelled', (id) => events.push(`cancelled:${id}`));
  return { events, text: () => text, audio: () => audioSamples };
}

describe('MockAdapter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = () => new MockAdapter({ script, replyDelayMs: 100, charMs: 200, chunkMs: 100, paceFactor: 1 });

  it('detects a spoken turn, emits transcripts and streams the scripted reply', async () => {
    const m = make();
    const c = collect(m);
    await m.connect({ instructions: 'x', tools: [] });
    for (let i = 0; i < 10; i++) m.sendAudio(loud());
    for (let i = 0; i < 40; i++) m.sendAudio(quiet()); // 800 ms of silence ends the turn
    expect(c.events).toEqual(['speech', 'asr:partial:吃了', 'asr:final:吃了饺子']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.events).toContain('start:mock-1');
    expect(c.events).toContain('done:mock-1');
    expect(c.text()).toBe('真香啊');
    expect(c.audio()).toBe(600 * 24); // 3 chars × 200 ms at 24 kHz
  });

  it('cancels mid-stream and stops emitting audio', async () => {
    const m = make();
    const c = collect(m);
    m.sendUserText('随便说点');
    await vi.advanceTimersByTimeAsync(250);
    const before = c.audio();
    m.cancelResponse();
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.events).toContain('cancelled:mock-1');
    expect(c.events).not.toContain('done:mock-1');
    expect(c.audio()).toBe(before);
  });

  it('emits a tool call for matching text', async () => {
    const m = make();
    const c = collect(m);
    m.sendUserText('跟我挥挥手吧');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.events).toContain('tool:perform_action:{"action":"wave"}');
    expect(c.text()).toBe('好呀');
  });

  it('answers the first createResponse with the greeting, later ones with the follow-up', async () => {
    const m = make();
    const c = collect(m);
    m.createResponse('greet');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('你好');
    m.createResponse('follow');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('你好还在吗');
  });

  it('uses the scripted line mapped to a known Director instruction', async () => {
    const m = new MockAdapter({
      script, replyDelayMs: 100, charMs: 200, chunkMs: 100, paceFactor: 1,
      instructionReplies: new Map([['IDLE', '我在呢']]),
    });
    const c = collect(m);
    m.createResponse('IDLE');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('我在呢');
    m.createResponse('unknown');
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.text()).toBe('我在呢还在吗'); // a mapped reply still counts as the first response
  });

  it('records context notes, instructions and tool results', async () => {
    const m = make();
    await m.connect({ instructions: 'v1', tools: [] });
    m.updateInstructions('v2');
    m.injectContextNote('note');
    m.sendToolResult('c1', { ok: true });
    expect(m.instructions).toBe('v2');
    expect(m.notes).toEqual(['note']);
    expect(m.toolResults).toEqual([{ callId: 'c1', result: { ok: true } }]);
  });

  it('simulateDrop emits error then closed', () => {
    const m = make();
    const seen: string[] = [];
    m.on('error', (code, retryable) => seen.push(`${code}:${retryable}`));
    m.on('closed', () => seen.push('closed'));
    m.simulateDrop();
    expect(seen).toEqual(['mock_drop:true', 'closed']);
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npm test -w gateway`
Expected: FAIL，无法解析 `../src/adapters/mock.ts`。

- [ ] **Step 7: 实现 MockAdapter**

`gateway/src/adapters/mock.ts`:

```ts
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { AI_SAMPLE_RATE, MIC_SAMPLE_RATE } from '@anyidea/protocol';
import { rmsInt16 } from '../audio.ts';
import type { AdapterEvents, RealtimeAdapter, SessionConfig } from './types.ts';

export interface MockTurn {
  /** If set, `sendUserText` picks this turn when the text contains it. */
  match?: string;
  /** Transcript emitted when a spoken turn is detected (turns are used in order). */
  user: string;
  reply: string;
  tool?: { name: string; args: unknown };
}

export interface MockScript {
  greeting: string;
  followup: string;
  /** Optional lines for the Director's idle notice and resume instructions (see instructionReplies). */
  idleNotice?: string;
  resume?: string;
  fallbackReply: string;
  turns: MockTurn[];
}

export interface MockOptions {
  script: MockScript;
  /** Exact Director instruction text → scripted reply; unmatched instructions fall back to greeting/followup. */
  instructionReplies?: ReadonlyMap<string, string>;
  /** 24 kHz PCM16 played back as reply audio; synthetic tone if absent. */
  speech?: Int16Array;
  speechThreshold?: number;
  endSilenceMs?: number;
  replyDelayMs?: number;
  /** Reply duration per character. */
  charMs?: number;
  chunkMs?: number;
  /** >1 sends audio faster than real time, like real models do. */
  paceFactor?: number;
}

interface ActiveResponse {
  id: string;
  timer: NodeJS.Timeout | null;
  started: boolean;
}

export class MockAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  instructions = '';
  readonly notes: string[] = [];
  readonly toolResults: Array<{ callId: string; result: unknown }> = [];

  private turnIndex = 0;
  private speaking = false;
  private silentMs = 0;
  private responseCounter = 0;
  private createCount = 0;
  private active: ActiveResponse | null = null;
  private speechOffset = 0;
  private closed = false;

  constructor(private readonly opts: MockOptions) {
    super();
  }

  async connect(config: SessionConfig): Promise<void> {
    this.instructions = config.instructions;
  }

  sendAudio(pcm16k: Int16Array): void {
    if (this.closed) return;
    const frameMs = (pcm16k.length / MIC_SAMPLE_RATE) * 1000;
    if (rmsInt16(pcm16k) >= (this.opts.speechThreshold ?? 800)) {
      this.silentMs = 0;
      if (!this.speaking) {
        this.speaking = true;
        this.emit('userSpeechStarted');
      }
      return;
    }
    if (!this.speaking) return;
    this.silentMs += frameMs;
    if (this.silentMs >= (this.opts.endSilenceMs ?? 800)) {
      this.speaking = false;
      this.silentMs = 0;
      this.onSpokenTurnEnd();
    }
  }

  sendUserText(text: string): void {
    const turn = this.opts.script.turns.find((t) => t.match !== undefined && text.includes(t.match));
    this.scheduleReply(turn ? turn.reply : this.opts.script.fallbackReply, turn?.tool);
  }

  updateInstructions(text: string): void {
    this.instructions = text;
  }

  createResponse(instructions?: string): void {
    const mapped = instructions === undefined ? undefined : this.opts.instructionReplies?.get(instructions);
    const text = mapped ?? (this.createCount === 0 ? this.opts.script.greeting : this.opts.script.followup);
    this.createCount++;
    this.scheduleReply(text);
  }

  cancelResponse(): void {
    this.cancelActive();
  }

  sendToolResult(callId: string, result: unknown): void {
    this.toolResults.push({ callId, result });
  }

  injectContextNote(text: string): void {
    this.notes.push(text);
  }

  close(): void {
    this.cancelActive();
    this.closed = true;
  }

  /** Test helper: behave like an upstream connection that dropped. */
  simulateDrop(): void {
    this.cancelActive();
    this.closed = true;
    this.emit('error', 'mock_drop', true);
    this.emit('closed');
  }

  private onSpokenTurnEnd(): void {
    const turns = this.opts.script.turns;
    const turn = turns.length > 0 ? turns[this.turnIndex++ % turns.length] : undefined;
    if (!turn) {
      this.scheduleReply(this.opts.script.fallbackReply);
      return;
    }
    this.emit('userTranscript', turn.user.slice(0, Math.ceil(turn.user.length / 2)), false);
    this.emit('userTranscript', turn.user, true);
    this.scheduleReply(turn.reply, turn.tool);
  }

  private scheduleReply(text: string, tool?: MockTurn['tool']): void {
    if (this.closed) return;
    this.cancelActive();
    const handle: ActiveResponse = { id: `mock-${++this.responseCounter}`, timer: null, started: false };
    this.active = handle;
    handle.timer = setTimeout(() => this.streamReply(handle, text, tool), this.opts.replyDelayMs ?? 300);
  }

  private streamReply(handle: ActiveResponse, text: string, tool?: MockTurn['tool']): void {
    if (this.active !== handle) return;
    handle.started = true;
    this.emit('responseStarted', handle.id);
    if (tool) this.emit('toolCall', handle.id, `call-${handle.id}`, tool.name, tool.args);
    const chunkMs = this.opts.chunkMs ?? 100;
    const totalMs = Math.max(chunkMs, text.length * (this.opts.charMs ?? 220));
    const chunks = Math.ceil(totalMs / chunkMs);
    const pace = this.opts.paceFactor ?? 2;
    let i = 0;
    let sentChars = 0;
    const tick = () => {
      if (this.active !== handle) return;
      if (i >= chunks) {
        this.active = null;
        this.emit('responseDone', handle.id);
        return;
      }
      this.emit('audioDelta', handle.id, this.nextSpeech(chunkMs));
      const targetChars = Math.min(text.length, Math.round(((i + 1) / chunks) * text.length));
      if (targetChars > sentChars) {
        this.emit('textDelta', handle.id, text.slice(sentChars, targetChars));
        sentChars = targetChars;
      }
      i++;
      handle.timer = setTimeout(tick, chunkMs / pace);
    };
    tick();
  }

  private cancelActive(): void {
    const a = this.active;
    if (!a) return;
    if (a.timer) clearTimeout(a.timer);
    this.active = null;
    if (a.started) this.emit('responseCancelled', a.id);
  }

  private nextSpeech(ms: number): Int16Array {
    const n = Math.round((ms / 1000) * AI_SAMPLE_RATE);
    const out = new Int16Array(n);
    const src = this.opts.speech;
    for (let k = 0; k < n; k++, this.speechOffset++) {
      if (src && src.length > 0) {
        out[k] = src[this.speechOffset % src.length];
      } else {
        const t = this.speechOffset / AI_SAMPLE_RATE;
        const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
        out[k] = Math.round(6000 * envelope * Math.sin(2 * Math.PI * 180 * t));
      }
    }
    return out;
  }
}

export function loadMockScript(path: string): MockScript {
  return JSON.parse(readFileSync(path, 'utf8')) as MockScript;
}

export function loadMockSpeech(path: string): Int16Array | undefined {
  if (!existsSync(path)) return undefined;
  const buf = readFileSync(path);
  const even = buf.byteLength - (buf.byteLength % 2);
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + even));
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 7 个测试 PASS；typecheck 无输出。

- [ ] **Step 9: 提交**

```bash
git add gateway package-lock.json
git commit -m "feat(gateway): RealtimeAdapter interface and scripted MockAdapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: ConversationLedger 与 MockSummarizer

**Files:**
- Create: `gateway/src/session/ledger.ts`
- Test: `gateway/test/ledger.test.ts`

**Depends on:** Task 2（gateway 包与 vitest）。可与 Task 4/5/6 并行。

**Interfaces:**
- Produces:
  - `interface LedgerEntry { role: 'user' | 'assistant'; text: string; ts: number; interrupted?: boolean }`
  - `interface Summarizer { summarize(previous: string, entries: readonly LedgerEntry[]): Promise<string> }`
  - `interface LedgerOptions { keepRecentTurns: number; summarizeAfterTurns: number; summarizeAfterTokens: number }`、`DEFAULT_LEDGER_OPTIONS`
  - `estimateTokens(text: string): number`
  - `class ConversationLedger`：`summary`、`recent`、`addUser(text, ts)`、`addAssistant(text, ts, interrupted?)`、`userTurns()`、`needsSummary()`、`summarize(summarizer): Promise<boolean>`、`buildInstructions(persona): string`、`clear()`
  - `class MockSummarizer implements Summarizer`

- [ ] **Step 1: 写失败的测试**

`gateway/test/ledger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConversationLedger, MockSummarizer, type LedgerEntry, type Summarizer } from '../src/session/ledger.ts';

const opts = { keepRecentTurns: 2, summarizeAfterTurns: 3, summarizeAfterTokens: 10_000 };

function fill(l: ConversationLedger, turns: number) {
  for (let i = 1; i <= turns; i++) {
    l.addUser(`问${i}`, i);
    l.addAssistant(`答${i}`, i);
  }
}

describe('ConversationLedger', () => {
  it('ignores blank entries and marks interruptions', () => {
    const l = new ConversationLedger(opts);
    l.addUser('  ', 1);
    l.addAssistant('', 2);
    l.addAssistant('说到一半', 3, true);
    expect(l.recent).toEqual([{ role: 'assistant', text: '说到一半', ts: 3, interrupted: true }]);
  });

  it('needs a summary after the turn threshold', () => {
    const l = new ConversationLedger(opts);
    fill(l, 3);
    expect(l.needsSummary()).toBe(false);
    l.addUser('问4', 4);
    expect(l.needsSummary()).toBe(true);
  });

  it('needs a summary after the token threshold', () => {
    const l = new ConversationLedger({ ...opts, summarizeAfterTokens: 5 });
    l.addUser('一二三四五六', 1);
    expect(l.needsSummary()).toBe(true);
  });

  it('summarizes older turns and keeps the most recent ones verbatim', async () => {
    const l = new ConversationLedger(opts);
    fill(l, 4);
    const seen: LedgerEntry[][] = [];
    const s: Summarizer = { summarize: async (_prev, entries) => { seen.push([...entries]); return '摘要A'; } };
    expect(await l.summarize(s)).toBe(true);
    expect(seen[0].map((e) => e.text)).toEqual(['问1', '答1', '问2', '答2']);
    expect(l.summary).toBe('摘要A');
    expect(l.recent.map((e) => e.text)).toEqual(['问3', '答3', '问4', '答4']);
  });

  it('keeps entries appended while the summary is running', async () => {
    const l = new ConversationLedger(opts);
    fill(l, 4);
    let release!: (v: string) => void;
    const s: Summarizer = { summarize: () => new Promise<string>((r) => { release = r; }) };
    const p = l.summarize(s);
    l.addUser('问5', 5);
    expect(await l.summarize(s)).toBe(false); // already running
    release('摘要B');
    await p;
    expect(l.recent.map((e) => e.text)).toEqual(['问3', '答3', '问4', '答4', '问5']);
  });

  it('drops a summary result if the ledger was cleared meanwhile', async () => {
    const l = new ConversationLedger(opts);
    fill(l, 4);
    let release!: (v: string) => void;
    const p = l.summarize({ summarize: () => new Promise<string>((r) => { release = r; }) });
    l.clear();
    release('旧摘要');
    expect(await p).toBe(false);
    expect(l.summary).toBe('');
    expect(l.recent).toEqual([]);
  });

  it('builds instructions from persona, summary and recent turns', () => {
    const l = new ConversationLedger(opts);
    l.addUser('我叫老王', 1);
    l.addAssistant('王叔好', 2, true);
    const text = l.buildInstructions('你是小暖。');
    expect(text).toBe('你是小暖。\n\n## 对话摘要\n\n（暂无）\n\n## 最近对话\n\n用户：我叫老王\n助手：王叔好（被用户打断）');
  });
});

describe('MockSummarizer', () => {
  it('concatenates previous summary and entries, capped at 800 chars', async () => {
    const s = new MockSummarizer();
    expect(await s.summarize('前情', [{ role: 'user', text: '你好', ts: 1 }])).toBe('前情；用户：你好');
    const long = await s.summarize('', [{ role: 'user', text: '字'.repeat(900), ts: 1 }]);
    expect(long.length).toBe(800);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w gateway -- ledger`
Expected: FAIL，无法解析 `../src/session/ledger.ts`。

- [ ] **Step 3: 实现**

`gateway/src/session/ledger.ts`:

```ts
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
    const lines = this.entries.map((e) => `${label(e)}：${e.text}${e.interrupted ? '（被用户打断）' : ''}`);
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w gateway -- ledger`
Expected: 8 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add gateway/src/session/ledger.ts gateway/test/ledger.test.ts
git commit -m "feat(gateway): in-memory conversation ledger with rolling summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ActionRouter（关键词快速通道 + 工具调用 + 去重）

**Files:**
- Create: `gateway/src/session/actions.ts`
- Test: `gateway/test/actions.test.ts`

**Depends on:** Task 2。可与 Task 3/5/6 并行。

**Interfaces:**
- Consumes: `ActionName`、`ACTION_NAMES`
- Produces: `matchKeyword(text): ActionName | null`、`parseActionArgs(args: unknown): ActionName | null`、`class ActionRouter(dedupeMs = 3000, now = Date.now)`：`fromKeyword(text): ActionName | null`、`fromTool(args): { action: ActionName | null; result: { ok: boolean; error?: string } }`

- [ ] **Step 1: 写失败的测试**

`gateway/test/actions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ActionRouter, matchKeyword, parseActionArgs } from '../src/session/actions.ts';

describe('matchKeyword', () => {
  it.each([
    ['挥挥手', 'wave'], ['跟我招招手', 'wave'], ['和大家打个招呼', 'wave'],
    ['点点头', 'nod'], ['你点头呀', 'nod'],
    ['对我笑一下', 'smile'], ['笑一个', 'smile'], ['微笑', 'smile'],
    ['转个身', 'turn'], ['转一圈给我看', 'turn'], ['转过去', 'turn'],
    ['给我比个心', 'heart'], ['比心', 'heart'],
  ])('%s → %s', (text, action) => {
    expect(matchKeyword(text)).toBe(action);
  });

  it('returns null for ordinary talk', () => {
    expect(matchKeyword('今天天气不错')).toBeNull();
  });

  it('picks the earliest mention', () => {
    expect(matchKeyword('先点点头再挥挥手')).toBe('nod');
  });
});

describe('parseActionArgs', () => {
  it('accepts objects and JSON strings with a known action', () => {
    expect(parseActionArgs({ action: 'heart' })).toBe('heart');
    expect(parseActionArgs('{"action":"turn"}')).toBe('turn');
  });
  it('rejects unknown or malformed input', () => {
    expect(parseActionArgs({ action: 'dance' })).toBeNull();
    expect(parseActionArgs('not json')).toBeNull();
    expect(parseActionArgs(null)).toBeNull();
  });
});

describe('ActionRouter', () => {
  it('deduplicates the same action within the window across keyword and tool', () => {
    let t = 0;
    const r = new ActionRouter(3000, () => t);
    expect(r.fromKeyword('挥挥手')).toBe('wave');
    t = 1000;
    expect(r.fromTool({ action: 'wave' })).toEqual({ action: null, result: { ok: true } });
    t = 3500;
    expect(r.fromTool({ action: 'wave' })).toEqual({ action: 'wave', result: { ok: true } });
  });

  it('does not deduplicate different actions', () => {
    const r = new ActionRouter(3000, () => 0);
    expect(r.fromKeyword('挥挥手')).toBe('wave');
    expect(r.fromKeyword('比个心')).toBe('heart');
  });

  it('reports unsupported tool actions to the model', () => {
    const r = new ActionRouter();
    expect(r.fromTool({ action: 'fly' })).toEqual({ action: null, result: { ok: false, error: 'unsupported_action' } });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w gateway -- actions`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现**

`gateway/src/session/actions.ts`:

```ts
import { ACTION_NAMES, type ActionName } from '@anyidea/protocol';

// Negations ("别挥手") are not handled in the POC; the LLM tool path covers nuanced phrasing.
const KEYWORD_RULES: ReadonlyArray<readonly [RegExp, ActionName]> = [
  [/挥挥?手|招招?手|打个?招呼/, 'wave'],
  [/点点?头/, 'nod'],
  [/笑一?[下个]|微笑|笑笑/, 'smile'],
  [/转个?身|转一?圈|转过去/, 'turn'],
  [/比个?心/, 'heart'],
];

export function matchKeyword(text: string): ActionName | null {
  let best: { index: number; action: ActionName } | null = null;
  for (const [re, action] of KEYWORD_RULES) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, action };
  }
  return best?.action ?? null;
}

export function parseActionArgs(args: unknown): ActionName | null {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const action = (value as Record<string, unknown>).action;
  return typeof action === 'string' && (ACTION_NAMES as readonly string[]).includes(action) ? (action as ActionName) : null;
}

export class ActionRouter {
  private readonly lastAt = new Map<ActionName, number>();

  constructor(
    private readonly dedupeMs = 3000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Action to execute for a final user transcript, or null (no match / deduplicated). */
  fromKeyword(text: string): ActionName | null {
    const action = matchKeyword(text);
    return action && this.admit(action) ? action : null;
  }

  /** Validates a `perform_action` tool call; `result` is sent back to the model immediately. */
  fromTool(args: unknown): { action: ActionName | null; result: { ok: boolean; error?: string } } {
    const action = parseActionArgs(args);
    if (!action) return { action: null, result: { ok: false, error: 'unsupported_action' } };
    return { action: this.admit(action) ? action : null, result: { ok: true } };
  }

  private admit(action: ActionName): boolean {
    const t = this.now();
    const last = this.lastAt.get(action);
    if (last !== undefined && t - last < this.dedupeMs) return false;
    this.lastAt.set(action, t);
    return true;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w gateway -- actions`
Expected: 全部 PASS（13 个关键词用例 + 7 个其他用例）。

- [ ] **Step 5: 提交**

```bash
git add gateway/src/session/actions.ts gateway/test/actions.test.ts
git commit -m "feat(gateway): action routing with keyword fast path and dedupe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: InterruptCoordinator

**Files:**
- Create: `gateway/src/session/interrupt.ts`
- Test: `gateway/test/interrupt.test.ts`

**Depends on:** Task 2。可与 Task 3/4/6 并行。

**Interfaces:**
- Produces: `type CancelSource = 'local' | 'model'`；`class InterruptCoordinator({ cancel(seq, source), confirmWindowMs })`：`active: number | null`、`falseInterruptions: number`、`isCancelled(seq)`、`onResponseStart(seq): number | null`（返回被顶替的旧回复序号）、`onResponseFinished(seq)`、`onLocalVad(speaking)`、`onClientInterrupted(seq)`、`onModelSpeechStarted()`、`onModelAutoCancelled(seq): boolean`、`cancelActive(source)`、`dispose()`

规则（spec §5）：`active` 从 `response.start` 一直到客户端报告播放结束；客户端打断立即取消；只有模型侧检测到说话时，需本地 VAD 在 `confirmWindowMs` 内确认；模型自行取消且本地没有说话 → 计一次误打断。**顶替：** 上一条回复还在客户端播放（未报告结束、未取消）时模型又开始了新回复（例如 Mock/模型把回声或插话识别成新一轮），旧回复记为已取消并由 `onResponseStart` 返回，由 Session 通知客户端并写 Ledger；此时**不**调用 `cancel()`，否则会把模型侧刚开始的新回复取消掉。

- [ ] **Step 1: 写失败的测试**

`gateway/test/interrupt.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterruptCoordinator, type CancelSource } from '../src/session/interrupt.ts';

function make() {
  const cancels: Array<[number, CancelSource]> = [];
  const c = new InterruptCoordinator({ confirmWindowMs: 300, cancel: (seq, src) => cancels.push([seq, src]) });
  return { c, cancels };
}

describe('InterruptCoordinator', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('cancels immediately when the client reports an interruption', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onClientInterrupted(1);
    expect(cancels).toEqual([[1, 'local']]);
    expect(c.isCancelled(1)).toBe(true);
    expect(c.active).toBeNull();
  });

  it('ignores interruptions for responses that are not active', () => {
    const { c, cancels } = make();
    c.onResponseStart(2);
    c.onClientInterrupted(1);
    expect(cancels).toEqual([]);
  });

  it('cancels on model speech when local VAD already hears the user', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onLocalVad(true);
    c.onModelSpeechStarted();
    expect(cancels).toEqual([[1, 'model']]);
  });

  it('waits for local confirmation within the window', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onModelSpeechStarted();
    expect(cancels).toEqual([]);
    vi.advanceTimersByTime(200);
    c.onLocalVad(true);
    expect(cancels).toEqual([[1, 'model']]);
  });

  it('ignores model-only speech (likely echo) after the window', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onModelSpeechStarted();
    vi.advanceTimersByTime(301);
    c.onLocalVad(true);
    expect(cancels).toEqual([]);
    expect(c.active).toBe(1);
  });

  it('does nothing on model speech when no response is active', () => {
    const { c, cancels } = make();
    c.onModelSpeechStarted();
    c.onLocalVad(true);
    expect(cancels).toEqual([]);
  });

  it('counts model auto-cancels without local speech as false interruptions', () => {
    const { c } = make();
    c.onResponseStart(1);
    expect(c.onModelAutoCancelled(1)).toBe(true);
    expect(c.falseInterruptions).toBe(1);
    expect(c.onModelAutoCancelled(1)).toBe(false);
    c.onResponseStart(2);
    c.onLocalVad(true);
    c.onModelAutoCancelled(2);
    expect(c.falseInterruptions).toBe(1);
  });

  it('cancels each response at most once', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onClientInterrupted(1);
    c.cancelActive('local');
    c.onClientInterrupted(1);
    expect(cancels).toHaveLength(1);
  });

  it('clears the active response when playback finishes', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onResponseFinished(1);
    c.onClientInterrupted(1);
    expect(c.active).toBeNull();
    expect(cancels).toEqual([]);
  });

  it('reports a still-playing response superseded by a new one, without cancelling the model', () => {
    const { c, cancels } = make();
    expect(c.onResponseStart(1)).toBeNull();
    expect(c.onResponseStart(2)).toBe(1);
    expect(c.isCancelled(1)).toBe(true);
    expect(c.active).toBe(2);
    expect(cancels).toEqual([]);
    c.onResponseFinished(2);
    expect(c.onResponseStart(3)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w gateway -- interrupt`
Expected: FAIL，无法解析模块。

- [ ] **Step 3: 实现**

`gateway/src/session/interrupt.ts`:

```ts
export type CancelSource = 'local' | 'model';

export interface InterruptDeps {
  cancel(seq: number, source: CancelSource): void;
  confirmWindowMs: number;
}

/**
 * Decides when an assistant response must be cancelled.
 * A response is "active" from response.start until the client reports playback ended.
 */
export class InterruptCoordinator {
  private activeSeq: number | null = null;
  private readonly cancelled = new Set<number>();
  private localSpeaking = false;
  private pending: NodeJS.Timeout | null = null;
  private falseCount = 0;

  constructor(private readonly deps: InterruptDeps) {}

  get active(): number | null {
    return this.activeSeq;
  }

  get falseInterruptions(): number {
    return this.falseCount;
  }

  isCancelled(seq: number): boolean {
    return this.cancelled.has(seq);
  }

  /** Returns the previous response if it was still active (superseded); it is marked cancelled but not cancelled upstream. */
  onResponseStart(seq: number): number | null {
    this.clearPending();
    const previous = this.activeSeq;
    this.activeSeq = seq;
    if (previous === null || previous === seq || this.cancelled.has(previous)) return null;
    this.cancelled.add(previous);
    return previous;
  }

  onResponseFinished(seq: number): void {
    if (this.activeSeq !== seq) return;
    this.activeSeq = null;
    this.clearPending();
  }

  onLocalVad(speaking: boolean): void {
    this.localSpeaking = speaking;
    if (speaking && this.pending) {
      this.clearPending();
      this.cancelActive('model');
    }
  }

  onClientInterrupted(seq: number): void {
    if (seq === this.activeSeq) this.cancelActive('local');
  }

  onModelSpeechStarted(): void {
    if (this.activeSeq === null) return;
    if (this.localSpeaking) {
      this.cancelActive('model');
      return;
    }
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
    }, this.deps.confirmWindowMs);
  }

  /** The model cancelled on its own (auto-interrupt we could not disable). Returns false if already handled. */
  onModelAutoCancelled(seq: number): boolean {
    if (this.cancelled.has(seq)) return false;
    this.cancelled.add(seq);
    if (!this.localSpeaking) this.falseCount++;
    if (this.activeSeq === seq) this.activeSeq = null;
    return true;
  }

  cancelActive(source: CancelSource): void {
    const seq = this.activeSeq;
    if (seq === null || this.cancelled.has(seq)) return;
    this.cancelled.add(seq);
    this.activeSeq = null;
    this.deps.cancel(seq, source);
  }

  dispose(): void {
    this.clearPending();
  }

  private clearPending(): void {
    if (!this.pending) return;
    clearTimeout(this.pending);
    this.pending = null;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w gateway -- interrupt`
Expected: 10 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add gateway/src/session/interrupt.ts gateway/test/interrupt.test.ts
git commit -m "feat(gateway): echo-safe interrupt coordination

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Director（迎宾、静默追问、主动性限流）与配置加载

**Files:**
- Create: `gateway/src/session/director.ts`, `gateway/src/config.ts`, `gateway/config/director.json`, `gateway/prompts/persona.md`
- Test: `gateway/test/director.test.ts`, `gateway/test/config.test.ts`

**Depends on:** Task 2。可与 Task 3/4/5 并行。

**Interfaces:**
- Consumes: `ResponseKind`
- Produces:
  - `interface DirectorConfig { followupAfterMs; idleNoticeAfterMs; maxConsecutive; maxPerWindow; windowMs; quietPhrases: string[]; greetingInstruction; followupInstruction; idleNoticeInstruction; resumeInstruction }`
  - `class Director(cfg, { requestResponse(kind, instructions) })`：`onSessionStart()`、`onUserSpeech(speaking)`、`onUserActivity()`、`onUserFinal(text)`、`onAiTurnStarted()`、`onAiTurnEnded()`、`setMuted(muted)`、`pause()`、`resume()`、`stop()`
  - `interface GatewayConfig { port; appSecret; adapter: 'mock'; allowDebugText; devOrigins; mockSpeechThreshold }`、`loadConfig(env)`、`makeOriginCheck(devOrigins)`、`loadDirectorConfig(path)`、`loadPersona(path)`

静默计时规则：计时器在"AI 一轮播放结束"或"用户说完（本地 VAD 由 speaking 变 silent）"时启动，在用户开口或新一轮 AI 回复开始时清除。后一种启动点覆盖误打断：用户（或噪声）打断了 AI 却没有产生识别结果、模型也不回复时，8 秒后照常追问一次，而不是从此一直沉默（spec §5.5 的兜底；专门的"你刚刚是想说什么吗"话术留给 Plan 2）。`resume()` 在用户要求安静或静音时不说续接语。

- [ ] **Step 1: 配置文件与人设**

`gateway/config/director.json`（数值均为【预估】，Plan 2 调参）:

```json
{
  "followupAfterMs": 8000,
  "idleNoticeAfterMs": 25000,
  "maxConsecutive": 2,
  "maxPerWindow": 3,
  "windowMs": 300000,
  "quietPhrases": ["别说了", "安静一会", "安静点", "先别说话"],
  "greetingInstruction": "用户刚打开应用。请用一两句话热情、自然地打个招呼，再问一个轻松的开放式问题。",
  "followupInstruction": "用户沉默了一会儿。请接着刚才没聊完的话题，温和地追问一句，不超过 20 个字。",
  "idleNoticeInstruction": "用户仍然没有说话。请只说一句类似「我在这儿呢，想聊随时叫我」的话，然后安静下来。",
  "resumeInstruction": "网络刚恢复。请自然地说一句「刚才网络断了一下，我们接着聊」，然后接上之前的话题。"
}
```

注意：JSON 字符串内部的引用一律用「」，不要用半角双引号。写完后运行 `node -e "JSON.parse(require('fs').readFileSync('gateway/config/director.json','utf8'))"` 确认无报错。

`gateway/prompts/persona.md`:

```markdown
你是"小暖"，一个温和、真诚、有点幽默感的 AI 聊天伙伴，正通过手机屏幕上的虚拟形象和用户语音聊天。

说话方式：
- 像朋友聊天一样说口语，每次 1 到 3 句，简短自然。
- 先回应用户刚说的具体内容，再自然延伸；优先接住用户上一句里的细节。
- 不必每轮都提问，大约一半以内的回合用一个轻松的问题收尾。
- 记住对话里提到的人、事和偏好，在合适的时候自然地提起。
- 不使用"宝宝""亲亲"之类的叠词称呼，不用夸张语气。
- 不声称自己有真实的感情或身体；被问到是不是真人时，如实说明自己是 AI。

动作：
- 用户请你做动作（挥手、点头、微笑、转身、比心）时，调用 perform_action 工具，然后只用一句话自然回应，比如"好呀～"，不要描述动作过程。
- 不在列表里的动作，礼貌地说明暂时还不会。

安全：
- 不提供医疗、用药、投资等专业建议，建议用户咨询专业人士或家人。
- 永远不要让用户转账，也不索要验证码、密码或身份证号。
```

- [ ] **Step 2: 写失败的测试**

`gateway/test/director.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseKind } from '@anyidea/protocol';
import { Director, type DirectorConfig } from '../src/session/director.ts';

const cfg: DirectorConfig = {
  followupAfterMs: 8000,
  idleNoticeAfterMs: 25000,
  maxConsecutive: 2,
  maxPerWindow: 3,
  windowMs: 300000,
  quietPhrases: ['别说了'],
  greetingInstruction: 'G',
  followupInstruction: 'F',
  idleNoticeInstruction: 'I',
  resumeInstruction: 'R',
};

function make(c: DirectorConfig = cfg) {
  const calls: Array<[ResponseKind, string]> = [];
  const d = new Director(c, { requestResponse: (k, i) => calls.push([k, i]) });
  return { d, calls };
}

describe('Director', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('greets on session start', () => {
    const { d, calls } = make();
    d.onSessionStart();
    expect(calls).toEqual([['greeting', 'G']]);
  });

  it('follows up once, then posts an idle notice, then stays quiet', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(7999);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['followup', 'F']]);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(25000);
    expect(calls).toEqual([['followup', 'F'], ['followup', 'I']]);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    expect(calls).toHaveLength(2);
  });

  it('user activity cancels the timer and resets the sequence', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onUserActivity();
    vi.advanceTimersByTime(10000);
    expect(calls).toEqual([]);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(8000);
    expect(calls).toEqual([['followup', 'F']]);
  });

  it('never fires while the user is speaking', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(1000);
    d.onUserSpeech(true);
    d.onAiTurnEnded(); // e.g. a short reply ended while user keeps talking
    vi.advanceTimersByTime(30000);
    expect(calls).toEqual([]);
    d.onUserSpeech(false);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(8000);
    expect(calls).toEqual([['followup', 'F']]);
  });

  it('stops following up after a quiet phrase', () => {
    const { d, calls } = make();
    d.onUserFinal('你先别说了好吗');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
  });

  it('respects the per-window limit', () => {
    const { d, calls } = make({ ...cfg, maxConsecutive: 10, maxPerWindow: 2, idleNoticeAfterMs: 8000 });
    for (let i = 0; i < 4; i++) {
      d.onAiTurnEnded();
      vi.advanceTimersByTime(8000);
    }
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(300000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(8000);
    expect(calls).toHaveLength(3);
  });

  it('is silent while muted or paused, and announces on resume', () => {
    const { d, calls } = make();
    d.setMuted(true);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    d.setMuted(false);
    d.pause();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
    d.resume();
    expect(calls).toEqual([['followup', 'R']]);
  });

  it('follows up when the user goes quiet and no reply starts (e.g. a false interruption)', () => {
    const { d, calls } = make();
    d.onUserSpeech(true);
    d.onUserSpeech(false);
    vi.advanceTimersByTime(8000);
    expect(calls).toEqual([['followup', 'F']]);
  });

  it('a starting AI turn cancels the pending follow-up', () => {
    const { d, calls } = make();
    d.onUserSpeech(true);
    d.onUserSpeech(false);
    vi.advanceTimersByTime(1500);
    d.onAiTurnStarted();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
  });

  it('does not announce the resume line after a quiet request', () => {
    const { d, calls } = make();
    d.onUserFinal('别说了');
    d.pause();
    d.resume();
    expect(calls).toEqual([]);
  });

  it('does nothing after stop', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    d.stop();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
  });
});
```

`gateway/test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDirectorConfig, loadPersona, makeOriginCheck } from '../src/config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('config', () => {
  it('requires a strong APP_SECRET', () => {
    expect(() => loadConfig({ APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
  });

  it('only accepts the mock adapter in Plan 1', () => {
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), ADAPTER: 'seeduplex' })).toThrow(/ADAPTER/);
  });

  it('parses defaults and dev origins', () => {
    const c = loadConfig({ APP_SECRET: 'x'.repeat(16), DEV_ORIGINS: 'http://localhost:5173, http://a.test' });
    expect(c).toEqual({ port: 8787, appSecret: 'x'.repeat(16), adapter: 'mock', allowDebugText: false, devOrigins: ['http://localhost:5173', 'http://a.test'], mockSpeechThreshold: 800 });
  });

  it('validates the mock speech threshold', () => {
    expect(loadConfig({ APP_SECRET: 'x'.repeat(16), MOCK_SPEECH_THRESHOLD: '1500' }).mockSpeechThreshold).toBe(1500);
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), MOCK_SPEECH_THRESHOLD: 'loud' })).toThrow(/MOCK_SPEECH_THRESHOLD/);
  });

  it('allows loopback app origins and listed dev origins only', () => {
    const ok = makeOriginCheck(['http://localhost:5173']);
    expect(ok('http://127.0.0.1:39123')).toBe(true);
    expect(ok('http://localhost:5173')).toBe(true);
    expect(ok('http://127.0.0.1.evil.com:1')).toBe(false);
    expect(ok('https://example.com')).toBe(false);
  });

  it('loads the shipped director config and persona', () => {
    const d = loadDirectorConfig(`${root}config/director.json`);
    expect(d.maxConsecutive).toBe(2);
    expect(loadPersona(`${root}prompts/persona.md`)).toContain('perform_action');
  });

  it('rejects an invalid director config', () => {
    expect(() => loadDirectorConfig(`${root}package.json`)).toThrow();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -w gateway -- director config`
Expected: FAIL，无法解析模块。

- [ ] **Step 4: 实现 Director**

`gateway/src/session/director.ts`:

```ts
import type { ResponseKind } from '@anyidea/protocol';

export interface DirectorConfig {
  followupAfterMs: number;
  idleNoticeAfterMs: number;
  maxConsecutive: number;
  maxPerWindow: number;
  windowMs: number;
  quietPhrases: string[];
  greetingInstruction: string;
  followupInstruction: string;
  idleNoticeInstruction: string;
  resumeInstruction: string;
}

export interface DirectorDeps {
  requestResponse(kind: ResponseKind, instructions: string): void;
}

/** Controls proactive speech: greeting, silence follow-ups, and how often the assistant may speak first. */
export class Director {
  private timer: NodeJS.Timeout | null = null;
  private consecutive = 0;
  private history: number[] = [];
  private quiet = false;
  private muted = false;
  private paused = false;
  private stopped = false;
  private userSpeaking = false;

  constructor(
    private readonly cfg: DirectorConfig,
    private readonly deps: DirectorDeps,
  ) {}

  onSessionStart(): void {
    this.deps.requestResponse('greeting', this.cfg.greetingInstruction);
  }

  /** Local VAD state from the client. */
  onUserSpeech(speaking: boolean): void {
    const wasSpeaking = this.userSpeaking;
    this.userSpeaking = speaking;
    if (speaking) this.onUserActivity();
    else if (wasSpeaking) this.arm(); // if no reply starts (false interruption, nothing recognized), follow up later
  }

  /** Any sign of the user engaging (model-side speech, transcripts). */
  onUserActivity(): void {
    this.clear();
    this.consecutive = 0;
  }

  onUserFinal(text: string): void {
    this.onUserActivity();
    if (this.cfg.quietPhrases.some((p) => text.includes(p))) this.quiet = true;
  }

  /** A new assistant response started: the silence timer no longer applies. */
  onAiTurnStarted(): void {
    this.clear();
  }

  onAiTurnEnded(): void {
    this.arm();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.clear();
  }

  pause(): void {
    this.paused = true;
    this.clear();
  }

  resume(): void {
    this.paused = false;
    this.consecutive = 0;
    if (!this.blocked()) this.deps.requestResponse('followup', this.cfg.resumeInstruction);
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  /** Starts the silence timer: first a follow-up, then (if still silent) the idle notice. */
  private arm(): void {
    this.clear();
    if (this.blocked() || this.consecutive >= this.cfg.maxConsecutive) return;
    const isLast = this.consecutive === this.cfg.maxConsecutive - 1;
    const delay = this.consecutive === 0 ? this.cfg.followupAfterMs : this.cfg.idleNoticeAfterMs;
    const instruction = isLast ? this.cfg.idleNoticeInstruction : this.cfg.followupInstruction;
    this.timer = setTimeout(() => this.fire(instruction), delay);
  }

  private blocked(): boolean {
    return this.stopped || this.quiet || this.muted || this.paused || this.userSpeaking;
  }

  private fire(instruction: string): void {
    this.timer = null;
    if (this.blocked()) return;
    const now = Date.now();
    this.history = this.history.filter((t) => now - t < this.cfg.windowMs);
    if (this.history.length >= this.cfg.maxPerWindow) return;
    this.history.push(now);
    this.consecutive++;
    this.deps.requestResponse('followup', instruction);
  }

  private clear(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
```

- [ ] **Step 5: 实现配置加载**

`gateway/src/config.ts`:

```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { DirectorConfig } from './session/director.ts';

export interface GatewayConfig {
  port: number;
  appSecret: string;
  adapter: 'mock';
  allowDebugText: boolean;
  devOrigins: string[];
  /** MockAdapter speech threshold (RMS, 16-bit). TUNABLE (estimate, env MOCK_SPEECH_THRESHOLD); raise if speaker echo triggers fake turns. */
  mockSpeechThreshold: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const appSecret = env.APP_SECRET ?? '';
  if (appSecret.length < 16) throw new Error('APP_SECRET must be set (at least 16 characters)');
  const adapter = env.ADAPTER ?? 'mock';
  if (adapter !== 'mock') throw new Error(`Unsupported ADAPTER "${adapter}" (real adapters arrive in Plan 2)`);
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PORT must be a valid port number');
  const mockSpeechThreshold = Number(env.MOCK_SPEECH_THRESHOLD ?? 800);
  if (!Number.isInteger(mockSpeechThreshold) || mockSpeechThreshold < 100 || mockSpeechThreshold > 20000) {
    throw new Error('MOCK_SPEECH_THRESHOLD must be an integer between 100 and 20000');
  }
  return {
    port,
    appSecret,
    adapter,
    allowDebugText: env.ALLOW_DEBUG_TEXT === '1',
    devOrigins: (env.DEV_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    mockSpeechThreshold,
  };
}

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export function makeOriginCheck(devOrigins: string[]): (origin: string) => boolean {
  return (origin) => LOOPBACK_ORIGIN.test(origin) || devOrigins.includes(origin);
}

const DirectorSchema = z.object({
  followupAfterMs: z.number().int().positive(),
  idleNoticeAfterMs: z.number().int().positive(),
  maxConsecutive: z.number().int().min(0),
  maxPerWindow: z.number().int().min(0),
  windowMs: z.number().int().positive(),
  quietPhrases: z.array(z.string().min(1)),
  greetingInstruction: z.string().min(1),
  followupInstruction: z.string().min(1),
  idleNoticeInstruction: z.string().min(1),
  resumeInstruction: z.string().min(1),
});

export function loadDirectorConfig(path: string): DirectorConfig {
  return DirectorSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadPersona(path: string): string {
  return readFileSync(path, 'utf8');
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS；typecheck 无输出。

- [ ] **Step 7: 提交**

```bash
git add gateway/src/session/director.ts gateway/src/config.ts gateway/config gateway/prompts gateway/test/director.test.ts gateway/test/config.test.ts
git commit -m "feat(gateway): proactive Director, persona and validated config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
