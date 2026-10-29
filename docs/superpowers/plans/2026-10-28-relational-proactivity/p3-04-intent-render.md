# P3-T4：意图组装、渲染、兜底选句与事后核对（纯函数）

**Spec：** 「意图契约 `ProactiveIntent`」「意图渲染与生成」（Qwen 指令、兜底、事后核对）、「情绪轨迹」应对阶段、开放项 1（只有被选中的那一条原话进当次指令）、开放项 3（2026-10-29：写法 A；健康类直接兜底；事后核对加材料外健康词）、坑位「打断与沉默」第 3 条（指令里不放可照读的例句，`{utterance}` 只替换用户自己的话）。

本任务四个文件都是纯函数：没有 I/O、没有时钟、不调模型。会话怎么调用它们在 P3-T5。

**规则汇总：**

| 意图 | 目的键 | 材料 | 兜底组 |
|---|---|---|---|
| `threadFollowup`（非敏感） | 事件：`now < dueAt` 为 `threadEventBefore`，否则 `threadEventAfter`；牵挂 `threadConcern`；计划 `threadPlan` | 这一条事项原话 + 说的时间（`saidWhen(createdAt)`） | `threadFollowup` |
| `threadFollowup`（`sensitive`） | 同上（只用于日志与核对） | 无；**原话不进任何指令**，`fallbackOnly=true` | `threadSensitive` |
| `moodCheck` | 本会话情绪低落 `moodCheckNow`，否则 `moodCheckEarlier` | 无 | `moodCheck` |
| `routine` | 按北京时间落在哪个作息窗口：`routineMorning/Noon/Evening/Night` | 无 | `routine` |
| `continueThread` | `continueThread` | `openLoop`（P3-T5 已保证是用户自己的话），说的时间 `justNow`；含健康词时（`openLoopSensitive`）同健康事项：不进指令，`fallbackOnly=true` | `continueThread` |
| `interestTopic` | `interestTopic` | 话题卡的 `prompt`（作为 fact，用 `withTopic`） | `interestTopic` |
| `humanConnection` | `humanConnection` | 一条含家人词的用户原话，说的时间 `earlier` | `humanConnection` |
| `selfShare` | `selfShare` | 无 | `selfShare` |
| `presenceCheck` | `presenceCheck` | 无；不许提问；要义 `presence` | `presenceCheck` |
| `restQuiet` | `restQuiet` | 无；不许提问 | `restQuiet` |
| `quiet` / `greetingPlain` | — | 返回 `null`（不开口；开场属于 P4） | — |

材料缺失（例如引擎选了 `continueThread` 但组装时没有 `openLoop`）返回 `null`，调用方按「不开口」处理。

**语气：** `tone.familiarity` 取熟悉度；情绪低落时 `tone.stage` 取应对阶段，否则 `null`；`allowJoke = familiarity === 'oldFriend' && !low`。渲染时，老朋友但不许开玩笑就改用 `familiar` 那句语气。

**应对阶段（只看最新情绪卡）：** 没有卡 → `explore`；`need==='help'` 或 `strategy==='suggest'` → `suggest`；`strategy` 为 `comfort`/`affirm`/`reflect` → `comfort`；其余 → `explore`。

**说的时间：** 按北京日期相差天数：0 今天、1 昨天、2–6 `days[n-2]`、7–13 上周、≥14 之前。

**兜底选句：** 组内第一个最近没用过的下标；都用过时取最近记录里最旧的那个。`fallbackKeep`（3）小于每组句数（≥5），所以总有没用过的。

**事后核对（只计数，不拦截）：** 材料外的 `《》「」『』“”` 作品名个数、材料外数字个数（沿用 `grounding.ts` 的 `findUngrounded`）、材料外 `healthWords` 个数、不许提问却有问号、`presence` 要义缺「在听类」或「随时类」词。

**Files:**
- Create: `gateway/src/session/proactive/assemble.ts`
- Create: `gateway/src/session/proactive/render.ts`
- Create: `gateway/src/session/proactive/fallback.ts`
- Create: `gateway/src/session/proactive/check.ts`
- Test: `gateway/test/proactive-render.test.ts`

**Interfaces:**
- Consumes: P3-T2 `Decision`、`Moment`、`CareStage`、`Familiarity`、`beijingHour`（`engine.ts`），`ProactiveIntent`（`intent.ts`），`ProactivityConfig`（`config.ts`）；P3-T3 `IntentCopy`、`IntentPurpose`、`FallbackKey`（`roles/types.ts`）；P2 `ThreadRecord`；现有 `AffectCard`（`session/affect.ts`）、`ProactiveRequest`（`adapters/types.ts`）、`findUngrounded`（`proactive/grounding.ts`）、`containsPhrase`、`SilenceRules`。
- Produces（冻结，见总览）：`IntentMaterial`、`PlannedIntent`、`BuildInput`、`beijingDay`、`careStage`、`saidWhen`、`buildIntent`；`renderIntent`、`speakLineRequest`；`pickFallback`；`CheckSpec`、`CheckRules`、`SpokenCheck`、`checkSpoken`、`violationsOf`。

- [x] **Step 1：写失败测试**

创建 `gateway/test/proactive-render.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDirectorConfig } from '../src/config.ts';
import { loadI18n } from '../src/i18n/load.ts';
import type { ThreadRecord } from '../src/memory/store.ts';
import type { AffectCard } from '../src/session/affect.ts';
import { beijingDay, buildIntent, careStage, saidWhen, type BuildInput } from '../src/session/proactive/assemble.ts';
import { checkSpoken, violationsOf } from '../src/session/proactive/check.ts';
import { loadProactivity } from '../src/session/proactive/config.ts';
import type { Decision } from '../src/session/proactive/engine.ts';
import { pickFallback } from '../src/session/proactive/fallback.ts';
import { renderIntent, speakLineRequest } from '../src/session/proactive/render.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cfg = loadProactivity(`${root}config/proactivity.json`);
const zh = loadDirectorConfig(`${root}roles/elder-companion/zh/director.json`);
const copy = zh.intents!;
const i18n = loadI18n(`${root}config`);
const DAY = 86_400_000;
const HOUR = 3_600_000;
// 08:30 Beijing (morning routine window).
const NOW = Date.parse('2026-11-03T08:30:00+08:00');

const thread = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: 't1', kind: 'concern', quote: '最近膝盖一到晚上就疼，睡不踏实。', dueAt: NOW, sensitive: false, mentionCount: 0,
  lastMentionedAt: null, createdAt: NOW - 3 * DAY, sourceSessionId: 's-old', ...over,
});
const input = (over: Partial<BuildInput> = {}): BuildInput => ({
  moment: 'silenceContext', now: NOW, language: 'zh', familiarity: 'familiar',
  affect: { low: false, stage: 'explore' }, material: {}, cfg, saidWords: copy.saidWhen, ...over,
});
const decision = (kind: Decision['kind'], threadId?: string): Decision => ({ kind, score: 0.6, candidates: 1, ...(threadId ? { threadId } : {}) });
const card = (over: Partial<AffectCard> = {}): AffectCard => ({ emotion: 'sad', intensity: 2, trend: 'flat', need: 'vent', strategy: 'ask', mismatch: false, crisis: false, ...over });

describe('assemble helpers', () => {
  it('reads the Beijing date and how long ago something was said', () => {
    expect(beijingDay(Date.parse('2026-11-03T00:10:00+08:00'))).toBe('2026-11-03');
    expect(beijingDay(Date.parse('2026-11-02T23:50:00+08:00'))).toBe('2026-11-02');
    expect(saidWhen(NOW - HOUR, NOW, copy.saidWhen)).toBe('今天');
    expect(saidWhen(Date.parse('2026-11-02T23:50:00+08:00'), NOW, copy.saidWhen)).toBe('昨天');
    expect(saidWhen(NOW - 2 * DAY, NOW, copy.saidWhen)).toBe('前天');
    expect(saidWhen(NOW - 3 * DAY, NOW, copy.saidWhen)).toBe('三天前');
    expect(saidWhen(NOW - 9 * DAY, NOW, copy.saidWhen)).toBe('上周');
    expect(saidWhen(NOW - 20 * DAY, NOW, copy.saidWhen)).toBe('之前');
  });

  it('derives the care stage from the latest card', () => {
    expect(careStage(null)).toBe('explore');
    expect(careStage(card({ need: 'help' }))).toBe('suggest');
    expect(careStage(card({ strategy: 'suggest' }))).toBe('suggest');
    expect(careStage(card({ strategy: 'comfort' }))).toBe('comfort');
    expect(careStage(card({ strategy: 'ask' }))).toBe('explore');
  });
});

describe('buildIntent', () => {
  it('locks a plain thread to its own quote and when it was said', () => {
    const t = thread();
    const planned = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: t } }))!;
    expect(planned.purpose).toBe('threadConcern');
    expect(planned.fallbackOnly).toBe(false);
    expect(planned.intent.material.quotes).toEqual([{ text: t.quote, said: '三天前' }]);
    expect(planned.intent.fallbackKey).toBe('threadFollowup');
  });

  it('never puts a sensitive quote into the intent; it is spoken from the sensitive group', () => {
    const t = thread({ sensitive: true, quote: '我有高血压，这几天量着有点高。' });
    const planned = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: t } }))!;
    expect(planned.fallbackOnly).toBe(true);
    expect(planned.intent.material.quotes).toEqual([]);
    expect(planned.intent.fallbackKey).toBe('threadSensitive');
  });

  it('splits events into before and after', () => {
    const before = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: thread({ kind: 'event', dueAt: NOW + 20 * HOUR }) } }))!;
    const after = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: thread({ kind: 'event', dueAt: NOW - 5 * HOUR }) } }))!;
    expect(before.purpose).toBe('threadEventBefore');
    expect(after.purpose).toBe('threadEventAfter');
  });

  it('picks purposes for mood, routine and the structural steps', () => {
    expect(buildIntent(decision('moodCheck'), input({ affect: { low: true, stage: 'comfort' } }))!.purpose).toBe('moodCheckNow');
    expect(buildIntent(decision('moodCheck'), input())!.purpose).toBe('moodCheckEarlier');
    expect(buildIntent(decision('routine'), input())!.purpose).toBe('routineMorning');
    expect(buildIntent(decision('routine'), input({ now: Date.parse('2026-11-03T15:00:00+08:00') }))).toBeNull();
    const checkin = buildIntent(decision('presenceCheck'), input({ moment: 'silenceCheckin' }))!;
    expect(checkin.intent.constraints).toEqual({ maxChars: cfg.maxChars, allowQuestion: false, mustExpress: 'presence' });
    expect(buildIntent(decision('restQuiet'), input({ moment: 'silenceRest' }))!.intent.constraints.allowQuestion).toBe(false);
  });

  it('uses the open loop, topic and family line as locked material, and needs them', () => {
    expect(buildIntent(decision('continueThread'), input({ material: { openLoop: '我那盆君子兰今年还没开花' } }))!.intent.material.quotes)
      .toEqual([{ text: '我那盆君子兰今年还没开花', said: '刚才' }]);
    expect(buildIntent(decision('continueThread'), input())).toBeNull();
    const health = buildIntent(decision('continueThread'), input({ material: { openLoop: '最近膝盖疼得睡不着', openLoopSensitive: true } }))!;
    expect(health.fallbackOnly).toBe(true);
    expect(health.intent.material.quotes).toEqual([]);
    expect(buildIntent(decision('interestTopic'), input({ material: { topic: '年轻时爱听的一首老歌' } }))!.intent.material.facts).toEqual(['年轻时爱听的一首老歌']);
    expect(buildIntent(decision('humanConnection'), input({ material: { family: '闺女在深圳工作，一年也就回来一两趟。' } }))!.intent.material.quotes)
      .toEqual([{ text: '闺女在深圳工作，一年也就回来一两趟。', said: '之前' }]);
    expect(buildIntent(decision('humanConnection'), input())).toBeNull();
  });

  it('returns null for quiet and the plain greeting, and when the thread does not match the decision', () => {
    expect(buildIntent(decision('quiet'), input())).toBeNull();
    expect(buildIntent(decision('greetingPlain'), input({ moment: 'sessionStart' }))).toBeNull();
    expect(buildIntent(decision('threadFollowup', 'other'), input({ material: { thread: thread() } }))).toBeNull();
  });

  it('sets tone from familiarity and the care stage', () => {
    const low = buildIntent(decision('moodCheck'), input({ familiarity: 'oldFriend', affect: { low: true, stage: 'comfort' } }))!;
    expect(low.intent.tone).toEqual({ familiarity: 'oldFriend', stage: 'comfort', allowJoke: false });
    const fine = buildIntent(decision('selfShare'), input({ familiarity: 'oldFriend' }))!;
    expect(fine.intent.tone).toEqual({ familiarity: 'oldFriend', stage: null, allowJoke: true });
  });
});

describe('renderIntent', () => {
  it('renders plan A: frame, locked quote, tone', () => {
    const t = thread();
    const planned = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: t } }))!;
    const request = renderIntent(planned, copy, zh.fallbacks!.threadFollowup[0]!);
    expect(request.cue).toBe('followup');
    expect(request.fallbackText).toBe(zh.fallbacks!.threadFollowup[0]);
    expect(request.instruction.split('\n')).toEqual([
      `现在由你主动开口，说一两句口语，不超过${cfg.maxChars}个字。目的：${copy.purposes.threadConcern}。`,
      `能用的事实只有下面【】里老人三天前说过的话；不要补充人名、地名、作品名、日期、数字或其他细节。`,
      `【${t.quote}】`,
      copy.tones.familiar,
    ]);
  });

  it('renders a sensitive thread as a line to read, with no quote anywhere', () => {
    const t = thread({ sensitive: true, quote: '我有高血压，这几天量着有点高。' });
    const planned = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: t } }))!;
    const line = zh.fallbacks!.threadSensitive[2]!;
    const request = renderIntent(planned, copy, line);
    expect(request).toEqual(speakLineRequest(copy, line));
    expect(request.instruction).toContain(line);
    expect(request.instruction).not.toContain('高血压');
  });

  it('renders topics with withTopic, no material with withoutMaterial, and bans questions where needed', () => {
    const topic = renderIntent(buildIntent(decision('interestTopic'), input({ material: { topic: '今天吃了什么好吃的' } }))!, copy, 'x');
    expect(topic.instruction).toContain('能用的话题只有下面【】里的内容');
    expect(topic.instruction).toContain('【今天吃了什么好吃的】');
    const checkin = renderIntent(buildIntent(decision('presenceCheck'), input({ moment: 'silenceCheckin' }))!, copy, 'x');
    expect(checkin.instruction).toContain(copy.withoutMaterial);
    expect(checkin.instruction.endsWith(copy.noQuestion)).toBe(true);
    const low = renderIntent(buildIntent(decision('moodCheck'), input({ familiarity: 'oldFriend', affect: { low: true, stage: 'explore' } }))!, copy, 'x');
    expect(low.instruction).toContain(copy.tones.familiar);
    expect(low.instruction).not.toContain(copy.tones.oldFriend);
    expect(low.instruction).toContain(copy.tones.explore);
  });

  it('does not expand $ patterns from user words', () => {
    const planned = buildIntent(decision('continueThread'), input({ material: { openLoop: '花了 $& 块钱' } }))!;
    expect(renderIntent(planned, copy, 'x').instruction).toContain('【花了 $& 块钱】');
  });
});

describe('pickFallback', () => {
  it('rotates through unused lines and never repeats a recent one', () => {
    expect(pickFallback(5, [])).toBe(0);
    expect(pickFallback(5, [0])).toBe(1);
    expect(pickFallback(5, [2, 1, 0])).toBe(3);
    expect(pickFallback(5, [3, 2, 1])).toBe(0);
    // An admin shortened the group: stale indexes are ignored.
    expect(pickFallback(5, [7, 6])).toBe(0);
    // Every line recent: the oldest recent one.
    expect(pickFallback(3, [1, 2, 0])).toBe(0);
  });
});

describe('checkSpoken', () => {
  const rules = { healthWords: i18n.memory.zh.healthWords, silence: i18n.silence.zh };

  it('counts health words that are not in the material (probe: 按时吃药)', () => {
    const c = checkSpoken('陈叔，血压高了别着急，记得按时吃药。', { material: ['我有高血压，这几天量着有点高。', '昨天'], allowQuestion: true, mustExpress: null }, rules);
    expect(c.health).toBeGreaterThanOrEqual(1);
    expect(violationsOf(c)).toContainEqual({ kind: 'health', count: c.health });
    const clean = checkSpoken('陈叔，这几天血压还高吗？', { material: ['我有高血压，这几天量着有点高。'], allowQuestion: true, mustExpress: null }, rules);
    expect(clean.health).toBe(0);
  });

  it('counts titles and numbers outside the material, questions and missing presence', () => {
    const c = checkSpoken('要不听听《茉莉花》？三点钟我再来。', { material: [], allowQuestion: false, mustExpress: 'presence' }, rules);
    expect(c.titles).toBe(1);
    expect(c.numbers).toBe(1);
    expect(c.question).toBe(true);
    expect(c.presenceMissing).toBe(true);
    expect(violationsOf(c).map((v) => v.kind).sort()).toEqual(['number', 'presence', 'question', 'title']);
    const ok = checkSpoken('我一直都在，您还在听吗？想聊随时说。', { material: ['我一直都在，您还在听吗？想聊随时说。'], allowQuestion: true, mustExpress: 'presence' }, rules);
    expect(violationsOf(ok)).toEqual([]);
  });
});
```

- [x] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/proactive-render.test.ts`
Expected: FAIL——四个模块不存在。

- [x] **Step 3：`assemble.ts`**

```ts
// Builds a ProactiveIntent from an engine decision (spec 意图契约). Pure: inputs in, intent out.
import type { Language } from '@anyidea/protocol';
import type { ThreadRecord } from '../../memory/store.ts';
import type { FallbackKey, IntentCopy, IntentPurpose } from '../../roles/types.ts';
import type { AffectCard } from '../affect.ts';
import type { ProactivityConfig } from './config.ts';
import { beijingHour, type CareStage, type Decision, type Familiarity, type Moment } from './engine.ts';
import type { ProactiveIntent } from './intent.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Material the session found for this moment; buildIntent uses only what the decision needs. */
export interface IntentMaterial {
  thread?: ThreadRecord;
  /** The user's own unfinished line in this session (already evidence-checked). */
  openLoop?: string;
  /** The open loop has a health word: read the fallback line instead (same rule as health threads). */
  openLoopSensitive?: boolean;
  /** Topic card prompt; not the user's words. */
  topic?: string;
  /** A remembered user line that names family. */
  family?: string;
}

export interface PlannedIntent {
  intent: ProactiveIntent;
  purpose: IntentPurpose;
  /** Health thread (2026-10-29): speak the fallback line, never render the quote. */
  fallbackOnly: boolean;
}

export interface BuildInput {
  moment: Moment;
  now: number;
  language: Language;
  familiarity: Familiarity;
  affect: { low: boolean; stage: CareStage };
  material: IntentMaterial;
  cfg: ProactivityConfig;
  saidWords: IntentCopy['saidWhen'];
}

export function beijingDay(at: number): string {
  return new Date(at + 8 * HOUR).toISOString().slice(0, 10);
}

/** ESConv stage from the latest card only (spec 情绪轨迹 › 应对阶段). */
export function careStage(card: AffectCard | null): CareStage {
  if (!card) return 'explore';
  if (card.need === 'help' || card.strategy === 'suggest') return 'suggest';
  if (card.strategy === 'comfort' || card.strategy === 'affirm' || card.strategy === 'reflect') return 'comfort';
  return 'explore';
}

/** How long ago, in Beijing calendar days, in the role's words. */
export function saidWhen(at: number, now: number, words: IntentCopy['saidWhen']): string {
  const days = Math.round((Date.parse(beijingDay(now)) - Date.parse(beijingDay(at))) / DAY);
  if (days <= 0) return words.today;
  if (days === 1) return words.yesterday;
  if (days <= 6) return words.days[days - 2] ?? words.earlier;
  if (days <= 13) return words.lastWeek;
  return words.earlier;
}

const ROUTINE_PURPOSE = { morning: 'routineMorning', noon: 'routineNoon', evening: 'routineEvening', night: 'routineNight' } as const;

function routinePurpose(now: number, cfg: ProactivityConfig): IntentPurpose | null {
  const hour = beijingHour(now);
  for (const slot of ['morning', 'noon', 'evening', 'night'] as const) {
    const w = cfg.routine[slot];
    if (hour >= w.start && hour < w.end) return ROUTINE_PURPOSE[slot];
  }
  return null;
}

function threadPurpose(thread: ThreadRecord, now: number): IntentPurpose {
  if (thread.kind === 'event') return now < thread.dueAt ? 'threadEventBefore' : 'threadEventAfter';
  return thread.kind === 'concern' ? 'threadConcern' : 'threadPlan';
}

type Shape = { purpose: IntentPurpose; fallbackKey: FallbackKey; quotes: Array<{ text: string; said: string | null }>; facts: string[]; fallbackOnly?: boolean };

function shapeFor(decision: Decision, input: BuildInput): Shape | null {
  const m = input.material;
  const words = input.saidWords;
  switch (decision.kind) {
    case 'threadFollowup': {
      const t = m.thread;
      if (!t || t.id !== decision.threadId) return null;
      const purpose = threadPurpose(t, input.now);
      // Health quotes stay out of every instruction; the sensitive group is read instead.
      if (t.sensitive) return { purpose, fallbackKey: 'threadSensitive', quotes: [], facts: [], fallbackOnly: true };
      return { purpose, fallbackKey: 'threadFollowup', quotes: [{ text: t.quote, said: saidWhen(t.createdAt, input.now, words) }], facts: [] };
    }
    case 'moodCheck':
      return { purpose: input.affect.low ? 'moodCheckNow' : 'moodCheckEarlier', fallbackKey: 'moodCheck', quotes: [], facts: [] };
    case 'routine': {
      const purpose = routinePurpose(input.now, input.cfg);
      return purpose ? { purpose, fallbackKey: 'routine', quotes: [], facts: [] } : null;
    }
    case 'continueThread':
      if (!m.openLoop) return null;
      if (m.openLoopSensitive) return { purpose: 'continueThread', fallbackKey: 'continueThread', quotes: [], facts: [], fallbackOnly: true };
      return { purpose: 'continueThread', fallbackKey: 'continueThread', quotes: [{ text: m.openLoop, said: words.justNow }], facts: [] };
    case 'interestTopic':
      return m.topic ? { purpose: 'interestTopic', fallbackKey: 'interestTopic', quotes: [], facts: [m.topic] } : null;
    case 'humanConnection':
      return m.family ? { purpose: 'humanConnection', fallbackKey: 'humanConnection', quotes: [{ text: m.family, said: words.earlier }], facts: [] } : null;
    case 'selfShare':
      return { purpose: 'selfShare', fallbackKey: 'selfShare', quotes: [], facts: [] };
    case 'presenceCheck':
      return { purpose: 'presenceCheck', fallbackKey: 'presenceCheck', quotes: [], facts: [] };
    case 'restQuiet':
      return { purpose: 'restQuiet', fallbackKey: 'restQuiet', quotes: [], facts: [] };
    case 'quiet':
    case 'greetingPlain':
      return null;
  }
}

/** Null = do not speak (quiet, the opening, or the material the decision needs is missing). */
export function buildIntent(decision: Decision, input: BuildInput): PlannedIntent | null {
  const shape = shapeFor(decision, input);
  if (!shape) return null;
  const structural = decision.kind === 'presenceCheck' || decision.kind === 'restQuiet';
  const intent: ProactiveIntent = {
    moment: input.moment,
    kind: decision.kind,
    material: { quotes: shape.quotes, facts: shape.facts },
    tone: {
      familiarity: input.familiarity,
      stage: input.affect.low ? input.affect.stage : null,
      allowJoke: input.familiarity === 'oldFriend' && !input.affect.low,
    },
    constraints: { maxChars: input.cfg.maxChars, allowQuestion: !structural, mustExpress: decision.kind === 'presenceCheck' ? 'presence' : null },
    language: input.language,
    fallbackKey: shape.fallbackKey,
  };
  return { intent, purpose: shape.purpose, fallbackOnly: shape.fallbackOnly ?? false };
}
```

- [x] **Step 4：`render.ts`**

```ts
// Qwen rendering of a planned intent (spec 意图渲染, plan A from the P3-T0 probe).
import type { ProactiveRequest } from '../../adapters/types.ts';
import type { IntentCopy } from '../../roles/types.ts';
import type { PlannedIntent } from './assemble.ts';

/** Function replacers: user words may contain `$&` and must land verbatim. */
const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((text, [token, value]) => text.replaceAll(token, () => value), template);

/** A configured line read as-is: fallbacks and the health group. */
export function speakLineRequest(copy: IntentCopy, line: string): ProactiveRequest {
  return { cue: 'followup', instruction: fill(copy.speakLine, { '{line}': line }), fallbackText: line };
}

export function renderIntent(planned: PlannedIntent, copy: IntentCopy, fallbackLine: string): ProactiveRequest {
  if (planned.fallbackOnly) return speakLineRequest(copy, fallbackLine);
  const { intent } = planned;
  const lines = [fill(copy.frame, { '{maxChars}': String(intent.constraints.maxChars), '{purpose}': copy.purposes[planned.purpose] })];
  const quote = intent.material.quotes[0];
  const fact = intent.material.facts[0];
  if (quote) lines.push(fill(copy.withQuote, { '{said}': quote.said ?? copy.saidWhen.earlier, '{material}': quote.text }));
  else if (fact) lines.push(fill(copy.withTopic, { '{material}': fact }));
  else lines.push(copy.withoutMaterial);
  // An old friend who is low gets the familiar tone: no jokes while comforting.
  const familiarity = intent.tone.familiarity === 'oldFriend' && !intent.tone.allowJoke ? 'familiar' : intent.tone.familiarity;
  lines.push(copy.tones[familiarity]);
  if (intent.tone.stage) lines.push(copy.tones[intent.tone.stage]);
  if (!intent.constraints.allowQuestion) lines.push(copy.noQuestion);
  return { cue: 'followup', instruction: lines.join('\n'), fallbackText: fallbackLine };
}
```

注意 `fill` 先替换 `{said}` 再替换 `{material}`（对象键的插入顺序），用户原话里即使含 `{said}` 也不会被二次替换——因为 `{material}` 的值在最后才放进去。

- [x] **Step 5：`fallback.ts`**

```ts
/** First line not used recently; if all were, the oldest recent one. `recent` is newest first. */
export function pickFallback(count: number, recent: readonly number[]): number {
  const valid = recent.filter((i) => Number.isInteger(i) && i >= 0 && i < count);
  for (let i = 0; i < count; i++) if (!valid.includes(i)) return i;
  return valid[valid.length - 1] ?? 0;
}
```

- [x] **Step 6：`check.ts`**

```ts
// Post-hoc check of a spoken proactive line (spec 事后核对). Counts only; never blocks or re-speaks.
import { containsPhrase } from '../../i18n/text.ts';
import type { SilenceRules } from '../../i18n/types.ts';
import { findUngrounded } from './grounding.ts';

export interface CheckSpec { material: readonly string[]; allowQuestion: boolean; mustExpress: 'presence' | null }
export interface CheckRules { healthWords: readonly string[]; silence: Pick<SilenceRules, 'listening' | 'anytime'> }
export interface SpokenCheck { titles: number; numbers: number; health: number; question: boolean; presenceMissing: boolean }
export type ViolationKind = 'title' | 'number' | 'health' | 'question' | 'presence';

const QUESTION = /[？?]/;

export function checkSpoken(text: string, spec: CheckSpec, rules: CheckRules): SpokenCheck {
  const { titles, numbers } = findUngrounded(text, spec.material);
  const source = spec.material.join('\n');
  const health = rules.healthWords.filter((word) => containsPhrase(text, word) && !containsPhrase(source, word)).length;
  const has = (words: readonly string[]) => words.some((word) => containsPhrase(text, word));
  return {
    titles: titles.length,
    numbers: numbers.length,
    health,
    question: !spec.allowQuestion && QUESTION.test(text),
    presenceMissing: spec.mustExpress === 'presence' && !(has(rules.silence.listening) && has(rules.silence.anytime)),
  };
}

/** One entry per violated rule, for content-free logging. */
export function violationsOf(check: SpokenCheck): Array<{ kind: ViolationKind; count: number }> {
  const out: Array<{ kind: ViolationKind; count: number }> = [];
  if (check.titles > 0) out.push({ kind: 'title', count: check.titles });
  if (check.numbers > 0) out.push({ kind: 'number', count: check.numbers });
  if (check.health > 0) out.push({ kind: 'health', count: check.health });
  if (check.question) out.push({ kind: 'question', count: 1 });
  if (check.presenceMissing) out.push({ kind: 'presence', count: 1 });
  return out;
}
```

总览契约里写的是 `checkSpoken`；`violationsOf` 是本任务补充的导出（P3-T5 用），记入任务报告。

- [x] **Step 7：运行测试**

Run: `npm test -w gateway -- test/proactive-render.test.ts && npm run typecheck -w gateway`
Expected: PASS。若「按时吃药」那条 `health` 为 0，先确认 `healthWords` 仍含「吃药」或「药」；不要放宽断言。

- [x] **Step 8：全量与提交**

Run: `npm test -w gateway`
Expected: PASS（没有接入会话，行为不变）。

```bash
git add gateway/src/session/proactive/assemble.ts gateway/src/session/proactive/render.ts gateway/src/session/proactive/fallback.ts gateway/src/session/proactive/check.ts gateway/test/proactive-render.test.ts
git commit -m "feat(proactive): assemble, render, pick fallbacks and check spoken lines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
