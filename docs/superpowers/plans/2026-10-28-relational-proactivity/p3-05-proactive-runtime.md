# P3-T5：会话级主动运行时 `ProactiveRuntime`

**Spec：** 「架构」（本会话运行态放在会话对象里，跨会话数据按 `(owner, agent)` 存记忆库）、「数据流」（预取 → 决策 → 渲染 → 兜底 → 事后核对 → 接受判定）、「决策引擎」接受判定（Q25）、三档与语音调节（Q18）、硬规则（危机、告别、同一事项每次会话只提一次）、「隐私」（告知后且未拒绝才写）、「失败处理与降级」（预取失败按空上下文决策）、「日志与指标」（四个内容无关事件）。

本任务做一个**不碰计时器、不碰适配器**的类：会话（P3-T6）在每个沉默段、话题聊干、请求发出 / 开始 / 结束、用户终稿、会话结束时调用它。它自己只读写注入的记忆库，并通过注入的 `logger` 记日志。

**行为表：**

| 调用 | 行为 |
|---|---|
| `silenceLine` | 当前语言没有 `intents`/`fallbacks` → `null`（配置文案）；还没聊起来且不知道称呼 → `null`；用户在告别 → `{ close: true }`；否则预取（只一次）→ 过期接受窗口 → 组装 `DecisionContext` → `decide` → `buildIntent` → 选兜底句 → `renderIntent` → `{ request }`；不开口 → `{ quiet: true }` |
| `approveExhausted` | 同一次「挂上」只决策一次（按 `armedCount` 缓存）；只给引擎 `selfShare` 一个可能（事项、兴趣、家人都置空）；选中才返回 `true` 并计一次主动；没有 `intents` 的语言返回 `true`（保持现状） |
| `onLineStarted` | 这条请求真的开始出声：打分类意图计入本会话次数、今天次数、已说意图；事项计提及；打开接受窗口；说的是兜底句时记下用过的句子；话题卡记下用过的卡 |
| `fallbackFor` | 超时兜底：返回照读同一意图兜底句的请求，只给一次 |
| `onLineEnded` | 接受窗口从现在开始计时；没被打断且有转写时做事后核对，按违规类型记日志 |
| `onUserFinal` | 告别短语设「在告别」（下一句实质发言清除）；档位短语升降一档；接受判定：轻回应不计，婉拒 / 安静 / 降档短语为拒绝（事项还要按婉拒关闭），其余为接受 |
| `reload` | 忘记 / 拒绝记忆之后：丢掉缓存的事项、家人原话等，下次用到时重新从库里读 |
| `end` | 还开着的接受窗口按拒绝计 |

**写库把关：** 只有 `store`、`ownerId`、`agentId` 都在且 `canPersist()` 为真（会话的 `memoryGate()==='ok'`）时才写：档位、接受计数、今日次数、事项提及与婉拒关闭、兜底句与话题卡去重。读不受这个限制（读出来的是此前已同意时写的数据）。写库异常只记 `proactive_store_failed`，不影响说话。

**日志（字段名避开 `fieldGuard` 禁用词）：**
- `proactive_decision`：`moment`、`kind`、`score`（两位小数）、`candidates`、`tier`、`fallback`（是否直接说兜底句）、`decideMs`
- `proactive_outcome`：`kind`、`outcome`（`accepted` / `rejected`）
- `proactive_grounding_violation`（warn）：`kind`、`violationKind`、`count`
- `proactive_tier_changed`：`from`、`to`
- `proactive_fallback`（warn）：`kind`、`code`（`no_audio`）
- `proactive_prefetch_failed`（warn）：`code`

**Files:**
- Create: `gateway/src/session/proactive/acceptance.ts`
- Create: `gateway/src/session/proactive/runtime.ts`
- Test: `gateway/test/proactive-runtime.test.ts`

**Interfaces:**
- Consumes: P3-T2 `decide`、`familiarityOf`、`DecisionContext`、`Moment`、`Familiarity`；P3-T1 `ProactivityConfig`、`SCORED_KINDS`、`ScoredKind`；P3-T3 `IntentCopy`、`FallbackGroups`、`FallbackKey`、`SilenceRules` 新字段；P3-T4 `beijingDay`、`careStage`、`buildIntent`、`PlannedIntent`、`IntentMaterial`、`renderIntent`、`speakLineRequest`、`pickFallback`、`checkSpoken`、`violationsOf`；P2 `MemoryStore` 方法（见总览 P2 冻结契约）；现有 `isLow`、`AffectCard`、`isMemoryEvidence`、`EvidenceRules`、`containsPhrase`、`TopicCard`、`Logger`、`ProactiveRequest`。
- Produces（冻结，见总览）：`ProactiveRuntime`、`ProactiveRuntimeDeps`、`SilenceInput`、`ProactiveCopy`、`ProactiveRules`、`SilenceStep`、`ProactiveLineResult`；`acceptance.ts` 的 `AcceptanceTracker`、`Verdict`、`PendingLine`、`Resolved`；`runtime.ts` 的 `nextTier`。

- [x] **Step 1：写失败测试**

创建 `gateway/test/proactive-runtime.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadDirectorConfig } from '../src/config.ts';
import { loadI18n } from '../src/i18n/load.ts';
import type { Logger } from '../src/log/logger.ts';
import type { MemoryStore, ThreadRecord } from '../src/memory/store.ts';
import type { AffectCard } from '../src/session/affect.ts';
import { AcceptanceTracker } from '../src/session/proactive/acceptance.ts';
import { loadProactivity } from '../src/session/proactive/config.ts';
import { speakLineRequest } from '../src/session/proactive/render.ts';
import { nextTier, ProactiveRuntime, type SilenceInput } from '../src/session/proactive/runtime.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cfg = loadProactivity(`${root}config/proactivity.json`);
const zh = loadDirectorConfig(`${root}roles/elder-companion/zh/director.json`);
const i18n = loadI18n(`${root}config`);
const DAY = 86_400_000;
const AFTERNOON = Date.parse('2026-11-03T15:00:00+08:00');
const TOPICS = [{ id: 'meal', prompt: '今天吃了什么好吃的', fallbackText: '您今天吃了点什么好吃的？' }];

function fakeStore(over: Record<string, unknown> = {}) {
  const store = {
    getProactiveTier: vi.fn((): string | undefined => undefined),
    setProactiveTier: vi.fn(),
    proactiveStats: vi.fn(() => [] as Array<{ kind: string; accepted: number; rejected: number }>),
    recordProactiveOutcome: vi.fn(),
    proactiveDaily: vi.fn(() => 0),
    incrementProactiveDaily: vi.fn(() => 1),
    listOpenThreads: vi.fn(() => [] as ThreadRecord[]),
    markThreadMentioned: vi.fn(() => true),
    closeThread: vi.fn(() => true),
    listMoodSummaries: vi.fn(() => []),
    relationshipStats: vi.fn(() => ({ firstMetAt: null, sessions: 0, totalMinutes: 0, activeDays: 0, lastSessionAt: null, hourHistogram: Array(24).fill(0) })),
    recentUserMessages: vi.fn(() => [] as Array<{ text: string }>),
    recentFallbackLines: vi.fn(() => [] as number[]),
    recordFallbackLine: vi.fn(),
    ...over,
  };
  return store;
}
const fakeLogger = () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  return logger;
};

function setup(opts: { store?: ReturnType<typeof fakeStore>; persist?: boolean; intents?: boolean; topics?: typeof TOPICS } = {}) {
  let now = AFTERNOON;
  const store = opts.store ?? fakeStore();
  const logger = fakeLogger();
  const runtime = new ProactiveRuntime({
    cfg,
    sessionId: 's-now',
    store: store as unknown as MemoryStore,
    ownerId: 'o1',
    agentId: 'a1',
    now: () => now,
    canPersist: () => opts.persist ?? true,
    copy: () => (opts.intents === false
      ? { topics: opts.topics ?? TOPICS, quietPhrases: zh.quietPhrases }
      : { intents: zh.intents, fallbacks: zh.fallbacks, topics: opts.topics ?? TOPICS, quietPhrases: zh.quietPhrases }),
    rules: () => ({ silence: i18n.silence.zh, healthWords: i18n.memory.zh.healthWords, declinePhrases: i18n.affect.zh.declinePhrases, evidence: i18n.evidence }),
    logger: logger as unknown as Logger,
  });
  return { runtime, store, logger, advance: (ms: number) => { now += ms; }, at: () => now };
}

const input = (over: Partial<SilenceInput> = {}): SilenceInput => ({
  step: 'context', language: 'zh', hadContent: true, lastUtterance: '我家那盆君子兰今年还没开花。',
  knownName: true, card: null, lowIntensity: 2, ...over,
});
const thread = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: 't1', kind: 'concern', quote: '我有高血压，这几天量着有点高。', dueAt: AFTERNOON, sensitive: true, mentionCount: 0,
  lastMentionedAt: null, createdAt: AFTERNOON - 3 * DAY, sourceSessionId: 's-old', ...over,
});
const crisis: AffectCard = { emotion: 'sad', intensity: 3, trend: 'worse', need: 'vent', strategy: 'comfort', mismatch: false, crisis: true };
const requestOf = (r: ReturnType<ProactiveRuntime['silenceLine']>) => (r && 'request' in r ? r.request : null);

describe('silenceLine', () => {
  it('falls back to configured copy without intents, or before a name is known and nothing was said', () => {
    expect(setup({ intents: false }).runtime.silenceLine(input())).toBeNull();
    expect(setup().runtime.silenceLine(input({ hadContent: false, knownName: false }))).toBeNull();
  });

  it('continues the user’s own statement after a pause', () => {
    const { runtime, logger } = setup();
    const request = requestOf(runtime.silenceLine(input()))!;
    expect(request.instruction).toContain('【我家那盆君子兰今年还没开花。】');
    expect(request.instruction).toContain('刚才');
    expect(zh.fallbacks!.continueThread).toContain(request.fallbackText);
    expect(logger.info).toHaveBeenCalledWith('proactive_decision', expect.objectContaining({ moment: 'silenceContext', kind: 'continueThread', score: 0.68, tier: 'moderate', fallback: false }));
  });

  it('never uses a question as material (pitfall 1); a topic card is offered instead', () => {
    const request = requestOf(setup().runtime.silenceLine(input({ lastUtterance: '上次聊到哪儿了？' })))!;
    expect(request.instruction).not.toContain('上次聊到哪儿了');
    expect(request.instruction).toContain('【今天吃了什么好吃的】');
  });

  it('reads the sensitive group for a health thread; the quote goes nowhere', () => {
    const store = fakeStore({ listOpenThreads: vi.fn(() => [thread()]) });
    const request = requestOf(setup({ store }).runtime.silenceLine(input({ hadContent: false })))!;
    expect(request).toEqual(speakLineRequest(zh.intents!, zh.fallbacks!.threadSensitive[0]!));
    expect(request.instruction).not.toContain('高血压');
  });

  it('reads the continue group when the user’s own line has a health word', () => {
    const request = requestOf(setup().runtime.silenceLine(input({ lastUtterance: '最近膝盖疼得睡不着。' })))!;
    expect(request.instruction).not.toContain('膝盖');
    expect(request).toEqual(speakLineRequest(zh.intents!, zh.fallbacks!.continueThread[0]!));
  });

  it('grounds the family nudge in a remembered line without health words', () => {
    const store = fakeStore({ recentUserMessages: vi.fn(() => [{ text: '女儿陪我去医院复查了。' }, { text: '闺女在深圳工作，一年也就回来一两趟。' }]) });
    const request = requestOf(setup({ store, topics: [] }).runtime.silenceLine(input({ hadContent: false })))!;
    expect(request.instruction).toContain('【闺女在深圳工作，一年也就回来一两趟。】');
    expect(request.instruction).toContain('之前');
    expect(store.recentUserMessages).toHaveBeenCalledWith('o1', 'a1', cfg.material.familyLookback);
  });

  it('stays quiet in the quiet tier and in a crisis, but always checks in and rests', () => {
    const quietTier = setup({ store: fakeStore({ getProactiveTier: vi.fn(() => 'quiet') }) });
    expect(quietTier.runtime.silenceLine(input())).toEqual({ quiet: true });
    const checkin = requestOf(quietTier.runtime.silenceLine(input({ step: 'checkin' })))!;
    expect(zh.fallbacks!.presenceCheck).toContain(checkin.fallbackText);
    expect(checkin.instruction).toContain(zh.intents!.noQuestion);
    const s = setup();
    expect(s.runtime.silenceLine(input({ card: crisis }))).toEqual({ quiet: true });
    expect(requestOf(s.runtime.silenceLine(input({ step: 'rest', card: crisis })))!.instruction).toContain(zh.intents!.purposes.restQuiet);
  });

  it('stops the ladder once the user says goodbye, until they say something else', () => {
    const { runtime } = setup();
    runtime.onUserFinal('好了，我去睡了', false, 'zh');
    expect(runtime.silenceLine(input())).toEqual({ close: true });
    runtime.onUserFinal('嗯', true, 'zh');
    expect(runtime.silenceLine(input())).toEqual({ close: true });
    runtime.onUserFinal('等等，还有件事想跟你说。', false, 'zh');
    expect(requestOf(runtime.silenceLine(input()))).not.toBeNull();
  });

  it('decides on empty context when the store fails', () => {
    const store = fakeStore({ listOpenThreads: vi.fn(() => { throw new Error('sqlite_busy'); }) });
    const s = setup({ store });
    expect(requestOf(s.runtime.silenceLine(input({ lastUtterance: '上次聊到哪儿了？' })))!.instruction).toContain('今天吃了什么好吃的');
    expect(s.logger.warn).toHaveBeenCalledWith('proactive_prefetch_failed', { code: 'store_error' });
  });
});

describe('counting, mentions and persistence', () => {
  it('counts a started line, marks the thread, remembers the fallback line, and offers the thread once', () => {
    const store = fakeStore({ listOpenThreads: vi.fn(() => [thread()]) });
    const s = setup({ store });
    const request = requestOf(s.runtime.silenceLine(input({ hadContent: false })))!;
    expect(s.runtime.owns(request)).toBe(true);
    s.runtime.onLineStarted(request);
    expect(store.markThreadMentioned).toHaveBeenCalledWith('o1', 't1', AFTERNOON);
    expect(store.incrementProactiveDaily).toHaveBeenCalledWith('o1', 'a1', '2026-11-03');
    expect(store.recordFallbackLine).toHaveBeenCalledWith('o1', 'a1', 'threadSensitive', 0, AFTERNOON, cfg.fallbackKeep);
    s.runtime.onLineEnded(zh.fallbacks!.threadSensitive[0]!, false);
    const next = requestOf(s.runtime.silenceLine(input({ step: 'check', hadContent: false })))!;
    expect(next.instruction).toContain('今天吃了什么好吃的');
  });

  it('keeps counts in memory only when memory is not allowed', () => {
    const store = fakeStore({ listOpenThreads: vi.fn(() => [thread()]) });
    const s = setup({ store, persist: false });
    const request = requestOf(s.runtime.silenceLine(input({ hadContent: false })))!;
    s.runtime.onLineStarted(request);
    s.runtime.onUserFinal('你少说点吧', false, 'zh');
    expect(store.markThreadMentioned).not.toHaveBeenCalled();
    expect(store.incrementProactiveDaily).not.toHaveBeenCalled();
    expect(store.recordFallbackLine).not.toHaveBeenCalled();
    expect(store.setProactiveTier).not.toHaveBeenCalled();
    expect(store.recordProactiveOutcome).not.toHaveBeenCalled();
  });

  it('drops a refused request without counting it', () => {
    const store = fakeStore();
    const s = setup({ store });
    const request = requestOf(s.runtime.silenceLine(input()))!;
    s.runtime.onRequestRefused(request);
    expect(s.runtime.owns(request)).toBe(false);
    s.runtime.onLineStarted(request);
    expect(store.incrementProactiveDaily).not.toHaveBeenCalled();
  });
});

describe('acceptance (Q25)', () => {
  const started = (store = fakeStore({ listOpenThreads: vi.fn(() => [thread({ sensitive: false, quote: '最近总睡不踏实。' })]) })) => {
    const s = setup({ store });
    const request = requestOf(s.runtime.silenceLine(input({ hadContent: false })))!;
    s.runtime.onLineStarted(request);
    s.advance(2_000);
    s.runtime.onLineEnded('上回说睡不踏实，这两天好些了吗？', false);
    return s;
  };

  it('a real reply inside the window is accepted', () => {
    const s = started();
    s.advance(5_000);
    s.runtime.onUserFinal('好多了，昨天还去公园走了走。', false, 'zh');
    expect(s.store.recordProactiveOutcome).toHaveBeenCalledWith('o1', 'a1', 'threadFollowup', 'accepted', s.at());
    expect(s.logger.info).toHaveBeenCalledWith('proactive_outcome', { kind: 'threadFollowup', outcome: 'accepted' });
  });

  it('a decline is rejected and closes the thread; a light reply does not count', () => {
    const s = started();
    s.runtime.onUserFinal('嗯', true, 'zh');
    expect(s.store.recordProactiveOutcome).not.toHaveBeenCalled();
    s.runtime.onUserFinal('别问了', false, 'zh');
    expect(s.store.recordProactiveOutcome).toHaveBeenCalledWith('o1', 'a1', 'threadFollowup', 'rejected', s.at());
    expect(s.store.closeThread).toHaveBeenCalledWith('o1', 't1', 'declined', s.at());
  });

  it('no reply before the window ends, or before the session ends, is rejected', () => {
    const late = started();
    late.advance(cfg.acceptance.windowMs + 1);
    late.runtime.silenceLine(input({ step: 'check', hadContent: false }));
    expect(late.store.recordProactiveOutcome).toHaveBeenCalledWith('o1', 'a1', 'threadFollowup', 'rejected', late.at());
    const ended = started();
    ended.runtime.end();
    expect(ended.store.recordProactiveOutcome).toHaveBeenCalledWith('o1', 'a1', 'threadFollowup', 'rejected', ended.at());
  });

  it('tracker: barge-in counts, a new line rejects the unanswered one', () => {
    const t = new AcceptanceTracker(15_000);
    expect(t.open({ kind: 'routine' })).toBeNull();
    expect(t.onUserFinal(1_000, 'content')).toEqual({ line: { kind: 'routine' }, outcome: 'accepted' });
    t.open({ kind: 'selfShare' });
    t.ended(0);
    expect(t.open({ kind: 'routine' })).toEqual({ line: { kind: 'selfShare' }, outcome: 'rejected' });
    expect(t.expire(10)).toBeNull();
  });
});

describe('tier by voice', () => {
  it('moves one step and stays inside the range', () => {
    const rules = i18n.silence.zh;
    expect(nextTier('moderate', '你少说点吧', rules)).toBe('quiet');
    expect(nextTier('quiet', '你少说点吧', rules)).toBeNull();
    expect(nextTier('moderate', '多跟我聊聊', rules)).toBe('active');
    expect(nextTier('active', '多跟我聊聊', rules)).toBeNull();
    expect(nextTier('moderate', '今天天气不错', rules)).toBeNull();
  });

  it('persists the new tier and the next silence follows it', () => {
    const s = setup();
    s.runtime.onUserFinal('你少说点吧', false, 'zh');
    expect(s.store.setProactiveTier).toHaveBeenCalledWith('o1', 'a1', 'quiet', AFTERNOON);
    expect(s.logger.info).toHaveBeenCalledWith('proactive_tier_changed', { from: 'moderate', to: 'quiet' });
    expect(s.runtime.silenceLine(input())).toEqual({ quiet: true });
  });
});

describe('fallback, post-hoc check and topic exhaustion', () => {
  it('gives the fallback line once when nothing was heard', () => {
    const s = setup();
    const request = requestOf(s.runtime.silenceLine(input()))!;
    const fallback = s.runtime.fallbackFor(request)!;
    expect(fallback).toEqual(speakLineRequest(zh.intents!, request.fallbackText));
    expect(s.runtime.fallbackFor(request)).toBeNull();
    expect(s.runtime.owns(fallback)).toBe(true);
    expect(s.logger.warn).toHaveBeenCalledWith('proactive_fallback', { kind: 'continueThread', code: 'no_audio' });
    s.runtime.onLineStarted(fallback);
    expect(s.store.recordFallbackLine).toHaveBeenCalledWith('o1', 'a1', 'continueThread', 0, AFTERNOON, cfg.fallbackKeep);
  });

  it('logs material-outside health words in what was actually said', () => {
    const s = setup();
    const request = requestOf(s.runtime.silenceLine(input()))!;
    s.runtime.onLineStarted(request);
    s.runtime.onLineEnded('君子兰不开花别着急，您记得按时吃药。', false);
    expect(s.logger.warn).toHaveBeenCalledWith('proactive_grounding_violation', expect.objectContaining({ kind: 'continueThread', violationKind: 'health' }));
    const cut = setup();
    const r2 = requestOf(cut.runtime.silenceLine(input()))!;
    cut.runtime.onLineStarted(r2);
    cut.runtime.onLineEnded('您记得按时吃', true);
    expect(cut.logger.warn).not.toHaveBeenCalledWith('proactive_grounding_violation', expect.anything());
  });

  it('approves the topic-exhaustion hint once per arming, as self-talk only', () => {
    const s = setup();
    const at = { language: 'zh' as const, card: null, lowIntensity: 2 };
    expect(s.runtime.approveExhausted(1, at)).toBe(true);
    expect(s.runtime.approveExhausted(1, at)).toBe(true);
    const decisions = s.logger.info.mock.calls.filter((c) => c[0] === 'proactive_decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]![1]).toMatchObject({ moment: 'topicExhausted', kind: 'selfShare' });
    expect(s.store.incrementProactiveDaily).toHaveBeenCalledTimes(1);
    const quiet = setup({ store: fakeStore({ getProactiveTier: vi.fn(() => 'quiet') }) });
    expect(quiet.runtime.approveExhausted(1, at)).toBe(false);
    expect(setup({ intents: false }).runtime.approveExhausted(1, at)).toBe(true);
  });
});
```

分数断言的来历（适中档门槛 0.45，下午 15:00 不在作息窗口）：`continueThread` = (35×80 + 30×50 + 20×50 + 15×100)/10000 = 0.68；`interestTopic` = 0.59；敏感牵挂事项 = (15×50 + 40×60 + 30×80 + 15×100)/10000 = 0.705；`humanConnection` = 0.58；`selfShare` = 0.57。

- [x] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/proactive-runtime.test.ts`
Expected: FAIL——`runtime.ts`、`acceptance.ts` 不存在。

- [x] **Step 3：`acceptance.ts`**

```ts
// Q25 acceptance window. Opens when a scored line starts; runs from when it ends.
import type { ScoredKind } from './config.ts';

export type Verdict = 'light' | 'decline' | 'content';
export interface PendingLine { kind: ScoredKind; threadId?: string }
export interface Resolved { line: PendingLine; outcome: 'accepted' | 'rejected' }

export class AcceptanceTracker {
  private line: PendingLine | null = null;
  private endsAt: number | null = null;

  constructor(private readonly windowMs: number) {}

  get pending(): PendingLine | null {
    return this.line;
  }

  /** A new scored line; an unanswered previous one is rejected. */
  open(line: PendingLine): Resolved | null {
    const previous = this.flush();
    this.line = line;
    this.endsAt = null;
    return previous;
  }

  /** Playback ended or was cut: the window starts now. */
  ended(now: number): void {
    if (this.line && this.endsAt === null) this.endsAt = now + this.windowMs;
  }

  expire(now: number): Resolved | null {
    return this.line && this.endsAt !== null && now > this.endsAt ? this.flush() : null;
  }

  /** Light replies do not count and keep the window open. A barge-in (window not started) counts. */
  onUserFinal(now: number, verdict: Verdict): Resolved | null {
    const expired = this.expire(now);
    if (expired) return expired;
    if (!this.line || verdict === 'light') return null;
    const line = this.line;
    this.line = null;
    this.endsAt = null;
    return { line, outcome: verdict === 'decline' ? 'rejected' : 'accepted' };
  }

  /** No reply at all: rejected. */
  flush(): Resolved | null {
    if (!this.line) return null;
    const line = this.line;
    this.line = null;
    this.endsAt = null;
    return { line, outcome: 'rejected' };
  }
}
```

- [x] **Step 4：`runtime.ts`**

```ts
// Per-session proactive runtime (spec 决策引擎, 意图渲染). Session counters live here; cross-session data
// is written only after the memory notice played and memory is not declined. No timers, no adapter.
import type { Language } from '@anyidea/protocol';
import type { ProactiveRequest } from '../../adapters/types.ts';
import { containsPhrase } from '../../i18n/text.ts';
import type { SilenceRules } from '../../i18n/types.ts';
import type { Logger } from '../../log/logger.ts';
import { isMemoryEvidence, type EvidenceRules } from '../../memory/evidence.ts';
import type { MemoryStore, MoodSummaryRecord, ProactiveTier, ThreadRecord } from '../../memory/store.ts';
import type { FallbackGroups, FallbackKey, IntentCopy, TopicCard } from '../../roles/types.ts';
import { isLow, type AffectCard } from '../affect.ts';
import { AcceptanceTracker, type Resolved, type Verdict } from './acceptance.ts';
import { beijingDay, buildIntent, careStage, type IntentMaterial, type PlannedIntent } from './assemble.ts';
import { checkSpoken, violationsOf } from './check.ts';
import { SCORED_KINDS, type ProactivityConfig, type ScoredKind } from './config.ts';
import { decide, familiarityOf, type Decision, type DecisionContext, type Familiarity, type Moment } from './engine.ts';
import { pickFallback } from './fallback.ts';
import { renderIntent, speakLineRequest } from './render.ts';

// Same step names as the Director's ladder; the session maps a planner stage to one of these.
export type SilenceStep = 'context' | 'check' | 'leave' | 'checkin' | 'rest';
export type ProactiveLineResult = { request: ProactiveRequest } | { quiet: true } | { close: true } | null;

export interface ProactiveCopy {
  intents?: IntentCopy;
  fallbacks?: FallbackGroups;
  topics: readonly TopicCard[];
  quietPhrases: readonly string[];
}

export interface ProactiveRules {
  silence: SilenceRules;
  healthWords: readonly string[];
  declinePhrases: readonly string[];
  evidence: EvidenceRules;
}

export interface ProactiveRuntimeDeps {
  cfg: ProactivityConfig;
  sessionId: string;
  store?: MemoryStore;
  ownerId?: string;
  agentId?: string;
  now: () => number;
  /** Memory notice played and memory not declined (Session.memoryGate() === 'ok'). */
  canPersist: () => boolean;
  copy: (language: Language) => ProactiveCopy;
  rules: (language: Language) => ProactiveRules;
  logger: Logger;
}

export interface SilenceInput {
  step: SilenceStep;
  language: Language;
  hadContent: boolean;
  /** The user's last substantive line in this session; '' when none. */
  lastUtterance: string;
  knownName: boolean;
  card: AffectCard | null;
  lowIntensity: number;
  /** Validated open loop from the latest card. */
  openLoop?: string;
}

const MOMENT_OF: Record<SilenceStep, Moment> = {
  context: 'silenceContext', check: 'silenceCheck', leave: 'silenceLeave', checkin: 'silenceCheckin', rest: 'silenceRest',
};
const TIERS: readonly ProactiveTier[] = ['quiet', 'moderate', 'active'];
const TOPIC_KEY = 'topicCard';

const isScored = (kind: string): kind is ScoredKind => (SCORED_KINDS as readonly string[]).includes(kind);
const hasAny = (text: string, phrases: readonly string[]) => phrases.some((phrase) => containsPhrase(text, phrase));

/** One step down or up by voice; null when nothing matched, both matched, or already at the end. */
export function nextTier(tier: ProactiveTier, text: string, rules: Pick<SilenceRules, 'tierDown' | 'tierUp'>): ProactiveTier | null {
  const down = hasAny(text, rules.tierDown);
  const up = hasAny(text, rules.tierUp);
  if (down === up) return null;
  const index = TIERS.indexOf(tier) + (down ? -1 : 1);
  return index < 0 || index >= TIERS.length ? null : TIERS[index]!;
}

interface InFlight {
  request: ProactiveRequest;
  planned: PlannedIntent;
  threadId?: string;
  language: Language;
  line: { key: FallbackKey; index: number; text: string };
  topicIndex: number | null;
  /** The fallback line itself is what gets spoken. */
  spokeFallback: boolean;
}

export class ProactiveRuntime {
  private loaded = false;
  private day = '';
  private tier: ProactiveTier;
  /** Tier chosen by voice in this session; survives a reload. */
  private tierChosen: ProactiveTier | null = null;
  private stats: Array<{ kind: string; accepted: number; rejected: number }> = [];
  private todaySpoken = 0;
  private threads: ThreadRecord[] = [];
  private lastMood: MoodSummaryRecord | null = null;
  private familiarity: Familiarity = 'new';
  private recentLines: string[] = [];
  private sessionSpoken = 0;
  private readonly spokenKinds = new Set<ScoredKind>();
  private readonly mentioned = new Set<string>();
  private readonly usedLines = new Map<string, number[]>();
  private leaving = false;
  private exhaustedSeen = 0;
  private exhaustedOk = false;
  private inFlight: InFlight | null = null;
  private live: InFlight | null = null;
  private readonly acceptance: AcceptanceTracker;

  constructor(private readonly deps: ProactiveRuntimeDeps) {
    this.tier = deps.cfg.defaultTier;
    this.acceptance = new AcceptanceTracker(deps.cfg.acceptance.windowMs);
  }

  silenceLine(input: SilenceInput): ProactiveLineResult {
    const copy = this.deps.copy(input.language);
    if (!copy.intents || !copy.fallbacks) return null;
    // The opening asked for a name and nothing has been said yet: the configured copy keeps asking.
    if (!input.hadContent && !input.knownName) return null;
    // Q6: never hold on to a user who is leaving.
    if (this.leaving) return { close: true };
    this.ensureLoaded();
    this.settle(this.acceptance.expire(this.deps.now()), false);
    const rules = this.deps.rules(input.language);
    const moment = MOMENT_OF[input.step];
    const now = this.deps.now();
    const low = isLow(input.card, input.lowIntensity);
    const stage = careStage(input.card);
    const openLoop = this.openLoopFor(input, rules);
    const topic = this.pickTopic(copy.topics);
    const family = this.familyLine(rules);
    const ctx = this.context(moment, { low, crisis: input.card?.crisis ?? false, stage }, {
      openLoop: openLoop !== undefined, interest: topic !== null, family: family !== undefined,
    }, this.threads);
    const { decision, decideMs } = this.timedDecide(ctx);
    const material: IntentMaterial = {
      thread: this.threads.find((t) => t.id === decision.threadId),
      ...(openLoop ? { openLoop, openLoopSensitive: hasAny(openLoop, rules.healthWords) } : {}),
      ...(topic ? { topic: topic.card.prompt } : {}),
      ...(family ? { family } : {}),
    };
    const planned = buildIntent(decision, {
      moment, now, language: input.language, familiarity: this.familiarity, affect: { low, stage },
      material, cfg: this.deps.cfg, saidWords: copy.intents.saidWhen,
    });
    this.logDecision(moment, decision, planned, decideMs);
    if (!planned) return { quiet: true };
    const key = planned.intent.fallbackKey as FallbackKey;
    const lines = copy.fallbacks[key];
    const index = pickFallback(lines.length, this.recentFor(key, this.deps.cfg.fallbackKeep));
    const text = lines[index]!;
    const request = renderIntent(planned, copy.intents, text);
    this.inFlight = {
      request, planned, language: input.language, line: { key, index, text },
      topicIndex: planned.intent.kind === 'interestTopic' && topic ? topic.index : null,
      spokeFallback: planned.fallbackOnly,
      ...(decision.threadId ? { threadId: decision.threadId } : {}),
    };
    return { request };
  }

  /** Topic exhaustion (spec 话题聊干): one decision per arming, self-talk only. */
  approveExhausted(armedCount: number, input: { language: Language; card: AffectCard | null; lowIntensity: number }): boolean {
    if (armedCount === this.exhaustedSeen) return this.exhaustedOk;
    this.exhaustedSeen = armedCount;
    const copy = this.deps.copy(input.language);
    if (!copy.intents || !copy.fallbacks) {
      this.exhaustedOk = true;
      return true;
    }
    this.ensureLoaded();
    const ctx = this.context('topicExhausted', {
      low: isLow(input.card, input.lowIntensity), crisis: input.card?.crisis ?? false, stage: careStage(input.card),
    }, { openLoop: false, interest: false, family: false }, []);
    const { decision, decideMs } = this.timedDecide(ctx);
    this.logDecision('topicExhausted', decision, null, decideMs);
    this.exhaustedOk = decision.kind === 'selfShare';
    if (this.exhaustedOk) this.countSpoken('selfShare');
    return this.exhaustedOk;
  }

  owns(request: ProactiveRequest): boolean {
    return this.inFlight?.request === request;
  }

  onRequestRefused(request: ProactiveRequest): void {
    if (this.owns(request)) this.inFlight = null;
  }

  onLineStarted(request: ProactiveRequest): void {
    const f = this.inFlight;
    if (!f || f.request !== request) return;
    this.inFlight = null;
    this.live = f;
    const kind = f.planned.intent.kind;
    const now = this.deps.now();
    if (isScored(kind)) {
      this.countSpoken(kind);
      if (f.threadId) {
        this.mentioned.add(f.threadId);
        const id = f.threadId;
        this.write('mention', (store, ownerId) => { store.markThreadMentioned(ownerId, id, now); });
      }
      this.settle(this.acceptance.open({ kind, ...(f.threadId ? { threadId: f.threadId } : {}) }), false);
    }
    if (f.spokeFallback) this.rememberUsed(f.line.key, f.line.index, this.deps.cfg.fallbackKeep);
    if (f.topicIndex !== null) this.rememberUsed(TOPIC_KEY, f.topicIndex, this.deps.copy(f.language).topics.length);
  }

  /** Nothing was heard in time: read the same intent's fallback line, once. */
  fallbackFor(request: ProactiveRequest): ProactiveRequest | null {
    const f = this.inFlight;
    // A read-out line (health group or an earlier fallback) is never asked for twice.
    if (!f || f.request !== request || f.spokeFallback) return null;
    const intents = this.deps.copy(f.language).intents;
    if (!intents) return null;
    f.spokeFallback = true;
    f.request = speakLineRequest(intents, f.line.text);
    this.deps.logger.warn('proactive_fallback', { kind: f.planned.intent.kind, code: 'no_audio' });
    return f.request;
  }

  onLineEnded(text: string, interrupted: boolean): void {
    const f = this.live;
    if (!f) return;
    this.live = null;
    this.acceptance.ended(this.deps.now());
    const said = text.trim();
    if (interrupted || !said) return;
    const intent = f.planned.intent;
    const material = f.spokeFallback
      ? [f.line.text]
      : [...intent.material.quotes.flatMap((q) => (q.said ? [q.text, q.said] : [q.text])), ...intent.material.facts];
    const rules = this.deps.rules(f.language);
    const check = checkSpoken(said, {
      material, allowQuestion: intent.constraints.allowQuestion, mustExpress: intent.constraints.mustExpress,
    }, { healthWords: rules.healthWords, silence: rules.silence });
    for (const v of violationsOf(check)) {
      this.deps.logger.warn('proactive_grounding_violation', { kind: intent.kind, violationKind: v.kind, count: v.count });
    }
  }

  onUserFinal(text: string, light: boolean, language: Language): void {
    const rules = this.deps.rules(language);
    const copy = this.deps.copy(language);
    if (!light) this.leaving = hasAny(text, rules.silence.farewell);
    this.ensureLoaded();
    const tier = nextTier(this.tier, text, rules.silence);
    if (tier) {
      const from = this.tier;
      this.tier = tier;
      this.tierChosen = tier;
      const now = this.deps.now();
      this.write('tier', (store, ownerId, agentId) => { store.setProactiveTier(ownerId, agentId, tier, now); });
      this.deps.logger.info('proactive_tier_changed', { from, to: tier });
    }
    const declined = !light && hasAny(text, [...rules.declinePhrases, ...copy.quietPhrases, ...rules.silence.tierDown]);
    const verdict: Verdict = light ? 'light' : declined ? 'decline' : 'content';
    this.settle(this.acceptance.onUserFinal(this.deps.now(), verdict), declined);
  }

  /** After forget / decline: cached user words may be gone; read them again when next needed. */
  reload(): void {
    this.loaded = false;
    this.threads = [];
    this.recentLines = [];
  }

  end(): void {
    this.settle(this.acceptance.flush(), false);
    this.inFlight = null;
    this.live = null;
  }

  private context(moment: Moment, affect: DecisionContext['affect'], has: DecisionContext['has'], threads: readonly ThreadRecord[]): DecisionContext {
    return {
      moment,
      now: this.deps.now(),
      currentSessionId: this.deps.sessionId,
      tier: this.tier,
      affect,
      lastMood: this.lastMood,
      threads,
      has,
      sessionSpoken: this.sessionSpoken,
      todaySpoken: this.todaySpoken,
      spokenKinds: this.spokenKinds,
      mentionedThreads: this.mentioned,
      stats: this.stats,
      userLeaving: false,
    };
  }

  private timedDecide(ctx: DecisionContext): { decision: Decision; decideMs: number } {
    const started = performance.now();
    const decision = decide(ctx, this.deps.cfg);
    return { decision, decideMs: Math.round(performance.now() - started) };
  }

  private logDecision(moment: Moment, decision: Decision, planned: PlannedIntent | null, decideMs: number): void {
    this.deps.logger.info('proactive_decision', {
      moment,
      kind: decision.kind,
      score: Math.round(decision.score * 100) / 100,
      candidates: decision.candidates,
      tier: this.tier,
      fallback: planned?.fallbackOnly ?? false,
      decideMs,
    });
  }

  private countSpoken(kind: ScoredKind): void {
    this.sessionSpoken += 1;
    this.spokenKinds.add(kind);
    this.todaySpoken += 1;
    const day = beijingDay(this.deps.now());
    this.write('daily', (store, ownerId, agentId) => {
      const count = store.incrementProactiveDaily(ownerId, agentId, day);
      if (count > 0) this.todaySpoken = Math.max(this.todaySpoken, count);
    });
  }

  private settle(resolved: Resolved | null, declined: boolean): void {
    if (!resolved) return;
    const { line, outcome } = resolved;
    const now = this.deps.now();
    this.deps.logger.info('proactive_outcome', { kind: line.kind, outcome });
    const row = this.stats.find((s) => s.kind === line.kind);
    if (row) row[outcome] += 1;
    else this.stats.push({ kind: line.kind, accepted: outcome === 'accepted' ? 1 : 0, rejected: outcome === 'rejected' ? 1 : 0 });
    this.write('outcome', (store, ownerId, agentId) => { store.recordProactiveOutcome(ownerId, agentId, line.kind, outcome, now); });
    const threadId = line.threadId;
    if (threadId && outcome === 'rejected' && declined) {
      this.threads = this.threads.filter((t) => t.id !== threadId);
      this.write('close', (store, ownerId) => { store.closeThread(ownerId, threadId, 'declined', now); });
    }
  }

  /** Prefetch once per Beijing day; a failure leaves an empty context (spec 失败处理与降级). */
  private ensureLoaded(): void {
    const day = beijingDay(this.deps.now());
    if (this.loaded && day === this.day) return;
    if (day !== this.day) this.todaySpoken = 0;
    this.loaded = true;
    this.day = day;
    const { store, ownerId, agentId, cfg } = this.deps;
    this.tier = this.tierChosen ?? cfg.defaultTier;
    if (!store || !ownerId || !agentId) return;
    try {
      this.tier = this.tierChosen ?? store.getProactiveTier(ownerId, agentId) ?? cfg.defaultTier;
      this.stats = store.proactiveStats(ownerId, agentId);
      this.todaySpoken = Math.max(this.todaySpoken, store.proactiveDaily(ownerId, agentId, day));
      this.threads = store.listOpenThreads(ownerId, agentId);
      this.lastMood = store.listMoodSummaries(ownerId, agentId, 1)[0] ?? null;
      this.familiarity = familiarityOf(store.relationshipStats(ownerId, agentId), cfg);
      this.recentLines = store.recentUserMessages(ownerId, agentId, cfg.material.familyLookback).map((row) => row.text);
    } catch {
      this.threads = [];
      this.recentLines = [];
      this.deps.logger.warn('proactive_prefetch_failed', { code: 'store_error' });
    }
  }

  /** continueThread material: the card's open loop, else the user's last statement (never a question). */
  private openLoopFor(input: SilenceInput, rules: ProactiveRules): string | undefined {
    const loop = input.openLoop?.trim();
    if (loop) return loop;
    const last = input.lastUtterance.trim();
    return input.hadContent && last && isMemoryEvidence(last, rules.evidence) ? last : undefined;
  }

  /** Newest remembered statement naming family, without health words. */
  private familyLine(rules: ProactiveRules): string | undefined {
    return this.recentLines.find((line) => isMemoryEvidence(line, rules.evidence)
      && hasAny(line, rules.silence.familyWords) && !hasAny(line, rules.healthWords));
  }

  private pickTopic(topics: readonly TopicCard[]): { index: number; card: TopicCard } | null {
    if (topics.length === 0) return null;
    const index = pickFallback(topics.length, this.recentFor(TOPIC_KEY, topics.length));
    return { index, card: topics[index]! };
  }

  /** Used indexes, newest first: this session's, then the store's. */
  private recentFor(key: string, limit: number): number[] {
    const local = this.usedLines.get(key) ?? [];
    let stored: number[] = [];
    const { store, ownerId, agentId } = this.deps;
    if (store && ownerId && agentId) {
      try {
        stored = store.recentFallbackLines(ownerId, agentId, key, limit);
      } catch {
        stored = [];
      }
    }
    return [...local, ...stored];
  }

  private rememberUsed(key: string, index: number, keep: number): void {
    const list = [index, ...(this.usedLines.get(key) ?? []).filter((i) => i !== index)].slice(0, Math.max(1, keep));
    this.usedLines.set(key, list);
    const now = this.deps.now();
    this.write('fallback', (store, ownerId, agentId) => { store.recordFallbackLine(ownerId, agentId, key, index, now, keep); });
  }

  /** Cross-session writes: only after the notice and without a decline. Failures never stop speech. */
  private write(code: string, body: (store: MemoryStore, ownerId: string, agentId: string) => void): void {
    const { store, ownerId, agentId } = this.deps;
    if (!store || !ownerId || !agentId || !this.deps.canPersist()) return;
    try {
      body(store, ownerId, agentId);
    } catch {
      this.deps.logger.error('proactive_store_failed', { code });
    }
  }
}
```

注意几处容易错的地方：
- `planned.intent.fallbackKey` 在 `ProactiveIntent` 里是 `string`，这里断言成 `FallbackKey`；`buildIntent` 只会产出 `FALLBACK_KEYS` 里的值。
- `todaySpoken` 先在本地加一，再用库里返回的计数取大，避免不写库时次数不增长。
- 预取在第一次用到时做，跨过北京时间零点会重读（今天次数清零）。
- `settle` 更新本会话的 `stats` 副本，后续决策立刻看到这次接受 / 拒绝。

- [x] **Step 5：运行测试**

Run: `npm test -w gateway -- test/proactive-runtime.test.ts && npm run typecheck -w gateway`
Expected: PASS。分数断言不对时，先核对 `proactivity.json` 是否被改过；不要改期望值。

- [x] **Step 6：全量与提交**

Run: `npm test -w gateway`
Expected: PASS（还没接入会话）。

```bash
git add gateway/src/session/proactive/acceptance.ts gateway/src/session/proactive/runtime.ts gateway/test/proactive-runtime.test.ts
git commit -m "feat(proactive): per-session runtime for decisions, counters, acceptance and tier

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
