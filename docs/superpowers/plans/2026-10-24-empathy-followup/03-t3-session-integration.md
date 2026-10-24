# T3: Session 接入与延迟投递

> 前置：T1、T2 已完成。Spec：`docs/superpowers/specs/2026-10-24-empathy-followup-design.md` §4.3–§4.4、§6.1。高风险：不改 Director 的四段式实现；只走现有 `requestResponse`。

**Files:**
- Modify: `gateway/src/session/session.ts`
- Test: `gateway/test/empathy-followup-session.test.ts`

**Interfaces:**
- Consumes: `FollowUpPlanner`、`followUpTrigger`、`followUpSkipCode`、`hasQuestionMark`（T2）；`RoleCatalog.followupPrompt` / `followupSpeakInstruction`（T1）；现有 `requestResponse`、`ResponseState`、`AffectCard`。
- Produces: Session 内部 `followUpTurn` / `followUpPlan` / `followUpUsed`，无新公开接口。

---

- [ ] **Step 1: 写失败测试**

新建 `gateway/test/empathy-followup-session.test.ts`。以下测试覆盖核心路径；T4 再加守卫矩阵。

```ts
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import type { ProactiveRequest } from '../src/adapters/types.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import { loadAffectConfig, type AffectCard } from '../src/session/affect.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session, type Transport } from '../src/session/session.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const affect = loadAffectConfig(`${root}config/affect.json`);
const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup',
  idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
  toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
};

const happyCard: AffectCard = { emotion: 'happy', intensity: 2, trend: 'flat', need: 'share_joy', strategy: 'affirm', mismatch: false, crisis: false };
const lowCard: AffectCard = { emotion: 'sad', intensity: 2, trend: 'flat', need: 'vent', strategy: 'comfort', mismatch: false, crisis: false };
const crisisCard: AffectCard = { ...lowCard, crisis: true };

const script = (reply: string): MockScript => ({ greeting: '你好呀', followup: '还在吗', fallbackReply: reply, turns: [] });

function setup(reply: string, card: AffectCard, followUp: string) {
  const requests: ProactiveRequest[] = [];
  const client: TextModelClient = {
    complete: async (input) => {
      if (input.system === 'FIXTURE AFFECT') return JSON.stringify(card);
      if (input.system === 'FIXTURE FOLLOWUP') return JSON.stringify({ text: followUp });
      return '{"speak":false}';
    },
  };
  const session = new Session({
    adapterFactory: () => {
      const m = new MockAdapter({ script: script(reply), replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
      const create = m.createResponse.bind(m);
      m.createResponse = (request?: ProactiveRequest) => {
        if (request) requests.push(request);
        create(request);
      };
      return m;
    },
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    textClient: client,
    affect,
  }, { roleId: 'elder-companion', styleId: 'grandchild', language: 'zh' });
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (m) => sent.push(m), sendAudio: () => {} };
  return { session, transport, requests, sent };
}

async function startAndFinishGreeting(s: ReturnType<typeof setup>) {
  await s.session.start(s.transport);
  await vi.advanceTimersByTimeAsync(1000);
  s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
}

async function sayAndFinishMain(s: ReturnType<typeof setup>, text: string, seq = 2) {
  s.session.handleClientMessage({ type: 'debug.userText', text });
  await vi.advanceTimersByTimeAsync(300);
  s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: seq, playedMs: 300, reason: 'ended' });
  await vi.advanceTimersByTimeAsync(0);
}

const followUps = (s: ReturnType<typeof setup>) => s.requests.filter((r) => r.cue === 'followup');

describe('empathy follow-up session', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('requests one follow-up after the main reply playback ends', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    expect(followUps(s)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(1);
    expect(followUps(s)[0]?.fallbackText).toBe('后来呢？');
    expect(followUps(s)[0]?.instruction).toContain('后来呢？');
  });

  it('does not follow up in a crisis', async () => {
    const s = setup('我在听。', crisisCard, '我陪您坐一会儿。');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '活着真没意思');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(0);
  });

  it('does not follow up when the main reply already asked a question', async () => {
    const s = setup('您孙子考的哪个学校？', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(0);
  });

  it('cancels a pending follow-up when the user speaks again', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(0);
  });

  it('does not follow up twice in one session', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 300, reason: 'ended' });
    await sayAndFinishMain(s, '他考的是本校。', 4);
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `cd gateway && npx vitest run test/empathy-followup-session.test.ts`
Expected: FAIL，没有 follow-up 请求；`followup` 配置存在但 Session 未接入。

- [ ] **Step 3: 加 import 与字段**

`gateway/src/session/session.ts` 顶部加：

```ts
import {
  createFollowUpPlanner,
  followUpSkipCode,
  followUpTrigger,
  hasQuestionMark,
  type FollowUpPlanner,
  type FollowUpTrigger,
} from './empathyFollowUp.ts';
```

在 `affectRendered` / `openLoop` 字段后加：

```ts
  /** Accepted user finals; the follow-up uses it to reject a stale card. */
  private userTurnSeq = 0;
  /** User turn that produced the current affect card. */
  private affectCardTurn = 0;
  /** Follow-ups actually requested this session (max from affect.json). */
  private followUpUsed = 0;
  private followUpTimer: NodeJS.Timeout | null = null;
  /** The playback-ended reply waiting for its delayed follow-up. */
  private followUpTurn: { turn: number; userText: string; replyText: string; startedAt: number } | null = null;
  /** Planner work started when the current card arrived. */
  private followUpPlan: { turn: number; trigger: FollowUpTrigger; controller: AbortController; promise: Promise<string | null> } | null = null;
  private followUpPlanWaiters: Array<() => void> = [];
  private readonly followUpPlanner: FollowUpPlanner | null;
```

- [ ] **Step 4: 构造 planner**

在 `this.affect = ...` 之后加：

```ts
    const followUpConfig = deps.affect?.followup;
    this.followUpPlanner = deps.textClient && deps.affect?.enabled && followUpConfig?.enabled
      ? createFollowUpPlanner({
          client: deps.textClient,
          config: followUpConfig,
          prompt: (language) => deps.roles.followupPrompt(language),
          safety: this.i18n.safety,
        })
      : null;
```

- [ ] **Step 5: 记录卡片轮次并启动并行规划**

`onAffectCard` 在 `this.affectCard = card;` 后加：

```ts
    this.affectCardTurn = this.userTurnSeq;
```

在 `this.syncAffectRender();` 后加：

```ts
    this.startFollowUpPlan(card);
```

在 `onAffectCard` 后加以下方法：

```ts
  /** Start the planner as soon as the current turn's card is eligible; playback end only schedules delivery. */
  private startFollowUpPlan(card: AffectCard): void {
    const config = this.deps.affect;
    if (!config?.followup.enabled || !this.followUpPlanner || this.ended) return;
    if (this.affectCardTurn !== this.userTurnSeq || this.userTurnSeq === 0) return;
    if (this.followUpUsed >= config.followup.maxPerSession) return;
    const trigger = followUpTrigger(card, config.lowIntensity);
    if (!trigger) {
      this.followUpPlan?.controller.abort();
      this.followUpPlan = null;
      return;
    }
    if (this.followUpPlan?.turn === this.affectCardTurn) return;
    const userText = this.turnUserText ?? this.lastUserText();
    if (!userText) return;
    this.followUpPlan?.controller.abort();
    const controller = new AbortController();
    const recentUserTexts = this.ledger.recent
      .filter((entry) => entry.role === 'user')
      .slice(-2)
      .map((entry) => entry.text);
    const promise = this.followUpPlanner({ language: this.language, trigger, userText, recentUserTexts, card }, controller.signal).catch(() => null);
    this.followUpPlan = { turn: this.affectCardTurn, trigger, controller, promise };
    log('empathy_followup', { trigger, outcome: 'planned', code: null, ms: 0 });
    for (const wake of this.followUpPlanWaiters.splice(0)) wake();
  }

  private lastUserText(): string | null {
    for (let i = this.ledger.recent.length - 1; i >= 0; i--) {
      const entry = this.ledger.recent[i];
      if (entry?.role === 'user') return entry.text;
    }
    return null;
  }
```

- [ ] **Step 6: 播放结束后调度**

在 `playback.stopped` 的 `reason === 'ended'` 分支里，`s.playbackEnded = true;` 前捕获用户原话，`finalize` 后调用调度：

```ts
          const replyUserText = this.turnUserText;
          s.playbackEnded = true;
          this.streamBarge = false;
          this.bargePreroll.length = 0;
          this.finalize(s, false);
          this.interrupt.onResponseFinished(msg.responseSeq);
          // finalize() ran while this response was still the active interrupt; this is the seam.
          this.gate.flush();
          this.uplinkResumeAt = Date.now() + (this.deps.tailGuardMs ?? 0);
          this.finishNotice(msg.responseSeq);
          if (toolOrigin) {
            this.toolTurn.onOriginPlaybackEnded();
            this.maybeContinue();
          } else {
            this.director.onAiTurnEnded(s.text);
            this.scheduleFollowUp(s, replyUserText);
            this.maybeSlimContext();
            this.tickSlim();
          }
```

在 `requestResponse` 前加以下方法：

```ts
  private scheduleFollowUp(s: ResponseState, userText: string | null): void {
    const config = this.deps.affect;
    if (!config?.followup.enabled || !this.followUpPlanner || this.ended) return;
    if (s.kind !== 'reply' || this.userTurnSeq === 0) return;
    const turn = this.userTurnSeq;
    this.followUpTurn = { turn, userText: userText ?? this.lastUserText() ?? '', replyText: s.text, startedAt: this.now() };
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    const timer = setTimeout(() => {
      this.followUpTimer = null;
      void this.tryFollowUp();
    }, config.followup.delayMs);
    timer.unref?.();
    this.followUpTimer = timer;
  }

  private async tryFollowUp(): Promise<void> {
    const started = this.now();
    const config = this.deps.affect;
    const pending = this.followUpTurn;
    if (!config?.followup.enabled || !this.followUpPlanner || !pending) return;
    if (this.ended) { this.skipFollowUp('ended', null, started); return; }
    if (this.userSpeaking) { this.skipFollowUp('user_speech', null, started); return; }
    if (this.interrupt.active !== null) { this.skipFollowUp('interrupted', null, started); return; }
    if (this.userTurnSeq !== pending.turn) { this.skipFollowUp('stale', null, started); return; }
    if (this.followUpUsed >= config.followup.maxPerSession) { this.skipFollowUp('limit', null, started); return; }
    let plan = this.followUpPlan?.turn === pending.turn ? this.followUpPlan : null;
    if (!plan) {
      await this.waitForFollowUpPlan(pending.turn, config.followup.timeoutMs);
      plan = this.followUpPlan?.turn === pending.turn ? this.followUpPlan : null;
    }
    if (!plan) { this.skipFollowUp('planner_timeout', null, started); return; }
    const text = await plan.promise;
    if (!text) { this.skipFollowUp('planner_empty', plan.trigger, started); return; }
    const skip = followUpSkipCode({
      trigger: plan.trigger,
      cardTurn: this.affectCardTurn,
      userTurn: pending.turn,
      mainReplyHasQuestion: hasQuestionMark(pending.replyText),
      userSpeaking: this.userSpeaking,
      ended: this.ended,
      interrupted: this.interrupt.active !== null,
      used: this.followUpUsed,
      maxPerSession: config.followup.maxPerSession,
    });
    if (skip) { this.skipFollowUp(skip, plan.trigger, started); return; }
    this.followUpUsed += 1;
    log('empathy_followup', { trigger: plan.trigger, outcome: 'spoken', code: null, ms: this.now() - started });
    this.followUpTurn = null;
    this.followUpPlan = null;
    this.requestResponse('followup', {
      cue: 'followup',
      instruction: this.deps.roles.followupSpeakInstruction(this.language).replaceAll('{line}', text),
      fallbackText: text,
    });
  }

  private waitForFollowUpPlan(turn: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.followUpPlanWaiters = this.followUpPlanWaiters.filter((wake) => wake !== finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.followUpPlanWaiters.push(finish);
      if (this.followUpPlan?.turn === turn) finish();
    });
  }

  private skipFollowUp(code: string, trigger: FollowUpTrigger | null, started: number): void {
    log('empathy_followup', { trigger, outcome: 'skipped', code, ms: this.now() - started });
    this.followUpTurn = null;
    this.followUpPlan?.controller.abort();
    this.followUpPlan = null;
    for (const wake of this.followUpPlanWaiters.splice(0)) wake();
  }
```

- [ ] **Step 7: 新终稿/用户开口/结束清理**

`onUserFinal` 第一行加：

```ts
    this.cancelFollowUp('new_turn');
```

在 `if (this.dropUserFinals) return;` 后加：

```ts
    this.userTurnSeq += 1;
```

`onSpeakingEdge` 第一行加：

```ts
    this.cancelFollowUp('user_speech');
```

`end()` 在 `this.ended = true;` 后加：

```ts
    this.cancelFollowUp('ended');
```

在 `skipFollowUp` 后加：

```ts
  private cancelFollowUp(code: 'new_turn' | 'user_speech' | 'ended'): void {
    const had = this.followUpTimer !== null || this.followUpPlan !== null || this.followUpTurn !== null;
    if (this.followUpTimer) { clearTimeout(this.followUpTimer); this.followUpTimer = null; }
    if (this.followUpPlan) { this.followUpPlan.controller.abort(); this.followUpPlan = null; }
    this.followUpTurn = null;
    for (const wake of this.followUpPlanWaiters.splice(0)) wake();
    if (had) log('empathy_followup', { trigger: null, outcome: 'skipped', code, ms: 0 });
  }
```

- [ ] **Step 8: 运行目标测试**

Run: `cd gateway && npx vitest run test/empathy-followup-session.test.ts`
Expected: PASS（5 个 it）。若 `FIXTURE FOLLOWUP` 未命中，检查 T1 的 `fixedRoleCatalog` stub。

- [ ] **Step 9: 全量回归**

Run:
```bash
cd /Users/jed/SourceCode/avatar
npm test -w gateway
npm run typecheck -w gateway
git diff --check
```
Expected: 全部通过。特别注意既有 `push-seam`/`session` 测试没有因新字段/定时器出现泄漏；`afterEach` 的 `vi.useRealTimers()` 不应报 pending timers。

- [ ] **Step 10: 提交**

```bash
git add gateway/src/session/session.ts gateway/test/empathy-followup-session.test.ts
git commit -m "feat(session): deliver a delayed follow-up after the main reply

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
