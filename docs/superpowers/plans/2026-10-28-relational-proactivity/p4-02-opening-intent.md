# P4-T2：开场意图（组装、渲染、兜底句、运行时）

**Spec：** 「开场」（Q15：已知称呼时决策引擎在 `session_start` 选 `thread_followup` / `mood_check` / `routine` / `greeting_plain` 之一交给 Qwen 说，材料只有称呼加上被选中的那一项；连接期间预取；超时或出错用兜底）、「意图渲染与生成」、开放项 1 与 3（健康类照读兜底句）。

本任务只加纯函数与运行时方法，不接入会话（P4-T3 接入）。

**开场规则：**

| 情况 | 结果 |
|---|---|
| 首次见面、不知道称呼、当前语言没有 `intents`/`fallbacks`/`greetingNameTexts`/`greetingCareTexts` | `openingLine` 返回 `null`（P4-T3 里走称呼模板或配置开场） |
| 引擎选 `greetingPlain` | Qwen 按开场指令说（称呼 + 目的「简单问候，问今天想聊什么」）；兜底句是 `greetingNameTexts` 里的一句（填好称呼） |
| 引擎选 `threadFollowup`（非敏感）/ `moodCheck` / `routine` | Qwen 按开场指令说（称呼 + 目的 + 材料）；兜底句 = `greetingCareTexts` 开头（填好称呼）接该意图组的兜底句 |
| 引擎选敏感事项 | 不进指令，照读「开头 + `threadSensitive` 兜底句」 |
| 同一语言再次调用（开场被打断后重说） | 返回**同一个**请求对象，不重新决策 |
| 请求的 `cue` | 固定为 `greeting`（Mock 脚本与回复类型按它区分）；超时兜底的照读请求也保留 `greeting` |

开场意图是打分类时（事项、情绪、作息）照常计入本会话与今天的次数、事项提及、接受判定；`greetingPlain` 不计。

**Files:**
- Modify: `gateway/src/roles/types.ts`（`INTENT_PURPOSES` 加 `greetingPlain`，`IntentCopy.opening`）
- Modify: `gateway/src/config.ts`（`intents.opening` 校验）
- Modify: `gateway/roles/elder-companion/zh/director.json`（`intents.opening`、`intents.purposes.greetingPlain`）
- Modify: `gateway/src/session/proactive/assemble.ts`（`greetingPlain`）
- Modify: `gateway/src/session/proactive/render.ts`（`opts.name`、`composeOpening`）
- Modify: `gateway/src/session/proactive/runtime.ts`（`ProactiveCopy` 两项、`prefetch`、`familiarityTier`、`openingLine`；`InFlight.line.key` 改为 `string`）
- Test: `gateway/test/proactive-opening.test.ts`（新建）；`gateway/test/proactive-render.test.ts`、`gateway/test/intent-copy.test.ts`（各改一处）

**Interfaces:**
- Consumes: P3 后半全部契约。
- Produces（冻结，见总览 P4 契约）：`IntentCopy.opening`、`renderIntent(..., opts?)`、`composeOpening`、`ProactiveCopy.greetingNameTexts/greetingHeads`、`ProactiveRuntime.prefetch/familiarityTier/openingLine`。

- [x] **Step 1：写失败测试**

创建 `gateway/test/proactive-opening.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadDirectorConfig } from '../src/config.ts';
import { loadI18n } from '../src/i18n/load.ts';
import type { Logger } from '../src/log/logger.ts';
import type { MemoryStore, MoodSummaryRecord, ThreadRecord } from '../src/memory/store.ts';
import { loadProactivity } from '../src/session/proactive/config.ts';
import { composeOpening, speakLineRequest } from '../src/session/proactive/render.ts';
import { ProactiveRuntime } from '../src/session/proactive/runtime.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cfg = loadProactivity(`${root}config/proactivity.json`);
const zh = loadDirectorConfig(`${root}roles/elder-companion/zh/director.json`);
const i18n = loadI18n(`${root}config`);
const HOUR = 3_600_000;
const MORNING = Date.parse('2026-11-03T08:30:00+08:00');
const AFTERNOON = Date.parse('2026-11-03T15:00:00+08:00');
const stats = (sessions: number, activeDays: number) => ({ firstMetAt: 1, sessions, totalMinutes: 0, activeDays, lastSessionAt: 1, hourHistogram: Array(24).fill(0) });

function setup(at: number, over: Record<string, unknown> = {}, copyOver: Record<string, unknown> = {}) {
  const store = {
    getProactiveTier: vi.fn((): string | undefined => undefined),
    setProactiveTier: vi.fn(), proactiveStats: vi.fn(() => []), recordProactiveOutcome: vi.fn(),
    proactiveDaily: vi.fn(() => 0), incrementProactiveDaily: vi.fn(() => 1),
    listOpenThreads: vi.fn(() => [] as ThreadRecord[]), markThreadMentioned: vi.fn(() => true), closeThread: vi.fn(() => true),
    listMoodSummaries: vi.fn(() => [] as MoodSummaryRecord[]), relationshipStats: vi.fn(() => stats(0, 0)),
    recentUserMessages: vi.fn(() => []), recentFallbackLines: vi.fn(() => [] as number[]), recordFallbackLine: vi.fn(),
    ...over,
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  const runtime = new ProactiveRuntime({
    cfg, sessionId: 's-now', store: store as unknown as MemoryStore, ownerId: 'o1', agentId: 'a1',
    now: () => at, canPersist: () => true,
    copy: () => ({
      intents: zh.intents, fallbacks: zh.fallbacks, topics: [], quietPhrases: zh.quietPhrases,
      greetingNameTexts: zh.greetingNameTexts, greetingHeads: zh.greetingCareTexts, ...copyOver,
    }),
    rules: () => ({ silence: i18n.silence.zh, healthWords: i18n.memory.zh.healthWords, declinePhrases: i18n.affect.zh.declinePhrases, evidence: i18n.evidence }),
    logger: logger as unknown as Logger,
  });
  return { runtime, store, logger };
}
const open = { language: 'zh' as const, name: '王叔', firstMeet: false };
const event = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: 't1', kind: 'event', quote: '我后天上午要去公园参加合唱团演出。', dueAt: MORNING - 5 * HOUR, sensitive: false, mentionCount: 0,
  lastMentionedAt: null, createdAt: MORNING - 2 * 86_400_000, sourceSessionId: 's-old', ...over,
});

describe('openingLine', () => {
  it('does nothing on a first meeting, without a name, or without opening copy', () => {
    expect(setup(AFTERNOON).runtime.openingLine({ ...open, firstMeet: true })).toBeNull();
    expect(setup(AFTERNOON).runtime.openingLine({ ...open, name: null })).toBeNull();
    expect(setup(AFTERNOON, {}, { greetingHeads: undefined }).runtime.openingLine(open)).toBeNull();
    expect(setup(AFTERNOON, {}, { intents: undefined, fallbacks: undefined }).runtime.openingLine(open)).toBeNull();
  });

  it('greets plainly with the name when nothing clears the threshold', () => {
    const { runtime, store } = setup(AFTERNOON);
    const request = runtime.openingLine(open)!;
    expect(request.cue).toBe('greeting');
    expect(request.instruction.split('\n')[0]).toBe(
      zh.intents!.opening.replaceAll('{maxChars}', String(cfg.maxChars)).replaceAll('{name}', '王叔').replaceAll('{purpose}', zh.intents!.purposes.greetingPlain),
    );
    expect(request.fallbackText).toBe(zh.greetingNameTexts![0]!.replaceAll('{name}', '王叔'));
    runtime.onLineStarted(request);
    expect(store.incrementProactiveDaily).not.toHaveBeenCalled();
  });

  it('repeats the same request after a cut-off and decides once', () => {
    const { runtime, logger } = setup(AFTERNOON);
    const first = runtime.openingLine(open);
    expect(runtime.openingLine(open)).toBe(first);
    expect(logger.info.mock.calls.filter((c) => c[0] === 'proactive_decision')).toHaveLength(1);
  });

  it('opens with a due event, locked to its quote, and counts it', () => {
    const { runtime, store } = setup(MORNING, { listOpenThreads: vi.fn(() => [event()]) });
    const request = runtime.openingLine(open)!;
    expect(request.instruction).toContain('【我后天上午要去公园参加合唱团演出。】');
    expect(request.instruction).toContain(zh.intents!.purposes.threadEventAfter);
    expect(request.fallbackText).toBe(composeOpening(zh.greetingCareTexts![0]!, '王叔', zh.fallbacks!.threadFollowup[0]!));
    runtime.onLineStarted(request);
    expect(store.markThreadMentioned).toHaveBeenCalledWith('o1', 't1', MORNING);
    expect(store.incrementProactiveDaily).toHaveBeenCalledTimes(1);
  });

  it('reads a composed line for a health event; the quote goes nowhere', () => {
    const quote = '我后天上午去医院复查腰。';
    const { runtime } = setup(MORNING, { listOpenThreads: vi.fn(() => [event({ sensitive: true, quote })]) });
    const request = runtime.openingLine(open)!;
    const line = composeOpening(zh.greetingCareTexts![0]!, '王叔', zh.fallbacks!.threadSensitive[0]!);
    expect(request).toEqual({ ...speakLineRequest(zh.intents!, line), cue: 'greeting' });
    expect(request.instruction).not.toContain('复查');
  });

  it('checks on a low last session ahead of the morning greeting', () => {
    const mood: MoodSummaryRecord = { id: 'm1', sessionId: 's-old', dominant: 'sad', peakIntensity: 2, endEmotion: 'sad', endIntensity: 2, endTrend: 'flat', crisis: false, createdAt: MORNING - 10 * HOUR };
    const request = setup(MORNING, { listMoodSummaries: vi.fn(() => [mood]) }).runtime.openingLine(open)!;
    expect(request.instruction).toContain(zh.intents!.purposes.moodCheckEarlier);
  });

  it('reads familiarity from ended sessions', () => {
    expect(setup(AFTERNOON, { relationshipStats: vi.fn(() => stats(3, 2)) }).runtime.familiarityTier()).toBe('familiar');
    expect(setup(AFTERNOON).runtime.familiarityTier()).toBe('new');
  });
});

describe('composeOpening', () => {
  it('joins a CJK head directly and a Latin head with a space', () => {
    expect(composeOpening('{name}，又见面啦。', '王叔', '今天过得怎么样？')).toBe('王叔，又见面啦。今天过得怎么样？');
    expect(composeOpening('Hello, {name}.', 'Ann', 'How was your day?')).toBe('Hello, Ann. How was your day?');
  });
});
```

在 `gateway/test/proactive-render.test.ts` 里，把 `returns null for quiet and the plain greeting…` 用例中 `greetingPlain` 那一行改为：

```ts
    expect(buildIntent(decision('greetingPlain'), input({ moment: 'sessionStart' }))!.purpose).toBe('greetingPlain');
```

并把用例名改为 `returns null for quiet and when the thread does not match the decision`。

在 `gateway/test/intent-copy.test.ts` 的 `has every purpose and the plan-A fragments` 用例末尾加：

```ts
    expect(zh.intents!.opening).toContain('{name}');
```

- [x] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/proactive-opening.test.ts test/proactive-render.test.ts test/intent-copy.test.ts`
Expected: FAIL——`openingLine`、`composeOpening`、`opening` 不存在，`greetingPlain` 返回 `null`。

- [x] **Step 3：类型、schema、文案**

`gateway/src/roles/types.ts`：`INTENT_PURPOSES` 末尾加 `'greetingPlain'`；`IntentCopy` 在 `frame` 之后加：

```ts
  /** Opening frame (P4): {maxChars} {name} {purpose}. Says the name once, then the purpose. */
  opening: string;
```

`gateway/src/config.ts` 的 `intents` 对象在 `frame` 之后加：

```ts
    opening: z.string().includes('{maxChars}').includes('{name}').includes('{purpose}'),
```

`gateway/roles/elder-companion/zh/director.json` 的 `intents` 里，`frame` 之后加：

```json
    "opening": "这是这次通话的开场，由你先开口，说一两句口语，不超过{maxChars}个字。先叫一声「{name}」打个招呼，只叫这一次。目的：{purpose}。",
```

`intents.purposes` 末尾加：

```json
      "greetingPlain": "又见面了，简单问候一下，问问今天想聊点什么"
```

- [x] **Step 4：`assemble.ts`**

`Shape` 的 `fallbackKey` 类型改为 `FallbackKey | 'greetingPlain'`。`shapeFor` 的 switch 里把

```ts
    case 'quiet':
    case 'greetingPlain':
      return null;
```

改为

```ts
    case 'greetingPlain':
      // The opening's fallback is composed from greetingNameTexts by the runtime.
      return { purpose: 'greetingPlain', fallbackKey: 'greetingPlain', quotes: [], facts: [] };
    case 'quiet':
      return null;
```

`buildIntent` 的注释改为 `/** Null = do not speak (quiet, or the material the decision needs is missing). */`。`greetingPlain` 不是结构性意图：`allowQuestion` 为真（开场要问一句）。

- [x] **Step 5：`render.ts`**

`renderIntent` 签名改为 `renderIntent(planned: PlannedIntent, copy: IntentCopy, fallbackLine: string, opts: { name?: string } = {}): ProactiveRequest`，第一行改为：

```ts
  const head = opts.name && intent.moment === 'sessionStart'
    ? fill(copy.opening, { '{maxChars}': String(intent.constraints.maxChars), '{name}': opts.name, '{purpose}': copy.purposes[planned.purpose] })
    : fill(copy.frame, { '{maxChars}': String(intent.constraints.maxChars), '{purpose}': copy.purposes[planned.purpose] });
  const lines = [head];
```

（`const { intent } = planned;` 要放在这几行之前。）文件末尾加：

```ts
/** Opening head with the name filled in, then a fallback line. Latin text needs a space between sentences. */
export function composeOpening(head: string, name: string, line: string): string {
  const filled = head.replaceAll('{name}', () => name).trim();
  return /[!-~]$/.test(filled) ? `${filled} ${line}` : `${filled}${line}`;
}
```

（与即将在 P4-T3 删除的 `care.ts` 里 `composeCareGreeting` 的拼法相同。）

- [x] **Step 6：`runtime.ts`**

1. `ProactiveCopy` 加：

```ts
  /** Name templates for a plain opening's fallback ({name}). */
  greetingNameTexts?: readonly string[];
  /** Opening heads ({name}) placed before a kind's fallback line. */
  greetingHeads?: readonly string[];
```

2. 常量：`const NAME_KEY = 'greetingName';`；`InFlight.line` 的类型改为 `{ key: string; index: number; text: string }`，`silenceLine` 里 `line: { key, index, text }` 不变。

3. 字段：`private opening: { language: Language; request: ProactiveRequest } | null = null;`

4. 方法（放在 `silenceLine` 之前）：

```ts
  /** Spec 连接期间预取: read the decision context before the opening is needed. */
  prefetch(): void {
    this.ensureLoaded();
  }

  familiarityTier(): Familiarity {
    this.ensureLoaded();
    return this.familiarity;
  }

  /** Known-name opening (spec 开场, Q15). The same request is returned for a retry in the same language. */
  openingLine(input: { language: Language; name: string | null; firstMeet: boolean }): ProactiveRequest | null {
    if (input.firstMeet || !input.name) return null;
    const copy = this.deps.copy(input.language);
    const names = copy.greetingNameTexts ?? [];
    const heads = copy.greetingHeads ?? [];
    if (!copy.intents || !copy.fallbacks || names.length === 0 || heads.length === 0) return null;
    if (this.opening?.language === input.language) return this.opening.request;
    this.ensureLoaded();
    const now = this.deps.now();
    const name = input.name;
    const ctx = this.context('sessionStart', { low: false, crisis: false, stage: 'explore' }, { openLoop: false, interest: false, family: false }, this.threads);
    const { decision, decideMs } = this.timedDecide(ctx);
    const planned = buildIntent(decision, {
      moment: 'sessionStart', now, language: input.language, familiarity: this.familiarity, affect: { low: false, stage: 'explore' },
      material: { thread: this.threads.find((t) => t.id === decision.threadId) }, cfg: this.deps.cfg, saidWords: copy.intents.saidWhen,
    });
    this.logDecision('sessionStart', decision, planned, decideMs);
    if (!planned) return null;
    let line: InFlight['line'];
    if (planned.intent.kind === 'greetingPlain') {
      const index = pickFallback(names.length, this.recentFor(NAME_KEY, names.length));
      line = { key: NAME_KEY, index, text: names[index]!.replaceAll('{name}', () => name) };
    } else {
      const key = planned.intent.fallbackKey as FallbackKey;
      const lines = copy.fallbacks[key];
      const index = pickFallback(lines.length, this.recentFor(key, this.deps.cfg.fallbackKeep));
      const head = heads[pickFallback(heads.length, [])]!;
      line = { key, index, text: composeOpening(head, name, lines[index]!) };
    }
    // The opening keeps the greeting cue: Mock scripts and response kinds key on it.
    const request: ProactiveRequest = { ...renderIntent(planned, copy.intents, line.text, { name }), cue: 'greeting' };
    this.inFlight = {
      request, planned, language: input.language, line, topicIndex: null, spokeFallback: planned.fallbackOnly,
      ...(decision.threadId ? { threadId: decision.threadId } : {}),
    };
    this.opening = { language: input.language, request };
    return request;
  }
```

`fallbackFor` 里换成照读请求时保留原来的 `cue`，开场的兜底仍是 `greeting`：

```ts
    f.request = { ...speakLineRequest(intents, f.line.text), cue: f.request.cue };
```

import 补上 `composeOpening`（`./render.ts`）。`onLineStarted` 不用改：`greetingPlain` 不是打分类，不计数；打分类开场照常计数、提及、开接受窗口。重试时同一请求已经开始过，`inFlight` 为空，`owns` 为假，不会重复计数。

- [x] **Step 7：运行测试**

Run: `npm test -w gateway -- test/proactive-opening.test.ts test/proactive-render.test.ts test/proactive-runtime.test.ts test/intent-copy.test.ts && npm run typecheck -w gateway`
Expected: PASS。分数来历：上午 8:30、事件已过 5 小时、非敏感：事项 (15×50 + 40×100 + 30×50 + 15×100)/10000 = 0.775，作息 0.74，事项胜出；上次低落 `moodCheck` 0.9（P3-T2 用例）。

- [x] **Step 8：全量与提交**

Run: `npm test -w gateway`
Expected: PASS（开场还没接入会话）。

```bash
git add gateway/src/roles/types.ts gateway/src/config.ts gateway/roles/elder-companion/zh/director.json \
  gateway/src/session/proactive/assemble.ts gateway/src/session/proactive/render.ts gateway/src/session/proactive/runtime.ts \
  gateway/test/proactive-opening.test.ts gateway/test/proactive-render.test.ts gateway/test/intent-copy.test.ts
git commit -m "feat(proactive): known-name opening intent with composed fallback lines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
