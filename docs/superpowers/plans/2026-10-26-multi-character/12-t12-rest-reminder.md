# Task 12: 连续使用满 60 分钟的休息提醒

**目标：** 网关按整台手机计算连续使用时间（会话间隔小于 10 分钟算连续，切换角色不清零），每到 `firstAfterMs`、之后每 `everyMs` 提醒一次。提醒只在空档播出：不在回复中、用户没在说话、不在工具轮里。到点时如果沉默链正在等某一段，提醒就占用这一段的位置播出；播完后沉默链从 context 段重新计时，提醒算作 assistantText，不计入沉默链的 previousTexts 去重。提醒走唯一的主动发声出口 `requestResponse('reminder', {cue:'restReminder', instruction, fallbackText})`，App 收到 `response.start{kind:'reminder'}` 后弹 toast（Task 16）。

**实现的 spec 章节：** 「AI 提示与休息提醒」（网关部分）；技术设计 §5（连续使用计时）、§8 第 5 条；§10（`pacing.json restReminder`、`restReminderText`、交叉校验）；「错误处理」（提醒和工具轮或打断冲突：推迟，不取消，不叠播）；「安全与隐私」（拟人化办法第 18 条）；附录 B（`restReminderText`）。

**前置：** Task 7 已完成（以及按顺序完成的 Task 8–11）。依赖：
- C1：`ResponseKind` 含 `'reminder'`。
- C2：`MemoryStore.continuousSince(ownerId, now, gapMs)`。
- C7：`SessionContext.continuousSince?: number`，由 `registry.resolve(bearer, character)` 用 `continuousSince` 填入（spec §8 第 2 条）。

> 本任务改 Director 的沉默链，属于「开场 / 沉默四段式」高风险区。Step 0 必须先做。

## Files

- Create: `gateway/src/session/restReminder.ts` — `RestReminderConfig`、`RestReminderSchema`、`nextReminderAt`、`RestReminderClock`
- Create: `gateway/test/rest-reminder.test.ts`（纯函数、时钟、配置、文案）
- Create: `gateway/test/director-reminder.test.ts`（Director 集成）
- Create: `gateway/test/rest-reminder-session.test.ts`（Session 集成）
- Modify: `gateway/src/adapters/types.ts`（`:20-23` `ProactiveCue`、`DirectorCue`）
- Modify: `gateway/src/adapters/mock.ts`（`:126-134` `byCue`）
- Modify: `gateway/src/session/director.ts`（`DirectorDeps` `:38-51`；字段 `:85-130`；`onAssistantInterrupted` `:258-287`；`onAiTurnEnded` `:309-373`；`arm` `:463-468`；`fire` `:470-485`；`clear` `:748-754`）
- Modify: `gateway/src/session/session.ts`（`SessionDeps`；字段区；构造函数里的 Director deps `:325-342`；`start()` `:375-391`；`end()` `:579-600`；`requestResponse()` `:850-870`）
- Modify: `gateway/src/session/pacing.ts`（`PacingSchema` `:15-41`）
- Modify: `gateway/config/pacing.json`
- Modify: `gateway/src/i18n/types.ts`、`gateway/src/i18n/load.ts`（`restReminderText`）
- Modify: `gateway/config/i18n/zh/memory.json`、`ja/memory.json`、`en/memory.json`（`restReminderText`）
- Modify: `gateway/src/index.ts`（Session deps：`restReminder`；DeviceRegistry 的连续间隔来源）
- Modify（调用方适配）：`gateway/test/pacing.test.ts`（`PacingConfig` 字面量和 JSON 夹具）

## Interfaces

**Consumes**
- C1：`ResponseKind`（含 `'reminder'`）。
- C2：`continuousSince(ownerId, now, gapMs): number`（Task 7 在 resolve 里调用）。
- C7：`SessionContext.continuousSince?: number`。
- 现有：`Director`（`src/session/director.ts`）、`Session.requestResponse`（`src/session/session.ts:850`）。

**Produces**（C11，原样）
- `gateway/config/pacing.json` 新增 `restReminder: { firstAfterMs: 3600000, everyMs: 3600000, continuityGapMs: 600000 }`。
- `gateway/src/session/restReminder.ts`：

```ts
export function nextReminderAt(continuousSince: number, now: number, cfg: RestReminderConfig): number;
export class RestReminderClock {
  constructor(continuousSince: number, cfg: RestReminderConfig, deps: RestReminderClockDeps); // deps: now, setTimer, clearTimer, onDue
  start(): void;
  stop(): void;
}
```

- `ProactiveRequest.cue` 新增 `'restReminder'`；Session 调 `requestResponse('reminder', ...)`；i18n 新增 `restReminderText`（放在 `config/i18n/<lang>/memory.json`，按总览「共享文件」的分配）。

私有辅助（非冻结）：`RestReminderConfig`、`RestReminderSchema`、`RestReminderClockDeps`、`DirectorDeps.restReminderRequest`、`Director.onRestReminderDue()`、`Director.onReminderMissed()`、`SessionDeps.restReminder`。

## 设计要点

1. **计时**：`nextReminderAt` 返回严格晚于 `now` 的下一个边界：`since + firstAfterMs`，之后每 `everyMs`。`RestReminderClock` 只有一个定时器，每个边界调一次 `onDue`，然后按「`max(now, 刚到的边界)` 之后的下一个边界」重新排，防止定时器提前 1ms 触发时重复提醒。时钟不持有任何内容，时间和定时器都注入。
2. **连续起点**：`ctx.continuousSince`（resolve 时算好的）；dev 会话没有它，用会话创建时的 `now()`。已知边界情况：上一个会话在第 59 分钟结束、新会话在第 62 分钟开始，第 60 分钟那次落在两个会话之间，下一次在第 120 分钟。仍满足拟人化办法第 18 条「超过 2 小时提醒」，不做持久化。
3. **欠账模型**：时钟到点只是让 Director 记一笔 `reminderOwed`。Director 决定何时说：
   - 被挡住（`stopped`、`muted`、`paused`（工具轮、重连、断线）、`userSpeaking`、开场还没播完）、正在回复（`aiBusy`）、已有一条主动请求在路上（`pending`）、打断后在等用户回复（`bargeIn`）：继续欠着。
   - 沉默链有一段已经排上定时器：占用这一段，定时器到点时说提醒，不说那一段。
   - 规划器正在为某一段生成：中止规划，立即说提醒（同样是占用这一段）。
   - 完全空闲（包括 `quiet` / `left`，沉默链已停）：立即说。
   - 以后每一个会排沉默段的时刻（AI 说完、用户说完、工具轮放开），欠着的提醒都优先占用下一个位置；沉默链已停（`quiet` / `left` / 下一段是 `rest`）时，用 `contextAfterMs` 作为等待时间。
4. **播完之后**：`done === 'reminder'` 时 `lastAnswer = 本轮字幕 || 提醒文案`（算作 assistantText），不进 `ladderTexts`（不参与 previousTexts 去重），然后 `next = 'context'` 重新计时；`quiet` / `left` 时保持安静。提醒不触发 checkin，也不触发 `onQuietRest`。
5. **被打断 / 被拒绝**：提醒开播后被用户打断，算已经提醒过，不重播。Session 拒绝请求（`requestResponse` 的守卫：工具轮、正在生成、上一句还在播）时调 `director.onReminderMissed()`，欠账恢复，并在下一个位置重试。
6. **请求形状**：`{ cue: 'restReminder', instruction: '请直接说下面这句话，不要改写：' + 文案, fallbackText: 文案 }`。不放可以照读的例句，不放否定句（打断与沉默坑位第 3 条）。Seeduplex 直接念 `fallbackText`。不经 `PushGate`（是一次回复，不是 session update）。指令前缀和现有工具 spokenText 一样只用中文前缀，三种语言共用（与 `maybeContinue` 现状一致）。
7. **kind**：`requestResponse('reminder', ...)` 设置 `pendingKind`，`responseStarted` 时发出 `response.start{kind:'reminder'}`，App 据此弹 toast。
8. **清理**：`end()` 里 `restClock.stop()`，和 slim 计时器一样。
9. **配置**：`restReminder` 三个阈值都在 `pacing.json`，zod 校验并交叉校验 `everyMs >= firstAfterMs / 2`；下限放到 10 秒，便于手机验收时调短。
10. **日志**：没有新增日志事件。现有 `response_start{seq, kind}` 会带 `kind: 'reminder'`。提醒文案不进日志。

## 调用方适配

| 位置 | 断在哪 | 修法 |
|---|---|---|
| `src/adapters/types.ts` `DirectorCue` | `ProactiveCue` 加了 `'restReminder'`，`Director.request(cue: DirectorCue)` 的 switch 不再穷尽，typecheck 报「缺少返回」 | `DirectorCue = Exclude<ProactiveCue, 'contextBridge' \| 'restReminder'>`；提醒请求由 Session 构造，经 `restReminderRequest` 交给 Director |
| `src/adapters/mock.ts` `byCue` | `Record<ProactiveCue, string>` 缺键 | 加 `restReminder: request?.fallbackText ?? s.followup` |
| `test/pacing.test.ts`（当前 `:106-112` 和 `:134-140` 的 `base` 对象、`:187` 和 `:203` 的 `PacingConfig` 字面量） | `restReminder` 必填 | 四处都加 `restReminder: { firstAfterMs: 3_600_000, everyMs: 3_600_000, continuityGapMs: 600_000 }`。用 `grep -n "push: { minIntervalMs" gateway/test/pacing.test.ts` 定位 |
| `src/index.ts` / `src/identity/registry.ts` | Task 7 的 `continuousSince(owner, now, gapMs)` 需要 `gapMs` 来自 `pacing.restReminder.continuityGapMs` | 见 Step 9 |

## Steps

- [x] **Step 0: 高风险区确认**

读 `docs/project/roadmap.md` 的「打断与沉默：已踩过的坑」1–11 和「记忆与回忆：已踩过的坑」第 8、9 条。向用户说明：Director 的沉默链会多一个「欠着的提醒占用下一段位置」的分支，四段式本身（规划器、checkin 校验、兜底文案）不改。得到确认后再继续。

- [x] **Step 1: 写计时、配置和文案的失败测试**

`gateway/test/rest-reminder.test.ts`：

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@anyidea/protocol';
import { loadI18n } from '../src/i18n/load.ts';
import { loadPacing } from '../src/session/pacing.ts';
import { RestReminderClock, nextReminderAt, type RestReminderConfig } from '../src/session/restReminder.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const HOUR = 3_600_000;
const cfg: RestReminderConfig = { firstAfterMs: HOUR, everyMs: HOUR, continuityGapMs: 600_000 };

/** Injected timers: the clock never touches real time. */
function manualTimers(start = 0) {
  let now = start;
  let nextId = 1;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const first = timers[0];
        if (!first || first.at > end) break;
        timers.shift();
        now = first.at;
        first.fn();
      }
      now = end;
    },
    pending: () => timers.length,
  };
}

describe('nextReminderAt', () => {
  it('returns the first boundary, then every interval, always strictly after now', () => {
    expect(nextReminderAt(0, 0, cfg)).toBe(HOUR);
    expect(nextReminderAt(0, HOUR - 1, cfg)).toBe(HOUR);
    expect(nextReminderAt(0, HOUR, cfg)).toBe(2 * HOUR);
    expect(nextReminderAt(0, 1.5 * HOUR, cfg)).toBe(2 * HOUR);
    expect(nextReminderAt(0, HOUR, { ...cfg, everyMs: HOUR / 2 })).toBe(1.5 * HOUR);
  });

  it('counts from the start of the continuous stretch, across sessions', () => {
    const now = 10 * HOUR;
    expect(nextReminderAt(now - 59 * 60_000, now, cfg)).toBe(now + 60_000);
  });
});

describe('RestReminderClock', () => {
  it('fires at each boundary and stops cleanly', () => {
    const timers = manualTimers(0);
    let due = 0;
    const clock = new RestReminderClock(-50 * 60_000, cfg, { ...timers, onDue: () => { due++; } });
    clock.start();
    timers.advance(10 * 60_000 - 1);
    expect(due).toBe(0);
    timers.advance(1);
    expect(due).toBe(1);
    timers.advance(HOUR);
    expect(due).toBe(2);
    clock.stop();
    expect(timers.pending()).toBe(0);
    timers.advance(5 * HOUR);
    expect(due).toBe(2);
  });

  it('moves to the next boundary when a timer runs early, instead of firing the same one again', () => {
    let now = 0;
    const queue: Array<() => void> = [];
    const delays: number[] = [];
    let due = 0;
    const clock = new RestReminderClock(0, cfg, {
      now: () => now,
      setTimer: (fn, ms) => { queue.push(fn); delays.push(ms); return queue.length; },
      clearTimer: () => {},
      onDue: () => { due++; },
    });
    clock.start();
    expect(delays).toEqual([HOUR]);
    now = HOUR - 1; // the timer fires 1 ms early
    queue.shift()!();
    expect(due).toBe(1);
    expect(delays).toEqual([HOUR, HOUR + 1]); // the 2 h boundary, not 1 ms later
    clock.stop();
  });
});

describe('restReminder config', () => {
  it('ships one-hour reminders with a ten-minute continuity gap', () => {
    expect(loadPacing(join(root, 'config/pacing.json')).restReminder).toEqual({
      firstAfterMs: 3_600_000, everyMs: 3_600_000, continuityGapMs: 600_000,
    });
  });

  it('rejects a missing block, bad ranges, extra keys, and everyMs below half of firstAfterMs', () => {
    const shipped = JSON.parse(readFileSync(join(root, 'config/pacing.json'), 'utf8')) as Record<string, unknown>;
    const dir = mkdtempSync(join(tmpdir(), 'rest-'));
    const write = (restReminder: unknown) => {
      const next: Record<string, unknown> = { ...shipped, restReminder };
      if (restReminder === undefined) delete next.restReminder;
      writeFileSync(join(dir, 'pacing.json'), JSON.stringify(next));
    };
    for (const restReminder of [
      undefined,
      { firstAfterMs: 3_600_000, everyMs: 1_799_999, continuityGapMs: 600_000 },
      { firstAfterMs: 9_999, everyMs: 3_600_000, continuityGapMs: 600_000 },
      { firstAfterMs: 3_600_000, everyMs: 3_600_000, continuityGapMs: 0 },
      { firstAfterMs: 3_600_000, everyMs: 3_600_000, continuityGapMs: 600_000, extra: 1 },
    ]) {
      write(restReminder);
      expect(() => loadPacing(join(dir, 'pacing.json'))).toThrow();
    }
    write({ firstAfterMs: 60_000, everyMs: 30_000, continuityGapMs: 600_000 });
    expect(loadPacing(join(dir, 'pacing.json')).restReminder.everyMs).toBe(30_000);
  });
});

describe('restReminderText', () => {
  const i18n = loadI18n(join(root, 'config'));

  it('ships the appendix B zh line and a line in every language', () => {
    expect(i18n.memory.zh.restReminderText).toBe('咱们聊了一个钟头了，要不要起来活动活动、喝口水？我在这儿等您。');
    for (const language of LANGUAGES) expect(i18n.memory[language].restReminderText.length).toBeGreaterThan(0);
  });
});
```

- [x] **Step 2: 运行，确认失败**

```bash
npm test -w gateway -- test/rest-reminder.test.ts
```

Expected：FAIL，`Cannot find module '../src/session/restReminder.ts'`。

- [x] **Step 3: 实现 `restReminder.ts`、配置与文案**

`gateway/src/session/restReminder.ts`：

```ts
import { z } from 'zod';

export interface RestReminderConfig {
  firstAfterMs: number;
  everyMs: number;
  /** Sessions closer than this count as one continuous stretch (across characters). */
  continuityGapMs: number;
}

/** pacing.json restReminder. Lower bounds allow short thresholds for phone acceptance. */
export const RestReminderSchema = z.object({
  firstAfterMs: z.number().int().min(10_000).max(14_400_000),
  everyMs: z.number().int().min(10_000).max(14_400_000),
  continuityGapMs: z.number().int().min(1_000).max(3_600_000),
}).strict().refine((r) => r.everyMs >= r.firstAfterMs / 2, { message: 'restReminder.everyMs must be >= firstAfterMs / 2' });

/** First boundary strictly after `now`: since + firstAfterMs, then every everyMs. */
export function nextReminderAt(continuousSince: number, now: number, cfg: RestReminderConfig): number {
  const first = continuousSince + cfg.firstAfterMs;
  if (now < first) return first;
  return first + (Math.floor((now - first) / cfg.everyMs) + 1) * cfg.everyMs;
}

export interface RestReminderClockDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** A boundary was reached; the Director decides when the line is actually spoken. */
  onDue: () => void;
}

/** One timer per session; calls onDue at every boundary until stopped. Holds no content. */
export class RestReminderClock {
  private handle: unknown = null;
  private stopped = false;

  constructor(
    private readonly continuousSince: number,
    private readonly cfg: RestReminderConfig,
    private readonly deps: RestReminderClockDeps,
  ) {}

  start(): void {
    this.arm(this.deps.now());
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) this.deps.clearTimer(this.handle);
    this.handle = null;
  }

  /** Schedules the boundary after `after`. A timer that fires early still moves to the next one. */
  private arm(after: number): void {
    if (this.stopped) return;
    const dueAt = nextReminderAt(this.continuousSince, after, this.cfg);
    this.handle = this.deps.setTimer(() => {
      this.handle = null;
      if (this.stopped) return;
      this.deps.onDue();
      this.arm(Math.max(this.deps.now(), dueAt));
    }, Math.max(0, dueAt - this.deps.now()));
  }
}
```

`gateway/src/session/pacing.ts`：
- import：`import { RestReminderSchema } from './restReminder.ts';`
- `PacingSchema` 的 `push: ...` 后面加：

```ts
  /** Rest reminder (spec: AI 提示与休息提醒); everyMs >= firstAfterMs / 2 is checked by the schema. */
  restReminder: RestReminderSchema,
```

`gateway/config/pacing.json`，在 `push` 后面加（前一行补逗号）：

```json
  "restReminder": { "firstAfterMs": 3600000, "everyMs": 3600000, "continuityGapMs": 600000 }
```

文案：`gateway/src/i18n/types.ts` 的 `MemoryCopy` 加：

```ts
  /** Spoken verbatim by the current character after continuous use (spec 附录 B). */
  restReminderText: string;
```

`gateway/src/i18n/load.ts`：`MemoryFileSchema` 加 `restReminderText: z.string().min(1).max(160),`；`loadMemoryCopy` 返回对象加 `restReminderText: raw.restReminderText,`。

三个 `memory.json` 各加一个顶层键：

```json
  "restReminderText": "咱们聊了一个钟头了，要不要起来活动活动、喝口水？我在这儿等您。"
```

```json
  "restReminderText": "もう1時間おしゃべりしましたね。少し立って体を動かしたり、お水を飲んだりしませんか？ここで待っていますね。"
```

```json
  "restReminderText": "We've been chatting for an hour. How about getting up to stretch and having a sip of water? I'll be right here."
```

调用方适配：`gateway/test/pacing.test.ts` 的四处夹具加 `restReminder: { firstAfterMs: 3_600_000, everyMs: 3_600_000, continuityGapMs: 600_000 },`（见上表）。

- [x] **Step 4: 运行，确认通过**

```bash
npm test -w gateway -- test/rest-reminder.test.ts test/pacing.test.ts test/i18n.test.ts test/affect-render.test.ts
```

Expected：PASS。

- [x] **Step 5: 写 Director 集成的失败测试**

`gateway/test/director-reminder.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { ResponseKind } from '@anyidea/protocol';
import { loadDirectorConfig } from '../src/config.ts';
import type { ProactiveRequest } from '../src/adapters/types.ts';
import { Director, type DirectorDeps, type SilenceContext } from '../src/session/director.ts';

const { silenceDecision: _decisionConfig, ...base } = loadDirectorConfig(
  fileURLToPath(new URL('../roles/elder-companion/zh/director.json', import.meta.url)),
);
const cfg = {
  ...base,
  contextInstruction: 'READ {continuation}',
  contextAfterMs: 6_000,
  checkAfterMs: 8_000,
  leaveAfterMs: 10_000,
  checkinAfterMs: 10_000,
  restAfterMs: 180_000,
};
const reminder: ProactiveRequest = { cue: 'restReminder', instruction: '请直接说下面这句话，不要改写：R', fallbackText: 'R' };

function setup(opts: { planner?: DirectorDeps['planProactiveLine']; withReminder?: boolean } = {}) {
  const calls: Array<{ kind: ResponseKind; request: ProactiveRequest }> = [];
  const d = new Director(cfg, {
    requestResponse: (kind, request) => { calls.push({ kind, request }); },
    ...(opts.withReminder === false ? {} : { restReminderRequest: () => reminder }),
    ...(opts.planner ? { planProactiveLine: opts.planner } : {}),
  });
  /** A real exchange: the ladder then waits for its context step. */
  const answer = () => {
    d.onUserFinal('今天走了很多路，脚有点酸。');
    d.onAiTurnStarted();
    d.onAiTurnEnded('今天走了不少地方。');
  };
  const reminders = () => calls.filter((call) => call.request.cue === 'restReminder');
  return { d, calls, answer, reminders };
}

describe('rest reminder in the Director', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('takes the slot of the waiting silence step, then restarts the chain from context', async () => {
    const s = setup();
    s.answer();
    s.d.onRestReminderDue();
    expect(s.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.calls).toEqual([{ kind: 'reminder', request: reminder }]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('R');
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.calls[1]!.request.fallbackText).toBe(cfg.contextText);
    s.d.stop();
  });

  it('counts as the last assistant line for the planner, but never as a previous ladder text', async () => {
    const contexts: SilenceContext[] = [];
    const s = setup({ planner: (context) => { contexts.push(context); return null; } });
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.contextText);
    s.d.onRestReminderDue(); // the check step is waiting: the reminder takes it
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs);
    expect(s.calls.at(-1)).toEqual({ kind: 'reminder', request: reminder });
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('R');
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    const last = contexts.at(-1)!;
    expect(last.stage).toBe('context');
    expect(last.assistantText).toBe('R');
    expect(last.previousTexts).toContain(cfg.contextText);
    expect(last.previousTexts).not.toContain('R');
    s.d.stop();
  });

  it('waits while a reply is playing, then speaks in the next gap', async () => {
    const s = setup();
    s.answer();
    s.d.onAiTurnStarted();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.reminders()).toEqual([]);
    s.d.onAiTurnEnded('今天天气不错。');
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(1);
    s.d.stop();
  });

  it('waits while the user is speaking', async () => {
    const s = setup();
    s.answer();
    s.d.onUserSpeech(true);
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.reminders()).toEqual([]);
    s.d.onUserSpeech(false);
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(1);
    s.d.stop();
  });

  it('waits through a tool turn (paused) and speaks after the release', async () => {
    const s = setup();
    s.answer();
    s.d.pause();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.reminders()).toEqual([]);
    s.d.releasePause(true);
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(1);
    s.d.stop();
  });

  it('speaks at once when the chain is quiet, and stays quiet afterwards', async () => {
    const s = setup();
    const quiet = cfg.quietPhrases[0];
    expect(quiet).toBeTruthy();
    s.answer();
    s.d.onUserFinal(quiet!);
    s.d.onRestReminderDue();
    expect(s.calls).toEqual([{ kind: 'reminder', request: reminder }]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('R');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.calls).toHaveLength(1);
    s.d.stop();
  });

  it('owes a refused reminder again and retries at the next slot', async () => {
    const s = setup();
    s.answer();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(1);
    s.d.onReminderMissed(); // the session refused it (a reply was still live)
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(2);
    s.d.stop();
  });

  it('does not repeat a reminder the user cut off', async () => {
    const s = setup();
    s.answer();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    s.d.onAiTurnStarted();
    s.d.onUserSpeech(true);
    s.d.onAssistantInterrupted();
    s.d.onUserSpeech(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.reminders()).toHaveLength(1);
    s.d.stop();
  });

  it('never speaks before the opening has played', async () => {
    const s = setup();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.calls).toEqual([]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('greeting');
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(1);
    s.d.stop();
  });

  it('is a no-op without a reminder source', async () => {
    const s = setup({ withReminder: false });
    s.answer();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toEqual([]);
    s.d.stop();
  });
});
```

运行：

```bash
npm test -w gateway -- test/director-reminder.test.ts
```

Expected：FAIL（`d.onRestReminderDue is not a function`）。

- [x] **Step 6: 实现 cue 类型与 Director 集成**

`gateway/src/adapters/types.ts`：

```ts
/** What the Director wants said. Qwen speaks from `instruction`; adapters that cannot prompt the model speak `fallbackText`. */
export type ProactiveCue = 'greeting' | 'followup' | 'idleNotice' | 'resume' | 'toolContinue' | 'memoryNotice' | 'contextBridge' | 'restReminder';

/** Cues the Director builds itself. `contextBridge` is spoken by the session; `restReminder` comes from the session's copy. */
export type DirectorCue = Exclude<ProactiveCue, 'contextBridge' | 'restReminder'>;
```

`gateway/src/adapters/mock.ts` 的 `byCue` 加一项：

```ts
      // Not scripted either: the session passes the configured reminder line.
      restReminder: request?.fallbackText ?? s.followup,
```

`gateway/src/session/director.ts`：

1. `DirectorDeps` 末尾加：

```ts
  /** Rest reminder line in the current language; absent = reminders off. */
  restReminderRequest?(): ProactiveRequest;
```

2. `pending` 的类型加 `'reminder'`：

```ts
  /** Silence step whose playback is in flight, the memory notice, or the rest reminder. */
  private pending: SilenceStep | 'notice' | 'repair' | 'resume' | 'reminder' | null = null;
```

3. 字段区（`restNoticed` 下面）加：

```ts
  /** The rest clock reached a boundary and the line has not been spoken yet. */
  private reminderOwed = false;
  /** Fallback text of the reminder in flight; the assistant's last line if no transcript arrives. */
  private reminderText = '';
  /** Silence step whose timer is armed; an owed reminder takes that slot when it fires. */
  private armedStep: SilenceStep | null = null;
```

4. 公开方法（放在 `cancelNotice()` 后面）：

```ts
  /** Rest clock boundary (spec: AI 提示与休息提醒). Speak now if idle, else take the next silence slot. */
  onRestReminderDue(): void {
    if (!this.deps.restReminderRequest) return;
    this.reminderOwed = true;
    if (this.reminderBlocked() || this.aiBusy || this.pending !== null || this.bargeIn) return;
    if (this.armedStep !== null) return; // fire() speaks it in that step's place
    this.speakReminder(); // idle, or a planner call in flight: take the slot now
  }

  /** The session refused the request (a reply was live): owe it again and retry at the next slot. */
  onReminderMissed(): void {
    if (this.pending !== 'reminder') return;
    this.pending = null;
    this.reminderOwed = true;
    this.armReminderSlot();
  }
```

5. `onAssistantInterrupted()`：在 `this.aiBusy = false;` 下面加：

```ts
    // A reminder the user cut off still counts as given; never replay it.
    if (this.pending === 'reminder') this.pending = null;
```

6. `onAiTurnEnded()`：
   - `hardStop` 分支里，`if (this.pending === 'notice') this.pending = null;` 下面加：

```ts
      if (this.pending === 'reminder') this.pending = null;
```

   - `const done = this.pending; this.pending = null;` 之后、`if (done === null && assistantText !== undefined) ...` 之前加：

```ts
    if (done === 'reminder') {
      // Counts as the assistant's last line, but it is not a ladder step: not in previousTexts.
      this.lastAnswer = assistantText?.trim() || this.reminderText;
      if (this.noticePending && this.noticeRetry) {
        this.requestMemoryNotice();
        return;
      }
      if (this.quiet || this.left) return;
      this.next = 'context';
      this.arm();
      return;
    }
```

   - notice 分支（`if (this.noticePending && (...)) { this.requestMemoryNotice(); return; }`）之后、`if (this.quiet || this.left) return;` 之前加：

```ts
    // An owed reminder takes the next silence slot, even when the ladder itself is quiet.
    if (this.armReminderSlot()) return;
```

7. `arm()` 替换为：

```ts
  /** Starts the timer for the current silence step. Each delay begins when the previous line has finished. */
  private arm(): void {
    this.clear();
    if (this.armReminderSlot()) return;
    if (this.blocked() || this.left) return;
    const step = this.next;
    this.armedStep = step;
    this.timer = setTimeout(() => this.fire(step), this.delayFor(step));
  }
```

8. `fire()` 的开头（`this.timer = null;` 之后）加：

```ts
    this.armedStep = null;
    // An owed rest reminder is said in this step's place.
    if (this.reminderOwed && !this.reminderBlocked()) {
      this.speakReminder();
      return;
    }
```

9. `clear()` 改为（`armedStep` 在提前 return 之前清掉）：

```ts
  private clear(): void {
    this.decision?.abort();
    this.decision = null;
    this.armedStep = null;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
```

10. 新增私有方法（放在 `blocked()` 旁边）：

```ts
  /** Quiet and left do not hold a reminder back; these do. */
  private reminderBlocked(): boolean {
    return this.stopped || this.muted || this.paused || this.userSpeaking || !this.opened;
  }

  private speakReminder(): void {
    const request = this.deps.restReminderRequest?.();
    if (!request) return;
    this.clear(); // aborts a planner call or the armed step: the reminder takes that slot
    this.reminderOwed = false;
    this.pending = 'reminder';
    this.reminderText = request.fallbackText;
    this.deps.requestResponse('reminder', request);
  }

  /** Arms the next silence slot for an owed reminder. A stopped ladder waits the context delay. */
  private armReminderSlot(): boolean {
    if (!this.reminderOwed || this.reminderBlocked()) return false;
    this.clear();
    const step = this.next;
    const wait = this.quiet || this.left || step === 'rest' ? this.delayFor('context') : this.delayFor(step);
    this.armedStep = step;
    this.timer = setTimeout(() => this.fire(step), wait);
    return true;
  }
```

- [x] **Step 7: 运行 Director 测试和沉默链回归**

```bash
npm test -w gateway -- test/director-reminder.test.ts test/director-silence.test.ts test/director.test.ts test/silence.test.ts test/care-opening.test.ts
```

Expected：全部 PASS。`director-silence.test.ts`、`director.test.ts`、`silence.test.ts` 是四段式和开场的回归，没有 `restReminderRequest` 时行为必须完全不变。

- [x] **Step 8: 写 Session 集成的失败测试**

`gateway/test/rest-reminder-session.test.ts`：

```ts
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig } from '../src/adapters/types.ts';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session } from '../src/session/session.ts';

const characters = loadCharacterRegistry(fileURLToPath(new URL('../characters', import.meta.url)), ['zh', 'ja', 'en']);
const text = DEFAULT_I18N.memory.zh.restReminderText;
const director: DirectorConfig = {
  followupAfterMs: 600_000, idleNoticeAfterMs: 600_000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300_000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup',
  idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
  toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
  contextAfterMs: 20_000, checkAfterMs: 600_000, leaveAfterMs: 600_000, checkinAfterMs: 600_000,
};

class FakeAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  readonly verbatimFallback = false;
  readonly supportsUserText = true;
  readonly requests: ProactiveRequest[] = [];
  private counter = 0;
  private activeId: string | null = null;
  async connect(_config: SessionConfig): Promise<void> {}
  sendAudio(_pcm: Int16Array): void {}
  sendUserText(_text: string): void {}
  updateInstructions(_text: string): void {}
  updateVoice(_voice: string | undefined): void {}
  createResponse(request?: ProactiveRequest): void {
    if (request) this.requests.push(request);
    const id = `resp-${++this.counter}`;
    this.activeId = id;
    this.emit('responseStarted', id);
  }
  cancelResponse(): void {}
  sendToolResult(_callId: string, _result: unknown): void {}
  injectContextNote(_text: string): void {}
  close(): void {}
  done(): void {
    const id = this.activeId;
    if (!id) throw new Error('no_active_response');
    this.activeId = null;
    this.emit('responseDone', id);
  }
}

const sessions: Session[] = [];
const restReminder = { firstAfterMs: 60_000, everyMs: 60_000, continuityGapMs: 600_000 };

function boot(opts: { continuousSince?: number; reminders?: boolean } = {}) {
  const adapter = new FakeAdapter();
  const sent: ServerMessage[] = [];
  const ctx: SessionContext = {
    characterId: 'xiaonuan',
    firstMeet: false,
    ...(opts.continuousSince !== undefined ? { continuousSince: opts.continuousSince } : {}),
  };
  const session = new Session({
    adapterFactory: () => adapter,
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    characters,
    ...(opts.reminders === false ? {} : { restReminder }),
  }, ctx, `rest-${sessions.length}`);
  sessions.push(session);
  const transport = { send: (msg: ServerMessage) => { sent.push(msg); }, sendAudio: () => {} };
  const reminders = () => adapter.requests.filter((request) => request.cue === 'restReminder');
  return { adapter, session, sent, transport, reminders };
}

async function open(t: ReturnType<typeof boot>): Promise<void> {
  await t.session.start(t.transport);
  t.adapter.done();
  t.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 0, reason: 'ended' });
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.end();
  vi.useRealTimers();
});

describe('rest reminder in a live session', () => {
  it('counts from the continuous stretch across sessions and takes the waiting silence slot', async () => {
    const t = boot({ continuousSince: 1_000_000 - 50_000 }); // due 10 s after start
    await open(t);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.reminders()).toEqual([]); // owed: the context step is armed for 20 s
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.reminders()).toEqual([{ cue: 'restReminder', instruction: `请直接说下面这句话，不要改写：${text}`, fallbackText: text }]);
    expect(t.adapter.requests.filter((request) => request.cue === 'followup')).toEqual([]);
    expect(t.sent).toContainEqual({ type: 'response.start', responseSeq: 2, kind: 'reminder' });
  });

  it('starts a fresh stretch at session start when the context has no continuity', async () => {
    const t = boot();
    await open(t);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.reminders()).toEqual([]);
    expect(t.adapter.requests.at(-1)?.cue).toBe('followup'); // the normal context step
  });

  it('clears its timer on end()', async () => {
    const t = boot({ continuousSince: 1_000_000 - 50_000 });
    await open(t);
    t.session.end();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.reminders()).toEqual([]);
  });

  it('is off without a restReminder config', async () => {
    const t = boot({ continuousSince: 1_000_000 - 50_000, reminders: false });
    await open(t);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.reminders()).toEqual([]);
  });
});
```

> `Session` 的 deps 字段名（`characters`）按 C7 写；如果 Task 7 落地的名字不同，以 Task 7 之后的测试写法为准，只改这一处。

运行：

```bash
npm test -w gateway -- test/rest-reminder-session.test.ts
```

Expected：FAIL（第一个用例没有 `restReminder` 请求，到 20 秒时发出的是 `followup`）。

- [x] **Step 9: 接入 Session 与生产配置**

`gateway/src/session/session.ts`：

1. import：`import { RestReminderClock, type RestReminderConfig } from './restReminder.ts';`

2. `SessionDeps` 里 `push?` 下面加：

```ts
  /** Rest reminder thresholds (gateway/config/pacing.json restReminder). Omitted = reminders off (tests). */
  restReminder?: RestReminderConfig;
```

3. 字段区（`slimTimer` 附近）加：

```ts
  /** Rest reminder clock; started with the session, stopped in end() like the slim clock. */
  private restClock: RestReminderClock | null = null;
```

4. 构造函数里 `new Director(...)` 的 deps 对象，在 `requestResponse: ...` 下面加：

```ts
        restReminderRequest: () => this.restReminderRequest(),
```

5. `start()`：`this.director.onSessionStart(...)` 之后、`this.armSlimInterval();` 之前加 `this.startRestReminder();`。

6. `end()`：`this.stopSlimClock();` 下面加：

```ts
    this.restClock?.stop();
    this.restClock = null;
```

7. `requestResponse()` 的拒绝分支改为：

```ts
    if (this.toolTurn.active || this.ended || this.interrupt.active !== null || this.modelGenerating) {
      if (request.cue === 'memoryNotice') this.director.onNoticeMissed();
      if (request.cue === 'restReminder') this.director.onReminderMissed();
      return;
    }
```

8. 新增私有方法（放在 `armSlimInterval()` 附近）：

```ts
  /** Continuous use is per phone (spec §5); a dev session without one starts its own stretch. */
  private startRestReminder(): void {
    const cfg = this.deps.restReminder;
    if (!cfg || this.ended) return;
    this.restClock = new RestReminderClock(this.context.continuousSince ?? this.now(), cfg, {
      now: () => this.now(),
      setTimer: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return timer;
      },
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      onDue: () => this.director.onRestReminderDue(),
    });
    this.restClock.start();
  }

  /** The configured line, spoken verbatim: no readable example, no negation (pitfall #3). */
  private restReminderRequest(): ProactiveRequest {
    const text = this.i18n.memory[this.language].restReminderText;
    return { cue: 'restReminder', instruction: `请直接说下面这句话，不要改写：${text}`, fallbackText: text };
  }
```

`gateway/src/index.ts`：
- `new Session({...})` 参数里 `push: pacing.push,` 下面加 `restReminder: pacing.restReminder,`。
- 连续间隔来源：确认 Task 7 的 `DeviceRegistry.resolve` 调用 `store.continuousSince(ownerId, now, gapMs)` 时 `gapMs` 来自 `pacing.restReminder.continuityGapMs`：

```bash
grep -n "continuousSince" gateway/src/identity/registry.ts gateway/src/index.ts
```

  - 如果 Task 7 已有 deps 字段（例如 `continuityGapMs`），只把 `index.ts` 里传入的值改成 `pacing.restReminder.continuityGapMs`。
  - 如果 Task 7 用的是常量或别的来源，在 `DeviceRegistryDeps` 加 `/** pacing.json restReminder.continuityGapMs. */ continuityGapMs: number;`，`resolve` 里改用 `this.deps.continuityGapMs`，`index.ts` 的 `new DeviceRegistry({...})` 加 `continuityGapMs: pacing.restReminder.continuityGapMs,`，并把 Task 7 测试里构造 `DeviceRegistry` 的地方补上同名字段（`grep -rn "new DeviceRegistry" gateway/test`）。

- [x] **Step 10: 运行，确认通过；全量回归**

```bash
npm test -w gateway -- test/rest-reminder-session.test.ts test/rest-reminder.test.ts test/director-reminder.test.ts test/session.test.ts test/slim.test.ts test/tool-turn.test.ts test/interrupt.test.ts
npm test -w gateway && npm run typecheck -w gateway
```

Expected：全部 PASS；typecheck 0 错误。

- [x] **Step 11: 提交**

```bash
git add gateway/src/session/restReminder.ts gateway/src/adapters/types.ts gateway/src/adapters/mock.ts \
  gateway/src/session/director.ts gateway/src/session/session.ts gateway/src/session/pacing.ts \
  gateway/config/pacing.json gateway/src/i18n/types.ts gateway/src/i18n/load.ts \
  gateway/config/i18n/zh/memory.json gateway/config/i18n/ja/memory.json gateway/config/i18n/en/memory.json \
  gateway/src/index.ts gateway/test/rest-reminder.test.ts gateway/test/director-reminder.test.ts \
  gateway/test/rest-reminder-session.test.ts gateway/test/pacing.test.ts
git commit -m "feat(session): remind the user to rest after an hour of continuous use

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（如果 Step 9 改了 `gateway/src/identity/registry.ts` 或 Task 7 的测试，把这些路径也加进 `git add`。）

## 验收清单

- [x] `pacing.json` 的 `restReminder` 三个阈值由 zod 校验，`everyMs < firstAfterMs / 2` 时启动失败。
- [x] 连续计时从 `ctx.continuousSince` 开始（跨会话、跨角色）；没有时从会话开始；边界严格晚于当前时刻，定时器提前触发不会重复提醒。
- [x] 提醒只在空档播出：回复中、用户说话中、工具轮（Director paused）、开场之前都推迟，不取消，不叠播。
- [x] 沉默链有一段在等时，提醒占用这一段；播完后从 context 段重新计时；规划器看到的 `assistantText` 是提醒，`previousTexts` 里没有它；提醒不触发 checkin 和 `onQuietRest`。
- [x] 用户打断的提醒不重播；Session 拒绝的提醒在下一个位置重试。
- [x] 请求是 `requestResponse('reminder', {cue:'restReminder', instruction:'请直接说下面这句话，不要改写：…', fallbackText})`，客户端收到 `response.start{kind:'reminder'}`；不经 `PushGate`。
- [x] `end()` 清理提醒计时器。
- [x] `restReminderText` 三种语言齐全，中文与附录 B 一致。
- [x] 没有新增日志事件；提醒文案不进日志。
- [x] 全量命令通过：

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
```

- [x] 手机验收（Task 17，由用户确认）：把 `firstAfterMs` / `everyMs` 临时调到 60000 验证播报与 toast，验收后改回 3600000，不提交调短的值。
