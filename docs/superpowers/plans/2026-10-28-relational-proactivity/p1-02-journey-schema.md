# P1-T2：模拟时钟与旅程剧本格式

**Spec：** 「测试与验收 › 多天合成剧本评测」第 1、3 点。

「旅程」= 同一位用户在若干天里的若干次会话。每次会话有自己的日期（相对第 0 天）、时刻（北京时间）、可选的角色（默认旅程角色）、用户说的话、会后沉默多久、以及给评委看的测试意图说明。`SimClock` 让「现在」跳到会话的模拟时间，然后照真实时间往前走，这样会话内部的先后顺序和真实一样。

**Files:**
- Create: `gateway/src/eval/simClock.ts`
- Create: `gateway/src/eval/journey.ts`（本任务只写 schema、加载、时间换算；runner 在 P1-T3 追加到同一文件）
- Test: `gateway/test/journey-schema.test.ts`

**Interfaces:**
- Consumes: `CHARACTER_IDS`、`CharacterId`（`@anyidea/protocol`）。
- Produces（冻结，见总览）：`SimClock`、`DAY_MS`、`Journey`、`JourneySession`、`parseJourneys`、`loadJourneys`、`sessionStartAt`。

- [ ] **Step 1：写失败测试**

创建 `gateway/test/journey-schema.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { SimClock } from '../src/eval/simClock.ts';
import { DAY_MS, parseJourneys, sessionStartAt } from '../src/eval/journey.ts';

const journey = (overrides: Record<string, unknown> = {}) => ({
  id: 'checkup-week',
  title: '复查前后',
  character: 'xiaonuan',
  start: '2026-11-02',
  sessions: [
    { day: 0, time: '09:00', turns: ['你好'] },
    { day: 2, time: '19:30', turns: ['我回来了'], note: '事件后回访' },
  ],
  ...overrides,
});

describe('SimClock', () => {
  it('jumps to a time and keeps ticking with the base clock', () => {
    let base = 1_000;
    const clock = new SimClock(() => base);
    expect(clock.now()).toBe(1_000);
    clock.setTo(5_000_000);
    expect(clock.now()).toBe(5_000_000);
    base += 250;
    expect(clock.now()).toBe(5_000_250);
    const unbound = clock.now;
    expect(unbound()).toBe(5_000_250);
  });
});

describe('journey scripts', () => {
  it('parses a valid journey and defaults nothing silently', () => {
    const [j] = parseJourneys([journey()]);
    expect(j!.sessions[1]!.note).toBe('事件后回访');
    expect(j!.sessions[0]!.character).toBeUndefined();
  });

  it('computes the Asia/Shanghai wall time of a session', () => {
    const [j] = parseJourneys([journey()]);
    expect(sessionStartAt(j!, j!.sessions[0]!)).toBe(Date.parse('2026-11-02T09:00:00+08:00'));
    expect(sessionStartAt(j!, j!.sessions[1]!)).toBe(Date.parse('2026-11-02T19:30:00+08:00') + 2 * DAY_MS);
  });

  it('rejects sessions that are not in strictly increasing time order', () => {
    expect(() => parseJourneys([journey({ sessions: [
      { day: 1, time: '09:00', turns: ['a'] },
      { day: 1, time: '09:00', turns: ['b'] },
    ] })])).toThrow(/strictly increasing/);
    expect(() => parseJourneys([journey({ sessions: [
      { day: 2, time: '09:00', turns: ['a'] },
      { day: 1, time: '23:00', turns: ['b'] },
    ] })])).toThrow(/strictly increasing/);
  });

  it('rejects duplicate ids, unknown characters, bad times and unknown keys', () => {
    expect(() => parseJourneys([journey(), journey()])).toThrow(/duplicate journey id/);
    expect(() => parseJourneys([journey({ character: 'lily' })])).toThrow();
    expect(() => parseJourneys([journey({ sessions: [{ day: 0, time: '24:00', turns: [] }, { day: 1, time: '09:00', turns: [] }] })])).toThrow();
    expect(() => parseJourneys([journey({ extra: 1 })])).toThrow();
    expect(() => parseJourneys([journey({ start: '2026-13-40' })])).toThrow(/start/);
  });

  it('allows a session where the user says nothing and only listens', () => {
    const [j] = parseJourneys([journey({ sessions: [
      { day: 0, time: '09:00', turns: [] , silenceAfterMs: 40_000 },
      { day: 1, time: '09:00', turns: ['在呢'] },
    ] })]);
    expect(j!.sessions[0]!.turns).toEqual([]);
  });
});
```

- [ ] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/journey-schema.test.ts`
Expected: FAIL——`simClock.ts` / `journey.ts` 不存在。

- [ ] **Step 3：实现 `SimClock`**

创建 `gateway/src/eval/simClock.ts`：

```ts
/** Wall clock for multi-day evals: jumps to a scripted time, then keeps ticking with the real clock. */
export class SimClock {
  private offset = 0;

  constructor(private readonly base: () => number = Date.now) {}

  /** Arrow property so it can be passed as a bare `() => number` dependency. */
  readonly now = (): number => this.base() + this.offset;

  setTo(at: number): void {
    this.offset = at - this.base();
  }
}
```

- [ ] **Step 4：实现剧本格式**

创建 `gateway/src/eval/journey.ts`：

```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CHARACTER_IDS } from '@anyidea/protocol';

export const DAY_MS = 86_400_000;

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const JourneySessionSchema = z.object({
  /** Days after the journey start (0 = first day). */
  day: z.number().int().min(0).max(13),
  /** Asia/Shanghai wall time, HH:mm. */
  time: Time,
  /** Defaults to the journey character. */
  character: z.enum(CHARACTER_IDS).optional(),
  /** What the user says, in order. Empty = the user only listens. */
  turns: z.array(z.string().min(1).max(200)).max(10),
  /** After the last turn, keep collecting proactive lines this long. */
  silenceAfterMs: z.number().int().min(1_000).max(60_000).optional(),
  /** What this session tests; shown to the judge, never spoken. */
  note: z.string().min(1).max(80).optional(),
}).strict();

const minuteOf = (s: { day: number; time: string }) => {
  const [h, m] = s.time.split(':').map(Number);
  return s.day * 1440 + h! * 60 + m!;
};

const JourneySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  title: z.string().min(1).max(40),
  character: z.enum(CHARACTER_IDS),
  /** First day, YYYY-MM-DD (Asia/Shanghai). */
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sessions: z.array(JourneySessionSchema).min(2).max(8),
}).strict().superRefine((j, ctx) => {
  // Rejects 2026-13-40 (Invalid Date) and 2026-02-30 (JS rolls it over to March).
  const at = Date.parse(`${j.start}T00:00:00+08:00`);
  if (Number.isNaN(at) || shanghaiDate(at) !== j.start) {
    ctx.addIssue({ code: 'custom', path: ['start'], message: 'start must be a real calendar date' });
  }
  for (let i = 1; i < j.sessions.length; i++) {
    if (minuteOf(j.sessions[i]!) <= minuteOf(j.sessions[i - 1]!)) {
      ctx.addIssue({ code: 'custom', path: ['sessions', i], message: 'sessions must be in strictly increasing day/time order' });
    }
  }
});

export type JourneySession = z.infer<typeof JourneySessionSchema>;
export type Journey = z.infer<typeof JourneySchema>;

/** YYYY-MM-DD of an instant in Asia/Shanghai (UTC+8, no DST). */
function shanghaiDate(at: number): string {
  return new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function parseJourneys(raw: unknown): Journey[] {
  const journeys = z.array(JourneySchema).min(1).parse(raw);
  const seen = new Set<string>();
  for (const j of journeys) {
    if (seen.has(j.id)) throw new Error(`duplicate journey id ${j.id}`);
    seen.add(j.id);
  }
  return journeys;
}

export function loadJourneys(path: string): Journey[] {
  return parseJourneys(JSON.parse(readFileSync(path, 'utf8')));
}

/** Epoch ms when the session starts, from the journey start date and the session's day and wall time. */
export function sessionStartAt(journey: Journey, session: JourneySession): number {
  return Date.parse(`${journey.start}T${session.time}:00+08:00`) + session.day * DAY_MS;
}
```

- [ ] **Step 5：运行测试**

Run: `npm test -w gateway -- test/journey-schema.test.ts && npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 6：提交**

```bash
git add gateway/src/eval/simClock.ts gateway/src/eval/journey.ts gateway/test/journey-schema.test.ts
git commit -m "feat(eval): journey scripts and a simulated wall clock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
