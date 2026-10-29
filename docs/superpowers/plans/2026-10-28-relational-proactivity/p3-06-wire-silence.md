# P3-T6：接入四段沉默与话题聊干（高风险）

**Spec：** 「四段沉默与话题聊干」（Q16：各段时长、`quietPhrases`、rest 不提问保留；每段调用决策引擎；context/check/leave 可以选 `quiet`，直接进入下一段计时；checkin 固定 `presenceCheck`）、「意图渲染与生成」（兜底：`fallbackAfterMs` 内没有开始出声就照读兜底句）、「事后核对」、Q25 接受判定、Q18 语音调档、Q6（告别不挽留）。

**高风险区（AGENTS.md 第 2 条）：** 开工前读 roadmap「记忆与回忆：已踩过的坑」第 4、8、9 条和「打断与沉默：已踩过的坑」第 3、4、6 条。本任务改的是沉默链与会话接线，改完必须跑 gateway 全量测试、typecheck，并在 P3-T7 跑真实记忆库召回探针。

**接法（总览取舍第 1 条）：** 不改 `Director` 的计时、阶梯推进、提醒插队、打断与告知逻辑。只在它已有的「规划结果」上加两个可选字段：

| 规划结果 | `Director` 做什么 |
|---|---|
| `{ text: null, close: true }`（已有） | 收住，不说，后面各段都不再开口 |
| `{ text: null, quiet: true }`（新） | 本段不说，按「这一段已说完」推进到下一段计时 |
| `{ text, request }`（新） | 照原样发出 `request`（不再套 `speakInstruction`），`text`（等于兜底句）记进本段已说列表 |
| `{ text }`（已有） | 原逻辑：套 `speakInstruction` 照读 |
| `null`（已有） | 原逻辑：说配置文案 |

`Session.planProactiveLine` 在沉默段先问 `ProactiveRuntime.silenceLine`；运行时返回 `null`（没有 `intents` 的语言、还没聊起来且不知道称呼）才走原来的文本规划器；没有文本规划器就返回 `null`（配置文案）。开场（`stage==='greeting'`）完全不经过运行时。

**会话接线：**

| 时机 | 做什么 |
|---|---|
| 构造 | `deps.proactivity` 存在就建 `ProactiveRuntime`；只要有运行时或文本规划器，就给 `Director` 接 `planProactiveLine` |
| `requestResponse` 被拒（工具轮、正在生成等） | 运行时的请求通知 `onRequestRefused` |
| `requestResponse` 发出运行时的请求 | 记下这条请求，**在 `createResponse` 之前**挂 `fallbackAfterMs` 计时 |
| `responseStarted`，`kind==='followup'` 且有待开始的运行时请求 | `onLineStarted`，记下 seq，清计时 |
| 兜底计时到点，请求仍未开始 | 这时没有在生成、没有在播、用户没在说、不在工具轮、适配器已连上 → `fallbackFor` 拿照读请求再发一次（不发 `response.cancel`）；否则放弃（`onRequestRefused`） |
| `finalize` 这条 seq | `onLineEnded(播出的文字, 是否被打断)` |
| 用户终稿（存进账本的那条） | `onUserFinal(text, 是否轻回应, 语言)` |
| `affectSection` | 挂着话题聊干提示时，先问 `approveExhausted`，不批准就不挂 |
| `clearAffect`（忘记 / 拒绝记忆） | `reload()` |
| `end()` | 清计时，`end()` |

**Files:**
- Modify: `gateway/src/session/director.ts`（`SilencePlan` 两个字段、`planProactiveLine` 内 `accept` 的两个分支、`skipStep`）
- Modify: `gateway/src/session/session.ts`
- Modify: `gateway/src/session/affect.ts`（`AffectTracker.exhaustedArmedCount`）
- Test: `gateway/test/director-silence.test.ts`（加用例）、`gateway/test/proactive-session.test.ts`（新建）

**Interfaces:**
- Consumes: P3-T5 `ProactiveRuntime`（全部方法）、`SilenceStep`；P3-T4 `speakLineRequest`（测试用）；P3-T3 `DirectorConfig.intents/fallbacks`、`SilenceRules` 新字段、`ProactivityConfig.fallbackAfterMs`。
- Produces（冻结，见总览）：`SilencePlan.request?`、`SilencePlan.quiet?`；`AffectTracker.exhaustedArmedCount`。

- [x] **Step 1：`Director` 的失败测试**

在 `gateway/test/director-silence.test.ts` 末尾追加：

```ts
describe('engine plans on the ladder (P3)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('speaks a ready request as-is and remembers its fallback text', async () => {
    const request: ProactiveRequest = { cue: 'followup', instruction: 'ENGINE', fallbackText: '您刚才说的，我还想接着听听。' };
    const contexts: SilenceContext[] = [];
    const s = setup((context) => { contexts.push(context); return context.stage === 'context' ? { text: request.fallbackText, request } : null; });
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.requests).toEqual([request]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('随便什么');
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs);
    expect(contexts.at(-1)).toMatchObject({ stage: 'check', previousTexts: [request.fallbackText] });
    s.d.stop();
  });

  it('a quiet plan says nothing and moves to the next step on time', async () => {
    const stages: string[] = [];
    const s = setup((context) => { stages.push(context.stage); return context.stage === 'checkin' ? null : { text: null, quiet: true }; });
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs - 1);
    expect(stages).toEqual(['context']);
    await vi.advanceTimersByTimeAsync(1);
    expect(stages).toEqual(['context', 'check']);
    await vi.advanceTimersByTimeAsync(cfg.leaveAfterMs);
    await vi.advanceTimersByTimeAsync(cfg.checkinAfterMs);
    expect(stages).toEqual(['context', 'check', 'leave', 'checkin']);
    // checkin returned null: the configured check-in copy is spoken.
    expect(s.requests.map((r) => r.fallbackText)).toEqual([cfg.checkinText]);
    s.d.stop();
  });

  it('a quiet rest step still ends the ladder', async () => {
    const s = setup(() => ({ text: null, quiet: true }));
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs + cfg.checkAfterMs + cfg.leaveAfterMs + cfg.checkinAfterMs + cfg.restAfterMs);
    expect(s.restCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(cfg.restAfterMs * 2);
    expect(s.requests).toEqual([]);
    s.d.stop();
  });
});
```

（引擎在 rest 段总是给 `restQuiet`，不会给 `quiet`；第三个用例只保证 `Director` 遇到这种输入不会死循环或反复开口。）

- [x] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/director-silence.test.ts`
Expected: FAIL——新用例里 `request` 被套进 `speakInstruction`、`quiet` 被当作失败去说配置文案。

- [x] **Step 3：`Director`**

`gateway/src/session/director.ts`：

`SilencePlan` 改为：

```ts
export interface SilencePlan {
  /** Spoken line. Null means the configured stage copy should be used. */
  text: string | null;
  /** The user clearly ended the conversation; stop the ladder instead of speaking. */
  close?: boolean;
  /** A ready request from the decision engine (P3); sent as-is, `text` is its fallback line. */
  request?: ProactiveRequest;
  /** The engine chose silence for this step: move on as if it had been said. */
  quiet?: boolean;
}
```

`DirectorDeps.planProactiveLine` 的注释改为：

```ts
  /** Plans the opening and each silence step. The session asks the decision engine first (P3); configured copy is the failure fallback. */
```

私有方法 `planProactiveLine(step)` 里的 `accept`，在 `if (plan?.close) { … }` 之后、`const text = plan?.text?.trim();` 之前插入：

```ts
      if (plan?.quiet) {
        this.skipStep(step);
        return;
      }
      if (plan?.request) {
        // Engine lines are already rendered; novelty is the engine's job, so no duplicate check here.
        this.pending = step;
        if (step !== 'rest') this.rememberLadderText(plan.request.fallbackText);
        this.deps.requestResponse('followup', plan.request);
        return;
      }
```

在 `requestSilenceStep` 之前加：

```ts
  /** A quiet decision: advance exactly as if this step had been spoken. */
  private skipStep(step: SilenceStep): void {
    this.pending = step;
    this.onAiTurnEnded();
  }
```

`onAiTurnEnded()` 不带参数时不改 `lastAnswer`（`done !== null`），并按 `done` 推进；`aiBusy` 本来就是 false。不要改 `onAiTurnEnded` 本身。

- [x] **Step 4：运行 Director 测试**

Run: `npm test -w gateway -- test/director-silence.test.ts test/director.test.ts test/director-reminder.test.ts`
Expected: PASS。原有用例不用改；若有失败，说明改动碰到了原分支，回头检查插入位置。

- [x] **Step 5：会话的失败测试**

创建 `gateway/test/proactive-session.test.ts`：

```ts
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig } from '../src/adapters/types.ts';
import { loadDirectorConfig } from '../src/config.ts';
import { loadI18n } from '../src/i18n/load.ts';
import type { Logger } from '../src/log/logger.ts';
import type { MemoryStore, ThreadRecord } from '../src/memory/store.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { loadProactivity } from '../src/session/proactive/config.ts';
import { speakLineRequest } from '../src/session/proactive/render.ts';
import { Session } from '../src/session/session.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const i18n = loadI18n(`${root}config`);
const proactivity = loadProactivity(`${root}config/proactivity.json`);
const shipped = loadDirectorConfig(`${root}roles/elder-companion/zh/director.json`);
// No silenceDecision: this session has no text planner, so every silence line comes from the engine.
const { silenceDecision: _planner, ...zh } = shipped;
const director = { ...zh, topics: [{ id: 'meal', prompt: '今天吃了什么好吃的', fallbackText: '您今天吃了点什么好吃的？' }] };
const AFTERNOON = Date.parse('2026-11-03T15:00:00+08:00');
const DAY = 86_400_000;

class FakeAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  readonly verbatimFallback = false;
  readonly supportsUserText = true;
  readonly requests: ProactiveRequest[] = [];
  readonly connects: SessionConfig[] = [];
  /** Swallow the next proactive request: no response.created (fallback test). */
  silentNext = false;
  private counter = 0;
  private activeId: string | null = null;
  async connect(config: SessionConfig): Promise<void> { this.connects.push(config); }
  sendAudio(): void {}
  sendUserText(): void {}
  updateInstructions(): void {}
  updateVoice(): void {}
  createResponse(request?: ProactiveRequest): void {
    if (request) this.requests.push(request);
    if (this.silentNext) { this.silentNext = false; return; }
    this.start();
  }
  /** A response the model starts on its own (the passive reply). */
  start(): string {
    const id = `resp-${++this.counter}`;
    this.activeId = id;
    this.emit('responseStarted', id);
    return id;
  }
  say(text: string): void { this.emit('textDelta', this.activeId!, text); }
  done(): void { const id = this.activeId!; this.activeId = null; this.emit('responseDone', id); }
  cancelResponse(): void {}
  sendToolResult(): void {}
  injectContextNote(): void {}
  close(): void {}
}

function fakeStore(over: Record<string, unknown> = {}) {
  return {
    getOwner: vi.fn(() => ({ id: 'o1', memoryConsent: 'granted', notifiedAt: 1 })),
    listProfileFacts: vi.fn(() => [{ id: 'p1', category: 'addressing', text: '称呼：王叔' }]),
    listAgentFacts: vi.fn(() => []),
    listPinned: vi.fn(() => []),
    recentUserMessages: vi.fn(() => [] as Array<{ text: string }>),
    getProactiveTier: vi.fn((): string | undefined => undefined),
    setProactiveTier: vi.fn(),
    proactiveStats: vi.fn(() => []),
    recordProactiveOutcome: vi.fn(),
    proactiveDaily: vi.fn(() => 0),
    incrementProactiveDaily: vi.fn(() => 1),
    listOpenThreads: vi.fn(() => [] as ThreadRecord[]),
    markThreadMentioned: vi.fn(() => true),
    closeThread: vi.fn(() => true),
    listMoodSummaries: vi.fn(() => []),
    relationshipStats: vi.fn(() => ({ firstMetAt: null, sessions: 0, totalMinutes: 0, activeDays: 0, lastSessionAt: null, hourHistogram: Array(24).fill(0) })),
    recentFallbackLines: vi.fn(() => [] as number[]),
    recordFallbackLine: vi.fn(),
    ...over,
  };
}

const sessions: Session[] = [];

function boot(store = fakeStore()) {
  const adapter = new FakeAdapter();
  const sent: ServerMessage[] = [];
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  const session = new Session({
    adapterFactory: () => adapter,
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    store: store as unknown as MemoryStore,
    budget: { totalChars: 8_000, snapshotMaxChars: 600, summaryMaxChars: 800 },
    i18n,
    proactivity,
    logger: logger as unknown as Logger,
  }, { ownerId: 'o1', agentId: 'a1', characterId: 'xiaonuan', firstMeet: false, language: 'zh' }, `proactive-${sessions.length}`);
  sessions.push(session);
  const transport = { send: (msg: ServerMessage) => { sent.push(msg); }, sendAudio: () => {} };
  let seq = 0;
  const played = (reason: 'ended' | 'interrupted' = 'ended') =>
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: ++seq, playedMs: 0, reason });
  const open = async () => {
    await session.start(transport);
    adapter.done();
    played();
    await vi.advanceTimersByTimeAsync(0);
  };
  const userTurn = async (text: string, reply = '嗯，挺好的。') => {
    adapter.emit('userTranscript', text, true);
    adapter.start();
    adapter.say(reply);
    adapter.done();
    played();
    await vi.advanceTimersByTimeAsync(0);
  };
  const followups = () => adapter.requests.filter((r) => r.cue === 'followup');
  return { adapter, session, sent, logger, store, open, userTurn, played, followups };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AFTERNOON);
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.end();
  vi.useRealTimers();
});

describe('silence ladder through the decision engine', () => {
  it('continues the user’s own statement at the context step, counts it and checks what was said', async () => {
    const t = boot();
    await t.open();
    await t.userTurn('我家那盆君子兰今年还没开花。');
    await vi.advanceTimersByTimeAsync(director.contextAfterMs!);
    const line = t.followups().at(-1)!;
    expect(line.instruction).toContain('【我家那盆君子兰今年还没开花。】');
    expect(t.sent).toContainEqual({ type: 'response.start', responseSeq: 3, kind: 'followup' });
    expect(t.store.incrementProactiveDaily).toHaveBeenCalledWith('o1', 'a1', '2026-11-03');
    t.adapter.say('君子兰不开花别着急，您记得按时吃药。');
    t.adapter.done();
    t.played();
    expect(t.logger.warn).toHaveBeenCalledWith('proactive_grounding_violation', expect.objectContaining({ kind: 'continueThread', violationKind: 'health' }));
    await t.userTurn('是啊，我昨天还给它换了盆土。');
    expect(t.store.recordProactiveOutcome).toHaveBeenCalledWith('o1', 'a1', 'continueThread', 'accepted', expect.any(Number));
  });

  it('reads the fallback line once when the model does not start in time', async () => {
    const t = boot();
    await t.open();
    await t.userTurn('我家那盆君子兰今年还没开花。');
    t.adapter.silentNext = true;
    await vi.advanceTimersByTimeAsync(director.contextAfterMs!);
    const first = t.followups().at(-1)!;
    await vi.advanceTimersByTimeAsync(proactivity.fallbackAfterMs - 1);
    expect(t.followups()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.followups().at(-1)).toEqual(speakLineRequest(director.intents!, first.fallbackText));
    expect(t.logger.warn).toHaveBeenCalledWith('proactive_fallback', { kind: 'continueThread', code: 'no_audio' });
    expect(t.sent).toContainEqual({ type: 'response.start', responseSeq: 3, kind: 'followup' });
  });

  it('stays quiet through context, check and leave in the quiet tier, then checks in', async () => {
    const t = boot(fakeStore({ getProactiveTier: vi.fn(() => 'quiet') }));
    await t.open();
    await t.userTurn('我家那盆君子兰今年还没开花。');
    await vi.advanceTimersByTimeAsync(director.contextAfterMs! + director.checkAfterMs! + director.leaveAfterMs!);
    expect(t.followups()).toEqual([]);
    await vi.advanceTimersByTimeAsync(director.checkinAfterMs!);
    expect(t.followups()).toHaveLength(1);
    expect(director.fallbacks!.presenceCheck).toContain(t.followups()[0]!.fallbackText);
  });

  it('keeps a health thread out of every instruction and reads the sensitive group', async () => {
    const quote = '我有高血压，这几天量着有点高。';
    const thread: ThreadRecord = { id: 't1', kind: 'concern', quote, dueAt: AFTERNOON, sensitive: true, mentionCount: 0, lastMentionedAt: null, createdAt: AFTERNOON - 3 * DAY, sourceSessionId: 's-old' };
    const t = boot(fakeStore({ listOpenThreads: vi.fn(() => [thread]) }));
    await t.open();
    await vi.advanceTimersByTimeAsync(director.contextAfterMs!);
    expect(t.followups().at(-1)).toEqual(speakLineRequest(director.intents!, director.fallbacks!.threadSensitive[0]!));
    expect(t.store.markThreadMentioned).toHaveBeenCalledWith('o1', 't1', expect.any(Number));
    const everything = [...t.adapter.requests.map((r) => r.instruction), ...t.adapter.connects.map((c) => c.instructions)].join('\n');
    expect(everything).not.toContain('高血压');
  });

  it('writes nothing across sessions when memory was declined', async () => {
    const t = boot(fakeStore({ getOwner: vi.fn(() => ({ id: 'o1', memoryConsent: 'declined', notifiedAt: 1 })) }));
    await t.open();
    await t.userTurn('我家那盆君子兰今年还没开花。');
    await vi.advanceTimersByTimeAsync(director.contextAfterMs!);
    expect(t.followups()).toHaveLength(1);
    expect(t.store.incrementProactiveDaily).not.toHaveBeenCalled();
  });

  it('stops the ladder after a goodbye', async () => {
    const t = boot();
    await t.open();
    await t.userTurn('好了，我去睡了，明天再聊。', '好的，晚安。');
    await vi.advanceTimersByTimeAsync(director.contextAfterMs! + director.checkAfterMs! + director.leaveAfterMs! + director.checkinAfterMs!);
    expect(t.followups()).toEqual([]);
  });
});
```

说明：
- 测试里的 `director` 去掉了 `silenceDecision`，所以会话没有文本规划器；要求「只有运行时」也能接上 `planProactiveLine`。
- `getOwner` 返回的对象只包含 `memoryGate()` 读的两个字段；如果 `OwnerRecord` 还有必填字段导致类型报错，用 `as unknown as` 处理，不要改产品代码。
- 告别用例里 `我去睡了` 也命中 `quietPhrases`？zh `quietPhrases` 是「别说了 / 安静一会 / 安静点 / 先别说话 / 别吵 / 我想静静」，不含它；这条用例验证的是运行时的告别收住。

- [x] **Step 6：运行，确认失败**

Run: `npm test -w gateway -- test/proactive-session.test.ts`
Expected: FAIL——会话没有接运行时，`followups()` 为空或是配置文案。

- [x] **Step 7：`AffectTracker.exhaustedArmedCount`**

`gateway/src/session/affect.ts` 的 `get exhaustedArmed()` 之后加：

```ts
  /** Times the topic-exhaustion hint has been armed; changes once per arming. */
  get exhaustedArmedCount(): number {
    return this.exhaustion.armedCount;
  }
```

- [x] **Step 8：`Session` 接线**

`gateway/src/session/session.ts`：

1. import：

```ts
import { ProactiveRuntime } from './proactive/runtime.ts';
```

2. 字段（放在 `private readonly director: Director;` 附近）：

```ts
  /** Decision engine runtime (P3); null when proactivity.json is not injected (most tests). */
  private readonly proactive: ProactiveRuntime | null;
  /** Engine request sent but not started yet; its fallback timer runs. */
  private proactiveRequest: ProactiveRequest | null = null;
  private proactiveTimer: NodeJS.Timeout | null = null;
  /** Seq of the engine line on air, for the post-hoc check. */
  private proactiveSeq: number | null = null;
```

3. 构造函数：在 `const hasSilencePlanner = …` 之后、`this.safeGreetingWired = …` 之前加：

```ts
    this.proactive = deps.proactivity ? new ProactiveRuntime({
      cfg: deps.proactivity,
      sessionId,
      ...(deps.store ? { store: deps.store } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...(agentId ? { agentId } : {}),
      now: () => this.now(),
      canPersist: () => this.memoryGate() === 'ok',
      copy: (language) => {
        const d = this.directorConfig(language);
        return {
          ...(d.intents ? { intents: d.intents } : {}),
          ...(d.fallbacks ? { fallbacks: d.fallbacks } : {}),
          topics: d.topics ?? [],
          quietPhrases: d.quietPhrases,
        };
      },
      rules: (language) => ({
        silence: this.i18n.silence[language],
        healthWords: this.i18n.memory[language].healthWords,
        declinePhrases: this.i18n.affect[language].declinePhrases,
        evidence: this.i18n.evidence,
      }),
      logger: this.log,
    }) : null;
    const textPlanner = Boolean(deps.textClient) && hasSilencePlanner;
```

把 `Director` 依赖里的这一段：

```ts
        ...(deps.textClient && hasSilencePlanner ? {
          planProactiveLine: (context, signal) => this.planProactiveLine(context, signal),
          getMemorySnapshot: …,
          safeGreeting: () => this.safeGreeting(),
          ...(deps.affect?.enabled ? { getPlanExtras: () => this.planExtras() } : {}),
        } : {}),
```

改为（`getMemorySnapshot` 的原函数体照抄，不改）：

```ts
        ...(textPlanner || this.proactive ? { planProactiveLine: (context, signal) => this.planProactiveLine(context, signal) } : {}),
        ...(textPlanner ? {
          getMemorySnapshot: …,
          safeGreeting: () => this.safeGreeting(),
          ...(deps.affect?.enabled ? { getPlanExtras: () => this.planExtras() } : {}),
        } : {}),
```

`this.safeGreetingWired` 仍等于 `Boolean(deps.textClient) && hasSilencePlanner`（care 开场的条件不变）。只有运行时、没有文本规划器时，开场会调一次 `planProactiveLine('greeting')` 并拿到 `null`，`Director` 随即说配置开场——与以前「没有规划器」时说的话相同。

4. `planProactiveLine` 改为先问运行时：

```ts
  private planProactiveLine(context: SilenceContext, signal: AbortSignal): SilencePlan | null | Promise<SilencePlan | null> {
    if (context.stage !== 'greeting' && this.proactive) {
      const line = this.proactive.silenceLine({
        step: context.stage,
        language: this.language,
        hadContent: context.userText !== '',
        lastUtterance: context.userText,
        knownName: this.greetingName() !== null,
        card: this.affectCard,
        lowIntensity: this.deps.affect?.lowIntensity ?? Number.POSITIVE_INFINITY,
        ...(this.openLoop ? { openLoop: this.openLoop } : {}),
      });
      if (line && 'request' in line) return { text: line.request.fallbackText, request: line.request };
      if (line && 'quiet' in line) return { text: null, quiet: true };
      if (line && 'close' in line) return { text: null, close: true };
    }
    return this.textPlan(context, signal);
  }

  /** The text-model planner: the opening, and silence steps the engine does not handle. */
  private textPlan(context: SilenceContext, signal: AbortSignal): Promise<SilencePlan | null> | null {
    const config = this.deps.roles.director(this.context.characterId, this.language).silenceDecision;
    const client = this.textFor('silence_plan');
    if (!config || !client) return null;
    let planner = this.silencePlanners.get(this.language);
    if (!planner) {
      planner = createSilencePlanner(client, config, this.i18n.silence[this.language], this.log);
      this.silencePlanners.set(this.language, planner);
    }
    return planner(context, signal);
  }
```

`context.stage` 在非 greeting 时就是 `'context' | 'check' | 'leave' | 'checkin' | 'rest'`；若 TypeScript 收窄不过，用 `context.stage as SilenceStep`（从 `./proactive/runtime.ts` 导入类型）。`Director.planContext` 里 `userText` 只在用户说过实质内容后非空（轻回应不会写进 `lastContent`），所以 `hadContent` 用它判断。

5. `requestResponse`：拒绝分支里，在两个 `onNoticeMissed` / `onReminderMissed` 之后加：

```ts
      if (this.proactive?.owns(request)) this.proactive.onRequestRefused(request);
```

在 `this.watchReply(false);` 之后、`this.adapter.createResponse(request);` 之前加：

```ts
    // Before createResponse: an adapter may start the response synchronously.
    if (this.proactive?.owns(request)) this.watchProactive(request);
```

6. 新增两个私有方法（放在 `requestResponse` 后面）：

```ts
  /** Spec 兜底: no response.created within fallbackAfterMs → read the fallback line once. */
  private watchProactive(request: ProactiveRequest): void {
    this.clearProactiveTimer();
    this.proactiveRequest = request;
    const waitMs = this.deps.proactivity?.fallbackAfterMs ?? 3_000;
    this.proactiveTimer = setTimeout(() => {
      this.proactiveTimer = null;
      if (this.proactiveRequest !== request || !this.proactive) return;
      const busy = this.ended || !this.adapterReady || this.modelGenerating || this.responseLive
        || this.userSpeaking || this.toolTurn.active || this.interrupt.active !== null;
      // No response.cancel here (pitfall 打断与沉默 #6): we only add a line when nothing is on air.
      const fallback = busy ? null : this.proactive.fallbackFor(request);
      if (!fallback) {
        this.proactive.onRequestRefused(request);
        this.proactiveRequest = null;
        return;
      }
      this.proactiveRequest = fallback;
      this.pendingKind = 'followup';
      this.watchReply(false);
      this.adapter.createResponse(fallback);
    }, waitMs);
    this.proactiveTimer.unref?.();
  }

  private clearProactiveTimer(): void {
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
  }
```

7. `responseStarted` 处理里，`this.pendingKind = null;` 之后加：

```ts
      const engineRequest = this.proactiveRequest;
      if (engineRequest && s.kind === 'followup') {
        this.proactiveRequest = null;
        this.clearProactiveTimer();
        this.proactiveSeq = s.seq;
        this.proactive?.onLineStarted(engineRequest);
      }
```

8. `finalize(s, interrupted)`：在 `s.text = text;` 之后加：

```ts
    if (s.seq === this.proactiveSeq) {
      this.proactiveSeq = null;
      this.proactive?.onLineEnded(text, interrupted);
    }
```

9. `onUserFinal`：在 `this.director.onUserFinal(text);` 之后加：

```ts
    this.proactive?.onUserFinal(text, this.director.isLightFinal(text), this.language);
```

10. `affectSection`：

```ts
  private affectSection(): string {
    const config = this.deps.affect;
    if (!config || !this.affect) return '';
    // Topic exhaustion is a proactive moment (spec 话题聊干): the hint only rides along when the engine approves.
    const armed = this.affect.exhaustedArmed
      && (this.proactive?.approveExhausted(this.affect.exhaustedArmedCount, { language: this.language, card: this.affectCard, lowIntensity: config.lowIntensity }) ?? true);
    return renderAffect(this.affectCard, this.i18n.affect[this.language], {
      exhaustedArmed: armed,
      lowIntensity: config.lowIntensity,
    });
  }
```

11. `clearAffect` 末尾加 `this.proactive?.reload();`。

12. `end()`：在 `this.director.stop();` 之后加：

```ts
    this.clearProactiveTimer();
    this.proactiveRequest = null;
    this.proactive?.end();
```

- [x] **Step 9：运行会话测试**

Run: `npm test -w gateway -- test/proactive-session.test.ts test/director-silence.test.ts`
Expected: PASS。常见问题：
- 第一个用例 `responseSeq` 不是 3：说明开场或被动回复多占了 seq，按实际序号改测试里的 `played()` 次序，不改产品代码。
- 兜底用例多发了一次：检查 `watchProactive` 是否在 `createResponse` 之前，`fallbackFor` 第二次是否返回 `null`。

- [x] **Step 10：全量回归**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS。重点看 `session.test.ts`、`care-opening.test.ts`、`first-meet.test.ts`、`multilingual.test.ts`、`rest-reminder-session.test.ts`、`push-seam.test.ts`、`no-response.test.ts`、`journey-runner.test.ts`：
- 这些测试的角色配置大多没有 `intents`，运行时返回 `null`，行为应与之前完全相同。
- 用 `sessionDepsFromSnapshot` 构造会话的测试（旅程 runner、快照测试）现在会带上 `proactivity`，shipped zh 有 `intents`，沉默段会走运行时。若这类测试断言了旧规划器的沉默行为，先确认断言的是「沉默段由文本规划器说」，再改为断言运行时的请求；改动逐条写进任务报告。
- 任何与沉默链无关的测试失败，都说明接线碰到了别处：停下排查，不要改测试迁就。

- [x] **Step 11：提交**

```bash
git add gateway/src/session/director.ts gateway/src/session/session.ts gateway/src/session/affect.ts \
  gateway/test/director-silence.test.ts gateway/test/proactive-session.test.ts
git commit -m "feat(proactive): run the silence ladder and topic exhaustion through the decision engine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（Step 10 里按规则改过的测试文件，按明确路径一并加入。）
