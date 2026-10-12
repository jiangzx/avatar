# Plan 1 · 02 网关会话编排与服务（Task 7–8）

> 先读 [00-overview.md](00-overview.md) 的 Global Constraints。本文件依赖 Task 1–6 的全部接口。

---

### Task 7: Session 编排

**Files:**
- Create: `gateway/src/session/session.ts`
- Test: `gateway/test/session.test.ts`

**Depends on:** Task 2–6 全部完成并提交（含 Task 5 的 `onResponseStart` 返回值与 Task 6 的 `onAiTurnStarted`）。

**Interfaces:**
- Consumes: `RealtimeAdapter`、`AdapterFactory`、`PERFORM_ACTION_TOOL`（Task 2）；`ConversationLedger`、`Summarizer`、`LedgerOptions`（Task 3）；`ActionRouter`（Task 4）；`InterruptCoordinator`（Task 5）；`Director`、`DirectorConfig`（Task 6）；`truncateByPlayback`、`AI_SAMPLE_RATE`、`MIC_FRAME_SAMPLES`、`ClientMessage`、`ServerMessage`、`ResponseKind`（Task 1）；`log`
- Produces:
  - `interface Transport { send(msg: ServerMessage): void; sendAudio(seq: number, pcm: Int16Array): void }`
  - `interface SessionDeps { adapterFactory; summarizer; persona: string; director: DirectorConfig; ledger?: LedgerOptions; confirmWindowMs?: number; modelContextTokenLimit?: number; rebuildAfterTurns?: number }`
  - `class Session`：`ledger`、`lastResponseSeq`、`falseInterruptions`、`start(transport): Promise<void>`、`attachTransport(transport)`、`detachTransport()`、`handleClientMessage(msg)`、`handleMicAudio(pcm)`、`end()`

行为要点（对应 spec §5–§7）：
- 每个模型回复分配递增的 `responseSeq`（只在本会话内递增；新会话从 1 开始，客户端在 `session.ready` 时重置门控，见 Task 14）；被取消的回复，其迟到的音频、文本、动作一律丢弃。
- 新回复开始时若上一条仍在客户端播放（被顶替）：先发 `response.cancelled(旧)`，按已上报的 `playedMs` 截断写入 Ledger，再发 `response.start(新)`。顺序保证客户端先停旧、再接新。
- 新回复开始时调用 `director.onAiTurnStarted()`，清掉静默计时。
- 助手条目在客户端报告"播放结束 / 被打断"时才写入 Ledger；被打断时按 `truncateByPlayback` 截断，并在模型不支持截断时注入上下文说明。
- 用户终稿：写 Ledger → 关键词动作 → 视需要触发摘要。
- 模型连接 `error(retryable)` / `closed` → 重建模型会话（客户端不断开），并发 `error(model_reconnecting)`；AI 一轮播放自然结束后，若模型侧上下文估算超过 `modelContextTokenLimit × 0.8` 或累计 `rebuildAfterTurns` 轮，静默重建瘦身（这是 spec §6 "下一次用户说完前"的落地点：选在 AI 播放自然结束后的空闲点，避免打断进行中的回复）。
- 客户端断开：暂停 Director、取消进行中的回复、按 20 ms 节奏给模型补静音帧；重新接入：发 `session.resumed`，Director 说一句续接语。

- [ ] **Step 1: 写失败的测试**

`gateway/test/session.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session, type SessionDeps, type Transport } from '../src/session/session.ts';

const script: MockScript = {
  greeting: '你好呀',
  followup: '还在吗',
  fallbackReply: '我在听',
  turns: [
    { user: '我叫老王', reply: '王叔好' },
    { match: '挥', user: '跟我挥挥手', reply: '好呀', tool: { name: 'perform_action', args: { action: 'wave' } } },
  ],
};

const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', followupInstruction: 'F', idleNoticeInstruction: 'I', resumeInstruction: 'R',
};

function collector() {
  const sent: ServerMessage[] = [];
  const audio: Array<{ seq: number; n: number }> = [];
  const transport: Transport = { send: (m) => sent.push(m), sendAudio: (seq, pcm) => audio.push({ seq, n: pcm.length }) };
  return { sent, audio, transport };
}

function setup(overrides: Partial<SessionDeps> = {}) {
  const mocks: MockAdapter[] = [];
  const session = new Session({
    adapterFactory: () => {
      const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
      mocks.push(m);
      return m;
    },
    summarizer: new MockSummarizer(),
    persona: 'P',
    director,
    ...overrides,
  });
  return { session, mocks, ...collector() };
}

const of = <T extends ServerMessage['type']>(sent: ServerMessage[], type: T) =>
  sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
const assistantText = (sent: ServerMessage[], seq: number) =>
  of(sent, 'transcript.assistant').filter((m) => m.responseSeq === seq).map((m) => m.text).join('');
const loud = () => new Int16Array(320).fill(3000);
const quiet = () => new Int16Array(320);

async function greetAndFinish(s: ReturnType<typeof setup>) {
  await s.session.start(s.transport);
  await vi.advanceTimersByTimeAsync(1000);
  s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
}

describe('Session', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('greets proactively and records the greeting once playback ends', async () => {
    const s = setup();
    await greetAndFinish(s);
    expect(of(s.sent, 'response.start')).toEqual([{ type: 'response.start', responseSeq: 1, kind: 'greeting' }]);
    expect(assistantText(s.sent, 1)).toBe('你好呀');
    expect(of(s.sent, 'response.end')).toEqual([{ type: 'response.end', responseSeq: 1 }]);
    expect(s.audio.every((a) => a.seq === 1)).toBe(true);
    expect(s.session.ledger.recent).toEqual([{ role: 'assistant', text: '你好呀', ts: expect.any(Number) }]);
  });

  it('handles a spoken user turn end to end', async () => {
    const s = setup();
    await greetAndFinish(s);
    for (let i = 0; i < 10; i++) s.session.handleMicAudio(loud());
    for (let i = 0; i < 40; i++) s.session.handleMicAudio(quiet());
    expect(of(s.sent, 'transcript.user').at(-1)).toEqual({ type: 'transcript.user', text: '我叫老王', final: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(s.sent, 'response.start').at(-1)).toEqual({ type: 'response.start', responseSeq: 2, kind: 'reply' });
    expect(assistantText(s.sent, 2)).toBe('王叔好');
    expect(s.session.ledger.recent.map((e) => e.text)).toEqual(['你好呀', '我叫老王']);
  });

  it('client interruption cancels the reply, drops late audio and truncates the ledger', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '随便聊聊' });
    await vi.advanceTimersByTimeAsync(150); // reply started at 50 ms, first chunk sent
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 50, reason: 'interrupted' });
    const framesAtCancel = s.audio.filter((a) => a.seq === 2).length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(s.sent, 'response.cancelled')).toEqual([{ type: 'response.cancelled', responseSeq: 2 }]);
    expect(s.audio.filter((a) => a.seq === 2).length).toBe(framesAtCancel);
    const last = s.session.ledger.recent.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.interrupted).toBe(true);
    expect('我在听'.startsWith(last.text)).toBe(true);
    expect(s.mocks[0].notes).toHaveLength(1);
  });

  it('ignores model-only speech during playback but cancels once local VAD confirms', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '随便聊聊' });
    await vi.advanceTimersByTimeAsync(100);
    s.mocks[0].emit('userSpeechStarted'); // echo heard by the model
    await vi.advanceTimersByTimeAsync(400);
    expect(of(s.sent, 'response.cancelled')).toEqual([]);
    s.mocks[0].emit('userSpeechStarted');
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    expect(of(s.sent, 'response.cancelled')).toEqual([{ type: 'response.cancelled', responseSeq: 2 }]);
  });

  it('cancels and records a still-playing response when the model starts a new one', async () => {
    const s = setup();
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000); // greeting streamed; the client is still playing it
    s.session.handleClientMessage({ type: 'playback.progress', responseSeq: 1, playedMs: 150 });
    s.mocks[0].sendUserText('随便聊聊'); // e.g. the model took echo or a barge-in as a new turn
    await vi.advanceTimersByTimeAsync(100);
    const types = s.sent.map((m) => (m.type === 'response.cancelled' || m.type === 'response.start' ? `${m.type}:${m.responseSeq}` : null)).filter(Boolean);
    expect(types).toEqual(['response.start:1', 'response.cancelled:1', 'response.start:2']);
    expect(s.session.ledger.recent.at(-1)).toEqual({ role: 'assistant', text: '你好', ts: expect.any(Number), interrupted: true });
    expect(s.mocks[0].notes).toHaveLength(1);
  });

  it('runs an action once when keyword and tool call agree', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '跟我挥挥手' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(s.sent, 'avatar.action')).toEqual([{ type: 'avatar.action', action: 'wave', source: 'keyword' }]);
    expect(s.mocks[0].toolResults).toEqual([{ callId: 'call-mock-2', result: { ok: true } }]);
  });

  it('summarizes older turns into the model instructions', async () => {
    const s = setup({ ledger: { keepRecentTurns: 1, summarizeAfterTurns: 1, summarizeAfterTokens: 10_000 } });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '第一句' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    s.session.handleClientMessage({ type: 'debug.userText', text: '第二句' });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.session.ledger.summary).toBe('助手：你好呀；用户：第一句；助手：我在听');
    expect(s.mocks[0].instructions).toContain('助手：你好呀；用户：第一句；助手：我在听');
    expect(s.mocks[0].instructions).toContain('用户：第二句');
  });

  it('rebuilds the model session after a drop, carrying the ledger', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '我叫老王' });
    await vi.advanceTimersByTimeAsync(1000);
    s.mocks[0].simulateDrop();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.mocks).toHaveLength(2);
    expect(of(s.sent, 'error')).toContainEqual({ type: 'error', code: 'model_reconnecting', retryable: true });
    expect(s.mocks[1].instructions).toContain('用户：我叫老王');
  });

  it('silently slims the model context after enough turns', async () => {
    const s = setup({ rebuildAfterTurns: 1 });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.mocks).toHaveLength(2);
    expect(of(s.sent, 'error')).toEqual([]);
  });

  it('survives a client disconnect and resumes with a bridging line', async () => {
    const s = setup();
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(75); // greeting is streaming
    s.session.detachTransport();
    await vi.advanceTimersByTimeAsync(5000);
    const second = collector();
    s.session.attachTransport(second.transport);
    expect(second.sent[0]).toEqual({ type: 'session.resumed', lastResponseSeq: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(second.sent, 'response.start')).toEqual([{ type: 'response.start', responseSeq: 2, kind: 'followup' }]);
    expect(assistantText(second.sent, 2)).toBe('还在吗');
    expect(second.audio.every((a) => a.seq === 2)).toBe(true);
  });

  it('drops uplink audio while muted', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'client.mute', muted: true });
    for (let i = 0; i < 10; i++) s.session.handleMicAudio(loud());
    for (let i = 0; i < 40; i++) s.session.handleMicAudio(quiet());
    expect(of(s.sent, 'transcript.user')).toEqual([]);
  });

  it('end() closes the model and clears memory', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.end();
    expect(s.session.ledger.recent).toEqual([]);
    s.session.handleClientMessage({ type: 'debug.userText', text: '还在吗' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(s.sent, 'response.start')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w gateway -- session`
Expected: FAIL，无法解析 `../src/session/session.ts`。

- [ ] **Step 3: 实现**

`gateway/src/session/session.ts`:

```ts
import {
  AI_SAMPLE_RATE,
  MIC_FRAME_SAMPLES,
  truncateByPlayback,
  type ClientMessage,
  type ResponseKind,
  type ServerMessage,
} from '@anyidea/protocol';
import { PERFORM_ACTION_TOOL, type AdapterFactory, type RealtimeAdapter, type SessionConfig } from '../adapters/types.ts';
import { log } from '../log.ts';
import { ActionRouter } from './actions.ts';
import { Director, type DirectorConfig } from './director.ts';
import { InterruptCoordinator } from './interrupt.ts';
import { ConversationLedger, DEFAULT_LEDGER_OPTIONS, type LedgerOptions, type Summarizer } from './ledger.ts';

export interface Transport {
  send(msg: ServerMessage): void;
  sendAudio(seq: number, pcm: Int16Array): void;
}

export interface SessionDeps {
  adapterFactory: AdapterFactory;
  summarizer: Summarizer;
  persona: string;
  director: DirectorConfig;
  ledger?: LedgerOptions;
  confirmWindowMs?: number;
  modelContextTokenLimit?: number;
  rebuildAfterTurns?: number;
}

interface ResponseState {
  seq: number;
  kind: ResponseKind;
  text: string;
  audioMs: number;
  playedMs: number;
  finalized: boolean;
}

export class Session {
  readonly ledger: ConversationLedger;
  private adapter: RealtimeAdapter;
  private transport: Transport | null = null;
  private readonly director: Director;
  private readonly interrupt: InterruptCoordinator;
  private readonly actions = new ActionRouter();
  private readonly byId = new Map<string, ResponseState>();
  private readonly bySeq = new Map<number, ResponseState>();
  private seqCounter = 0;
  private pendingKind: ResponseKind | null = null;
  private muted = false;
  private keepalive: NodeJS.Timeout | null = null;
  private turnsSinceRebuild = 0;
  private charsSinceRebuild = 0;
  private rebuilding = false;
  private ended = false;

  constructor(private readonly deps: SessionDeps) {
    this.ledger = new ConversationLedger(deps.ledger ?? DEFAULT_LEDGER_OPTIONS);
    this.director = new Director(deps.director, { requestResponse: (kind, text) => this.requestResponse(kind, text) });
    this.interrupt = new InterruptCoordinator({
      confirmWindowMs: deps.confirmWindowMs ?? 300,
      cancel: (seq, source) => this.cancel(seq, source),
    });
    this.adapter = this.createAdapter();
  }

  get lastResponseSeq(): number {
    return this.seqCounter;
  }

  get falseInterruptions(): number {
    return this.interrupt.falseInterruptions;
  }

  async start(transport: Transport): Promise<void> {
    this.transport = transport;
    await this.adapter.connect(this.sessionConfig());
    this.director.onSessionStart();
  }

  attachTransport(transport: Transport): void {
    this.transport = transport;
    this.stopKeepalive();
    transport.send({ type: 'session.resumed', lastResponseSeq: this.seqCounter });
    this.director.resume();
  }

  detachTransport(): void {
    this.transport = null;
    this.director.pause();
    this.interrupt.cancelActive('local');
    this.startKeepalive();
  }

  handleMicAudio(pcm: Int16Array): void {
    if (this.muted || this.rebuilding || this.ended) return;
    this.adapter.sendAudio(pcm);
  }

  handleClientMessage(msg: ClientMessage): void {
    if (this.ended) return;
    switch (msg.type) {
      case 'vad': {
        const speaking = msg.state === 'speaking';
        this.interrupt.onLocalVad(speaking);
        this.director.onUserSpeech(speaking);
        break;
      }
      case 'playback.progress': {
        const s = this.bySeq.get(msg.responseSeq);
        if (s) s.playedMs = Math.max(s.playedMs, msg.playedMs);
        break;
      }
      case 'playback.stopped': {
        const s = this.bySeq.get(msg.responseSeq);
        if (!s) break;
        s.playedMs = Math.max(s.playedMs, msg.playedMs);
        if (msg.reason === 'interrupted') {
          this.interrupt.onClientInterrupted(msg.responseSeq);
          this.finalize(s, true);
        } else {
          this.finalize(s, false);
          this.interrupt.onResponseFinished(msg.responseSeq);
          this.director.onAiTurnEnded();
          this.maybeSlimContext();
        }
        break;
      }
      case 'client.mute':
        this.muted = msg.muted;
        this.director.setMuted(msg.muted);
        break;
      case 'debug.userText':
        this.interrupt.cancelActive('local');
        this.onUserFinal(msg.text, true);
        this.adapter.sendUserText(msg.text);
        break;
      case 'session.start':
      case 'session.resume':
      case 'session.end':
        break; // lifecycle is handled by SessionManager
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.stopKeepalive();
    this.director.stop();
    this.interrupt.dispose();
    this.adapter.removeAllListeners();
    this.adapter.close();
    this.ledger.clear();
    this.transport = null;
  }

  private send(msg: ServerMessage): void {
    this.transport?.send(msg);
  }

  private instructions(): string {
    return this.ledger.buildInstructions(this.deps.persona);
  }

  private sessionConfig(): SessionConfig {
    return { instructions: this.instructions(), tools: [PERFORM_ACTION_TOOL] };
  }

  private requestResponse(kind: ResponseKind, instructions: string): void {
    if (this.ended || this.interrupt.active !== null) return; // never talk over an active response
    this.pendingKind = kind;
    this.adapter.createResponse(instructions);
  }

  private createAdapter(): RealtimeAdapter {
    const a = this.deps.adapterFactory();
    const current = () => a === this.adapter && !this.ended;

    a.on('userSpeechStarted', () => {
      if (!current()) return;
      this.director.onUserActivity();
      this.interrupt.onModelSpeechStarted();
    });
    a.on('userTranscript', (text, final) => {
      if (!current()) return;
      this.director.onUserActivity();
      if (final) this.onUserFinal(text, true);
      else this.send({ type: 'transcript.user', text, final: false });
    });
    a.on('responseStarted', (id) => {
      if (!current()) return;
      const s: ResponseState = { seq: ++this.seqCounter, kind: this.pendingKind ?? 'reply', text: '', audioMs: 0, playedMs: 0, finalized: false };
      this.pendingKind = null;
      this.byId.set(id, s);
      this.bySeq.set(s.seq, s);
      this.director.onAiTurnStarted();
      const superseded = this.interrupt.onResponseStart(s.seq);
      if (superseded !== null) {
        // The previous reply is still playing on the client: stop it there first, then record what was heard.
        this.send({ type: 'response.cancelled', responseSeq: superseded });
        const prev = this.bySeq.get(superseded);
        if (prev) this.finalize(prev, true);
      }
      this.send({ type: 'response.start', responseSeq: s.seq, kind: s.kind });
      if (!this.transport) this.interrupt.cancelActive('local'); // nobody is listening
    });
    a.on('audioDelta', (id, pcm) => {
      const s = this.live(a, id);
      if (!s) return;
      s.audioMs += (pcm.length / AI_SAMPLE_RATE) * 1000;
      this.transport?.sendAudio(s.seq, pcm);
    });
    a.on('textDelta', (id, text) => {
      const s = this.live(a, id);
      if (!s) return;
      s.text += text;
      this.charsSinceRebuild += text.length;
      this.send({ type: 'transcript.assistant', responseSeq: s.seq, text });
    });
    a.on('toolCall', (id, callId, name, args) => {
      if (!current()) return;
      if (name !== PERFORM_ACTION_TOOL.name) {
        a.sendToolResult(callId, { ok: false, error: 'unknown_tool' });
        return;
      }
      const { action, result } = this.actions.fromTool(args);
      a.sendToolResult(callId, result);
      const s = this.byId.get(id);
      const cancelled = s ? this.interrupt.isCancelled(s.seq) : false;
      if (action && !cancelled) this.send({ type: 'avatar.action', action, source: 'tool' });
    });
    a.on('responseDone', (id) => {
      const s = this.live(a, id);
      if (s) this.send({ type: 'response.end', responseSeq: s.seq });
    });
    a.on('responseCancelled', (id) => {
      if (!current()) return;
      const s = this.byId.get(id);
      if (!s || !this.interrupt.onModelAutoCancelled(s.seq)) return;
      log('model_auto_cancel', { seq: s.seq });
      this.send({ type: 'response.cancelled', responseSeq: s.seq });
      this.finalize(s, true);
    });
    a.on('error', (code, retryable) => {
      if (!current()) return;
      log('adapter_error', { code, retryable });
      if (retryable) void this.rebuild('error');
      else this.send({ type: 'error', code, retryable: false });
    });
    a.on('closed', () => {
      if (current()) void this.rebuild('closed');
    });
    return a;
  }

  /** Response state if it belongs to the current adapter and is still deliverable. */
  private live(a: RealtimeAdapter, id: string): ResponseState | null {
    if (a !== this.adapter || this.ended) return null;
    const s = this.byId.get(id);
    if (!s || s.finalized || this.interrupt.isCancelled(s.seq)) return null;
    return s;
  }

  private cancel(seq: number, source: string): void {
    log('response_cancel', { seq, source });
    this.adapter.cancelResponse();
    this.send({ type: 'response.cancelled', responseSeq: seq });
    const s = this.bySeq.get(seq);
    if (s) this.finalize(s, true);
  }

  private finalize(s: ResponseState, interrupted: boolean): void {
    if (s.finalized) return;
    s.finalized = true;
    const text = interrupted ? truncateByPlayback(s.text, s.playedMs, s.audioMs) : s.text;
    this.ledger.addAssistant(text, Date.now(), interrupted);
    if (interrupted && s.text.length > 0 && !this.adapter.supportsPlaybackTruncate) {
      this.adapter.injectContextNote(`助手上一句只说到：「${text}」，被用户打断。`);
    }
    this.maybeSummarize();
  }

  private onUserFinal(text: string, echo: boolean): void {
    if (echo) this.send({ type: 'transcript.user', text, final: true });
    this.ledger.addUser(text, Date.now());
    this.turnsSinceRebuild++;
    this.charsSinceRebuild += text.length;
    this.director.onUserFinal(text);
    const action = this.actions.fromKeyword(text);
    if (action) this.send({ type: 'avatar.action', action, source: 'keyword' });
    this.maybeSummarize();
  }

  private maybeSummarize(): void {
    if (!this.ledger.needsSummary()) return;
    this.ledger
      .summarize(this.deps.summarizer)
      .then((applied) => {
        if (applied && !this.ended) this.adapter.updateInstructions(this.instructions());
      })
      .catch(() => log('summarize_failed'));
  }

  private maybeSlimContext(): void {
    const limit = (this.deps.modelContextTokenLimit ?? 12_000) * 0.8;
    const estimate = this.charsSinceRebuild + this.instructions().length;
    if (estimate > limit || this.turnsSinceRebuild >= (this.deps.rebuildAfterTurns ?? 30)) void this.rebuild('slim');
  }

  private async rebuild(reason: 'error' | 'closed' | 'slim'): Promise<void> {
    if (this.rebuilding || this.ended) return;
    this.rebuilding = true;
    log('model_rebuild', { reason });
    if (reason !== 'slim') this.send({ type: 'error', code: 'model_reconnecting', retryable: true });
    this.interrupt.cancelActive('local'); // uses the old adapter
    const old = this.adapter;
    this.adapter = this.createAdapter();
    old.removeAllListeners();
    old.close();
    try {
      await this.adapter.connect(this.sessionConfig());
      this.turnsSinceRebuild = 0;
      this.charsSinceRebuild = 0;
    } catch {
      log('model_rebuild_failed', { reason });
      this.send({ type: 'error', code: 'model_unavailable', retryable: true });
    } finally {
      this.rebuilding = false;
    }
  }

  private startKeepalive(): void {
    if (this.keepalive) return;
    const silence = new Int16Array(MIC_FRAME_SAMPLES);
    this.keepalive = setInterval(() => {
      if (!this.rebuilding && !this.ended) this.adapter.sendAudio(silence);
    }, 20);
  }

  private stopKeepalive(): void {
    if (!this.keepalive) return;
    clearInterval(this.keepalive);
    this.keepalive = null;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w gateway -- session`
Expected: 12 个测试 PASS。

如果 "summarizes older turns" 失败：检查 `greetAndFinish` 之后 Ledger 内容应为 `[助手:你好呀]`，第一句后为 `[助手:你好呀, 用户:第一句, 助手:我在听]`，第二句写入后 `keepRecentTurns: 1` 的切点在"用户：第二句"，因此摘要包含前三条。

- [ ] **Step 5: 全量测试与类型检查**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS；typecheck 无输出。

- [ ] **Step 6: 提交**

```bash
git add gateway/src/session/session.ts gateway/test/session.test.ts
git commit -m "feat(gateway): session orchestration with interrupts, memory, rebuild and resume

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: SessionManager、HTTP/WS 服务与入口

**Files:**
- Create: `gateway/src/session/tokens.ts`, `gateway/src/session/manager.ts`, `gateway/src/server/schemas.ts`, `gateway/src/server/server.ts`, `gateway/src/index.ts`
- Test: `gateway/test/server.test.ts`

**Depends on:** Task 7。本任务产出的 HTTP/WS 契约是 avatar-core Task 12 的依据，完成后冻结。

**Interfaces:**
- Consumes: `Session`、`Transport`（Task 7）；`loadConfig`、`makeOriginCheck`、`loadDirectorConfig`、`loadPersona`（Task 6）；`MockAdapter`、`loadMockScript`、`loadMockSpeech`（Task 2）；`MockSummarizer`（Task 3）；`encodeAudioFrame`、`decodeAudioFrame`、`FRAME_AI`、`FRAME_MIC`、`MIC_FRAME_SAMPLES`、`SessionTokens`、`ClientMessage`
- Produces（HTTP/WS 契约，avatar-core Task 12 依赖）:
  - `POST /session`（请求头 `x-app-secret`）→ `200 SessionTokens`；密钥错误 → `401`
  - `POST /session/resume`（请求头 `x-app-secret`，body `{ sessionId, resumeToken }`）→ `200 SessionTokens`；会话不存在或令牌无效 → `404 {"error":"session_gone"}`
  - `GET /healthz` → `200 {"ok":true}`
  - `GET /ws?token=<connectToken>` 升级为 WebSocket；无效令牌 → `401`。首条消息必须是 `session.start` 或 `session.resume`；之后文本帧为 `ClientMessage` JSON，二进制帧为 `FRAME_MIC` 音频
  - 连接接管：同一会话出现新的合法连接时，**新连接生效**，服务端主动断开旧连接（手机切网后旧 TCP 可能处于半开状态，服务端迟迟收不到关闭）。旧连接之后的关闭事件被忽略，不会影响新连接
  - 心跳：服务端每 `heartbeatMs`（默认 10 秒）发一次 WS ping；上一个周期内既没收到 pong 也没收到任何消息就断开该连接，进入 60 秒宽限期
  - CORS：只对 `http://127.0.0.1:<port>` 与 `DEV_ORIGINS` 返回 `Access-Control-Allow-Origin`
  - `class TokenStore`、`safeEqual(a, b)`；`class SessionManager(makeSession, graceMs = 60000)`：`create()`、`resume(sessionId, resumeToken)`、`claim(connectToken): { sessionId; connId } | null`、`attachSocket(sessionId, connId, terminate)`、`begin(sessionId, connId, kind, transport)`、`route(sessionId, connId)`、`disconnected(sessionId, connId)`、`end(sessionId)`、`shutdown()`、`size`
  - `createGatewayServer(opts: GatewayServerOptions): Server`（`GatewayServerOptions.heartbeatMs?`）

- [ ] **Step 1: 写失败的测试**

`gateway/test/server.test.ts`:

```ts
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FRAME_AI, decodeAudioFrame, type ServerMessage, type SessionTokens } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import { makeOriginCheck } from '../src/config.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { SessionManager } from '../src/session/manager.ts';
import { Session } from '../src/session/session.ts';
import { createGatewayServer } from '../src/server/server.ts';

const SECRET = 'test-secret-0123456789';
const script: MockScript = { greeting: '你好', followup: '还在吗', fallbackReply: '我在听', turns: [] };
const director: DirectorConfig = {
  followupAfterMs: 60000, idleNoticeAfterMs: 60000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', followupInstruction: 'F', idleNoticeInstruction: 'I', resumeInstruction: 'R',
};

let server: Server | null = null;
let manager: SessionManager | null = null;
const sockets: WebSocket[] = [];

async function boot(opts: { graceMs?: number; allowDebugText?: boolean; heartbeatMs?: number } = {}) {
  manager = new SessionManager(
    () => new Session({
      adapterFactory: () => new MockAdapter({ script, replyDelayMs: 10, charMs: 20, chunkMs: 20, paceFactor: 1 }),
      summarizer: new MockSummarizer(),
      persona: 'P',
      director,
    }),
    opts.graceMs ?? 60_000,
  );
  server = createGatewayServer({
    manager,
    appSecret: SECRET,
    allowedOrigin: makeOriginCheck([]),
    allowDebugText: opts.allowDebugText ?? true,
    heartbeatMs: opts.heartbeatMs,
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  manager?.shutdown();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  manager = null;
});

async function post(base: string, path: string, body: unknown = {}, secret = SECRET) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-secret': secret },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  audioFrames: number;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
}

function connect(base: string, token: string, options: WebSocket.ClientOptions = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`, options);
    sockets.push(ws);
    const client: Client = {
      ws,
      messages: [],
      audioFrames: 0,
      waitFor: (pred, timeoutMs = 2000) =>
        new Promise((res, rej) => {
          const started = Date.now();
          const poll = () => {
            const hit = client.messages.find(pred);
            if (hit) return res(hit);
            if (Date.now() - started > timeoutMs) return rej(new Error('timeout'));
            setTimeout(poll, 10);
          };
          poll();
        }),
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const f = decodeAudioFrame(new Uint8Array(data as Buffer));
        if (f?.kind === FRAME_AI) client.audioFrames++;
      } else {
        client.messages.push(JSON.parse(data.toString()) as ServerMessage);
      }
    });
    ws.on('open', () => resolve(client));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`http_${res.statusCode}`)));
    ws.on('error', reject);
  });
}

const start = (c: Client) => c.ws.send(JSON.stringify({ type: 'session.start', clientInfo: { platform: 'test', audioPath: 'A' } }));

describe('gateway server', () => {
  it('requires the app secret to create a session', async () => {
    const base = await boot();
    expect((await post(base, '/session', {}, 'wrong-secret-0123456')).status).toBe(401);
    const ok = await post(base, '/session');
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.json).sort()).toEqual(['connectToken', 'resumeToken', 'sessionId']);
  });

  it('answers CORS preflight only for loopback origins', async () => {
    const base = await boot();
    const good = await fetch(`${base}/session`, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:39123' } });
    expect(good.status).toBe(204);
    expect(good.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:39123');
    const bad = await fetch(`${base}/session`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects unknown and reused connect tokens', async () => {
    const base = await boot();
    await expect(connect(base, 'nope')).rejects.toThrow('http_401');
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    await connect(base, t.connectToken);
    await expect(connect(base, t.connectToken)).rejects.toThrow('http_401');
  });

  it('starts a session and streams the greeting', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    await c.waitFor((m) => m.type === 'session.ready');
    await c.waitFor((m) => m.type === 'response.start' && m.kind === 'greeting');
    await c.waitFor((m) => m.type === 'response.end');
    expect(c.audioFrames).toBeGreaterThan(0);
  });

  it('reports malformed client messages', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    c.ws.send('{"type":"nope"}');
    await c.waitFor((m) => m.type === 'error' && m.code === 'bad_message');
  });

  it('ignores debug text when disabled', async () => {
    const base = await boot({ allowDebugText: false });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    await c.waitFor((m) => m.type === 'response.end');
    c.ws.send(JSON.stringify({ type: 'debug.userText', text: '你好' }));
    await new Promise((r) => setTimeout(r, 300));
    expect(c.messages.some((m) => m.type === 'transcript.user')).toBe(false);
  });

  it('resumes after a disconnect with rotated tokens', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const r1 = await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken });
    expect(r1.status).toBe(200);
    const reused = await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken });
    expect(reused.status).toBe(404);
    const t2 = r1.json as unknown as SessionTokens;
    const c2 = await connect(base, t2.connectToken);
    c2.ws.send(JSON.stringify({ type: 'session.resume', sessionId: t.sessionId }));
    await c2.waitFor((m) => m.type === 'session.resumed');
  });

  it('lets a new connection take over a half-open one', async () => {
    const base = await boot();
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c1 = await connect(base, t.connectToken);
    start(c1);
    await c1.waitFor((m) => m.type === 'session.ready');
    const c1Closed = new Promise<void>((r) => c1.ws.on('close', () => r()));
    // The phone switched networks: the old socket still looks open to the server.
    const r1 = await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken });
    expect(r1.status).toBe(200);
    const c2 = await connect(base, (r1.json as unknown as SessionTokens).connectToken);
    await c1Closed; // the server dropped the superseded socket
    c2.ws.send(JSON.stringify({ type: 'session.resume', sessionId: t.sessionId }));
    await c2.waitFor((m) => m.type === 'session.resumed');
    c2.ws.send(JSON.stringify({ type: 'debug.userText', text: '你好' }));
    await c2.waitFor((m) => m.type === 'transcript.user');
    expect(manager!.size).toBe(1);
  });

  it('drops a socket that stops answering pings and keeps the session for resume', async () => {
    const base = await boot({ heartbeatMs: 50 });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken, { autoPong: false });
    start(c);
    await c.waitFor((m) => m.type === 'session.ready');
    await new Promise<void>((r) => c.ws.on('close', () => r()));
    expect((await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken })).status).toBe(200);
  });

  it('forgets sessions after the grace period', async () => {
    const base = await boot({ graceMs: 100 });
    const t = (await post(base, '/session')).json as unknown as SessionTokens;
    const c = await connect(base, t.connectToken);
    start(c);
    await c.waitFor((m) => m.type === 'session.ready');
    c.ws.close();
    await new Promise((r) => setTimeout(r, 250));
    expect((await post(base, '/session/resume', { sessionId: t.sessionId, resumeToken: t.resumeToken })).status).toBe(404);
    expect(manager!.size).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w gateway -- server`
Expected: FAIL，无法解析 `../src/session/manager.ts`。

- [ ] **Step 3: 实现 TokenStore**

`gateway/src/session/tokens.ts`:

```ts
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionTokens } from '@anyidea/protocol';

const newToken = () => randomBytes(24).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface ConnectEntry {
  sessionId: string;
  expiresAt: number;
}

export class TokenStore {
  private readonly connect = new Map<string, ConnectEntry>();
  private readonly resume = new Map<string, string>();

  constructor(
    private readonly connectTtlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(sessionId: string): SessionTokens {
    const connectToken = newToken();
    const resumeToken = newToken();
    this.connect.set(connectToken, { sessionId, expiresAt: this.now() + this.connectTtlMs });
    this.resume.set(sessionId, resumeToken);
    return { sessionId, connectToken, resumeToken };
  }

  /** One-time use. Returns the session id or null. */
  consumeConnect(token: string): string | null {
    const entry = this.connect.get(token);
    this.connect.delete(token);
    if (!entry || entry.expiresAt < this.now()) return null;
    return entry.sessionId;
  }

  /** Validates and rotates the resume token; the old one stops working. */
  rotate(sessionId: string, resumeToken: string): SessionTokens | null {
    const current = this.resume.get(sessionId);
    if (!current || !safeEqual(current, resumeToken)) return null;
    return this.issue(sessionId);
  }

  revoke(sessionId: string): void {
    this.resume.delete(sessionId);
    for (const [token, entry] of this.connect) if (entry.sessionId === sessionId) this.connect.delete(token);
  }
}
```

- [ ] **Step 4: 实现 SessionManager**

`gateway/src/session/manager.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { SessionTokens } from '@anyidea/protocol';
import { log } from '../log.ts';
import type { Session, Transport } from './session.ts';
import { TokenStore } from './tokens.ts';

interface Entry {
  session: Session;
  started: boolean;
  /** Id of the newest WS connection; 0 = none. Events from older connections are ignored. */
  connId: number;
  /** Drops the current socket when a newer connection supersedes it. */
  terminate: (() => void) | null;
  grace: NodeJS.Timeout | null;
}

export class SessionManager {
  readonly tokens = new TokenStore();
  private readonly sessions = new Map<string, Entry>();
  private nextConnId = 0;

  constructor(
    private readonly makeSession: () => Session,
    private readonly graceMs = 60_000,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  create(): SessionTokens {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { session: this.makeSession(), started: false, connId: 0, terminate: null, grace: null });
    log('session_created', { sessions: this.sessions.size });
    return this.tokens.issue(sessionId);
  }

  resume(sessionId: string, resumeToken: string): SessionTokens | null {
    if (!this.sessions.has(sessionId)) return null;
    return this.tokens.rotate(sessionId, resumeToken);
  }

  /**
   * A WS connection presents a (one-time) connect token. The newest connection always wins:
   * after a network change the previous socket may still look open here (half-open TCP).
   */
  claim(connectToken: string): { sessionId: string; connId: number } | null {
    const sessionId = this.tokens.consumeConnect(connectToken);
    if (!sessionId) return null;
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    if (entry.grace) {
      clearTimeout(entry.grace);
      entry.grace = null;
    }
    if (entry.connId !== 0) {
      const terminate = entry.terminate;
      entry.terminate = null;
      if (entry.started) entry.session.detachTransport();
      terminate?.();
      log('connection_superseded', {});
    }
    entry.connId = ++this.nextConnId;
    return { sessionId, connId: entry.connId };
  }

  attachSocket(sessionId: string, connId: number, terminate: () => void): void {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.connId === connId) entry.terminate = terminate;
  }

  async begin(sessionId: string, connId: number, kind: 'start' | 'resume', transport: Transport): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.connId !== connId) return false;
    if (kind === 'start') {
      if (entry.started) return false;
      entry.started = true;
      transport.send({ type: 'session.ready', sessionId });
      await entry.session.start(transport);
      return true;
    }
    if (!entry.started) return false;
    entry.session.attachTransport(transport);
    log('session_resumed', {});
    return true;
  }

  /** The session, but only for its current connection. */
  route(sessionId: string, connId: number): Session | null {
    const entry = this.sessions.get(sessionId);
    return entry && entry.connId === connId ? entry.session : null;
  }

  disconnected(sessionId: string, connId: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.connId !== connId) return; // unknown session or an older, superseded socket
    entry.connId = 0;
    entry.terminate = null;
    if (entry.started) entry.session.detachTransport();
    if (entry.grace) clearTimeout(entry.grace);
    entry.grace = setTimeout(() => this.destroy(sessionId, 'grace_expired'), this.graceMs);
  }

  end(sessionId: string): void {
    this.destroy(sessionId, 'client_end');
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.destroy(id, 'shutdown');
  }

  private destroy(sessionId: string, reason: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.grace) clearTimeout(entry.grace);
    entry.session.end();
    this.tokens.revoke(sessionId);
    this.sessions.delete(sessionId);
    log('session_destroyed', { reason, sessions: this.sessions.size });
  }
}
```

- [ ] **Step 5: 实现校验 schema**

`gateway/src/server/schemas.ts`:

```ts
import { z } from 'zod';
import type { ClientMessage } from '@anyidea/protocol';

const seq = z.number().int().min(0).max(2 ** 32 - 1);
const ms = z.number().min(0).max(3_600_000);

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.start'), clientInfo: z.object({ platform: z.string().max(32), audioPath: z.enum(['A', 'B']) }) }),
  z.object({ type: z.literal('session.resume'), sessionId: z.string().max(64) }),
  z.object({ type: z.literal('vad'), state: z.enum(['speaking', 'silent']), t: z.number() }),
  z.object({ type: z.literal('playback.progress'), responseSeq: seq, playedMs: ms }),
  z.object({ type: z.literal('playback.stopped'), responseSeq: seq, playedMs: ms, reason: z.enum(['interrupted', 'ended']) }),
  z.object({ type: z.literal('client.mute'), muted: z.boolean() }),
  z.object({ type: z.literal('debug.userText'), text: z.string().min(1).max(500) }),
  z.object({ type: z.literal('session.end') }),
]);

export const ResumeRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  resumeToken: z.string().min(1).max(128),
});

export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > 8192) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = ClientMessageSchema.safeParse(value);
  return result.success ? (result.data as ClientMessage) : null;
}
```

- [ ] **Step 6: 实现 HTTP/WS 服务**

`gateway/src/server/server.ts`:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { FRAME_AI, FRAME_MIC, MIC_FRAME_SAMPLES, decodeAudioFrame, encodeAudioFrame } from '@anyidea/protocol';
import { log } from '../log.ts';
import type { SessionManager } from '../session/manager.ts';
import type { Transport } from '../session/session.ts';
import { safeEqual } from '../session/tokens.ts';
import { ResumeRequestSchema, parseClientMessage } from './schemas.ts';

export interface GatewayServerOptions {
  manager: SessionManager;
  appSecret: string;
  allowedOrigin: (origin: string) => boolean;
  allowDebugText: boolean;
  /** Uplink frames are 20 ms (50/s); allow bursts up to 2x. */
  maxFramesPerSecond?: number;
  /** WS ping interval; a socket silent for a whole interval (no pong, no message) is dropped. */
  heartbeatMs?: number;
}

export function createGatewayServer(opts: GatewayServerOptions): Server {
  const server = createServer((req, res) => {
    handleHttp(req, res, opts).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const claimed = opts.manager.claim(url.searchParams.get('token') ?? '');
    if (!claimed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => bindConnection(ws, claimed.sessionId, claimed.connId, opts));
  });
  return server;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, opts: GatewayServerOptions): Promise<void> {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && opts.allowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-app-secret');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  res.setHeader('Cache-Control', 'no-store');
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'GET' && path === '/healthz') {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method !== 'POST') {
    json(res, 404, { error: 'not_found' });
    return;
  }
  const secret = req.headers['x-app-secret'];
  if (typeof secret !== 'string' || !safeEqual(secret, opts.appSecret)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  if (path === '/session') {
    json(res, 200, opts.manager.create());
    return;
  }
  if (path === '/session/resume') {
    const parsed = ResumeRequestSchema.safeParse(await readJson(req, 4096));
    if (!parsed.success) {
      json(res, 400, { error: 'bad_request' });
      return;
    }
    const tokens = opts.manager.resume(parsed.data.sessionId, parsed.data.resumeToken);
    if (!tokens) {
      json(res, 404, { error: 'session_gone' });
      return;
    }
    json(res, 200, tokens);
    return;
  }
  json(res, 404, { error: 'not_found' });
}

function bindConnection(ws: WebSocket, sessionId: string, connId: number, opts: GatewayServerOptions): void {
  const { manager } = opts;
  const maxFrames = opts.maxFramesPerSecond ?? 100;
  let begun = false;
  let frames = 0;
  let windowStart = Date.now();
  let alive = true;
  const transport: Transport = {
    send: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    sendAudio: (seq, pcm) => {
      if (ws.readyState === ws.OPEN) ws.send(encodeAudioFrame(FRAME_AI, seq, pcm));
    },
  };
  manager.attachSocket(sessionId, connId, () => ws.terminate());
  const heartbeat = setInterval(() => {
    if (!alive) {
      log('ws_heartbeat_timeout', {});
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, opts.heartbeatMs ?? 10_000);
  ws.on('pong', () => {
    alive = true;
  });

  ws.on('message', (data, isBinary) => {
    alive = true;
    if (isBinary) {
      if (!begun) return;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        frames = 0;
      }
      if (++frames > maxFrames) return;
      const frame = decodeAudioFrame(toBytes(data));
      if (!frame || frame.kind !== FRAME_MIC || frame.pcm.length > 4 * MIC_FRAME_SAMPLES) return;
      manager.route(sessionId, connId)?.handleMicAudio(frame.pcm);
      return;
    }
    const msg = parseClientMessage(data.toString());
    if (!msg) {
      transport.send({ type: 'error', code: 'bad_message', retryable: false });
      return;
    }
    if (msg.type === 'session.start' || msg.type === 'session.resume') {
      if (begun) return;
      if (msg.type === 'session.resume' && msg.sessionId !== sessionId) {
        ws.close(4001, 'session_mismatch');
        return;
      }
      begun = true;
      manager
        .begin(sessionId, connId, msg.type === 'session.start' ? 'start' : 'resume', transport)
        .then((ok) => {
          if (!ok) ws.close(4002, 'bad_state');
        })
        .catch(() => {
          log('session_begin_failed', {});
          ws.close(1011, 'internal');
        });
      return;
    }
    if (!begun) return;
    if (msg.type === 'debug.userText' && !opts.allowDebugText) return;
    if (msg.type === 'session.end') {
      if (manager.route(sessionId, connId)) manager.end(sessionId);
      ws.close(1000);
      return;
    }
    manager.route(sessionId, connId)?.handleClientMessage(msg);
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    manager.disconnected(sessionId, connId); // ignored if this socket was superseded or the session ended
  });
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npm test -w gateway -- server`
Expected: 10 个测试 PASS。

- [ ] **Step 8: 入口文件**

`gateway/src/index.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { MockAdapter, loadMockScript, loadMockSpeech } from './adapters/mock.ts';
import { loadConfig, loadDirectorConfig, loadPersona, makeOriginCheck } from './config.ts';
import { log } from './log.ts';
import { MockSummarizer } from './session/ledger.ts';
import { SessionManager } from './session/manager.ts';
import { Session } from './session/session.ts';
import { createGatewayServer } from './server/server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig();
const director = loadDirectorConfig(`${root}config/director.json`);
const persona = loadPersona(`${root}prompts/persona.md`);
const script = loadMockScript(`${root}mock/script.json`);
const speech = loadMockSpeech(`${root}mock/speech-24k.pcm`);
if (!speech) log('mock_speech_missing', { hint: 'run scripts/make-mock-speech.sh' });
// Lets the mock answer each Director instruction with the matching scripted line (idle notice, resume line, ...).
const instructionReplies = new Map([
  [director.greetingInstruction, script.greeting],
  [director.followupInstruction, script.followup],
  [director.idleNoticeInstruction, script.idleNotice ?? script.followup],
  [director.resumeInstruction, script.resume ?? script.followup],
]);

const manager = new SessionManager(
  () =>
    new Session({
      adapterFactory: () => new MockAdapter({ script, speech, instructionReplies, speechThreshold: config.mockSpeechThreshold }),
      summarizer: new MockSummarizer(),
      persona,
      director,
    }),
);
const server = createGatewayServer({
  manager,
  appSecret: config.appSecret,
  allowedOrigin: makeOriginCheck(config.devOrigins),
  allowDebugText: config.allowDebugText,
});

server.listen(config.port, '0.0.0.0', () => log('gateway_listening', { port: config.port, adapter: config.adapter }));

const shutdown = () => {
  manager.shutdown();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 9: 本地冒烟**

```bash
[ -f gateway/.env ] || cp gateway/.env.example gateway/.env
# The secret is generated once: reuse app/dev.json if Task 15 already created it.
SECRET="$(grep -s '"APP_SECRET"' app/dev.json | sed -E 's/.*"APP_SECRET": *"([^"]*)".*/\1/')"
if [ -z "$SECRET" ] || [ "$SECRET" = "same-as-gateway-APP_SECRET" ]; then SECRET="$(openssl rand -hex 16)"; fi
sed -i '' "s/^APP_SECRET=.*/APP_SECRET=$SECRET/" gateway/.env
npm run start -w gateway &
sleep 2
curl -s http://127.0.0.1:8787/healthz
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/session
curl -s -X POST -H "x-app-secret: $(grep APP_SECRET gateway/.env | cut -d= -f2)" http://127.0.0.1:8787/session
kill %1
```

Expected: `{"ok":true}`；`401`；一段含 `sessionId`、`connectToken`、`resumeToken` 的 JSON。终端日志中只出现事件名和数值，没有任何对话文本。

- [ ] **Step 10: 全量测试、类型检查与提交**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS。

```bash
git add gateway/src gateway/test
git commit -m "feat(gateway): session manager, authenticated HTTP/WS server and entrypoint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
