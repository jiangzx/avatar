# Task T4: 规划器输入（affect / openLoop / 时间节气）、规划规则与话题聊干

> 依据 spec §2（规划器输入）、§4（话题聊干）、§7（危机）、§9（多语言）。先读 `00-overview.md` 的 T2、T3、T4 冻结接口。
>
> **高风险区：** 本任务改四段式沉默规划器的输入和提示词。开始前读 `docs/project/roadmap.md` 的「打断与沉默：已踩过的坑」「记忆与回忆：已踩过的坑」。用户已在 spec grilling 中授权（spec「状态」一节），前提是坑位契约全部保留：checkin 内容校验（`stageContentOk`）、`previousTexts` 去重、不补充输入里没有的人名/作品名/地名（规则 10）、回忆问句不猜答案（规则 11）、Director 的轻回应处理（`waitQuietly`）都不改。改后必须跑 gateway 全量测试、typecheck 和真实记忆库召回探针（Step 24）。
>
> 前置条件：T3 已合入 `dev-master`（`renderAffect`、Session 的 `affectCard` / `syncAffectRender` / `onAffectCard`、`affectFixture` / `affectCardJson` / `sessionInternals` 测试辅助）。

**Files:**
- Create: `gateway/src/session/timeContext.ts`
- Create: `gateway/src/session/topicExhaustion.ts`
- Create: `gateway/test/time-context.test.ts`
- Create: `gateway/test/topic-exhaustion.test.ts`
- Modify: `gateway/src/session/director.ts`（`SilenceContext` 新字段、`DirectorDeps.getPlanExtras`、`planContext`）
- Modify: `gateway/src/session/silence.ts`（`usedChars` 计入新字段）
- Modify: `gateway/src/session/affect.ts`（`AffectTracker` 接入 `TopicExhaustion`；`AffectTrackerDeps.declinePhrases?`）
- Modify: `gateway/src/session/session.ts`（`getPlanExtras` 接线、`openLoop`、`declinePhrases`、终稿后重新渲染）
- Modify: `gateway/roles/elder-companion/{zh,ja,en}/director.json`（`silenceDecision.instruction` 追加规则 12–15）
- Test: `gateway/test/director-silence.test.ts`、`gateway/test/silence.test.ts`、`gateway/test/session.test.ts`、`gateway/test/config.test.ts`

**Interfaces:**
- Consumes（T2）：`AffectCard`、`AffectConfig`（`exhausted`、`lowIntensity`、`timeZone`、`solarTermWindowDays`）、`isLow`、`AffectTracker`（`onUserFinal`、`onLightFinal`、`exhaustedArmed`、`summary()`、`deps.onCard`）、`AffectSummary.exhaustedArmed/exhaustedRevoked`、`AffectCopy`（`declinePhrases`、`solarTerms`、`seasons`、`timeOfDay`）、`containsPhrase`。
- Consumes（T3）：Session 的 `affectCard`、`syncAffectRender()`、`onAffectCard(card)`；`renderAffect` 在 `exhaustedArmed` 时渲染引导句。
- Consumes（T0）：`this.gate.request({ instructions: true })`（经 `syncAffectRender`）。
- Produces（与总览一致）：
  - `SilenceContext` 新增 `affect?`、`openLoop?`、`timeOfDay`、`season`、`solarTerm?`（`timeOfDay`/`season` 的可选性见「接口疑问」Q1）。
  - `timeContext(now: number, timeZone: string, windowDays: number, copy: AffectCopy): { timeOfDay: string; season: string; solarTerm?: string }`。
  - `DirectorDeps.getPlanExtras?: () => Pick<SilenceContext, 'affect' | 'openLoop' | 'timeOfDay' | 'season' | 'solarTerm'>`。
  - `AffectTracker` 实现 `exhaustedArmed`、`onLightFinal` 计数、婉拒冷却；`summary()` 填 `exhaustedArmed` / `exhaustedRevoked`。对外方法不变；`AffectTrackerDeps` 只追加一个可选依赖 `declinePhrases`（Q2）。

## 现状（2026-10-23 核对代码）

- `Director.planContext(stage)`（`director.ts:575`）给 greeting 和 context/check/leave/checkin/rest 共用，只有 `stage`、`userText`、`assistantText`、`previousTexts`、`memorySnapshot`。greeting 只在没有称呼时才走规划器（有称呼走 `safeGreeting`），这条不改。
- `createSilencePlanner`（`silence.ts:51`）的 `usedChars` 只算 userText、assistantText、previousTexts，然后只裁 `memorySnapshot`，超出 `maxInputChars` 直接跳过（`silence_decision_skipped`）。
- 轻回应：`Director.onUserFinal` 里有过实质内容时走 `waitQuietly()`，沉默链不开口，只留 rest 钩子（`director.ts:199-214`、`director.ts:606`）。这是沉默契约，本任务不改，Step 8 加回归测试。
- Session 只在 `deps.textClient && hasSilencePlanner` 时给 Director 传 `planProactiveLine` 等规划依赖（`session.ts:271-277`）。
- 现有规划器提示词是一整段字符串，规则 1)–11) 之后紧跟输出约定（zh「只输出 JSON：」、ja「JSON だけを出力：」、en「Output JSON only:」）。新规则 12)–15) 插在规则 11 与输出约定之间，规则 1–11 一字不改。

## 话题聊干的状态机（spec §4 的落地）

- `shortStreak`：连续短答数。短答 = 轻回应（`onLightFinal`），或去掉空白、标点和符号后长度 ≤ `shortMaxChars`。
- `cooldown`：冷却 N 表示随后 N 条终稿都不预备（2026-10-23 计划审查修订，与 spec「冷却 4 轮 / 婉拒冷却 10 轮」字面一致）。每条终稿开头记下「本句处于冷却中」（`cooldown > 0`）并减一，处于冷却中的这句不尝试预备，即使减到 0。
- 婉拒（命中 `declinePhrases`，`containsPhrase` 匹配）优先：`cooldown = declineCooldownTurns`，清除预备，`shortStreak = 0`，不计撤销。
- 实质内容（非短答）：`shortStreak = 0`；如果已预备，清除并计一次 `exhaustedRevoked`。
- 短答且已预备：说明这句短答的被动回复已经带着引导（引导已用上），清除预备，`shortStreak = 0`，`cooldown = cooldownTurns`。默认配置下，这就是「`shortStreak` 达到 `shortStreakTrigger` 后冷却」。
- 短答且未预备：`shortStreak += 1`；`shortStreak >= shortStreakTrigger - 1` 时尝试预备。
- 卡片：低落（`isLow`）时清除预备并禁止预备；`need === 'topic_exhausted'` 时尝试预备。
- 尝试预备的条件：`cooldown === 0`、本句不处于冷却中（只对终稿路径）且最新卡片不低落；成功一次计一次 `exhaustedArmed`。
- 已知代价：「引导已用上」不检查引导是否真的推送到了上游。第 1 句短答后的推送要等回复结束才有缝隙，如果用户在回复结束前就说了第 2 句短答，引导从未生效却照样进入冷却。可以接受：只是少一次换话头，不会多打扰。
- 预备状态一变，Session 重新渲染；渲染文本变了才 `gate.request({ instructions: true })`（T3 的 `syncAffectRender`）。Director 和沉默链完全不知道这件事。

---

- [ ] **Step 0: 核对前置条件**

Run（仓库根目录）：

```bash
git log --oneline -15
grep -n "export function renderAffect" gateway/src/session/affectRender.ts
grep -n "private syncAffectRender\|private onAffectCard\|private affectCard" gateway/src/session/session.ts
grep -n "onLightFinal\|get exhaustedArmed\|exhaustedArmed: 0\|exhaustedRevoked: 0\|this.deps.onCard" gateway/src/session/affect.ts
grep -n "\.onUserFinal(\|\.onLightFinal(" gateway/src/session/session.ts
grep -n "affectFixture\|affectCardJson\|sessionInternals" gateway/test/session.test.ts
```

Expected：每条都有命中。下文假定 T2 的 `AffectTracker` 把构造参数存成 `private readonly deps: AffectTrackerDeps`，Session 里的分析器字段叫 `this.affect`；名字不同就沿用 T2 的名字。最后两条确认 T2 在 `Session.onUserFinal` 里调用了 `this.affect.onUserFinal` / `onLightFinal`，以及 T3 的测试辅助存在。任何一条没命中，停下来报告。

- [ ] **Step 1: 写 `timeContext` 的失败测试**

新建 `gateway/test/time-context.test.ts`：

```ts
import { LANGUAGES } from '@anyidea/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import type { AffectCopy } from '../src/i18n/types.ts';
import { timeContext } from '../src/session/timeContext.ts';

const copy: AffectCopy = {
  lines: {
    crisis: 'C',
    mood: { low: 'L', happy: 'H', love: 'V', neutral: 'N' },
    trend: { better: 'B', worse: 'W' },
    need: { vent: 'v', share_joy: 'j', help: 'h', chat: 'c', topic_exhausted: 'd' },
    strategy: { comfort: 'co', reflect: 're', affirm: 'af', ask: 'as', disclose: 'di', suggest: 'su' },
    mismatch: 'M',
    exhaustedHint: 'X',
    tail: 'T',
  },
  declinePhrases: [],
  solarTerms: [{ name: '霜降', month: 10, day: 23 }, { name: '冬至', month: 12, day: 22 }, { name: '小寒', month: 1, day: 5 }],
  seasons: { spring: '春天', summer: '夏天', autumn: '秋天', winter: '冬天' },
  timeOfDay: { morning: '早上', noon: '中午', afternoon: '下午', evening: '傍晚', night: '夜里' },
};
const SH = 'Asia/Shanghai';
/** UTC instant for a Shanghai wall-clock time (UTC+8, no DST). */
const shanghai = (month: number, day: number, hour: number, year = 2026) => Date.UTC(year, month - 1, day, hour - 8);

describe('timeContext', () => {
  it('buckets the local hour', () => {
    const at = (hour: number, day = 23) => timeContext(shanghai(10, day, hour), SH, 3, copy).timeOfDay;
    expect(at(4)).toBe('夜里');
    expect(at(5)).toBe('早上');
    expect(at(10)).toBe('早上');
    expect(at(11)).toBe('中午');
    expect(at(12)).toBe('中午');
    expect(at(13)).toBe('下午');
    expect(at(17)).toBe('下午');
    expect(at(18)).toBe('傍晚');
    expect(at(21)).toBe('傍晚');
    expect(at(22)).toBe('夜里');
    expect(at(23)).toBe('夜里');
  });

  it('reads the wall clock in the configured zone', () => {
    // 08:30 in Shanghai is 20:30 the evening before in New York (EDT in late October).
    const instant = shanghai(10, 23, 8) + 30 * 60_000;
    expect(timeContext(instant, SH, 3, copy).timeOfDay).toBe('早上');
    expect(timeContext(instant, 'America/New_York', 3, copy).timeOfDay).toBe('傍晚');
  });

  it('maps the local month to a season', () => {
    const season = (month: number) => timeContext(shanghai(month, 15, 12), SH, 0, copy).season;
    expect([1, 2, 12].map(season)).toEqual(['冬天', '冬天', '冬天']);
    expect([3, 4, 5].map(season)).toEqual(['春天', '春天', '春天']);
    expect([6, 7, 8].map(season)).toEqual(['夏天', '夏天', '夏天']);
    expect([9, 10, 11].map(season)).toEqual(['秋天', '秋天', '秋天']);
  });

  it('names a solar term only within the window, across the year boundary too', () => {
    expect(timeContext(shanghai(10, 23, 12), SH, 3, copy).solarTerm).toBe('霜降');
    expect(timeContext(shanghai(10, 26, 12), SH, 3, copy).solarTerm).toBe('霜降');
    const outside = timeContext(shanghai(10, 27, 12), SH, 3, copy);
    expect(outside.solarTerm).toBeUndefined();
    expect('solarTerm' in outside).toBe(false);
    expect(timeContext(shanghai(12, 31, 12), SH, 5, copy).solarTerm).toBe('小寒');
    expect(timeContext(shanghai(12, 31, 12), SH, 3, copy).solarTerm).toBeUndefined();
  });

  it('picks the nearest term when two are inside the window', () => {
    const near = { ...copy, solarTerms: [{ name: 'A', month: 10, day: 20 }, { name: 'B', month: 10, day: 24 }] };
    expect(timeContext(shanghai(10, 23, 12), SH, 3, near).solarTerm).toBe('B');
  });

  it('rejects an unknown time zone', () => {
    expect(() => timeContext(0, 'Not/AZone', 3, copy)).toThrow(RangeError);
  });

  it('returns localized words from the shipped copy of every language', () => {
    for (const language of LANGUAGES) {
      const shipped = DEFAULT_I18N.affect[language];
      const result = timeContext(shanghai(10, 23, 15), SH, 3, shipped);
      expect(Object.values(shipped.timeOfDay)).toContain(result.timeOfDay);
      expect(Object.values(shipped.seasons)).toContain(result.season);
      if (result.solarTerm !== undefined) expect(shipped.solarTerms.map((term) => term.name)).toContain(result.solarTerm);
    }
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd gateway && npx vitest run test/time-context.test.ts`
Expected: FAIL，`Failed to resolve import "../src/session/timeContext.ts"`。

- [ ] **Step 3: 实现 `timeContext.ts`**

新建 `gateway/src/session/timeContext.ts`：

```ts
import type { AffectCopy } from '../i18n/types.ts';

const DAY_MS = 86_400_000;

type TimeOfDay = keyof AffectCopy['timeOfDay'];
type Season = keyof AffectCopy['seasons'];

interface LocalDate {
  year: number;
  month: number;
  day: number;
  hour: number;
}

/** Calendar definitions, not tuning knobs: [5,11) morning, [11,13) noon, [13,18) afternoon, [18,22) evening, else night. */
function bucketFor(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 13) return 'noon';
  if (hour >= 13 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 22) return 'evening';
  return 'night';
}

/** Meteorological seasons by local month (northern hemisphere, same as the solar-term table). */
function seasonFor(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

/** Wall-clock date and hour in the zone. Throws RangeError for an unknown zone. */
function localDate(now: number, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') % 24 };
}

/** Nearest approximate solar term within ±windowDays; neighbouring years cover the year boundary. */
function solarTermNear(date: LocalDate, windowDays: number, terms: AffectCopy['solarTerms']): string | undefined {
  const today = Date.UTC(date.year, date.month - 1, date.day);
  let best: { name: string; days: number } | undefined;
  for (const term of terms) {
    for (const year of [date.year - 1, date.year, date.year + 1]) {
      const days = Math.abs(Date.UTC(year, term.month - 1, term.day) - today) / DAY_MS;
      if (days <= windowDays && (!best || days < best.days)) best = { name: term.name, days };
    }
  }
  return best?.name;
}

/** Localized time words for planner small talk; every value comes from AffectCopy. */
export function timeContext(
  now: number,
  timeZone: string,
  windowDays: number,
  copy: AffectCopy,
): { timeOfDay: string; season: string; solarTerm?: string } {
  const date = localDate(now, timeZone);
  const solarTerm = solarTermNear(date, windowDays, copy.solarTerms);
  return {
    timeOfDay: copy.timeOfDay[bucketFor(date.hour)],
    season: copy.seasons[seasonFor(date.month)],
    ...(solarTerm ? { solarTerm } : {}),
  };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `cd gateway && npx vitest run test/time-context.test.ts`
Expected: PASS（7 个用例）。

- [ ] **Step 5: 写 Director 规划输入的失败测试与轻回应回归测试**

`gateway/test/director-silence.test.ts` 第 5 行，原文：

```ts
import { Director, type DirectorDeps } from '../src/session/director.ts';
```

改为：

```ts
import { Director, type DirectorDeps, type SilenceContext } from '../src/session/director.ts';
```

在 `describe('substantive conversation silence', ...)` 块的最后一个用例之后（该块的结束 `});` 之前）追加：

```ts
  it('adds the plan extras to every planned stage and keeps the open loop to context and check', async () => {
    const contexts: SilenceContext[] = [];
    const extras: Pick<SilenceContext, 'affect' | 'openLoop' | 'timeOfDay' | 'season' | 'solarTerm'> = {
      affect: { emotion: 'happy', intensity: 1, trend: 'flat', need: 'chat', low: false, crisis: false },
      openLoop: '明天要去医院复查',
      timeOfDay: '下午',
      season: '秋天',
      solarTerm: '霜降',
    };
    const requests: ProactiveRequest[] = [];
    const d = new Director(cfg, {
      requestResponse: (_kind, request) => requests.push(request),
      planProactiveLine: (context) => { contexts.push(context); return { text: `${context.stage}承接` }; },
      getPlanExtras: () => extras,
    });
    d.onUserFinal('今天走了很多路，脚有点酸。');
    d.onAiTurnStarted();
    d.onAiTurnEnded('今天走了不少地方。');
    for (const [stage, wait] of [['context', cfg.contextAfterMs], ['check', cfg.checkAfterMs], ['leave', cfg.leaveAfterMs]] as const) {
      await vi.advanceTimersByTimeAsync(wait);
      d.onAiTurnStarted();
      d.onAiTurnEnded(`${stage}承接`);
    }
    await vi.advanceTimersByTimeAsync(cfg.checkinAfterMs);
    const { openLoop: _openLoop, ...withoutLoop } = extras;
    const base = { userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。', memorySnapshot: '' };
    expect(contexts).toEqual([
      { stage: 'context', ...base, previousTexts: [], ...extras },
      { stage: 'check', ...base, previousTexts: ['context承接'], ...extras },
      { stage: 'leave', ...base, previousTexts: ['context承接', 'check承接'], ...withoutLoop },
      { stage: 'checkin', ...base, previousTexts: ['context承接', 'check承接', 'leave承接'], ...withoutLoop },
    ]);
    expect(requests).toHaveLength(4);
    d.stop();
  });

  it('gives the greeting plan the time words but never an open loop', () => {
    const contexts: SilenceContext[] = [];
    const d = new Director(cfg, {
      requestResponse: () => {},
      planProactiveLine: (context) => { contexts.push(context); return null; },
      getPlanExtras: () => ({ openLoop: '明天要去医院复查', timeOfDay: '早上', season: '秋天' }),
    });
    d.onSessionStart();
    expect(contexts).toEqual([
      { stage: 'greeting', userText: '', assistantText: '', previousTexts: [], memorySnapshot: '', timeOfDay: '早上', season: '秋天' },
    ]);
    d.stop();
  });

  it('keeps light-reply handling unchanged when the extras say the topic ran dry', async () => {
    let calls = 0;
    let rests = 0;
    const requests: ProactiveRequest[] = [];
    const d = new Director(cfg, {
      requestResponse: (_kind, request) => requests.push(request),
      onQuietRest: () => { rests++; },
      planProactiveLine: () => { calls++; return { text: '换个话头' }; },
      getPlanExtras: () => ({
        affect: { emotion: 'neutral', intensity: 1, trend: 'flat', need: 'topic_exhausted', low: false, crisis: false },
        timeOfDay: '下午',
        season: '秋天',
      }),
    });
    d.onUserFinal('今天走了很多路，脚有点酸。');
    d.onAiTurnStarted();
    d.onAiTurnEnded('今天走了不少地方。');
    d.onUserFinal('嗯');
    d.onAiTurnStarted();
    d.onAiTurnEnded('嗯。');
    d.onUserFinal('好的');
    d.onAiTurnStarted();
    d.onAiTurnEnded('好。');
    await vi.advanceTimersByTimeAsync(600_000);
    // Same contract as without extras: light replies after content wait quietly; only the rest hook runs.
    expect(calls).toBe(0);
    expect(requests).toEqual([]);
    expect(rests).toBe(1);
    d.stop();
  });
```

- [ ] **Step 6: 运行，确认失败**

Run: `cd gateway && npx vitest run test/director-silence.test.ts`
Expected: FAIL。前两个新用例的实际上下文里没有 `affect` / `timeOfDay` 等字段（`getPlanExtras` 还没被读取）。第三个新用例 `keeps light-reply handling unchanged...` 现在就 PASS，它是回归护栏，实现后必须仍然 PASS。原有用例全部 PASS。

- [ ] **Step 7: 实现 `SilenceContext`、`getPlanExtras`、`planContext`**

`gateway/src/session/director.ts`，原文：

```ts
import { containsPhrase } from '../i18n/text.ts';
import type { DirectorConfig } from '../roles/types.ts';
import { log } from '../log.ts';
```

改为：

```ts
import { containsPhrase } from '../i18n/text.ts';
import type { DirectorConfig } from '../roles/types.ts';
import { log } from '../log.ts';
import type { AffectCard } from './affect.ts';
```

原文：

```ts
export interface SilenceContext {
  stage: ProactivePlanStage;
  userText: string;
  assistantText: string;
  previousTexts: readonly string[];
  /** Rendered memory snapshot; empty when this session has none. */
  memorySnapshot: string;
}
```

改为：

```ts
export interface SilenceContext {
  stage: ProactivePlanStage;
  userText: string;
  assistantText: string;
  previousTexts: readonly string[];
  /** Rendered memory snapshot; empty when this session has none. */
  memorySnapshot: string;
  /** Latest analyzer card in planner form; absent before the first card or without an analyzer. */
  affect?: Pick<AffectCard, 'emotion' | 'intensity' | 'trend' | 'need'> & { low: boolean; crisis: boolean };
  /** Unfinished thing the user said in this session; only the context and check stages get it. */
  openLoop?: string;
  /** Localized time words for small-talk wording only; absent without plan extras. */
  timeOfDay?: string;
  season?: string;
  /** Approximate solar term within the configured window. */
  solarTerm?: string;
}
```

原文：

```ts
  /** Current rendered memory for this session, read at planning time; proactive stages get the safe view. */
  getMemorySnapshot?(stage: ProactivePlanStage): string;
```

改为：

```ts
  /** Current rendered memory for this session, read at planning time; proactive stages get the safe view. */
  getMemorySnapshot?(stage: ProactivePlanStage): string;
  /** Planner-only extras read at planning time: latest affect card, open loop, localized time words. */
  getPlanExtras?(): Pick<SilenceContext, 'affect' | 'openLoop' | 'timeOfDay' | 'season' | 'solarTerm'>;
```

原文：

```ts
  private planContext(stage: ProactivePlanStage): SilenceContext {
    return {
      stage,
      userText: stage === 'greeting' ? '' : this.lastContent,
      assistantText: stage === 'greeting' ? '' : this.lastAnswer,
      previousTexts: [...this.ladderTexts],
      memorySnapshot: this.deps.getMemorySnapshot?.(stage) ?? '',
    };
  }
```

改为：

```ts
  private planContext(stage: ProactivePlanStage): SilenceContext {
    const extras: Pick<SilenceContext, 'affect' | 'openLoop' | 'timeOfDay' | 'season' | 'solarTerm'> = this.deps.getPlanExtras?.() ?? {};
    const { openLoop, ...rest } = extras;
    return {
      stage,
      userText: stage === 'greeting' ? '' : this.lastContent,
      assistantText: stage === 'greeting' ? '' : this.lastAnswer,
      previousTexts: [...this.ladderTexts],
      memorySnapshot: this.deps.getMemorySnapshot?.(stage) ?? '',
      ...rest,
      // The open loop is handled like userText, so only the stages that quote userText get it.
      ...(openLoop && (stage === 'context' || stage === 'check') ? { openLoop } : {}),
    };
  }
```

`onUserFinal`、`waitQuietly`、`onAiTurnEnded` 等轻回应与阶梯逻辑一行都不改。

- [ ] **Step 8: 运行，确认通过**

Run: `cd gateway && npx vitest run test/director-silence.test.ts test/director.test.ts`
Expected: PASS。原有的 `toEqual` 精确断言（没有 `getPlanExtras`）不变，证明不传扩展时上下文与现状完全一致。

- [ ] **Step 9: 写规划器输入预算的失败测试**

`gateway/test/silence.test.ts`，在 `it('does not send oversized exchanges for optional speech', ...)` 之后追加：

```ts
  it('passes the affect, open-loop and time fields to the planner as data', async () => {
    let input!: Parameters<TextModelClient['complete']>[0];
    const plan = createSilencePlanner({ complete: async data => {
      input = data;
      return '{"speak":true,"text":"走累了，脚酸着也不好受。"}';
    } }, config, zhRules);
    const withExtras = {
      ...context,
      affect: { emotion: 'sad' as const, intensity: 2 as const, trend: 'worse' as const, need: 'vent' as const, low: true, crisis: false },
      openLoop: '明天要去复查',
      timeOfDay: '下午',
      season: '秋天',
      solarTerm: '霜降',
    };
    expect(await plan(withExtras, signal())).toEqual({ text: '走累了，脚酸着也不好受。' });
    expect(JSON.parse(input.user)).toEqual(withExtras);
  });

  it('counts the new fields in the input budget and still trims only the memory snapshot', async () => {
    let input!: Parameters<TextModelClient['complete']>[0];
    const line = '您好，又见到您了。今天想聊点什么？';
    const plan = createSilencePlanner({ complete: async data => {
      input = data;
      return JSON.stringify({ speak: true, text: line });
    } }, config, zhRules);
    const extras = {
      affect: { emotion: 'happy' as const, intensity: 1 as const, trend: 'flat' as const, need: 'chat' as const, low: false, crisis: false },
      openLoop: '开'.repeat(100),
      timeOfDay: '下午',
      season: '秋天',
      solarTerm: '霜降',
    };
    const opening = { ...context, stage: 'greeting' as const, userText: '', assistantText: '', memorySnapshot: '记'.repeat(7000), ...extras };
    expect(await plan(opening, signal())).toEqual({ text: line });
    const used = JSON.stringify(extras.affect).length + 100 + 2 + 2 + 2;
    const sent = JSON.parse(input.user) as { memorySnapshot: string; openLoop: string };
    expect(sent.memorySnapshot).toHaveLength(6000 - used);
    expect(sent.openLoop).toBe(extras.openLoop);
  });

  it('skips optional speech when the new fields push the exchange over budget', async () => {
    let calls = 0;
    const plan = createSilencePlanner({ complete: async () => { calls++; return '{"speak":true,"text":"不应播放"}'; } }, config, zhRules);
    // userText 5990 + assistantText 9 fits on its own; the open loop tips it over 6000.
    expect(await plan({ ...context, userText: '长'.repeat(5990), openLoop: '开'.repeat(20) }, signal())).toBeNull();
    expect(calls).toBe(0);
  });
```

- [ ] **Step 10: 运行，确认失败**

Run: `cd gateway && npx vitest run test/silence.test.ts`
Expected: FAIL。`counts the new fields...` 报 `expected ... to have a length of <6000 - used> but got 6000`；`skips optional speech...` 返回了 `{ text: '不应播放' }`，`calls` 是 1。`passes the affect, open-loop and time fields...` 现在就 PASS（输入本来就整体透传）。

- [ ] **Step 11: 实现 `usedChars`**

`gateway/src/session/silence.ts`，原文：

```ts
    if (signal.aborted) return null;
    const usedChars = context.userText.length + context.assistantText.length
      + context.previousTexts.reduce((total, text) => total + text.length, 0);
```

改为：

```ts
    if (signal.aborted) return null;
    // Plan extras are small and always sent whole; they count before the snapshot gets its share.
    const extraChars = (context.affect ? JSON.stringify(context.affect).length : 0)
      + (context.openLoop?.length ?? 0)
      + (context.timeOfDay?.length ?? 0)
      + (context.season?.length ?? 0)
      + (context.solarTerm?.length ?? 0);
    const usedChars = context.userText.length + context.assistantText.length
      + context.previousTexts.reduce((total, text) => total + text.length, 0)
      + extraChars;
```

`stageContentOk`、`variationHint`、解析与日志都不改。

- [ ] **Step 12: 运行，确认通过**

Run: `cd gateway && npx vitest run test/silence.test.ts test/multilingual.test.ts`
Expected: PASS。

- [ ] **Step 13: 写 `TopicExhaustion` 与分析器接入的失败测试**

新建 `gateway/test/topic-exhaustion.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import { AffectTracker, loadAffectConfig, type AffectCard } from '../src/session/affect.ts';
import { TopicExhaustion } from '../src/session/topicExhaustion.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const exhausted = { shortMaxChars: 4, shortStreakTrigger: 2, cooldownTurns: 4, declineCooldownTurns: 10 };
const decline = ['算了', '不想聊这个'];
const card = (over: Partial<AffectCard> = {}): AffectCard => ({
  emotion: 'neutral', intensity: 1, trend: 'flat', need: 'chat', strategy: 'ask', mismatch: false, crisis: false, ...over,
});

describe('TopicExhaustion', () => {
  it('arms after the first short answer and cools down once the second one used it', () => {
    const t = new TopicExhaustion(exhausted);
    t.onFinal('嗯', true, decline);
    expect(t.armed).toBe(true);
    t.onFinal('还行', false, decline);
    expect(t.armed).toBe(false);
    // cooldownTurns = 4 blocks exactly the next four finals.
    for (let i = 0; i < 4; i++) {
      t.onFinal('还行', false, decline);
      expect(t.armed).toBe(false);
    }
    t.onFinal('还行', false, decline);
    expect(t.armed).toBe(true);
    expect(t.armedCount).toBe(2);
    expect(t.revokedCount).toBe(0);
  });

  it('revokes on real content, counts it, and can arm again', () => {
    const t = new TopicExhaustion(exhausted);
    t.onFinal('嗯', true, decline);
    t.onFinal('我下午去公园看人下棋了', false, decline);
    expect(t.armed).toBe(false);
    expect(t.revokedCount).toBe(1);
    t.onFinal('好吧', false, decline);
    expect(t.armed).toBe(true);
    expect(t.armedCount).toBe(2);
  });

  it('ignores spaces and punctuation when it measures a short answer', () => {
    const a = new TopicExhaustion(exhausted);
    a.onFinal('嗯……。', false, decline);
    expect(a.armed).toBe(true);
    const b = new TopicExhaustion(exhausted);
    b.onFinal('Yes.', false, decline);
    expect(b.armed).toBe(true);
    const c = new TopicExhaustion(exhausted);
    c.onFinal('Not really sure.', false, decline);
    expect(c.armed).toBe(false);
  });

  it('cools down for ten finals after a decline and does not count it as revoked', () => {
    const t = new TopicExhaustion(exhausted);
    t.onFinal('嗯', true, decline);
    t.onFinal('算了吧', false, decline);
    expect(t.armed).toBe(false);
    // declineCooldownTurns = 10 blocks exactly the next ten finals.
    for (let i = 0; i < 10; i++) {
      t.onFinal('嗯', true, decline);
      expect(t.armed).toBe(false);
    }
    t.onFinal('嗯', true, decline);
    expect(t.armed).toBe(true);
    expect(t.revokedCount).toBe(0);
  });

  it('never arms while the latest card is low, and a low or crisis card disarms', () => {
    const t = new TopicExhaustion(exhausted);
    t.onCard(card({ emotion: 'sad', intensity: 3 }), true);
    t.onFinal('嗯', true, decline);
    expect(t.armed).toBe(false);
    t.onCard(card(), false);
    expect(t.armed).toBe(false);
    t.onFinal('嗯', true, decline);
    expect(t.armed).toBe(true);
    t.onCard(card({ emotion: 'sad', intensity: 3, crisis: true }), true);
    expect(t.armed).toBe(false);
  });

  it('arms on a topic_exhausted card unless it is cooling down', () => {
    const t = new TopicExhaustion(exhausted);
    t.onCard(card({ need: 'topic_exhausted' }), false);
    expect(t.armed).toBe(true);
    t.onFinal('还行', false, decline);
    expect(t.armed).toBe(false);
    t.onCard(card({ need: 'topic_exhausted' }), false);
    expect(t.armed).toBe(false);
    expect(t.armedCount).toBe(1);
  });
});

describe('AffectTracker topic exhaustion', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const config = loadAffectConfig(`${root}config/affect.json`);
  const json = (over: Record<string, unknown> = {}) => JSON.stringify({
    emotion: 'neutral', intensity: 1, trend: 'flat', need: 'topic_exhausted', strategy: 'disclose', mismatch: false, crisis: false, ...over,
  });
  function make(reply: () => string) {
    const cards: AffectCard[] = [];
    const tracker = new AffectTracker({
      client: { complete: async () => reply() },
      config,
      prompt: () => 'AFFECT',
      history: () => [],
      evidence: DEFAULT_I18N.evidence,
      safety: DEFAULT_I18N.safety,
      onCard: (accepted) => cards.push(accepted),
      declinePhrases: (language) => DEFAULT_I18N.affect[language].declinePhrases,
    });
    return { tracker, cards };
  }

  it('arms on a short answer, revokes on content, re-arms on a topic_exhausted card, and counts both', async () => {
    const { tracker, cards } = make(() => json());
    expect(tracker.exhaustedArmed).toBe(false);
    tracker.onLightFinal('嗯', 'zh');
    expect(tracker.exhaustedArmed).toBe(true);
    tracker.onUserFinal('我下午去公园看人下棋了', 'zh');
    expect(tracker.exhaustedArmed).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(cards).toHaveLength(1);
    expect(tracker.exhaustedArmed).toBe(true);
    expect(tracker.summary()).toMatchObject({ exhaustedArmed: 2, exhaustedRevoked: 1 });
    tracker.dispose();
  });

  it('cools down after a decline phrase and never arms on a low card', async () => {
    const declined = make(() => json());
    declined.tracker.onUserFinal(DEFAULT_I18N.affect.zh.declinePhrases[0]!, 'zh');
    await vi.advanceTimersByTimeAsync(10);
    expect(declined.tracker.exhaustedArmed).toBe(false);
    declined.tracker.dispose();

    const low = make(() => json({ emotion: 'sad', intensity: 3, need: 'vent', strategy: 'comfort' }));
    low.tracker.onUserFinal('老伴走了以后家里空落落的', 'zh');
    await vi.advanceTimersByTimeAsync(10);
    low.tracker.onLightFinal('嗯', 'zh');
    expect(low.tracker.exhaustedArmed).toBe(false);
    low.tracker.dispose();
  });
});
```

- [ ] **Step 14: 运行，确认失败**

Run: `cd gateway && npx vitest run test/topic-exhaustion.test.ts`
Expected: FAIL，`Failed to resolve import "../src/session/topicExhaustion.ts"`。

- [ ] **Step 15: 实现 `topicExhaustion.ts`**

新建 `gateway/src/session/topicExhaustion.ts`：

```ts
import { containsPhrase } from '../i18n/text.ts';
import type { AffectCard, AffectConfig } from './affect.ts';

/** Spaces, punctuation and symbols do not count toward a short answer. */
function contentLength(text: string): number {
  return [...text.replace(/[\s\p{P}\p{S}]+/gu, '')].length;
}

/**
 * Session-local topic-exhaustion state (spec §4). The conditional hint is armed one short answer
 * early, so the passive reply to the next short answer already carries it. Memory only, never logged.
 */
export class TopicExhaustion {
  private shortStreak = 0;
  private cooldown = 0;
  private low = false;
  private armedNow = false;
  private armedTotal = 0;
  private revokedTotal = 0;

  constructor(private readonly config: AffectConfig['exhausted']) {}

  get armed(): boolean {
    return this.armedNow;
  }

  /** Times the hint was armed this session (affect_summary.exhaustedArmed). */
  get armedCount(): number {
    return this.armedTotal;
  }

  /** Times real content cancelled an armed hint (affect_summary.exhaustedRevoked). */
  get revokedCount(): number {
    return this.revokedTotal;
  }

  /** Every user final. `light` marks a whole-utterance light reply; short lines are detected here. */
  onFinal(text: string, light: boolean, declinePhrases: readonly string[]): void {
    // A cooldown of N blocks the next N finals (spec §4): this final uses one step and may not arm.
    const cooling = this.cooldown > 0;
    if (cooling) this.cooldown -= 1;
    if (declinePhrases.some((phrase) => containsPhrase(text, phrase))) {
      this.cooldown = this.config.declineCooldownTurns;
      this.shortStreak = 0;
      this.armedNow = false;
      return;
    }
    const short = light || contentLength(text) <= this.config.shortMaxChars;
    if (!short) {
      this.shortStreak = 0;
      if (this.armedNow) {
        this.armedNow = false;
        this.revokedTotal += 1;
      }
      return;
    }
    if (this.armedNow) {
      // The hint was live for this short answer's reply: drop it and cool down.
      this.armedNow = false;
      this.shortStreak = 0;
      this.cooldown = this.config.cooldownTurns;
      return;
    }
    this.shortStreak += 1;
    if (!cooling && this.shortStreak >= this.config.shortStreakTrigger - 1) this.tryArm();
  }

  /** Every accepted card. A low card disarms; topic_exhausted arms early. */
  onCard(card: AffectCard, low: boolean): void {
    this.low = low;
    if (low) {
      this.armedNow = false;
      return;
    }
    if (card.need === 'topic_exhausted') this.tryArm();
  }

  private tryArm(): void {
    if (this.armedNow || this.cooldown > 0 || this.low) return;
    this.armedNow = true;
    this.armedTotal += 1;
  }
}
```

`topicExhaustion.ts` 只从 `affect.ts` 导入类型，运行时没有循环依赖；低落判定由 `AffectTracker` 用 `isLow` 算好后传进来。

- [ ] **Step 16: 把 `TopicExhaustion` 接进 `AffectTracker`**

`gateway/src/session/affect.ts`（T2 的文件，只做下面这些追加和替换，其余不动）：

1）导入区追加：

```ts
import { TopicExhaustion } from './topicExhaustion.ts';
```

2）`AffectTrackerDeps` 接口末尾（`onCard` 之后）追加一个可选依赖：

```ts
  /** Decline phrases for the final's language (i18n affect.json); missing means no decline cooldown. */
  declinePhrases?: (language: Language) => readonly string[];
```

3）`AffectTracker` 类：在字段区追加

```ts
  /** Topic-exhaustion counters; session memory only. */
  private readonly exhaustion: TopicExhaustion;
```

在构造函数体内（T2 保存 `deps` 之后）追加：

```ts
    this.exhaustion = new TopicExhaustion(deps.config.exhausted);
```

4）把 T2 的 `exhaustedArmed` getter（T2 固定返回 `false`）的方法体换成：

```ts
  get exhaustedArmed(): boolean {
    return this.exhaustion.armed;
  }
```

5）`onUserFinal(text, language)` 方法体里，紧跟在 T2 的 `if (this.disposed) return;` 之后插入（在其余提前 return 之前，例如输入超预算跳过分析时，计数仍要更新）：

```ts
    this.exhaustion.onFinal(text, false, this.deps.declinePhrases?.(language) ?? []);
```

`onLightFinal(text, language)` 同样插在 `if (this.disposed) return;` 之后（T2 没写这行就插在方法体第一行）：

```ts
    this.exhaustion.onFinal(text, true, this.deps.declinePhrases?.(language) ?? []);
```

6）在 T2 接受卡片并调用 `this.deps.onCard(card)` 的那一行之前插入：

```ts
    this.exhaustion.onCard(card, isLow(card, this.deps.config.lowIntensity));
```

（必须在 `onCard` 之前，这样 Session 收到卡片时 `exhaustedArmed` 已经是新值。）

7）`summary()` 里 T2 写的 `exhaustedArmed: 0` 和 `exhaustedRevoked: 0` 分别换成：

```ts
      exhaustedArmed: this.exhaustion.armedCount,
      exhaustedRevoked: this.exhaustion.revokedCount,
```

8）T2 的 `reset()`（Cycle 6b，forget/decline 时调用）也要清掉话题聊干的会话状态。在 `TopicExhaustion` 类里 `tryArm` 之前加：

```ts
  /** Forget/decline: drop the streak and any armed hint. Cooldown and counters stay. */
  reset(): void {
    this.shortStreak = 0;
    this.low = false;
    this.armedNow = false;
  }
```

并在 `AffectTracker.reset()` 方法体末尾追加：

```ts
    this.exhaustion.reset();
```

在 `gateway/test/topic-exhaustion.test.ts` 末尾追加对应用例：

```ts
describe('TopicExhaustion.reset', () => {
  it('drops the streak and the armed hint but keeps the cooldown', () => {
    const t = new TopicExhaustion({ shortMaxChars: 4, shortStreakTrigger: 2, cooldownTurns: 4, declineCooldownTurns: 10 });
    t.onFinal('嗯', true, []);
    expect(t.armed).toBe(true);
    t.reset();
    expect(t.armed).toBe(false);
    expect(t.armedCount).toBe(1);
    t.onFinal('算了', false, ['算了']);
    t.reset();
    t.onFinal('嗯', true, []);
    expect(t.armed).toBe(false); // the decline cooldown survives a reset
  });
});
```

- [ ] **Step 17: 运行，确认通过**

Run: `cd gateway && npx vitest run test/topic-exhaustion.test.ts`，再跑 T2 的分析器测试确认没有回退：`npx vitest run test/affect.test.ts`（如果 T2 的测试文件名不同，用 `ls test | grep -i affect` 找到后一起跑）。
Expected: PASS（`topic-exhaustion.test.ts` 9 个用例；T2 的用例全部 PASS）。

- [ ] **Step 18: 写 Session 接线的失败测试**

`gateway/test/session.test.ts` 顶部导入追加：

```ts
import { timeContext } from '../src/session/timeContext.ts';
```

在文件末尾追加：

```ts
describe('Session planner extras and topic exhaustion', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const plannerDirector: DirectorConfig = {
    ...director,
    contextAfterMs: 3000,
    silenceDecision: {
      instruction: 'DECIDE', speakInstruction: 'READ {continuation}',
      maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
      policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
    },
  };
  /** 14:00 in Asia/Shanghai on 2026-10-23. */
  const FIXED_NOW = Date.UTC(2026, 9, 23, 6, 0);

  it('sends the latest card, the open loop and local time words to the planner', async () => {
    const plannerInputs: unknown[] = [];
    const s = setup({
      roles: fixedRoleCatalog('P', plannerDirector),
      i18n,
      affect: affectFixture,
      now: () => FIXED_NOW,
      textClient: { complete: async (input) => {
        if (input.system === 'DECIDE') {
          plannerInputs.push(JSON.parse(input.user));
          return '{"speak":false}';
        }
        return affectCardJson({ emotion: 'happy', intensity: 1, trend: 'flat', need: 'chat', strategy: 'ask', openLoop: '明天要去医院复查' });
      } },
    });
    const time = timeContext(FIXED_NOW, affectFixture.timeZone, affectFixture.solarTermWindowDays, i18n.affect.zh);
    await greetAndFinish(s);
    expect(plannerInputs).toEqual([{ stage: 'greeting', userText: '', assistantText: '', previousTexts: [], memorySnapshot: '', ...time }]);
    s.session.handleClientMessage({ type: 'debug.userText', text: '明天要去医院复查' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(plannerInputs[1]).toEqual({
      stage: 'context',
      userText: '明天要去医院复查',
      assistantText: '我在听',
      previousTexts: [],
      memorySnapshot: '',
      ...time,
      affect: { emotion: 'happy', intensity: 1, trend: 'flat', need: 'chat', low: false, crisis: false },
      openLoop: '明天要去医院复查',
    });
    s.session.end();
  });

  it('arms the topic-exhaustion hint after one short answer and drops it on real content, asking for a push each time', async () => {
    const s = setup({
      i18n,
      affect: affectFixture,
      textClient: { complete: async () => affectCardJson({ emotion: 'neutral', intensity: 1, trend: 'flat', need: 'chat', strategy: 'ask' }) },
    });
    await greetAndFinish(s);
    const request = vi.spyOn(sessionInternals(s.session).gate, 'request');
    const pushes = () => request.mock.calls.filter(([update]) => update.instructions === true).length;
    const hint = i18n.affect.zh.lines.exhaustedHint;

    s.session.handleClientMessage({ type: 'debug.userText', text: '还行' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).toContain(hint);
    const armed = pushes();
    expect(armed).toBeGreaterThanOrEqual(1);

    s.session.handleClientMessage({ type: 'debug.userText', text: '我下午去公园看人下棋了' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).not.toContain(hint);
    expect(pushes()).toBeGreaterThan(armed);
    s.session.end();
  });

  it('drops the hint once the second short answer has used it', async () => {
    const s = setup({
      i18n,
      affect: affectFixture,
      textClient: { complete: async () => affectCardJson({ emotion: 'neutral', intensity: 1, trend: 'flat', need: 'chat', strategy: 'ask' }) },
    });
    await greetAndFinish(s);
    const hint = i18n.affect.zh.lines.exhaustedHint;
    s.session.handleClientMessage({ type: 'debug.userText', text: '还行' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).toContain(hint);
    s.session.handleClientMessage({ type: 'debug.userText', text: '嗯嗯' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).not.toContain(hint);
    s.session.end();
  });

  it('forgets the open loop and the card on a forget rebuild, so the planner no longer sees them', async () => {
    const s = setup({
      roles: fixedRoleCatalog('P', plannerDirector),
      i18n,
      affect: affectFixture,
      now: () => FIXED_NOW,
      textClient: { complete: async (input) => (input.system === 'DECIDE'
        ? '{"speak":false}'
        : affectCardJson({ emotion: 'sad', intensity: 2, trend: 'flat', need: 'vent', strategy: 'comfort', openLoop: '明天要去医院复查' })) },
    });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '明天要去医院复查' });
    await vi.advanceTimersByTimeAsync(10);
    const view = s.session as unknown as {
      planExtras(): Pick<SilenceContext, 'affect' | 'openLoop'>;
      rebuild(reason: string, keepToolTurn?: boolean): Promise<void>;
    };
    expect(view.planExtras().openLoop).toBe('明天要去医院复查');
    void view.rebuild('forget', true);
    expect(view.planExtras().openLoop).toBeUndefined();
    expect(view.planExtras().affect).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    s.session.end();
  });
});
```

如果 `session.test.ts` 还没有导入 `SilenceContext`，在顶部加 `import type { SilenceContext } from '../src/session/director.ts';`。

说明：第一个用例里规划器和分析器共用一个假客户端，按 `system === 'DECIDE'`（规划器提示词）区分；Mock 对未匹配的 `debug.userText` 回复 `我在听`。`affectFixture`、`affectCardJson`、`sessionInternals` 是 T3 加的模块级辅助。

- [ ] **Step 19: 运行，确认失败**

Run: `cd gateway && npx vitest run test/session.test.ts -t "Session planner extras and topic exhaustion"`
Expected: FAIL。第一个用例的规划器输入里没有 `timeOfDay`/`season`/`affect`/`openLoop`；最后一个用例报 `view.planExtras is not a function`；第二、三个用例的指令里没有引导句（Session 还没接 `declinePhrases`、终稿后也没有重新渲染）。注意：如果 Step 16 已经让分析器在 `onLightFinal` 时预备，第二、三个用例可能因为 Session 没有在终稿后调用 `syncAffectRender` 而仍然失败，这是预期。

- [ ] **Step 20: 实现 Session 接线**

`gateway/src/session/session.ts`：

1）导入。原文：

```ts
import { createSilencePlanner } from './silence.ts';
```

改为：

```ts
import { createSilencePlanner } from './silence.ts';
import { timeContext } from './timeContext.ts';
```

2）字段。在 T3 加的字段之后，原文：

```ts
  /** affect_crisis is logged at most once per session. */
  private crisisLogged = false;
```

改为：

```ts
  /** affect_crisis is logged at most once per session. */
  private crisisLogged = false;
  /** Last validated open loop from an accepted card; planner input only, never logged. */
  private openLoop: string | undefined;
```

3）Director 依赖。原文：

```ts
        ...(deps.textClient && hasSilencePlanner ? {
          planProactiveLine: (context, signal) => this.planProactiveLine(context, signal),
          getMemorySnapshot: (stage) => stage === 'greeting'
            ? this.context.greetingMemorySnapshot ?? ''
            : this.context.proactiveMemorySnapshot ?? '',
          safeGreeting: () => this.safeGreeting(),
        } : {}),
```

改为：

```ts
        ...(deps.textClient && hasSilencePlanner ? {
          planProactiveLine: (context, signal) => this.planProactiveLine(context, signal),
          getMemorySnapshot: (stage) => stage === 'greeting'
            ? this.context.greetingMemorySnapshot ?? ''
            : this.context.proactiveMemorySnapshot ?? '',
          safeGreeting: () => this.safeGreeting(),
          ...(deps.affect?.enabled ? { getPlanExtras: () => this.planExtras() } : {}),
        } : {}),
```

4）T2 创建 `AffectTracker` 的构造参数里（T3 已把 `onCard` 改成 `(card) => this.onAffectCard(card)`），在 `onCard` 之后追加：

```ts
      declinePhrases: (language) => this.i18n.affect[language].declinePhrases,
```

5）`onAffectCard`（T3）。原文：

```ts
    this.affectCard = card;
    if (card.crisis && !this.crisisLogged) {
```

改为：

```ts
    this.affectCard = card;
    // The tracker already checked the open loop against the user's own lines.
    if (card.openLoop) this.openLoop = card.openLoop;
    if (card.crisis && !this.crisisLogged) {
```

5b）T3 的 `clearAffect()`。原文：

```ts
  private clearAffect(): void {
    this.affectCard = null;
    this.affectRendered = '';
```

改为：

```ts
  private clearAffect(): void {
    this.affectCard = null;
    this.affectRendered = '';
    // The open loop is the user's own words; forget/decline must drop it too (spec §8).
    this.openLoop = undefined;
```

6）在 `onAffectCard` 方法之后新增：

```ts
  /** Planner-only extras: latest card, the session's open loop, and localized time words. */
  private planExtras(): Pick<SilenceContext, 'affect' | 'openLoop' | 'timeOfDay' | 'season' | 'solarTerm'> {
    const config = this.deps.affect;
    if (!config) return {};
    const card = this.affectCard;
    return {
      ...timeContext(this.now(), config.timeZone, config.solarTermWindowDays, this.i18n.affect[this.language]),
      ...(card ? {
        affect: {
          emotion: card.emotion,
          intensity: card.intensity,
          trend: card.trend,
          need: card.need,
          low: isLow(card, config.lowIntensity),
          crisis: card.crisis,
        },
      } : {}),
      ...(this.openLoop ? { openLoop: this.openLoop } : {}),
    };
  }
```

7）`onUserFinal` 末尾。原文：

```ts
    const action = this.actions.fromKeyword(text);
    if (action) this.send({ type: 'avatar.action', action, source: 'keyword' });
    this.maybeSummarize();
  }
```

改为：

```ts
    const action = this.actions.fromKeyword(text);
    if (action) this.send({ type: 'avatar.action', action, source: 'keyword' });
    // The tracker may have armed or dropped the topic-exhaustion hint on this final.
    this.syncAffectRender();
    this.maybeSummarize();
  }
```

这一行必须在 T2 调用 `this.affect.onUserFinal(...)` / `this.affect.onLightFinal(...)` 之后；如果 T2 把它们放在 `this.maybeSummarize()` 之后，就把这一行移到那两个调用后面。`this.director.onUserFinal(text)` 不动。

- [ ] **Step 21: 运行，确认通过**

Run: `cd gateway && npx vitest run test/session.test.ts test/director-silence.test.ts test/silence.test.ts test/topic-exhaustion.test.ts test/time-context.test.ts`
Expected: PASS。`session.test.ts` 里原有的规划器输入精确断言（`inputs` 只有五个字段的那几处）不变：那些用例没有传 `affect`，Session 不给 Director 传 `getPlanExtras`。

- [ ] **Step 22: 写规划器提示词规则的失败测试**

`gateway/test/config.test.ts`，原文（`describe('config')` 的最后一个用例结尾）：

```ts
    expect(() => DirectorSchema.parse({ ...cfg, silenceDecision: {
      ...decision, variationHints: { checkin: [] },
    } })).toThrow();
  });
});

describe('identity config', () => {
```

改为：

```ts
    expect(() => DirectorSchema.parse({ ...cfg, silenceDecision: {
      ...decision, variationHints: { checkin: [] },
    } })).toThrow();
  });

  it('appends affect, open-loop and time rules 12-15 to every planner prompt without touching rules 1-11', () => {
    const load = (language: 'zh' | 'ja' | 'en') =>
      loadDirectorConfig(`${root}roles/elder-companion/${language}/director.json`).silenceDecision!.instruction;

    const zh = load('zh');
    expect(zh).toContain('12) affect 是对方此刻状态的内部参考，可能没有；其中 low 为 true 时（优先于第 3 条），context、check 不起新话题');
    expect(zh).toContain('crisis 为 true 时，任何阶段都不起新话题，只表达你一直在，并劝对方联系家人或身边的人');
    expect(zh).toContain('13) affect.need 为 share_joy 或 chat、且 low 不为 true 时，context、check 可以主动起一个和 userText 相关的小话题。');
    expect(zh).toContain('14) openLoop 是对方本次说过、还没说完的事，可能没有；只在 context、check 阶段可用，用法同 userText');
    expect(zh).toContain('15) timeOfDay、season、solarTerm 是当地时段、季节和前后几天内的节气（日期是约数），只用于寒暄措辞，不要编造天气');
    expect(zh).toContain('10) 只能使用输入里已经出现过的具体人名、作品名、地名和事件；不要补充输入里没有的具体名字或作品名。');
    expect(zh).toContain('checkin：必须问对方是否还在听，并说明随时都可以接着聊；不超过 30 个字');
    expect(zh.indexOf('11) ')).toBeLessThan(zh.indexOf('12) '));
    expect(zh.indexOf('15) ')).toBeLessThan(zh.indexOf('只输出 JSON：'));

    const ja = load('ja');
    expect(ja).toContain('12) affect は相手の今の様子の内部参考で、ないこともある。');
    expect(ja).toContain('crisis が true のときは、どの段階でも新しい話題を出さず');
    expect(ja).toContain('13) affect.need が share_joy または chat で');
    expect(ja).toContain('14) openLoop は相手が今回話した、まだ終わっていない事柄で');
    expect(ja).toContain('15) timeOfDay、season、solarTerm は現地の時間帯、季節、前後数日以内の節気（日付はおおよそ）');
    expect(ja).toContain('10) 入力に出てきた具体的な人名、作品名、地名、出来事だけを使う。');
    expect(ja.indexOf('11) ')).toBeLessThan(ja.indexOf('12) '));
    expect(ja.indexOf('15) ')).toBeLessThan(ja.indexOf('JSON だけを出力：'));
    expect(ja).not.toContain('您');

    const en = load('en');
    expect(en).toContain('12) affect is internal guidance about how they feel right now and may be absent.');
    expect(en).toContain('When affect.crisis is true, do not start a new topic at any stage');
    expect(en).toContain('13) When affect.need is share_joy or chat and affect.low is not true');
    expect(en).toContain('14) openLoop is something they said earlier in this conversation that is not finished');
    expect(en).toContain('15) timeOfDay, season, and solarTerm are the local time of day');
    expect(en).toContain('never invent the weather');
    expect(en).toContain('10) Use only the specific names, titles, places, and events that already appear in the input');
    expect(en.indexOf('11) ')).toBeLessThan(en.indexOf('12) '));
    expect(en.indexOf('15) ')).toBeLessThan(en.indexOf('Output JSON only:'));
    expect(en).not.toMatch(/[一-鿿]/);
  });
});

describe('identity config', () => {
```

- [ ] **Step 23: 运行，确认失败；改三份 `director.json`；再确认通过**

Run: `cd gateway && npx vitest run test/config.test.ts`
Expected: FAIL，`expected '你是小暖，…' to contain '12) affect 是对方此刻状态的内部参考…'`。

然后改提示词。三处都只在规则 11 与输出约定之间插入新规则，规则 1–11、输出约定本身一字不改。插入的文字不含双引号，不需要转义。

`gateway/roles/elder-companion/zh/director.json` 的 `silenceDecision.instruction` 中，原文片段：

```text
只轻轻接一句或问对方想聊什么。只输出 JSON：
```

改为：

```text
只轻轻接一句或问对方想聊什么。12) affect 是对方此刻状态的内部参考，可能没有；其中 low 为 true 时（优先于第 3 条），context、check 不起新话题，只陪着、接住对方的感受，leave 也不留新话头；crisis 为 true 时，任何阶段都不起新话题，只表达你一直在，并劝对方联系家人或身边的人。不要说出 affect 里的词。13) affect.need 为 share_joy 或 chat、且 low 不为 true 时，context、check 可以主动起一个和 userText 相关的小话题。14) openLoop 是对方本次说过、还没说完的事，可能没有；只在 context、check 阶段可用，用法同 userText，只能用其中已有的事实，不要猜结果。15) timeOfDay、season、solarTerm 是当地时段、季节和前后几天内的节气（日期是约数），只用于寒暄措辞，不要编造天气，也不要说成对方说过的事。只输出 JSON：
```

`gateway/roles/elder-companion/ja/director.json` 的 `silenceDecision.instruction` 中，原文片段：

```text
何を話したいかを聞く。JSON だけを出力：
```

改为：

```text
何を話したいかを聞く。12) affect は相手の今の様子の内部参考で、ないこともある。low が true のときは（3 の規則より優先）、context と check で新しい話題を出さず、そばにいて気持ちを受け止めるだけにし、leave でも新しい話のきっかけを残さない。crisis が true のときは、どの段階でも新しい話題を出さず、ずっとそばにいると伝え、家族や身近な人に連絡するようやさしく勧める。affect の中の言葉はそのまま口にしない。13) affect.need が share_joy または chat で、low が true でないときは、context と check で userText に関係する小さな話題を自分から出してよい。14) openLoop は相手が今回話した、まだ終わっていない事柄で、ないこともある。context と check の段階でだけ使い、扱いは userText と同じ。中にある事実だけを使い、結果を推測しない。15) timeOfDay、season、solarTerm は現地の時間帯、季節、前後数日以内の節気（日付はおおよそ）で、あいさつの言い回しにだけ使う。天気をでっち上げず、相手が話したこととして扱わない。JSON だけを出力：
```

`gateway/roles/elder-companion/en/director.json` 的 `silenceDecision.instruction` 中，原文片段：

```text
just acknowledge briefly or ask what they would like to talk about. Output JSON only:
```

改为：

```text
just acknowledge briefly or ask what they would like to talk about. 12) affect is internal guidance about how they feel right now and may be absent. When affect.low is true (this overrides rule 3), in context and check do not start a new topic; just stay with them and acknowledge the feeling; in leave do not leave a new opening either. When affect.crisis is true, do not start a new topic at any stage; only say you are here and gently urge them to contact family or someone nearby. Never say the words in affect aloud. 13) When affect.need is share_joy or chat and affect.low is not true, in context and check you may start one small topic related to userText. 14) openLoop is something they said earlier in this conversation that is not finished, and may be absent; use it only in the context and check stages, treat it exactly like userText, use only the facts already in it, and do not guess the outcome. 15) timeOfDay, season, and solarTerm are the local time of day, the season, and a solar term within a few days (its date is approximate); use them only for small-talk wording, never invent the weather, and never present them as something the user said. Output JSON only:
```

Run: `cd gateway && npx vitest run test/config.test.ts test/fileCatalog.test.ts test/director-silence.test.ts`
Expected: PASS。`config.test.ts` 原有对 zh/ja/en 提示词的断言（各阶段名、`previousTexts`、`close`、`within 80 characters`、`60 文字以内`、en 不含汉字、ja 不含「您」）仍然通过。

- [ ] **Step 24: 全量回归与真实记忆库召回探针**

Run（仓库根目录）：

```bash
npm test -w gateway
npm run typecheck -w gateway
git diff --check
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$HOME/.avatar/memory.db"
```

Expected：测试与 typecheck 全部通过，`git diff --check` 无输出。召回探针（只读）：zh「上次聊到哪儿了」`hits:true`；「上次聊过电影吗」`hits:true`；「我说过喜欢喝茶吗」`hits:false`；`newTitleFlag:false`。探针结果和总览不一致就停下来报告，不要提交。如果本机没有 `$HOME/.avatar/memory.db`，按 AGENTS §7 记入 `docs/blockers.md` 并在报告里写明没跑。

- [ ] **Step 25: 提交**

```bash
git add gateway/src/session/timeContext.ts gateway/src/session/topicExhaustion.ts \
  gateway/src/session/director.ts gateway/src/session/silence.ts gateway/src/session/affect.ts gateway/src/session/session.ts \
  gateway/roles/elder-companion/zh/director.json gateway/roles/elder-companion/ja/director.json gateway/roles/elder-companion/en/director.json \
  gateway/test/time-context.test.ts gateway/test/topic-exhaustion.test.ts gateway/test/director-silence.test.ts \
  gateway/test/silence.test.ts gateway/test/session.test.ts gateway/test/config.test.ts
git commit -m "feat(gateway): feed affect and time into the silence planner and add topic-exhaustion hints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

报告里写：实际跑过的命令与结果（含召回探针四项输出）；本任务没有改 Director 的轻回应处理、`stageContentOk`、规则 1–11，回归护栏是 `keeps light-reply handling unchanged...`。

## 接口疑问

**Q1：`SilenceContext.timeOfDay` / `season` 改成可选。** 总览写的是必填 `timeOfDay: string; season: string`。必填的话，没有 `getPlanExtras` 的 Director（测试、Mock、`affect.enabled=false`）也必须造出这两个字段，现有几处对规划器输入的 `toEqual` 精确断言（`director-silence.test.ts:127-130,162`、`session.test.ts:324-355`）都要改，这些正是沉默契约的回归测试；`silence.test.ts`、`multilingual.test.ts` 里手写的 `SilenceContext` 也会 typecheck 失败。改成可选后，`getPlanExtras` 的签名（`Pick<SilenceContext, …>`）不变，Session 启用时总是填这两个字段。

**Q2：`AffectTrackerDeps` 追加可选的 `declinePhrases?: (language) => readonly string[]`。** 冻结的 deps 里拿不到 `AffectCopy`，婉拒短语只在 i18n 里，`onUserFinal(text, language)` 有语言却查不到短语。追加的是可选字段，不改已有方法和字段。

**Q3：「引导已用上」的判定。** spec 写的是「`shortStreak` 达到 `shortStreakTrigger` 后冷却」。卡片（`need === 'topic_exhausted'`）也能预备，此时 `shortStreak` 可能是 0，按字面要再来两句短答才会冷却。T4 统一为「已预备时再来一句短答就算用上」：默认配置下与 spec 完全一致，卡片预备的情况也说得通。

**Q4：时段和季节的边界写在代码里**（`timeContext.ts` 的 `bucketFor` / `seasonFor`）。它们是日历定义，不是调参项，冻结的 `timeContext` 签名和 `AffectConfig` 也没有给它们留位置。如果要进配置，需要改 T2 拥有的 `affect.json` schema。另外 `timeZone` 无效时 `Intl` 会抛 `RangeError`，Director 的 try/catch 会让每次规划都退回配置文案。建议 T2 的 schema 用 `Intl.DateTimeFormat` 校验 `timeZone`，在启动时就失败。

**Q5：openLoop 在代码里也只给 context/check。** spec 只在提示词里约束。T4 在 `planContext` 里同样过滤（greeting/leave/checkin/rest 拿不到），提示词规则 14 保留，两层都有。

**Q6：T2 内部位置是假定的。** Step 16 假定 T2 在 `summary()` 里写的是字面量 `exhaustedArmed: 0` / `exhaustedRevoked: 0`，有 `this.deps.onCard(card)` 这一行，并且构造参数存在 `this.deps`。实际写法不同时，按 Step 16 的语义找到对应位置修改，不要改 T2 的对外接口。如果 T2 把短答（≤ `shortMaxChars`）也路由到 `onLightFinal`，`TopicExhaustion` 照样计为短答，不受影响。
