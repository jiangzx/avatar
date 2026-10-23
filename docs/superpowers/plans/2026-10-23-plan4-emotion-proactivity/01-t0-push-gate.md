# Task T0: 统一推送闸门与无响应观测

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. 先读 `00-overview.md` 的 Global Constraints 与「冻结接口 / T0 产出」，再读 spec §0、roadmap「打断与沉默：已踩过的坑」（尤其第 6 条）和 blockers #48。

**Goal:** Session 里所有运行中的 `session.update`（指令、音色）都经过 `PushGate`，只在安全缝隙发送、合并、每轮最多一次、间隔 ≥ `minIntervalMs`；适配器新增可选 `updateSession`（Seeduplex 一次完整 update，Qwen 一次部分 update）；用户终稿后无响应只记 `no_response_after_final`，不重建。

**为什么：** P4 实测 Seeduplex 播报中 `session.update` 会让下一轮不再响应（3/3，无 error）。现有两条路径会在播报中推送：`applyLanguage` 直接 `adapter.updateVoice`（`session.ts:537`），`maybeSummarize` 成功后直接 `pushInstructions()`（`session.ts:1096`）。

**本任务不改对话内容**：指令文本、开场、四段沉默、召回都不变，只改推送时机。

## 设计要点（实现前必读）

**与 spec §0 的已批准偏差（以 `00-overview.md` 冻结接口为准，不要改回 spec 写法）：**

| spec §0 写法 | 本计划 | 原因 |
|---|---|---|
| `InstructionGate` | `PushGate`（`pushGate.ts`） | 同时管指令和音色 |
| `gate.request({ voice?: string \| undefined })` | `voice?: { value: string \| undefined }` | 区分「不改音色」和「改回适配器默认」 |
| `log('no_response_after_final', { adapter, sinceFinalMs })` | 不带 `adapter` | Session 拿不到适配器名，启动日志已标明（接口疑问 5） |
| flush 时机含「打断结束」 | 打断停播不 flush | 坑位第 6 条：打断中 `session.update` 会丢服务端正在听的音频；由打断后那句回复播完覆盖（下表） |
| — | 新增 `session_push` 日志、`Director.isLightFinal`、`MockAdapter.sessionUpdates` | T7 统计推送次数；下游任务判轻回应 |

缝隙判定（Session 传给 `PushGate` 的 `seamOpen`）：

```text
pushSeamOpen = !ended && adapterReady && !modelGenerating && replyWatch === null && slimSeamOpen()
slimSeamOpen = !toolTurn.active && !userSpeaking && !responseLive && interrupt.active === null   （现有，不改）
```

- `adapterReady`：`connect()` 成功后为 true；`rebuild()` 一开始置 false，重连成功再置 true。保证 `setInitialLanguage`（manager 在 `start()` 之前调用，`manager.ts:131`）和重建期间不推送。
- `replyWatch`：一个计时器，从「存入的用户终稿」或「主动请求 `createResponse`」开始，到 `responseStarted` 为止，最长 `push.noResponseAfterMs`。期间缝隙关闭。原因：P4 只验证了「上一轮 done 之后、下一轮用户音频之前」安全；「终稿到回复开始之间」没测过，而 Seeduplex 的转写终稿可能早于 `response.output_audio.started`。语言切换正好在终稿处判定，所以 `onUserFinal` 先启动 watch，再做语言检测。
- 同一个 watch 兼做无响应观测：只有「非轻回应 + 终稿时没有活跃回复 + 本句开口后还没出现过 `response.start`」才在到期时记日志；其余情况到期只 flush。
- 已接受的窗口：本地 VAD 静音边沿到转写终稿之间，`userSpeaking` 已为 false、`replyWatch` 还没启动，缝隙在判定上是开的。这里不会主动 flush（静音边沿不 flush，见下文），只有 `PushGate` 的间隔计时器恰好在这段到期才可能发送，概率很低。本期接受，不加额外标志；如果 T7 真机观察到 #48 复现，再加 `awaitingFinal` 标志。

flush 调用点（全部都会先过 `seamOpen`，不满足就继续保留待推送）：

| 时机 | 位置 | 说明 |
|---|---|---|
| 回复正常播完 | `playback.stopped` reason=ended，`interrupt.onResponseFinished` 之后（替换 `session.ts:441` 的 `maybePushLanguage()`） | 主缝隙 |
| 主动请求发出前 | `requestResponse`，`createResponse` 之前（替换 `session.ts:651`） | 随后先 `watchReply(false)` 再 `createResponse`，关缝到该句开始 |
| 工具轮结束 | `releaseToolTurn` 末尾 | continuation 仍在播时 seam 关闭，等它播完走第一行 |
| 用户说完但没形成回复 | `replyWatch` 到期 | spec「用户说话结束而未形成回复」 |
| 间隔到期 | `PushGate` 内部计时器 | 到期重新判缝 |

刻意**不** flush 的地方：`playback.stopped` reason=interrupted、本地 VAD silent 边沿、`finalize()`、用户终稿本身。前者是坑位第 6 条（打断中 `session.update` 会丢服务端正在听的音频）；后三者此时上游可能正要生成回复。spec 的「打断结束」由「打断后的那句回复播完」或「没听清兜底句走 `requestResponse`」覆盖。

重连：`start()` 与 `rebuild()` 的 `connect()` 成功后 `gate.clearPending()`，因为 `connect` 已带最新指令与音色（替换 `session.ts:304`、`session.ts:1152` 的 `languagePushPending = false`）。

已接受的代价（spec §0）：换语言后的第一句可能仍是旧音色；摘要/状态卡可能晚一到两轮生效。

---

**Files:**

- Create: `gateway/src/session/pushGate.ts`
- Create: `gateway/test/push-gate.test.ts`
- Create: `gateway/test/push-seam.test.ts`
- Create: `gateway/test/no-response.test.ts`
- Modify: `gateway/src/adapters/types.ts`（L65–67 后加一行可选方法）
- Modify: `gateway/src/adapters/seeduplex.ts`（L95 后加 `updateSession`）
- Modify: `gateway/src/adapters/qwen.ts`（L97–100 后加 `updateSession`）
- Modify: `gateway/src/adapters/mock.ts`（L62 后加 `sessionUpdates`；L112–114 后加 `updateSession`）
- Modify: `gateway/src/session/pacing.ts`（L15–36 `PacingSchema` 加 `push`）
- Modify: `gateway/config/pacing.json`（末尾加 `push`）
- Modify: `gateway/src/session/session.ts`（L34、L107–108、L150–151、L161、L248–250、L303–304、L374–375、L438–441、L466–468、L503–506、L524–547、L580–584、L631–636、L650–652、L703–705、L739、L857–866、L1083–1084、L1140–1152、L1195–1196）
- Modify: `gateway/src/session/director.ts`（L229 前加 `isLightFinal`）
- Modify: `gateway/src/index.ts`（L154 后加 `push: pacing.push`）
- Modify: `gateway/scripts/eval.ts`（L69 后加 `push: pacing.push`，让 T1 基线与生产同一推送节奏）
- Test (modify): `gateway/test/seeduplex.test.ts`（L103 前插入）、`gateway/test/qwen.test.ts`（L130 前插入）、`gateway/test/mock.test.ts`（L136 前插入）、`gateway/test/pacing.test.ts`（L103–108、L130–135、L149、L157）、`gateway/test/session.test.ts`（L184–186、L519–523、L977–1032）、`gateway/test/multilingual.test.ts`（L209–226）

**Interfaces:**

- Consumes: 无上游任务。现有 `Session.slimSeamOpen()`、`modelGenerating`、`responseLive`、`interrupt.active`、`toolTurn.active`、`userSpeaking`；`RealtimeAdapter.updateInstructions/updateVoice`（保留，作为无 `updateSession` 时的退路）。
- Produces（与 `00-overview.md`「T0 产出」一致，名字与签名原样）：
  - `gateway/src/session/pushGate.ts`：`PushRequest`、`PushGateDeps`、`class PushGate { request; flush; onUserFinal; clearPending; readonly hasPending; dispose }`。
  - `RealtimeAdapter.updateSession?(update: { instructions?: string; voice?: { value: string | undefined } }): void`。
  - `PacingSchema.push = { minIntervalMs: int 0..10000, noResponseAfterMs: int 1000..30000 }`（strict）；`pacing.json` 写 `{ "minIntervalMs": 1000, "noResponseAfterMs": 5000 }`。
  - `SessionDeps.push?: PacingConfig['push']`，省略时 `{ minIntervalMs: 0, noResponseAfterMs: 5000 }`。
  - 日志 `log('no_response_after_final', { sinceFinalMs })`。
  - Session 内部：`pushInstructions()` → `gate.request({ instructions: true })`；`applyLanguage` → `gate.request({ instructions: true, voice: { value: this.voiceFor(next) } })`；删除 `languagePushPending` / `maybePushLanguage`。
  - 额外（见文末「接口疑问」）：`Director.isLightFinal(text: string): boolean`；日志 `log('session_push', { instructions: boolean, voice: boolean })`；`MockAdapter.sessionUpdates`。

---

## Cycle 1：PushGate 纯逻辑

- [x] **Step 1: 写失败测试**

Create `gateway/test/push-gate.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushGate, type PushRequest } from '../src/session/pushGate.ts';

function gate(minIntervalMs = 0) {
  let open = true;
  const sent: PushRequest[] = [];
  const g = new PushGate({
    seamOpen: () => open,
    send: (update) => sent.push(update),
    now: () => Date.now(),
    minIntervalMs,
  });
  return { g, sent, setOpen: (value: boolean) => { open = value; } };
}

describe('PushGate', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends at once when the seam is open', () => {
    const { g, sent } = gate();
    g.request({ instructions: true });
    expect(sent).toEqual([{ instructions: true }]);
    expect(g.hasPending).toBe(false);
  });

  it('holds while the seam is closed and sends on the next flush', () => {
    const { g, sent, setOpen } = gate();
    setOpen(false);
    g.request({ instructions: true });
    g.flush();
    expect(sent).toEqual([]);
    expect(g.hasPending).toBe(true);
    setOpen(true);
    g.flush();
    expect(sent).toEqual([{ instructions: true }]);
    expect(g.hasPending).toBe(false);
  });

  it('merges requests into one update and keeps the latest voice', () => {
    const { g, sent, setOpen } = gate();
    setOpen(false);
    g.request({ voice: { value: 'voice-en' } });
    g.request({ instructions: true });
    g.request({ voice: { value: 'voice-zh' } });
    setOpen(true);
    g.flush();
    expect(sent).toEqual([{ instructions: true, voice: { value: 'voice-zh' } }]);
  });

  it('keeps an explicit default voice as a voice change', () => {
    const { g, sent } = gate();
    g.request({ voice: { value: undefined } });
    expect(sent).toHaveLength(1);
    expect('voice' in sent[0]!).toBe(true);
    expect(sent[0]!.voice).toEqual({ value: undefined });
  });

  it('ignores an empty request', () => {
    const { g, sent } = gate();
    g.request({});
    expect(sent).toEqual([]);
    expect(g.hasPending).toBe(false);
  });

  it('sends at most once per user turn', () => {
    const { g, sent } = gate();
    g.request({ instructions: true });
    g.request({ voice: { value: 'voice-zh' } });
    expect(sent).toHaveLength(1);
    expect(g.hasPending).toBe(true);
    g.onUserFinal();
    expect(sent).toHaveLength(1); // a new turn only lifts the cap; it does not flush
    g.flush();
    expect(sent).toEqual([{ instructions: true }, { voice: { value: 'voice-zh' } }]);
  });

  it('waits out the minimum interval and then flushes by itself', async () => {
    const { g, sent } = gate(1_000);
    g.request({ instructions: true });
    g.onUserFinal();
    await vi.advanceTimersByTimeAsync(300);
    g.request({ instructions: true });
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(699);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
  });

  it('checks the seam again when the interval timer fires', async () => {
    const { g, sent, setOpen } = gate(1_000);
    g.request({ instructions: true });
    g.onUserFinal();
    g.request({ instructions: true });
    setOpen(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(1);
    expect(g.hasPending).toBe(true);
    setOpen(true);
    g.flush();
    expect(sent).toHaveLength(2);
  });

  it('drops pending work on clearPending and lets the fresh session take one push', () => {
    const { g, sent, setOpen } = gate();
    g.request({ instructions: true });
    setOpen(false);
    g.request({ voice: { value: 'voice-zh' } });
    g.clearPending();
    expect(g.hasPending).toBe(false);
    setOpen(true);
    g.flush();
    expect(sent).toHaveLength(1);
    g.request({ instructions: true });
    expect(sent).toHaveLength(2);
  });

  it('never sends after dispose', async () => {
    const { g, sent } = gate(1_000);
    g.request({ instructions: true });
    g.onUserFinal();
    g.request({ instructions: true });
    g.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    g.request({ instructions: true });
    g.flush();
    expect(sent).toHaveLength(1);
    expect(g.hasPending).toBe(false);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run（仓库根目录）: `npx vitest run --root gateway test/push-gate.test.ts`
Expected: FAIL：模块不存在（vitest 的文案类似 `Failed to load url ../src/session/pushGate.ts` 或 `Failed to resolve import`，以实际输出为准）。

- [x] **Step 3: 实现**

Create `gateway/src/session/pushGate.ts`:

```ts
export interface PushRequest {
  /** Re-read and send the current instructions when flushed. */
  instructions?: boolean;
  /** Present = change voice; value undefined = adapter default. */
  voice?: { value: string | undefined };
}

export interface PushGateDeps {
  /** Session seam: slimSeamOpen() && !modelGenerating && !ended. */
  seamOpen: () => boolean;
  /** Called at most once per flush with the merged request. */
  send: (update: PushRequest) => void;
  now: () => number;
  minIntervalMs: number;
}

/**
 * Holds session changes until a safe seam (blockers #48: a Seeduplex session.update during a
 * reply silences the next turn). Merges requests, sends at most one per user turn and per interval.
 */
export class PushGate {
  private pending: PushRequest | null = null;
  private lastSentAt: number | null = null;
  private pushedThisTurn = false;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly deps: PushGateDeps) {}

  get hasPending(): boolean {
    return this.pending !== null;
  }

  /** Merge into the pending update, then try to flush. */
  request(update: PushRequest): void {
    if (this.disposed || (!update.instructions && !update.voice)) return;
    const merged: PushRequest = { ...this.pending };
    if (update.instructions) merged.instructions = true;
    // Latest voice wins; instructions are re-read at send time.
    if (update.voice) merged.voice = { value: update.voice.value };
    this.pending = merged;
    this.flush();
  }

  /** Send the pending update if the seam is open, the interval has passed, and this turn has not pushed yet. */
  flush(): void {
    if (this.disposed || !this.pending || this.pushedThisTurn || !this.deps.seamOpen()) return;
    const waitMs = this.lastSentAt === null ? 0 : this.lastSentAt + this.deps.minIntervalMs - this.deps.now();
    if (waitMs > 0) {
      this.armTimer(waitMs);
      return;
    }
    const update = this.pending;
    this.pending = null;
    this.pushedThisTurn = true;
    this.lastSentAt = this.deps.now();
    this.clearTimer();
    this.deps.send(update);
  }

  /** A new user turn begins: allow one more push this turn. */
  onUserFinal(): void {
    this.pushedThisTurn = false;
  }

  /** Drop pending work (after a successful reconnect). The fresh session may take one push. */
  clearPending(): void {
    this.pending = null;
    this.pushedThisTurn = false;
    this.clearTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.clearTimer();
  }

  /** Retry when the interval ends; the seam is checked again then. */
  private armTimer(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, ms);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run --root gateway test/push-gate.test.ts`
Expected: PASS（10 passed）。

---

## Cycle 2：适配器 `updateSession`

- [x] **Step 5: 写失败测试（三个适配器）**

`gateway/test/seeduplex.test.ts`：在 L103 `it('does not become ready or send audio until session.created arrives', ...` 之前插入：

```ts
  it('sends one full session.update for a combined instructions and voice change', async () => {
    const server = new WebSocketServer({ port: 0 }); servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    type Sent = { type: string; session?: { instructions?: string; tools?: unknown[]; audio?: { output?: { voice?: string } } } };
    const sent: Sent[] = [];
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Sent;
      sent.push(event);
      if (event.type === 'session.create') socket.send(JSON.stringify({ type: 'session.created' }));
    }));
    const adapter = new SeeduplexAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'voice-default' });
    await adapter.connect({ ...config, voice: 'voice-en' });
    adapter.updateSession({ instructions: 'next fixture', voice: { value: 'voice-zh' } });
    adapter.updateSession({ instructions: 'third fixture' });
    adapter.updateSession({ voice: { value: undefined } });
    adapter.updateSession({});
    await wait();
    const updates = sent.filter((event) => event.type === 'session.update').map((event) => event.session);
    expect(updates).toHaveLength(3);
    expect(updates[0]).toMatchObject({ instructions: 'next fixture', audio: { output: { voice: 'voice-zh' } } });
    expect(updates[0]?.tools).toHaveLength(1);
    expect(updates[1]).toMatchObject({ instructions: 'third fixture', audio: { output: { voice: 'voice-zh' } } });
    expect(updates[2]).toMatchObject({ instructions: 'third fixture', audio: { output: { voice: 'voice-default' } } });
    adapter.close();
  });

```

`gateway/test/qwen.test.ts`：在 L130 `it('waits for session.created before resolving or sending audio', ...` 之前插入：

```ts
  it('sends one partial session.update for a combined instructions and voice change', async () => {
    const s = new WebSocketServer({ port: 0 }); servers.push(s); await new Promise<void>((r) => s.once('listening', r)); const port = (s.address() as { port: number }).port;
    const sent: Array<Record<string, unknown>> = [];
    s.on('connection', (ws) => ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as Record<string, unknown>;
      sent.push(e);
      if (e.type === 'session.update' && sent.length === 1) { ws.send(JSON.stringify({ type: 'session.created' })); ws.send(JSON.stringify({ type: 'session.updated' })); }
    }));
    const a = new QwenAdapter({ apiKey: 'fixture', endpoint: `ws://127.0.0.1:${port}`, voice: 'voice-default' });
    await a.connect({ instructions: 'fixture', tools: [], voice: 'voice-en' });
    a.updateSession({ instructions: 'next', voice: { value: 'voice-zh' } });
    a.updateSession({ instructions: 'only instructions' });
    a.updateSession({ voice: { value: undefined } });
    a.updateSession({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updates = sent.filter((e) => e.type === 'session.update').map((e) => e.session);
    expect(updates.slice(1)).toEqual([
      { instructions: 'next', audio: { output: { voice: 'voice-zh' } } },
      { instructions: 'only instructions' },
      { audio: { output: { voice: 'voice-default' } } },
    ]);
    a.close();
  });

```

`gateway/test/mock.test.ts`：在 L136 `it('simulateDrop emits error then closed', ...` 之前插入：

```ts
  it('records combined session updates and applies them', async () => {
    const m = make();
    await m.connect({ instructions: 'v1', tools: [], voice: 'voice-en' });
    m.updateSession({ instructions: 'v2', voice: { value: 'voice-zh' } });
    m.updateSession({ voice: { value: undefined } });
    expect(m.sessionUpdates).toEqual([
      { instructions: 'v2', voice: { value: 'voice-zh' } },
      { voice: { value: undefined } },
    ]);
    expect(m.instructions).toBe('v2');
    expect(m.voice).toBeUndefined();
  });

```

- [x] **Step 6: 跑测试确认失败**

Run: `npx vitest run --root gateway test/seeduplex.test.ts test/qwen.test.ts test/mock.test.ts`
Expected: FAIL 3 项，`TypeError: m.updateSession is not a function` / `a.updateSession is not a function` / `adapter.updateSession is not a function`。

- [x] **Step 7: 实现**

`gateway/src/adapters/types.ts`，L66–67 之后加一行：

```ts
  /** Move the session to another voice without reconnecting; undefined = the adapter default. */
  updateVoice(voice: string | undefined): void;
  /** One combined session change. Seeduplex sends a single full session.update; Qwen a single partial one. */
  updateSession?(update: { instructions?: string; voice?: { value: string | undefined } }): void;
```

`gateway/src/adapters/seeduplex.ts`，L95 `updateVoice(...)` 这一行之后加：

```ts
  updateVoice(voice: string | undefined): void { this.voice = voice ?? this.opts.voice; this.pushSession(); }
  /** Both changes in one full payload: P4 showed back-to-back updates must be merged (blockers #48). */
  updateSession(update: { instructions?: string; voice?: { value: string | undefined } }): void {
    if (update.instructions === undefined && !update.voice) return;
    if (update.instructions !== undefined) this.instructions = update.instructions;
    if (update.voice) this.voice = update.voice.value ?? this.opts.voice;
    this.pushSession();
  }
```

`gateway/src/adapters/qwen.ts`，L97–100 的 `updateVoice` 方法之后加：

```ts
  /** One partial session.update with only the changed fields; same keys as the connect payload. */
  updateSession(update: { instructions?: string; voice?: { value: string | undefined } }): void {
    const session: Json = {};
    if (update.instructions !== undefined) {
      this.instructions = update.instructions;
      session.instructions = update.instructions;
    }
    if (update.voice) {
      this.voice = update.voice.value ?? this.opts.voice;
      session.audio = { output: { voice: this.voice } };
    }
    if (this.connected && Object.keys(session).length > 0) this.send({ type: 'session.update', session });
  }
```

> 【推断】Qwen 部分 update 同时带 `instructions` 与 `audio.output.voice`：两个键各自单独发送已验证（`qwen.test.ts` 现有用例与 2026-10-21 音色探针），连接时的首个 `session.update` 也同时带这两个键。组合的部分 update 尚无真实探针，T7 真实回归时一并确认（见文末）。

`gateway/src/adapters/mock.ts`，L62 `toolResults` 之后加：

```ts
  readonly toolResults: Array<{ callId: string; result: unknown }> = [];
  /** Every combined session change, in order (tests assert the push gate). */
  readonly sessionUpdates: Array<{ instructions?: string; voice?: { value: string | undefined } }> = [];
```

同文件 L112–114 `updateVoice` 方法之后加：

```ts
  updateSession(update: { instructions?: string; voice?: { value: string | undefined } }): void {
    this.sessionUpdates.push({ ...update });
    if (update.instructions !== undefined) this.instructions = update.instructions;
    if (update.voice) this.voice = update.voice.value;
  }
```

- [x] **Step 8: 跑测试确认通过**

Run: `npx vitest run --root gateway test/seeduplex.test.ts test/qwen.test.ts test/mock.test.ts`
Expected: PASS（39 passed）。

---

## Cycle 3：`pacing.json` 的 `push`

- [x] **Step 9: 写失败测试**

`gateway/test/pacing.test.ts` 改三处，再加一个用例。

(a) L103–108 与 L130–135 两处 `base` 对象，都把：

```ts
      policies: { summarize: { timeoutMs: 15_000, retries: 1, backoffMs: 1000, maxBackoffMs: 4000 } },
    };
```

改为：

```ts
      policies: { summarize: { timeoutMs: 15_000, retries: 1, backoffMs: 1000, maxBackoffMs: 4000 } },
      push: { minIntervalMs: 1_000, noResponseAfterMs: 5_000 },
    };
```

(b) L157 改为：

```ts
    const pacing: PacingConfig = { rebuild: { contextChars: 2000, triggerRatio: 1, afterTurns: 30 }, tailGuardMs: 400, output: { maxTokens: null }, policies: { summarize: { timeoutMs: 1000, retries: 0, backoffMs: 0, maxBackoffMs: 0 } }, slim, push: { minIntervalMs: 1_000, noResponseAfterMs: 5_000 } };
```

(c) 在 L149 `it('rejects personas that leave too little room for history, and inconsistent ledger turns', ...` 之前插入：

```ts
  it('ships push pacing and rejects a missing or out-of-range push block', () => {
    expect(loadPacing(`${root}config/pacing.json`).push).toEqual({ minIntervalMs: 1_000, noResponseAfterMs: 5_000 });
    const dir = mkdtempSync(join(tmpdir(), 'pace-'));
    const shipped = JSON.parse(readFileSync(join(root, 'config/pacing.json'), 'utf8')) as Record<string, unknown>;
    const write = (push: unknown) => {
      const next: Record<string, unknown> = { ...shipped, push };
      if (push === undefined) delete next.push;
      writeFileSync(join(dir, 'pacing.json'), JSON.stringify(next));
    };
    for (const push of [
      undefined,
      { minIntervalMs: -1, noResponseAfterMs: 5_000 },
      { minIntervalMs: 10_001, noResponseAfterMs: 5_000 },
      { minIntervalMs: 1_000, noResponseAfterMs: 999 },
      { minIntervalMs: 1_000, noResponseAfterMs: 30_001 },
      { minIntervalMs: 1.5, noResponseAfterMs: 5_000 },
      { minIntervalMs: 1_000, noResponseAfterMs: 5_000, extra: 1 },
    ]) {
      write(push);
      expect(() => loadPacing(join(dir, 'pacing.json'))).toThrow();
    }
    write({ minIntervalMs: 0, noResponseAfterMs: 1_000 });
    expect(loadPacing(join(dir, 'pacing.json')).push).toEqual({ minIntervalMs: 0, noResponseAfterMs: 1_000 });
  });

```

- [x] **Step 10: 跑测试确认失败**

Run: `npx vitest run --root gateway test/pacing.test.ts`
Expected: FAIL 2 项：`requires slim pacing config`（strict schema 不认识 `push` 键而抛错）与 `ships push pacing ...`（`push` 为 undefined）。

- [x] **Step 11: 实现**

`gateway/src/session/pacing.ts`，`PacingSchema` 末尾（L35 `slim` 的 `}).strict(),` 之后、L36 `}).strict();` 之前）加：

```ts
  /** Session updates wait for a seam (blockers #48); the reply watch only logs. */
  push: z.object({
    minIntervalMs: z.number().int().min(0).max(10_000),
    noResponseAfterMs: z.number().int().min(1_000).max(30_000),
  }).strict(),
```

`gateway/config/pacing.json`，把末尾：

```json
      "en": "Let me think about where we were."
    }
  }
}
```

改为：

```json
      "en": "Let me think about where we were."
    }
  },
  "push": { "minIntervalMs": 1000, "noResponseAfterMs": 5000 }
}
```

- [x] **Step 12: 跑测试确认通过**

Run: `npx vitest run --root gateway test/pacing.test.ts`
Expected: PASS（12 passed）。

---

## Cycle 4：Session 全部推送路径迁移到闸门

- [x] **Step 13: 写失败测试**

(a) Create `gateway/test/push-seam.test.ts`（Seeduplex 本地上游断言线上事件；Mock 断言重连清空、无回复到期 flush、连接前不推送）：

```ts
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { ServerMessage } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import { SeeduplexAdapter } from '../src/adapters/seeduplex.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer, type Summarizer } from '../src/session/ledger.ts';
import { Session, type SessionDeps, type Transport } from '../src/session/session.ts';

const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));

const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting',
  followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle',
  resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: 'ok',
  memoryNoticeInstruction: 'M', memoryNoticeText: 'notice',
};

const ctx = (language: 'zh' | 'en'): SessionContext => ({ roleId: 'elder-companion', styleId: 'grandchild', language });
const bilingual = () => fixedRoleCatalog('P-zh', director, {
  languages: ['zh', 'en'],
  defaultLanguage: 'en',
  personas: { zh: 'P-zh', en: 'P-en' },
});
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

type Wire = { type: string; session?: { instructions?: string; audio?: { output?: { voice?: string } } } };

/** A local Seeduplex upstream: records what the gateway sends and lets the test speak as the model. */
async function seeduplexUpstream(servers: WebSocketServer[]) {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const received: Wire[] = [];
  let socket: WebSocket | null = null;
  server.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Wire;
      received.push(event);
      if (event.type === 'session.create') ws.send(JSON.stringify({ type: 'session.created' }));
    });
  });
  const emit = (event: Record<string, unknown>) => socket!.send(JSON.stringify(event));
  return {
    port: (server.address() as { port: number }).port,
    updates: () => received.filter((event) => event.type === 'session.update'),
    final: (transcript: string) => {
      emit({ type: 'conversation.item.input_audio_transcription.started' });
      emit({ type: 'conversation.item.input_audio_transcription.completed', transcript });
    },
    start: (id: string) => {
      emit({ type: 'response.output_audio.started', response_id: id });
      emit({ type: 'response.output_text.delta', response_id: id, delta: 'fixture reply' });
      emit({ type: 'response.output_audio.delta', response_id: id, delta: Buffer.from(new Int16Array(480).buffer).toString('base64') });
    },
    done: (id: string) => emit({ type: 'response.output_audio.done', response_id: id }),
  };
}

function seeduplexSession(port: number, overrides: Partial<SessionDeps>, language: 'zh' | 'en') {
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (message) => sent.push(message), sendAudio: () => {} };
  const session = new Session({
    adapterFactory: () => new SeeduplexAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'voice-default' }),
    summarizer: new MockSummarizer(),
    roles: bilingual(),
    i18n,
    languageRules: i18n.language,
    voiceFor: (l) => `voice-${l}`,
    ...overrides,
  }, ctx(language), `seam-${language}`);
  return { session, transport, sent };
}

describe('push seam on a Seeduplex upstream (blockers #48)', () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends no session.update while a reply is due or live after a language switch, then one full update', async () => {
    const up = await seeduplexUpstream(servers);
    const { session, transport } = seeduplexSession(up.port, {}, 'en');
    await session.start(transport);
    await wait();
    up.start('r1');
    up.done('r1');
    await wait();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });

    up.final('今天天气不错'); // switches the session to zh before the reply starts
    await wait();
    expect(session.currentLanguage).toBe('zh');
    expect(up.updates()).toHaveLength(0);
    up.start('r2');
    await wait();
    expect(up.updates()).toHaveLength(0);
    up.done('r2');
    await wait();
    expect(up.updates()).toHaveLength(0); // generation ended, playback has not

    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await wait();
    const updates = up.updates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.session?.audio?.output?.voice).toBe('voice-zh');
    expect(updates[0]!.session?.instructions).toContain('P-zh');
    session.end();
  });

  it('holds the summary push while a reply is live and sends it after playback ends', async () => {
    const up = await seeduplexUpstream(servers);
    let release: (text: string) => void = () => {};
    const summarizer: Summarizer = { summarize: () => new Promise<string>((resolve) => { release = resolve; }) };
    const { session, transport } = seeduplexSession(up.port, {
      summarizer,
      ledger: { keepRecentTurns: 1, summarizeAfterTurns: 1, summarizeAfterTokens: 10_000 },
    }, 'zh');
    await session.start(transport);
    await wait();
    up.start('r1');
    up.done('r1');
    await wait();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    up.final('第一句');
    up.start('r2');
    up.done('r2');
    await wait();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });

    up.final('第二句'); // two user turns: the summary starts
    up.start('r3');
    await wait();
    release('SUMMARY-FIXTURE');
    await wait();
    expect(session.ledger.summary).toBe('SUMMARY-FIXTURE');
    expect(up.updates()).toHaveLength(0);
    up.done('r3');
    await wait();
    expect(up.updates()).toHaveLength(0);

    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 300, reason: 'ended' });
    await wait();
    const updates = up.updates();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.session?.instructions).toContain('SUMMARY-FIXTURE');
    session.end();
  });
});

const script: MockScript = { greeting: '你好呀', followup: '还在吗', fallbackReply: '我在听', turns: [] };

function mockSession(overrides: Partial<SessionDeps> = {}) {
  const mocks: MockAdapter[] = [];
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (message) => sent.push(message), sendAudio: () => {} };
  const session = new Session({
    adapterFactory: () => {
      const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
      mocks.push(m);
      return m;
    },
    summarizer: new MockSummarizer(),
    roles: bilingual(),
    i18n,
    languageRules: i18n.language,
    voiceFor: (l) => `voice-${l}`,
    ...overrides,
  }, ctx('zh'), 'seam-mock');
  return { session, transport, sent, mocks };
}

const gateOf = (session: Session) => session as unknown as { gate: { hasPending: boolean } };

describe('push seam lifecycle', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('drops a held push after a reconnect, since connect carries the new language', async () => {
    vi.useFakeTimers();
    const s = mockSession();
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    await vi.advanceTimersByTimeAsync(150); // reply seq 2 is live
    s.session.setInitialLanguage('en');
    expect(gateOf(s.session).gate.hasPending).toBe(true);

    s.mocks[0]!.simulateDrop();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.mocks).toHaveLength(2);
    expect(gateOf(s.session).gate.hasPending).toBe(false);
    expect(s.mocks[1]!.instructions).toContain('P-en');
    expect(s.mocks[1]!.voice).toBe('voice-en');
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.mocks[0]!.sessionUpdates).toEqual([]);
    expect(s.mocks[1]!.sessionUpdates).toEqual([]);
    s.session.end();
  });

  it('flushes a held push when no reply forms after the final', async () => {
    vi.useFakeTimers();
    const s = mockSession({ push: { minIntervalMs: 0, noResponseAfterMs: 3_000 } });
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    // A final with no upstream reply (the mock only answers audio or debug text).
    s.mocks[0]!.emit('userTranscript', 'Could we speak English from now on please', true);
    expect(s.session.currentLanguage).toBe('en');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(s.mocks[0]!.sessionUpdates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.mocks[0]!.sessionUpdates).toHaveLength(1);
    expect(s.mocks[0]!.sessionUpdates[0]).toMatchObject({ voice: { value: 'voice-en' } });
    s.session.end();
  });

  it('never pushes before the adapter has connected', async () => {
    vi.useFakeTimers();
    const s = mockSession();
    s.session.setInitialLanguage('en');
    expect(gateOf(s.session).gate.hasPending).toBe(true);
    await s.session.start(s.transport);
    expect(gateOf(s.session).gate.hasPending).toBe(false);
    expect(s.mocks[0]!.instructions).toContain('P-en');
    expect(s.mocks[0]!.voice).toBe('voice-en');
    expect(s.mocks[0]!.sessionUpdates).toEqual([]);
    s.session.end();
  });
});
```

(b) `gateway/test/session.test.ts` L184–186 的 `drivePush` 改为调闸门：

```ts
/** Narrow cast: the guard tests need one push attempt without a real model request. */
const drivePush = (session: Session): void =>
  (session as unknown as { gate: { flush(): void } }).gate.flush();
```

(c) 同文件 L519–523（`summarizes older turns into the model instructions` 的尾部）由：

```ts
    s.session.handleClientMessage({ type: 'debug.userText', text: '第二句' });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.session.ledger.summary).toBe('助手：你好呀；用户：第一句；助手：我在听');
    expect(s.mocks[0].instructions).toContain('助手：你好呀；用户：第一句；助手：我在听');
    expect(s.mocks[0].instructions).toContain('用户：第二句');
  });
```

改为：

```ts
    s.session.handleClientMessage({ type: 'debug.userText', text: '第二句' });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.session.ledger.summary).toBe('助手：你好呀；用户：第一句；助手：我在听');
    // The summary waits for the seam: the reply to 第二句 is still due.
    expect(s.mocks[0].sessionUpdates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.mocks[0].sessionUpdates).toEqual([]);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 300, reason: 'ended' });
    expect(s.mocks[0].sessionUpdates).toHaveLength(1);
    expect(s.mocks[0].instructions).toContain('助手：你好呀；用户：第一句；助手：我在听');
    expect(s.mocks[0].instructions).toContain('用户：第二句');
  });
```

(d) 同文件 L977–1032 的四个用例（`moves the adapter voice when the session language changes`、`pushes new-language instructions before the next proactive request`、`defers new-language instructions while the user is speaking`、`does not push new-language instructions when an interruption finalizes the reply`）整段替换为：

```ts
  it('moves voice and instructions in one update at the next seam, once per turn', async () => {
    const s = setup({
      roles: bilingualRoles(),
      voiceFor: (language) => language === 'en' ? 'voice-en' : 'voice-zh',
    }, { ...ownedCtx });
    await greetAndFinish(s);
    const updates = s.mocks[0]!.sessionUpdates;

    s.session.setInitialLanguage('en'); // seam open: sent now
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ voice: { value: 'voice-en' } });
    expect(updates[0]!.instructions).toContain('P-en');
    expect(s.mocks[0]!.voice).toBe('voice-en');

    s.session.setInitialLanguage('zh'); // same turn: held
    expect(updates).toHaveLength(1);
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    await vi.advanceTimersByTimeAsync(1000); // reply streamed, still playing on the client
    expect(updates).toHaveLength(1);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ voice: { value: 'voice-zh' } });
    expect(updates[1]!.instructions).toContain('P-zh');
    expect(s.mocks[0]!.voice).toBe('voice-zh');
    s.session.end();
  });

  it('pushes held new-language instructions right before the next proactive request', async () => {
    const s = setup({ roles: bilingualRoles() }, { ...ownedCtx });
    await greetAndFinish(s);
    const push = vi.spyOn(s.mocks[0]!, 'updateSession');
    const creates = vi.spyOn(s.mocks[0]!, 'createResponse');
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    s.session.setInitialLanguage('en');
    s.session.handleClientMessage({ type: 'vad', state: 'silent', t: 400 });
    expect(push).not.toHaveBeenCalled(); // a silent edge is not a seam: a reply may still form
    await vi.advanceTimersByTimeAsync(8_500); // silence follow-up goes through requestResponse
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0].instructions).toContain('P-en');
    expect(creates).toHaveBeenCalled();
    expect(push.mock.invocationCallOrder[0]!).toBeLessThan(creates.mock.invocationCallOrder[0]!);
    s.session.end();
  });

  it('defers new-language instructions while the user is speaking', async () => {
    const s = setup({ roles: bilingualRoles() }, { ...ownedCtx });
    await greetAndFinish(s);
    const push = vi.spyOn(s.mocks[0]!, 'updateSession');
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    s.session.setInitialLanguage('en');
    drivePush(s.session);
    expect(push).not.toHaveBeenCalled();
    s.session.handleClientMessage({ type: 'vad', state: 'silent', t: 400 });
    expect(push).not.toHaveBeenCalled();
    drivePush(s.session);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0].instructions).toContain('P-en');
    s.session.end();
  });

  it('does not push new-language instructions when an interruption finalizes the reply', async () => {
    const s = setup({ roles: bilingualRoles() }, { ...ownedCtx });
    await greetAndFinish(s);
    const push = vi.spyOn(s.mocks[0]!, 'updateSession');
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    await vi.advanceTimersByTimeAsync(150); // reply seq 2 is live
    s.session.setInitialLanguage('en');
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 50, reason: 'interrupted' });
    expect(push).not.toHaveBeenCalled();
    s.session.end();
  });
```

(e) `gateway/test/multilingual.test.ts` L209–226 整个用例替换为（该 fake 没有 `updateSession`，顺带覆盖退路）：

```ts
  it('returns to zh and moves the voice at the next seam when a ja session hears a longer Han sentence', async () => {
    const adapter = new FakeAdapter();
    const roles = fixedRoleCatalog('P-zh', director, {
      languages: ['zh', 'ja', 'en'],
      defaultLanguage: 'zh',
      personas: trilingualPersonas,
    });
    const { session, transport } = makeSession(adapter, roles, ctxFor('ja'), { voiceFor: (language) => `voice-${language}` });
    await session.start(transport);
    adapter.done();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });

    adapter.emit('userTranscript', '今天天气不错', true);

    expect(session.currentLanguage).toBe('zh');
    expect(adapter.voices).toEqual([]); // the reply is due: no session.update yet
    adapter.beginResponse();
    adapter.done();
    expect(adapter.voices).toEqual([]);
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    // No updateSession on this fake: the gate falls back to voice, then instructions.
    expect(adapter.voices).toEqual(['voice-zh']);
    expect(adapter.pushes).toHaveLength(1);
    expect(adapter.pushes[0]).toContain('P-zh');
    session.end();
  });
```

- [x] **Step 14: 跑测试确认失败**

Run: `npx vitest run --root gateway test/session.test.ts test/multilingual.test.ts test/push-seam.test.ts`
Expected: FAIL 10 项。典型原因：`expected [ 'voice-zh' ] to deeply equal []`（旧 `applyLanguage` 立即 `updateVoice`）；Seeduplex 两例 `expected [ { type: 'session.update', … } ] to have a length of +0 but got 1`（终稿时或回复中就推了）；`TypeError: Cannot read properties of undefined (reading 'hasPending')`（还没有 `gate`）；`expected [] to have a length of 1`（旧代码不走 `updateSession`）；`expected "updateSession" to be called 1 times, but got 0 times`。

- [x] **Step 15: 实现 `session.ts` 迁移**

以下每处「原文」都按当前 `dev-master` 逐字给出，行号为改动前。

15.1 L34 之后加 import：

```ts
import { DEFAULT_TOOL_TURN_TIMEOUT_MS, type PacingConfig } from './pacing.ts';
import { PushGate, type PushRequest } from './pushGate.ts';
```

15.2 `SessionDeps`，L107–108 之后加：

```ts
  /** Interval slim rebuild (gateway/config/pacing.json slim). */
  slim?: PacingConfig['slim'];
  /** Push seam pacing (gateway/config/pacing.json push). Omitted in tests: DEFAULT_PUSH. */
  push?: PacingConfig['push'];
```

15.3 L151 `DEFAULT_SUMMARIZE_POLICY` 之后加：

```ts
/** Used only when SessionDeps.push is omitted (tests); production reads gateway/config/pacing.json. */
const DEFAULT_PUSH: PacingConfig['push'] = { minIntervalMs: 0, noResponseAfterMs: 5_000 };
```

15.4 L161 原文 `  private languagePushPending = false;` 替换为：

```ts
  /** Every live session.update goes through here (blockers #48). */
  private readonly gate: PushGate;
  private readonly push: PacingConfig['push'];
  /** True once connect() succeeded on the current adapter; false while rebuilding. */
  private adapterReady = false;
  /** Runs from a user final (or a proactive request) until a response starts; closes the push seam. */
  private replyWatch: NodeJS.Timeout | null = null;
  /** A response started since the last speaking edge; a later final is then not reported. */
  private responseSinceSpeech = false;
```

15.5 构造函数 L248–250 之后（`this.i18n = ...` 下一行）加：

```ts
    this.i18n = deps.i18n ?? DEFAULT_I18N;
    this.push = deps.push ?? DEFAULT_PUSH;
    this.gate = new PushGate({
      seamOpen: () => this.pushSeamOpen(),
      send: (update) => this.sendSessionUpdate(update),
      now: () => this.now(),
      minIntervalMs: this.push.minIntervalMs,
    });
```

15.6 `start()` L303–304，原文：

```ts
    await this.adapter.connect(this.sessionConfig());
    this.languagePushPending = false;
```

改为：

```ts
    await this.adapter.connect(this.sessionConfig());
    // connect() already carried the latest instructions and voice.
    this.adapterReady = true;
    this.gate.clearPending();
```

15.7 `vad` 分支 L374–375 之后加一行：

```ts
        const speaking = msg.state === 'speaking';
        this.userSpeaking = speaking;
        if (speaking) this.onSpeakingEdge();
```

15.8 `playback.stopped` 正常结束分支 L439–441，原文：

```ts
          // finalize() ran while this response was still the active interrupt, so push here
          // instead: a language switch made during the reply must reach the live model now.
          this.maybePushLanguage();
```

改为：

```ts
          // finalize() ran while this response was still the active interrupt; this is the seam.
          this.gate.flush();
```

15.9 `debug.userText` 分支 L467–468 之间加一行：

```ts
        this.dropUserFinals = false; // a deliberate new turn, not a late transcript
        this.responseSinceSpeech = false;
        this.onUserFinal(msg.text, true);
```

15.10 `end()` L505 `this.clearToolTimer();` 之后加：

```ts
    this.clearToolTimer();
    this.clearReplyWatch();
    this.gate.dispose();
```

15.11 L524–547：`setInitialLanguage` 与 `applyLanguage` 整段替换为：

```ts
  /** Initial language from session.start; before connect it simply rides on the connect payload. */
  setInitialLanguage(language: Language): void {
    this.applyLanguage(language);
  }

  private applyLanguage(language: Language): void {
    const next = this.resolveLanguage(language);
    // Session-end extraction reads this context, so it must track the latest language.
    this.context.language = next;
    if (next === this.language) return;
    this.language = next;
    this.director.setLanguage(next);
    const budget = this.budgetFor(next);
    if (budget) {
      // Never postpone summarization for a smaller target-language budget.
      this.ledger.setSummarizeAfterTokens(historyBudget(this.personaFor(next), budget, PROMPT_LABELS[next]));
    }
    // Same store data, new labels, addressing patterns, and evidence rules.
    this.refreshMemorySnapshot();
    // Voice and instructions travel together at the next seam. Undefined voice = adapter default.
    this.gate.request({ instructions: true, voice: { value: this.voiceFor(next) } });
  }
```

15.12 删除 L580–584 整个 `maybePushLanguage()` 方法（连同其后的空行）：

```ts
  private maybePushLanguage(): void {
    if (!this.languagePushPending || this.ended || this.modelGenerating || !this.slimSeamOpen()) return;
    this.languagePushPending = false;
    this.pushInstructions();
  }
```

15.13 L631–636 `pushInstructions()` 整段替换为下面这组方法（注意 `onTurnFinal` 本 cycle 只传 `false`，Cycle 5 再改）：

```ts
  /** Queues fresh instructions for the next push seam. */
  private pushInstructions(): void {
    this.gate.request({ instructions: true });
  }

  /** Seam for session.update: slim seam, nothing generating, no reply awaited, adapter connected. */
  private pushSeamOpen(): boolean {
    return !this.ended && this.adapterReady && !this.modelGenerating && this.replyWatch === null && this.slimSeamOpen();
  }

  /** The gate's only sink. Instructions are rendered now, so the newest state is what goes out. */
  private sendSessionUpdate(update: PushRequest): void {
    const instructions = update.instructions ? this.instructions() : undefined;
    if (instructions !== undefined) this.lastInstructionsChars = instructions.length;
    log('session_push', { instructions: instructions !== undefined, voice: update.voice !== undefined });
    if (this.adapter.updateSession) {
      this.adapter.updateSession({
        ...(instructions !== undefined ? { instructions } : {}),
        ...(update.voice ? { voice: update.voice } : {}),
      });
      return;
    }
    if (update.voice) this.adapter.updateVoice(update.voice.value);
    if (instructions !== undefined) this.adapter.updateInstructions(instructions);
  }

  /** Local or server speech began: a new utterance, so drop the reply watch. */
  private onSpeakingEdge(): void {
    this.responseSinceSpeech = false;
    this.clearReplyWatch();
  }

  /**
   * Holds the push seam shut until a response starts. After a substantive final, expiry logs
   * no_response_after_final (content-free); either way it flushes, since no reply formed.
   */
  private watchReply(logOnExpiry: boolean): void {
    this.clearReplyWatch();
    const startedAt = this.now();
    this.replyWatch = setTimeout(() => {
      this.replyWatch = null;
      if (this.ended) return;
      if (logOnExpiry) log('no_response_after_final', { sinceFinalMs: this.now() - startedAt });
      this.gate.flush();
    }, this.push.noResponseAfterMs);
    this.replyWatch.unref?.();
  }

  private clearReplyWatch(): void {
    if (this.replyWatch) clearTimeout(this.replyWatch);
    this.replyWatch = null;
  }

  /** A stored final opens a new push turn and shuts the seam until its reply starts. */
  private onTurnFinal(text: string): void {
    this.gate.onUserFinal();
    // A live reply already shuts the seam and is this final's answer.
    if (this.responseLive || this.modelGenerating) return;
    this.watchReply(false);
  }
```

15.14 `requestResponse` L650–652，原文：

```ts
    this.pendingKind = kind;
    this.maybePushLanguage();
    this.adapter.createResponse(request);
```

改为：

```ts
    this.pendingKind = kind;
    // Last seam before the proactive line; the watch keeps it shut until that line starts.
    this.gate.flush();
    // Watch before createResponse: an adapter that emits responseStarted synchronously clears it at once.
    this.watchReply(false);
    this.adapter.createResponse(request);
```

`speakConfirm()` 与 `maybeContinue` 里的 `createResponse` 故意不加 watch：它们发生在工具轮内或重连刚 `clearPending` 之后，缝隙本来就关着或没有待推送。

15.15 `createAdapter()` 的 `userSpeechStarted` 监听 L703–705，在 `if (!current()) return;` 之后加一行：

```ts
    a.on('userSpeechStarted', () => {
      if (!current()) return;
      this.onSpeakingEdge();
      this.director.onUserActivity();
```

15.16 `responseStarted` 监听 L739 `log('response_start', ...)` 之后加两行：

```ts
      log('response_start', { seq: s.seq, kind: s.kind });
      this.clearReplyWatch();
      this.responseSinceSpeech = true;
```

15.17 `finalize()` 尾部 L859–861，原文：

```ts
    this.maybeSummarize();
    // An interrupted reply keeps the pending push for the next safe seam.
    if (!interrupted) this.maybePushLanguage();
  }
```

改为（保留 L857–858 那段「Do not session.update here」注释不动）：

```ts
    this.maybeSummarize();
  }
```

15.18 `onUserFinal()` 开头 L864–866，原文：

```ts
  private onUserFinal(text: string, echo: boolean): void {
    const nextLanguage = detectLanguage(text, this.language, this.deps.languageRules);
    if (nextLanguage !== this.language) this.applyLanguage(nextLanguage, true);
```

改为：

```ts
  private onUserFinal(text: string, echo: boolean): void {
    // Before the language check: its push must find the seam already shut.
    if (!this.dropUserFinals) this.onTurnFinal(text);
    const nextLanguage = detectLanguage(text, this.language, this.deps.languageRules);
    if (nextLanguage !== this.language) this.applyLanguage(nextLanguage);
```

15.19 `releaseToolTurn()` 末尾 L1083–1084 之后加一行：

```ts
    // Continuation playback rearms silence later. Timeout and barge-in rearm now.
    this.director.releasePause(!allowSpeech);
    this.gate.flush();
  }
```

15.20 `rebuild()` L1120（三个提前 return 之后），原文：

```ts
    if (!keepToolTurn && this.toolTurn.onRebuild()) this.releaseToolTurn(false);
```

改为：

```ts
    // The old upstream will never answer; the new one is not ready for session.update yet.
    // Must come before releaseToolTurn, whose flush would otherwise send to the closing adapter.
    this.clearReplyWatch();
    this.adapterReady = false;
    if (!keepToolTurn && this.toolTurn.onRebuild()) this.releaseToolTurn(false);
```

同函数 L1150–1152，原文：

```ts
      await this.adapter.connect(this.sessionConfig());
      connected = true;
      this.languagePushPending = false;
```

改为：

```ts
      await this.adapter.connect(this.sessionConfig());
      connected = true;
      // connect() carried the latest instructions and voice; nothing is left to push.
      this.adapterReady = true;
      this.gate.clearPending();
```

15.21 `finishSlimRebuild()` L1195–1196（同样先 watch 再 `createResponse`），原文：

```ts
      this.adapter.createResponse({ cue: 'contextBridge', instruction: line, fallbackText: line });
      return true;
```

改为：

```ts
      this.watchReply(false);
      this.adapter.createResponse({ cue: 'contextBridge', instruction: line, fallbackText: line });
      return true;
```

15.22 自检：`grep -n "maybePushLanguage\|languagePushPending" gateway/src/session/session.ts` 无输出；`grep -n "updateVoice\|updateInstructions" gateway/src/session/session.ts` 只剩 `sendSessionUpdate` 里的两行退路。

- [x] **Step 16: 接线 `index.ts` 与 eval 脚本**

`gateway/src/index.ts` L154：

```ts
      slim: pacing.slim,
      push: pacing.push,
```

`gateway/scripts/eval.ts` L69：

```ts
  tailGuardMs: pacing.tailGuardMs,
  push: pacing.push,
```

- [x] **Step 17: 跑测试确认通过**

Run: `npx vitest run --root gateway test/session.test.ts test/multilingual.test.ts test/push-seam.test.ts`
Expected: PASS（Seeduplex 两例用真实计时器与本地 WebSocket，单例约 100 ms）。

Run: `npm run typecheck -w gateway`
Expected: 无错误输出。

---

## Cycle 5：`no_response_after_final` 观测

- [x] **Step 18: 写失败测试**

Create `gateway/test/no-response.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig } from '../src/adapters/types.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session, type Transport } from '../src/session/session.ts';

const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));

const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting',
  followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle',
  resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: 'ok',
  memoryNoticeInstruction: 'M', memoryNoticeText: 'notice',
};

/** Answers nothing by itself except proactive requests; the test plays the model. */
class QuietAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  readonly verbatimFallback = false;
  readonly supportsUserText = true;
  private counter = 0;
  private activeId: string | null = null;
  async connect(_config: SessionConfig): Promise<void> {}
  sendAudio(_pcm: Int16Array): void {}
  sendUserText(_text: string): void {}
  updateInstructions(_text: string): void {}
  updateVoice(_voice: string | undefined): void {}
  createResponse(_request?: ProactiveRequest): void { this.begin(); }
  cancelResponse(): void {}
  sendToolResult(_callId: string, _result: unknown): void {}
  injectContextNote(_text: string): void {}
  close(): void {}
  begin(): void {
    this.activeId = `resp-${++this.counter}`;
    this.emit('responseStarted', this.activeId);
  }
  done(): void {
    const id = this.activeId!;
    this.activeId = null;
    this.emit('responseDone', id);
  }
}

const USER_LINE = '我今天去公园散步了';

async function started() {
  const adapter = new QuietAdapter();
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (message) => sent.push(message), sendAudio: () => {} };
  const session = new Session({
    adapterFactory: () => adapter,
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    i18n,
    languageRules: i18n.language,
    push: { minIntervalMs: 0, noResponseAfterMs: 5_000 },
  }, { roleId: 'elder-companion', styleId: 'grandchild' }, 'no-response');
  await session.start(transport);
  adapter.done(); // greeting
  session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
  return { adapter, session };
}

describe('no_response_after_final', () => {
  let lines: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    lines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const reports = () => lines.filter((line) => line.includes('"no_response_after_final"'));

  it('logs once, content-free, when a substantive final gets no response', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.emit('userTranscript', USER_LINE, true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(reports()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports()).toHaveLength(1);
    expect(JSON.parse(reports()[0]!)).toMatchObject({ event: 'no_response_after_final', sinceFinalMs: 5_000 });
    expect(reports()[0]).not.toContain(USER_LINE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toHaveLength(1);
    session.end();
  });

  it('is cancelled by response.start', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.emit('userTranscript', USER_LINE, true);
    await vi.advanceTimersByTimeAsync(1_000);
    adapter.begin();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
    session.end();
  });

  it('is cancelled when the user speaks again', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.emit('userTranscript', USER_LINE, true);
    await vi.advanceTimersByTimeAsync(1_000);
    session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
    session.end();
  });

  it('is cancelled when the session ends', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.emit('userTranscript', USER_LINE, true);
    session.end();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
  });

  it('does not time a light reply', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.emit('userTranscript', '嗯', true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
    session.end();
  });

  it('does not time a final that arrives while a reply is live', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.begin();
    adapter.emit('userTranscript', USER_LINE, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
    session.end();
  });

  it('does not time a final whose reply already started after the speaking edge', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.begin(); // Qwen: response.created before the transcript is final
    adapter.done();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    adapter.emit('userTranscript', USER_LINE, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
    session.end();
  });
});
```

- [x] **Step 19: 跑测试确认失败**

Run: `npx vitest run --root gateway test/no-response.test.ts`
Expected: FAIL 1 项：`logs once, content-free, when a substantive final gets no response`（`expected [] to have a length of 1`，Cycle 4 的 watch 从不记日志）。其余 6 项此时已通过，Step 21 后它们负责防止误报（已验证：去掉轻回应判定，`does not time a light reply` 会失败；去掉 `responseSinceSpeech` 判定，`does not time a final whose reply already started after the speaking edge` 会失败）。

- [x] **Step 20: 实现 `Director.isLightFinal`**

`gateway/src/session/director.ts`，L229 `/** A new assistant response started: the silence timer no longer applies. */` 之前插入（复用私有 `isLight` 与文件内 `normalizeUtterance`，与 `onUserFinal` 判定一致）：

```ts
  /** Whole-utterance light reply (lightPhrases) or an empty one. Quiet phrases are not light. */
  isLightFinal(text: string): boolean {
    const key = normalizeUtterance(text);
    return !key || this.isLight(key);
  }

```

- [x] **Step 21: 实现观测条件**

`gateway/src/session/session.ts`，把 Step 15.13 写入的 `onTurnFinal` 整段替换为：

```ts
  /** A stored final opens a new push turn and shuts the seam until its reply starts. */
  private onTurnFinal(text: string): void {
    this.gate.onUserFinal();
    // A live reply already shuts the seam and is this final's answer.
    if (this.responseLive || this.modelGenerating) return;
    // Qwen can finalize the transcript after its reply started: stay shut, but do not report.
    this.watchReply(!this.responseSinceSpeech && !this.director.isLightFinal(text));
  }
```

说明：spec §0 的两条「不计时」在这里体现为「不记日志」。终稿到达时已有活跃回复（`responseLive || modelGenerating`）就不启动 watch；本句开口后已出现过 `response.start`（`responseSinceSpeech`）仍启动 watch 以关住缝隙，但到期不记日志。轻回应同理。

- [x] **Step 22: 跑测试确认通过**

Run: `npx vitest run --root gateway test/no-response.test.ts`
Expected: PASS（7 passed）。

---

## 收尾验证与提交

- [x] **Step 23: 全量测试**

Run: `npm test -w gateway`
Expected: 全部通过。参考值：改动前 `dev-master` 为 45 个文件 / 651 项；本任务新增 26 项，预期 48 个文件 / 677 项（若基线已变，以「0 failed」为准，并在报告写实际数字）。

- [x] **Step 24: 类型检查**

Run: `npm run typecheck -w gateway`
Expected: 无错误输出。

- [x] **Step 25: 空白检查**

Run: `git diff --check`
Expected: 无输出。

- [x] **Step 26: Mock 冒烟（只看启动日志，不连手机）**

Run（仓库根目录；用一次性端口与假密钥，不读 `.env`，不要用 `app/dev.json`）：

```bash
(cd gateway && APP_SECRET=t0-smoke-not-a-secret-000000 ADAPTER=mock PORT=18787 node --import tsx src/index.ts > /tmp/t0-smoke.log 2>&1 & PID=$!; sleep 4; kill $PID); grep -E '"gateway_listening"|Error' /tmp/t0-smoke.log
```

Expected: 一行 `{"event":"gateway_listening","port":18787,"adapter":"mock"}`，无 `Error`（证明 `pacing.json` 的 `push` 通过启动校验并注入）。

- [x] **Step 27: 真实记忆库召回探针（高风险区回归门槛）**

本任务改了主动开口路径的推送时机（`requestResponse`），按总览要求跑：

```bash
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$HOME/.avatar/memory.db"
```

Expected：zh「上次聊到哪儿了」`hits:true`；「上次聊过电影吗」`hits:true`；「我说过喜欢喝茶吗」`hits:false`；`newTitleFlag:false`。真实库不存在时不要声称通过：在报告里写「未跑，原因：库路径不存在」。

- [x] **Step 28: 提交**

先 `git status` 确认只有本任务的文件；不要动 `docs/superpowers/specs/2026-10-22-emotion-proactivity-design.md` 等与本任务无关的改动。勾选本文件已完成的步骤后：

```bash
git add gateway/src/session/pushGate.ts \
  gateway/src/session/session.ts \
  gateway/src/session/director.ts \
  gateway/src/session/pacing.ts \
  gateway/config/pacing.json \
  gateway/src/adapters/types.ts \
  gateway/src/adapters/seeduplex.ts \
  gateway/src/adapters/qwen.ts \
  gateway/src/adapters/mock.ts \
  gateway/src/index.ts \
  gateway/scripts/eval.ts \
  gateway/test/push-gate.test.ts \
  gateway/test/push-seam.test.ts \
  gateway/test/no-response.test.ts \
  gateway/test/seeduplex.test.ts \
  gateway/test/qwen.test.ts \
  gateway/test/mock.test.ts \
  gateway/test/pacing.test.ts \
  gateway/test/session.test.ts \
  gateway/test/multilingual.test.ts \
  docs/superpowers/plans/2026-10-23-plan4-emotion-proactivity/01-t0-push-gate.md
git commit -m "$(cat <<'EOF'
feat(gateway): gate every session update behind a safe seam

Seeduplex stops answering the next turn when session.update lands
during a reply (blockers #48). All live instruction and voice changes
now go through PushGate: merged, sent only when no reply is due, live,
or interrupted, at most once per user turn and once per interval.
Adapters gain an optional updateSession (one full update on Seeduplex,
one partial update on Qwen). A content-free no_response_after_final
log records finals that get no reply within push.noResponseAfterMs.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

报告里写明：真实命令与结果（测试数、typecheck、冒烟、召回探针是否跑及结果）。roadmap 由 T7 更新，本任务不改。

---

## 给下游任务的代码事实

- 推送入口只有两个：`this.pushInstructions()`（只刷新指令）与 `this.gate.request({...})`。T3「渲染文本变化才推」应调用 `this.pushInstructions()`，不要直接碰适配器。
- `onUserFinal` 第一行先调 `onTurnFinal(text)`（关缝 + 开新一轮），然后才是语言检测。T2 在 `dropUserFinals` 之后挂 `AffectTracker` 时不要把它挪到语言检测之前。
- 轻回应判定用 `this.director.isLightFinal(text)`，T2 复用，不要复制 `lightPhrases` 逻辑。
- 测试里取闸门：`(session as unknown as { gate: { hasPending: boolean; flush(): void } }).gate`；`MockAdapter.sessionUpdates` 记录每次合并更新。MockAdapter 有 `updateSession`，所以 Session 对它不再调用 `updateInstructions/updateVoice`，监视那两个方法的新测试会恒为未调用。
- 日志：`session_push { instructions, voice }`（布尔）每次网关尝试发送记一条，T7 用它统计推送次数。注意记的是尝试次数：适配器未连接时（`qwen.ts`/`seeduplex.ts` 的 `connected` 守卫）会静默丢弃，所以统计值可能略高。
- `Director.isLightFinal(text)` 只判 `lightPhrases` 整句或空串；`quietPhrases`（安静句）不算轻回应，T2 会把它当实质内容送分析器（与 spec 一致）。

## 接口疑问

1. **`PushGateDeps.seamOpen` 的注释偏窄。** 总览写的是 `slimSeamOpen() && !modelGenerating && !ended`。本计划的 Session 实际传 `!ended && adapterReady && !modelGenerating && replyWatch === null && slimSeamOpen()`。签名不变，只是条件更严：`adapterReady` 挡住 `start()` 之前的 `setInitialLanguage`（`manager.ts:131`）和重建期间；`replyWatch` 挡住「终稿到回复开始」这段 P4 没测过的窗口（不挡的话，`applyLanguage` 会在终稿瞬间推送，正是 #48 想避免的）。建议把总览注释改为「Session 决定的安全缝隙」。
2. **`clearPending()` 同时重置每轮一次的计数。** 总览只写 “Drop pending work”。重连后上游是新会话，没收到过任何 update，允许它在本轮再接一次推送；不重置的话，重连前已推过一次时，重连后的摘要要等到下一句终稿后才能送达。
3. **新增 `Director.isLightFinal(text)`（总览冻结列表里没有）。** `isLight` 原是私有方法，Session 判定「轻回应不计时」需要它；T2 的「轻回应不调用分析器」也应复用。`director.ts` 是 T4/T5 共享文件，本任务只加这一个方法。
4. **新增日志事件 `session_push`（不含内容）。** 不在冻结列表；spec 的 T7 要统计推送次数，日志是唯一不加协议的办法。不要的话删掉 `sendSessionUpdate` 里那一行即可，不影响测试。
5. **spec「打断结束」「用户说话结束而未形成回复」两个 flush 点的落法**：前者不单独 flush（坑位第 6 条），由打断后那句回复播完或 `requestResponse` 兜底；后者落在 `replyWatch` 到期。主动请求（含 slim 过渡句）发出后同样启动不记日志的 watch，所以「主动请求已发、回复未开始」期间也不会推送。代价：Director 在用户终稿 watch 期间发起主动请求时，会用不记日志的 watch 替换它，这一轮的 `no_response_after_final` 可能漏记。
6. **Qwen 组合部分 update 是【推断】。** `instructions` 与 `audio.output.voice` 各自的部分 update 已验证，组合形式没有真实探针。建议 T7 的真实回归里加一次：Qwen 上换语言后，下一轮回复用的是新音色且指令生效。
7. **`gateway/scripts/eval.ts` 不在总览共享文件表里**，本任务加了一行 `push: pacing.push`，让 T1 基线与生产推送节奏一致。T1 改 eval CLI 时注意保留这一行。
