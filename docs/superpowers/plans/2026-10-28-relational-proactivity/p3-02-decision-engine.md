# P3-T2：意图契约与决策引擎（纯函数）

**Spec：** 「意图契约 `ProactiveIntent`」「决策引擎」（时机、打分、硬规则、三档、接受率系数、疲劳）、「事项线」生命周期、「关系画像」熟悉度、Q6（危机与告别不起新话题）、Q13、Q16、Q18、Q25。

本任务只写纯函数与类型，不接入会话（P3 后半接入）。引擎输入一个只读的 `DecisionContext`（P3 后半从记忆库、情绪卡、会话状态组装），输出选中的意图与得分。所有数值来自 `proactivity.json`（P3-T1）。

**规则汇总（实现与测试都按这张表）：**

| 情况 | 结果 |
|---|---|
| `silenceCheckin` | 固定 `presenceCheck`（危机时也是） |
| `silenceRest` | 固定 `restQuiet` |
| 总开关关闭 / 危机 / 用户在告别 | 开场 `greetingPlain`，其余 `quiet` |
| 本会话或今天的主动次数已达档位上限（开场不受限） | `quiet` |
| 安静档 | 开场只考虑「事件」类事项线（事件前 / 事件后），其余时机一律 `quiet` |
| 当前情绪低落 | 去掉 `interestTopic`、`selfShare`；`humanConnection` 只在应对阶段为 `suggest` 时可选 |
| 本会话已提事项数达 `threads.maxPerSession` | 去掉 `threadFollowup` |
| 本会话产生的事项、本会话已提过的事项 | 不参与 |
| 最高分 < 档位门槛 | 开场 `greetingPlain`，其余 `quiet` |
| 平分 | `priority` 小的胜出 |

各时机可选的打分意图：

| 时机 | 候选 |
|---|---|
| `sessionStart` | `threadFollowup`、`moodCheck`、`routine` |
| `silenceContext` | `threadFollowup`、`moodCheck`、`routine`、`interestTopic`、`continueThread`、`humanConnection` |
| `silenceCheck` | `threadFollowup`、`interestTopic`、`continueThread`、`selfShare` |
| `silenceLeave` | `interestTopic`、`selfShare`（留一个话头，不提问由渲染约束保证） |
| `topicExhausted` | `threadFollowup`、`interestTopic`、`humanConnection`、`selfShare` |

`silenceLeave` 的候选是编写计划时补的（spec 表格没有列 leave；现行 leave 段会「留话头」，这里保持它能开口）。

**打分：** `score = (Σ 权重 × 特征) / 10000 × 接受率系数 × 疲劳系数`，特征与权重都是 0–100。

| 意图 | relevance | urgency | importance | novelty |
|---|---|---|---|---|
| `threadFollowup` | base | 按事项类型：事件后 `eventAfter`、事件前 `eventBefore`、牵挂 `concern`、计划 `plan` | 敏感 `sensitive`，否则 `plain` | 100 |
| `moodCheck` | base | `mood.recentHours` 内为 base，否则 `staleUrgency` | 上次有危机为 100，否则 base | 本会话说过为 0，否则 100 |
| `routine` | base（只在作息窗口内可选） | base | base | 同上 |
| `humanConnection` | 情绪低落时 `humanConnection.lowRelevance`，否则 base | base | base | 同上 |
| `continueThread`、`interestTopic`、`selfShare` | base | base | base | 同上 |

- 接受率系数（Q25）：`0.5 + (接受 + priorAccepted) / (接受 + 拒绝 + priorAccepted + priorRejected)`；分母为 0 时取 1。
- 疲劳系数：`1 − 0.5 × min(1, 本会话已主动次数 / max(1, 档位每次会话上限))`。
- `moodCheck` 可选条件：本会话情绪低落，或 `lookbackHours` 内最近一次情绪摘要的结束情绪为 `sad` 且结束强度 ≥ `mood.lowIntensity`。
- 作息窗口按北京时间的小时判断（`start ≤ hour < end`）。

**事项资格 `threadUrgency`：**
- 事件：提及次数达 `event.maxMentions` 不可提；事件前 `preDays` 天内且从未提过 → `eventBefore`；事件后 `postDays` 天内且事件后还没提过 → `eventAfter`；其余不可提。
- 牵挂：次数达上限或创建超过 `expireDays` 天不可提；提过的要隔 `intervalDays` 天；从未提过的可以直接提（它来自已结束的会话）。
- 计划：次数达上限不可提；创建后 `minDays`～`maxDays` 天内可提。

**Files:**
- Create: `gateway/src/session/proactive/engine.ts`
- Create: `gateway/src/session/proactive/intent.ts`
- Test: `gateway/test/proactive-engine.test.ts`

**Interfaces:**
- Consumes: P3-T1 `ProactivityConfig`、`ScoredKind`、`IntentKind`、`SCORED_KINDS`；P2 `ThreadRecord`、`MoodSummaryRecord`、`RelationshipStats`、`ProactiveTier`（`memory/store.ts`）。
- Produces（冻结，P3 后半使用）：

```ts
// gateway/src/session/proactive/engine.ts
export const MOMENTS = ['sessionStart', 'silenceContext', 'silenceCheck', 'silenceLeave', 'silenceCheckin', 'silenceRest', 'topicExhausted'] as const;
export type Moment = (typeof MOMENTS)[number];
export type Familiarity = 'new' | 'familiar' | 'oldFriend';
export type CareStage = 'explore' | 'comfort' | 'suggest';
export interface DecisionContext { /* see Step 3 */ }
export interface Decision { kind: IntentKind; threadId?: string; score: number; candidates: number }
export function decide(ctx: DecisionContext, cfg: ProactivityConfig): Decision;
export function threadUrgency(thread: ThreadRecord, now: number, cfg: ProactivityConfig): number | null;
export function acceptanceMultiplier(kind: ScoredKind, stats: DecisionContext['stats'], cfg: ProactivityConfig): number;
export function familiarityOf(stats: RelationshipStats, cfg: ProactivityConfig): Familiarity;
export function beijingHour(at: number): number;

// gateway/src/session/proactive/intent.ts
export interface ProactiveIntent { /* see Step 4 */ }
```

- [ ] **Step 1：写失败测试**

创建 `gateway/test/proactive-engine.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MoodSummaryRecord, ThreadRecord } from '../src/memory/store.ts';
import { loadProactivity, type ProactivityConfig } from '../src/session/proactive/config.ts';
import { acceptanceMultiplier, beijingHour, decide, familiarityOf, threadUrgency, type DecisionContext } from '../src/session/proactive/engine.ts';

const cfg = loadProactivity(fileURLToPath(new URL('../config/proactivity.json', import.meta.url)));
const DAY = 86_400_000;
const HOUR = 3_600_000;
// 08:30 Beijing: inside the morning routine window.
const NOW = Date.parse('2026-11-03T08:30:00+08:00');
// 15:00 Beijing: outside every routine window.
const AFTERNOON = Date.parse('2026-11-03T15:00:00+08:00');

const ctx = (over: Partial<DecisionContext> = {}): DecisionContext => ({
  moment: 'silenceCheck',
  now: AFTERNOON,
  currentSessionId: 's-now',
  tier: 'moderate',
  affect: { low: false, crisis: false, stage: 'explore' },
  lastMood: null,
  threads: [],
  has: { openLoop: false, interest: false, family: false },
  sessionSpoken: 0,
  todaySpoken: 0,
  spokenKinds: new Set(),
  mentionedThreads: new Set(),
  stats: [],
  userLeaving: false,
  ...over,
});
const thread = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: 't1', kind: 'concern', quote: '最近膝盖疼', dueAt: NOW, sensitive: false, mentionCount: 0, lastMentionedAt: null,
  createdAt: NOW - DAY, sourceSessionId: 's-old', ...over,
});
const sadMood = (over: Partial<MoodSummaryRecord> = {}): MoodSummaryRecord => ({
  id: 'm1', sessionId: 's-old', dominant: 'sad', peakIntensity: 2, endEmotion: 'sad', endIntensity: 2, endTrend: 'flat', crisis: false,
  createdAt: NOW - 10 * HOUR, ...over,
});

describe('structural moments and hard rules', () => {
  it('always checks in and rests at those steps, even in a crisis', () => {
    expect(decide(ctx({ moment: 'silenceCheckin', affect: { low: true, crisis: true, stage: 'explore' } }), cfg).kind).toBe('presenceCheck');
    expect(decide(ctx({ moment: 'silenceRest' }), cfg).kind).toBe('restQuiet');
  });

  it('starts no new topic in a crisis, when the user is leaving, or when switched off', () => {
    const rich = { has: { openLoop: true, interest: true, family: true } };
    expect(decide(ctx({ ...rich, affect: { low: true, crisis: true, stage: 'explore' } }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ ...rich, userLeaving: true }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ ...rich }), { ...cfg, enabled: false }).kind).toBe('quiet');
    expect(decide(ctx({ ...rich, moment: 'sessionStart', affect: { low: true, crisis: true, stage: 'explore' } }), cfg).kind).toBe('greetingPlain');
  });

  it('stays quiet once the session or daily cap is reached, but the opening still speaks', () => {
    const rich = { has: { openLoop: true, interest: true, family: true } };
    expect(decide(ctx({ ...rich, sessionSpoken: cfg.tiers.moderate.maxPerSession }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ ...rich, todaySpoken: cfg.tiers.moderate.maxPerDay }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ moment: 'sessionStart', now: NOW, todaySpoken: 99 }), cfg).kind).toBe('routine');
  });
});

describe('scoring', () => {
  it('picks the highest score above the tier threshold', () => {
    // interestTopic 0.59 > selfShare 0.57 at the check step.
    const d = decide(ctx({ has: { openLoop: false, interest: true, family: false } }), cfg);
    expect(d).toEqual({ kind: 'interestTopic', score: 0.59, candidates: 2 });
  });

  it('gets quieter as the session goes on (fatigue)', () => {
    // After 2 of 4 lines: interestTopic 0.4425 and selfShare 0.4275 are both under 0.45.
    expect(decide(ctx({ has: { openLoop: false, interest: true, family: false }, sessionSpoken: 2 }), cfg).kind).toBe('quiet');
  });

  it('opens with a mood check after a low last session, ahead of a due event and the morning greeting', () => {
    const d = decide(ctx({
      moment: 'sessionStart', now: NOW, lastMood: sadMood(),
      threads: [thread({ kind: 'event', dueAt: NOW - 5 * HOUR, sensitive: true })],
    }), cfg);
    expect(d.kind).toBe('moodCheck');
    expect(d.score).toBe(0.9);
  });

  it('opens with a due event before the morning greeting', () => {
    const d = decide(ctx({ moment: 'sessionStart', now: NOW, threads: [thread({ kind: 'event', dueAt: NOW - 5 * HOUR, sensitive: true })] }), cfg);
    expect(d).toMatchObject({ kind: 'threadFollowup', threadId: 't1', score: 0.865 });
  });

  it('opens with a plain greeting when nothing clears the threshold', () => {
    expect(decide(ctx({ moment: 'sessionStart', now: AFTERNOON }), cfg)).toEqual({ kind: 'greetingPlain', score: 0.45, candidates: 0 });
  });

  it('lowers a kind the user keeps turning down', () => {
    expect(acceptanceMultiplier('routine', [{ kind: 'routine', accepted: 0, rejected: 10 }], cfg)).toBeCloseTo(0.5 + 2 / 14, 10);
    expect(acceptanceMultiplier('routine', [], cfg)).toBe(1);
    expect(acceptanceMultiplier('routine', [], { ...cfg, acceptance: { ...cfg.acceptance, priorAccepted: 0, priorRejected: 0 } })).toBe(1);
    const d = decide(ctx({ moment: 'sessionStart', now: NOW, stats: [{ kind: 'routine', accepted: 0, rejected: 10 }] }), cfg);
    expect(d.kind).toBe('routine');
    expect(d.score).toBeCloseTo(0.74 * (0.5 + 2 / 14), 5);
  });

  it('breaks ties by priority', () => {
    const same = { ...cfg, kinds: { ...cfg.kinds, selfShare: { ...cfg.kinds.selfShare, weights: cfg.kinds.interestTopic.weights, base: cfg.kinds.interestTopic.base } } };
    expect(decide(ctx({ has: { openLoop: false, interest: true, family: false } }), same).kind).toBe('interestTopic');
  });
});

describe('tiers, mood and threads', () => {
  it('quiet tier: only a due event at the opening, nothing during silence', () => {
    const due = thread({ kind: 'event', dueAt: NOW - 5 * HOUR });
    expect(decide(ctx({ tier: 'quiet', has: { openLoop: true, interest: true, family: true } }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ tier: 'quiet', moment: 'sessionStart', now: NOW, lastMood: sadMood() }), cfg).kind).toBe('greetingPlain');
    expect(decide(ctx({ tier: 'quiet', moment: 'sessionStart', now: NOW, threads: [due] }), cfg)).toMatchObject({ kind: 'threadFollowup', threadId: 't1' });
  });

  it('low mood: no topic change or self-talk; family nudge only at the suggest stage', () => {
    const has = { openLoop: false, interest: true, family: true };
    expect(decide(ctx({ moment: 'topicExhausted', has, affect: { low: true, crisis: false, stage: 'comfort' } }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ moment: 'topicExhausted', has, affect: { low: true, crisis: false, stage: 'suggest' } }), cfg).kind).toBe('humanConnection');
  });

  it('skips threads from this session, threads already mentioned, and stops at the per-session thread cap', () => {
    // Afternoon opening: no routine window, no mood, so only threads can beat the plain greeting.
    const start = { moment: 'sessionStart' as const, now: AFTERNOON };
    const fresh = thread({ id: 'fresh', sourceSessionId: 's-now' });
    const told = thread({ id: 'told' });
    expect(decide(ctx({ ...start, threads: [fresh] }), cfg).kind).toBe('greetingPlain');
    expect(decide(ctx({ ...start, threads: [told], mentionedThreads: new Set(['told']) }), cfg).kind).toBe('greetingPlain');
    expect(decide(ctx({ ...start, threads: [thread({ id: 'other' })], mentionedThreads: new Set(['a', 'b']) }), cfg).kind).toBe('greetingPlain');
    expect(decide(ctx({ ...start, threads: [thread({ id: 'other' })] }), cfg)).toMatchObject({ kind: 'threadFollowup', threadId: 'other', score: 0.615 });
  });
});

describe('threadUrgency', () => {
  it('events: once before (within preDays), once after (within postDays)', () => {
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW + 20 * HOUR }), NOW, cfg)).toBe(80);
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW + 2 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW + 20 * HOUR, mentionCount: 1, lastMentionedAt: NOW - HOUR }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW - DAY, mentionCount: 1, lastMentionedAt: NOW - 2 * DAY }), NOW, cfg)).toBe(100);
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW - DAY, mentionCount: 2, lastMentionedAt: NOW - 2 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW - DAY, mentionCount: 1, lastMentionedAt: NOW - HOUR }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW - 8 * DAY }), NOW, cfg)).toBeNull();
  });

  it('concerns: first mention right away, then every intervalDays, up to maxMentions and expireDays', () => {
    expect(threadUrgency(thread(), NOW, cfg)).toBe(60);
    expect(threadUrgency(thread({ mentionCount: 1, lastMentionedAt: NOW - 2 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ mentionCount: 1, lastMentionedAt: NOW - 3 * DAY }), NOW, cfg)).toBe(60);
    expect(threadUrgency(thread({ mentionCount: 3, lastMentionedAt: NOW - 5 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ createdAt: NOW - 15 * DAY }), NOW, cfg)).toBeNull();
  });

  it('plans: between minDays and maxDays after creation, once', () => {
    expect(threadUrgency(thread({ kind: 'plan', createdAt: NOW - 2 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'plan', createdAt: NOW - 4 * DAY }), NOW, cfg)).toBe(50);
    expect(threadUrgency(thread({ kind: 'plan', createdAt: NOW - 8 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'plan', createdAt: NOW - 4 * DAY, mentionCount: 1 }), NOW, cfg)).toBeNull();
  });
});

describe('helpers', () => {
  it('reads the Beijing hour', () => {
    expect(beijingHour(NOW)).toBe(8);
    expect(beijingHour(Date.parse('2026-11-03T00:05:00+08:00'))).toBe(0);
  });

  it('derives familiarity from ended sessions and active days', () => {
    const stats = (sessions: number, activeDays: number) => ({ firstMetAt: 1, sessions, totalMinutes: 0, activeDays, lastSessionAt: 1, hourHistogram: Array(24).fill(0) });
    expect(familiarityOf(stats(2, 2), cfg)).toBe('new');
    expect(familiarityOf(stats(3, 1), cfg)).toBe('new');
    expect(familiarityOf(stats(3, 2), cfg)).toBe('familiar');
    expect(familiarityOf(stats(15, 10), cfg)).toBe('oldFriend');
  });
});

const _typecheck: ProactivityConfig = cfg;
void _typecheck;
```

- [ ] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/proactive-engine.test.ts`
Expected: FAIL——`engine.ts` 不存在。

- [ ] **Step 3：引擎**

创建 `gateway/src/session/proactive/engine.ts`：

```ts
// Decision engine (spec 2026-10-28 决策引擎). Pure: no I/O, no clock, no model call; < 1 ms per decision.
import type { MoodSummaryRecord, ProactiveTier, RelationshipStats, ThreadRecord } from '../../memory/store.ts';
import type { IntentKind, ProactivityConfig, ScoredKind } from './config.ts';

export const MOMENTS = ['sessionStart', 'silenceContext', 'silenceCheck', 'silenceLeave', 'silenceCheckin', 'silenceRest', 'topicExhausted'] as const;
export type Moment = (typeof MOMENTS)[number];
export type Familiarity = 'new' | 'familiar' | 'oldFriend';
/** ESConv order while the user is low: explore, then comfort, then suggest. */
export type CareStage = 'explore' | 'comfort' | 'suggest';

export interface DecisionContext {
  moment: Moment;
  /** Session clock (ms). */
  now: number;
  currentSessionId: string;
  tier: ProactiveTier;
  affect: { low: boolean; crisis: boolean; stage: CareStage };
  lastMood: MoodSummaryRecord | null;
  threads: readonly ThreadRecord[];
  /** Whether usable material exists; P3 back half gathers it. */
  has: { openLoop: boolean; interest: boolean; family: boolean };
  /** Scored proactive lines so far this session / today (structural lines do not count). */
  sessionSpoken: number;
  todaySpoken: number;
  spokenKinds: ReadonlySet<ScoredKind>;
  mentionedThreads: ReadonlySet<string>;
  stats: ReadonlyArray<{ kind: string; accepted: number; rejected: number }>;
  userLeaving: boolean;
}

export interface Decision { kind: IntentKind; threadId?: string; score: number; candidates: number }

const DAY = 86_400_000;
const HOUR = 3_600_000;

const MOMENT_KINDS: Record<Moment, readonly ScoredKind[]> = {
  sessionStart: ['threadFollowup', 'moodCheck', 'routine'],
  silenceContext: ['threadFollowup', 'moodCheck', 'routine', 'interestTopic', 'continueThread', 'humanConnection'],
  silenceCheck: ['threadFollowup', 'interestTopic', 'continueThread', 'selfShare'],
  silenceLeave: ['interestTopic', 'selfShare'],
  silenceCheckin: [],
  silenceRest: [],
  topicExhausted: ['threadFollowup', 'interestTopic', 'humanConnection', 'selfShare'],
};

type Features = { relevance: number; urgency: number; importance: number; novelty: number };

export function beijingHour(at: number): number {
  return new Date(at + 8 * HOUR).getUTCHours();
}

export function familiarityOf(stats: RelationshipStats, cfg: ProactivityConfig): Familiarity {
  const f = cfg.familiarity;
  if (stats.sessions >= f.oldFriendMinSessions && stats.activeDays >= f.oldFriendMinDays) return 'oldFriend';
  if (stats.sessions >= f.familiarMinSessions && stats.activeDays >= f.familiarMinDays) return 'familiar';
  return 'new';
}

/** Q25: 0.5..1.5, smoothed by the configured prior. */
export function acceptanceMultiplier(kind: ScoredKind, stats: DecisionContext['stats'], cfg: ProactivityConfig): number {
  const row = stats.find((s) => s.kind === kind);
  const a = (row?.accepted ?? 0) + cfg.acceptance.priorAccepted;
  const total = a + (row?.rejected ?? 0) + cfg.acceptance.priorRejected;
  return total === 0 ? 1 : 0.5 + a / total;
}

/** Urgency (0..100) when this thread may be raised now, else null (spec 事项线 lifecycle). */
export function threadUrgency(thread: ThreadRecord, now: number, cfg: ProactivityConfig): number | null {
  const t = cfg.threads;
  if (thread.kind === 'event') {
    if (thread.mentionCount >= t.event.maxMentions) return null;
    if (now < thread.dueAt) return thread.dueAt - now <= t.event.preDays * DAY && thread.mentionCount === 0 ? t.urgency.eventBefore : null;
    if (now - thread.dueAt > t.event.postDays * DAY) return null;
    return thread.lastMentionedAt !== null && thread.lastMentionedAt >= thread.dueAt ? null : t.urgency.eventAfter;
  }
  if (thread.kind === 'concern') {
    if (thread.mentionCount >= t.concern.maxMentions || now - thread.createdAt > t.concern.expireDays * DAY) return null;
    if (thread.lastMentionedAt !== null && now - thread.lastMentionedAt < t.concern.intervalDays * DAY) return null;
    return t.urgency.concern;
  }
  if (thread.mentionCount >= t.plan.maxMentions) return null;
  const age = now - thread.createdAt;
  return age >= t.plan.minDays * DAY && age <= t.plan.maxDays * DAY ? t.urgency.plan : null;
}

function inRoutineWindow(now: number, cfg: ProactivityConfig): boolean {
  const hour = beijingHour(now);
  return Object.values(cfg.routine).some((w) => hour >= w.start && hour < w.end);
}

function moodIsLow(ctx: DecisionContext, cfg: ProactivityConfig): boolean {
  const m = ctx.lastMood;
  const recentLow = m !== null && ctx.now - m.createdAt <= cfg.mood.lookbackHours * HOUR
    && m.endEmotion === 'sad' && m.endIntensity >= cfg.mood.lowIntensity;
  return ctx.affect.low || recentLow;
}

/** Feature values for one kind, or null when it has nothing to say now. */
function featuresFor(kind: ScoredKind, ctx: DecisionContext, cfg: ProactivityConfig): Array<{ f: Features; threadId?: string }> {
  const base = cfg.kinds[kind].base;
  const novelty = ctx.spokenKinds.has(kind) ? 0 : 100;
  switch (kind) {
    case 'threadFollowup':
      return ctx.threads.flatMap((thread) => {
        if (thread.sourceSessionId === ctx.currentSessionId || ctx.mentionedThreads.has(thread.id)) return [];
        if (ctx.tier === 'quiet' && thread.kind !== 'event') return [];
        const urgency = threadUrgency(thread, ctx.now, cfg);
        if (urgency === null) return [];
        const importance = thread.sensitive ? cfg.threads.importance.sensitive : cfg.threads.importance.plain;
        return [{ f: { relevance: base.relevance, urgency, importance, novelty: 100 }, threadId: thread.id }];
      });
    case 'moodCheck': {
      if (!moodIsLow(ctx, cfg)) return [];
      const recent = ctx.lastMood !== null && ctx.now - ctx.lastMood.createdAt <= cfg.mood.recentHours * HOUR;
      const urgency = ctx.affect.low || recent ? base.urgency : cfg.mood.staleUrgency;
      const importance = ctx.lastMood?.crisis ? 100 : base.importance;
      return [{ f: { relevance: base.relevance, urgency, importance, novelty } }];
    }
    case 'routine':
      return inRoutineWindow(ctx.now, cfg) ? [{ f: { ...base, novelty } }] : [];
    case 'humanConnection':
      if (!ctx.has.family) return [];
      return [{ f: { ...base, relevance: ctx.affect.low ? cfg.humanConnection.lowRelevance : base.relevance, novelty } }];
    case 'continueThread':
      return ctx.has.openLoop ? [{ f: { ...base, novelty } }] : [];
    case 'interestTopic':
      return ctx.has.interest ? [{ f: { ...base, novelty } }] : [];
    case 'selfShare':
      return [{ f: { ...base, novelty } }];
  }
}

/** Hard rules that remove whole kinds before scoring. */
function allowed(kind: ScoredKind, ctx: DecisionContext, cfg: ProactivityConfig): boolean {
  if (!cfg.kinds[kind].enabled) return false;
  if (ctx.tier === 'quiet' && !(ctx.moment === 'sessionStart' && kind === 'threadFollowup')) return false;
  if (kind === 'threadFollowup' && ctx.mentionedThreads.size >= cfg.threads.maxPerSession) return false;
  if (ctx.affect.low) {
    if (kind === 'interestTopic' || kind === 'selfShare') return false;
    if (kind === 'humanConnection' && ctx.affect.stage !== 'suggest') return false;
  }
  return true;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

export function decide(ctx: DecisionContext, cfg: ProactivityConfig): Decision {
  if (ctx.moment === 'silenceCheckin') return { kind: 'presenceCheck', score: 0, candidates: 0 };
  if (ctx.moment === 'silenceRest') return { kind: 'restQuiet', score: 0, candidates: 0 };
  const tier = cfg.tiers[ctx.tier];
  const threshold = tier.threshold / 100;
  const fallback: Decision = { kind: ctx.moment === 'sessionStart' ? 'greetingPlain' : 'quiet', score: threshold, candidates: 0 };
  if (!cfg.enabled || ctx.affect.crisis || ctx.userLeaving) return fallback;
  const opening = ctx.moment === 'sessionStart';
  if (!opening && (ctx.sessionSpoken >= tier.maxPerSession || ctx.todaySpoken >= tier.maxPerDay)) return fallback;
  const fatigue = opening ? 1 : 1 - 0.5 * Math.min(1, ctx.sessionSpoken / Math.max(1, tier.maxPerSession));
  let best: Decision | null = null;
  let bestPriority = Number.POSITIVE_INFINITY;
  let candidates = 0;
  for (const kind of MOMENT_KINDS[ctx.moment]) {
    if (!allowed(kind, ctx, cfg)) continue;
    const w = cfg.kinds[kind].weights;
    const multiplier = acceptanceMultiplier(kind, ctx.stats, cfg);
    for (const { f, threadId } of featuresFor(kind, ctx, cfg)) {
      candidates++;
      const raw = (w.relevance * f.relevance + w.urgency * f.urgency + w.importance * f.importance + w.novelty * f.novelty) / 10_000;
      const score = round(raw * multiplier * fatigue);
      const priority = cfg.kinds[kind].priority;
      if (!best || score > best.score || (score === best.score && priority < bestPriority)) {
        best = { kind, score, candidates: 0, ...(threadId ? { threadId } : {}) };
        bestPriority = priority;
      }
    }
  }
  if (!best || best.score < threshold) return { ...fallback, candidates };
  return { ...best, candidates };
}
```

- [ ] **Step 4：意图契约类型**

创建 `gateway/src/session/proactive/intent.ts`：

```ts
// Model-agnostic intent contract (spec 意图契约). P3 back half builds it from a Decision and renders it per adapter.
import type { Language } from '@anyidea/protocol';
import type { IntentKind } from './config.ts';
import type { CareStage, Familiarity, Moment } from './engine.ts';

export interface ProactiveIntent {
  moment: Moment;
  kind: IntentKind;
  /** Locked material: verbatim user words (with when they were said) and prompt-safe facts. Empty = speak from purpose only. */
  material: { quotes: ReadonlyArray<{ text: string; said: string | null }>; facts: readonly string[] };
  tone: { familiarity: Familiarity; stage: CareStage | null; allowJoke: boolean };
  constraints: { maxChars: number; allowQuestion: boolean; mustExpress: 'presence' | null };
  language: Language;
  /** Key of the fallback line group in director.json when the adapter fails or stays silent. */
  fallbackKey: string;
}
```

- [ ] **Step 5：运行测试**

Run: `npm test -w gateway -- test/proactive-engine.test.ts && npm run typecheck -w gateway`
Expected: PASS。若某条分数断言差在小数末位，检查是否漏了 `round()`；不要改期望值（期望值是按 Step 3 的公式与基线配置手算的）。

- [ ] **Step 6：全量**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected：通过。引擎未接入会话，对话行为不变。

- [ ] **Step 7：更新 roadmap 并提交**

roadmap「关系连续的主动互动」一节写入：P3 前半完成（T0 探针结论、T1 配置与后台场景、T2 引擎）；下一步：用户确认探针结论后写 P3 后半计划（意图组装与渲染、接入开场 / 四段沉默 / 话题聊干、兜底与事后核对、坑位第 4、8 条修订）。

```bash
git add gateway/src/session/proactive/engine.ts gateway/src/session/proactive/intent.ts gateway/test/proactive-engine.test.ts docs/project/roadmap.md
git commit -m "feat(proactive): pure decision engine and the intent contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
