import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadDirectorConfig } from '../src/config.ts';
import type { ProactiveRequest } from '../src/adapters/types.ts';
import { Director, type DirectorDeps, type SilenceContext } from '../src/session/director.ts';

const base = loadDirectorConfig(
  fileURLToPath(new URL('../roles/elder-companion/zh/director.json', import.meta.url)),
);
const cfg = {
  ...base,
  contextInstruction: 'READ {continuation}',
  contextAfterMs: base.contextAfterMs ?? 6_000,
  checkAfterMs: base.checkAfterMs ?? 8_000,
  leaveAfterMs: base.leaveAfterMs ?? 10_000,
  checkinAfterMs: base.checkinAfterMs ?? 10_000,
  restAfterMs: base.restAfterMs ?? 180_000,
};

function setup(planProactiveLine?: DirectorDeps['planProactiveLine']) {
  const requests: ProactiveRequest[] = [];
  let rests = 0;
  const d = new Director(cfg, {
    requestResponse: (_kind, request) => requests.push(request),
    onQuietRest: () => { rests++; },
    ...(planProactiveLine ? { planProactiveLine } : {}),
  });
  const answer = () => {
    d.onUserFinal('今天走了很多路，脚有点酸。');
    d.onAiTurnStarted();
    d.onAiTurnEnded('今天走了不少地方。');
  };
  return { d, requests, answer, restCount: () => rests };
}

describe('substantive conversation silence', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps the configured ladder when no planner is available', async () => {
    const s = setup();
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.requests).toHaveLength(1);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.contextText);
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs);
    expect(s.requests).toHaveLength(2);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.checkContextText);
    await vi.advanceTimersByTimeAsync(cfg.leaveAfterMs);
    expect(s.requests).toHaveLength(3);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.leaveText);
    await vi.advanceTimersByTimeAsync(cfg.checkinAfterMs);
    expect(s.requests).toHaveLength(4);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.checkinText);
    await vi.advanceTimersByTimeAsync(cfg.restAfterMs);
    expect(s.restCount()).toBe(1);
    s.d.stop();
  });

  it('drops a pending memory notice when consent is declined', () => {
    const requests: ProactiveRequest[] = [];
    const d = new Director(cfg, { requestResponse: (_kind, request) => requests.push(request) }, true);
    d.cancelNotice();
    d.onAiTurnEnded();
    expect(requests).toHaveLength(0);
    d.stop();
  });

  it('speaks the configured four-step ladder when the planner declines', async () => {
    const contexts: Array<{ stage: string; previousTexts: readonly string[] }> = [];
    const s = setup((context) => { contexts.push(context); return null; });
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.requests.map((r) => r.fallbackText)).toEqual([cfg.contextText]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.contextText);
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs);
    expect(s.requests.map((r) => r.fallbackText)).toEqual([cfg.contextText, cfg.checkContextText]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.checkContextText);
    await vi.advanceTimersByTimeAsync(cfg.leaveAfterMs);
    expect(s.requests.map((r) => r.fallbackText)).toEqual([cfg.contextText, cfg.checkContextText, cfg.leaveText]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.leaveText);
    await vi.advanceTimersByTimeAsync(cfg.checkinAfterMs);
    expect(s.requests.map((r) => r.fallbackText)).toEqual([cfg.contextText, cfg.checkContextText, cfg.leaveText, cfg.checkinText]);
    expect(contexts.map((c) => ({ stage: c.stage, previousTexts: c.previousTexts }))).toEqual([
      { stage: 'context', previousTexts: [] },
      { stage: 'check', previousTexts: [cfg.contextText] },
      { stage: 'leave', previousTexts: [cfg.contextText, cfg.checkContextText] },
      { stage: 'checkin', previousTexts: [cfg.contextText, cfg.checkContextText, cfg.leaveText] },
    ]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.checkinText);
    await vi.advanceTimersByTimeAsync(cfg.restAfterMs);
    expect(s.restCount()).toBe(1);
    s.d.stop();
  });

  it('plans every stage with the previous lines and speaks the generated text', async () => {
    const contexts: Array<{ stage: string; userText: string; assistantText: string; previousTexts: readonly string[] }> = [];
    const s = setup((context) => {
      contexts.push(context);
      return { text: `${context.stage}承接` };
    });
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.requests.at(-1)?.fallbackText).toBe('context承接');
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('context承接');
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs);
    expect(s.requests.at(-1)?.fallbackText).toBe('check承接');
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('check承接');
    await vi.advanceTimersByTimeAsync(cfg.leaveAfterMs);
    expect(s.requests.at(-1)?.fallbackText).toBe('leave承接');
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('leave承接');
    await vi.advanceTimersByTimeAsync(cfg.checkinAfterMs);
    // The fourth stage is planned too; its content check lives in the planner.
    expect(s.requests.at(-1)).toEqual({ cue: 'followup', instruction: 'READ "checkin承接"', fallbackText: 'checkin承接' });
    expect(contexts).toEqual([
      { stage: 'context', userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。', previousTexts: [], memorySnapshot: '' },
      { stage: 'check', userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。', previousTexts: ['context承接'], memorySnapshot: '' },
      { stage: 'leave', userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。', previousTexts: ['context承接', 'check承接'], memorySnapshot: '' },
      { stage: 'checkin', userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。', previousTexts: ['context承接', 'check承接', 'leave承接'], memorySnapshot: '' },
    ]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('checkin承接');
    await vi.advanceTimersByTimeAsync(cfg.restAfterMs);
    expect(s.restCount()).toBe(1);
    s.d.stop();
  });

  it('stops the ladder when the planner reports a clear ending', async () => {
    let calls = 0;
    const s = setup(() => { calls++; return { text: null, close: true }; });
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.requests).toEqual([]);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(600000);
    expect(s.requests).toEqual([]);
    expect(s.restCount()).toBe(0);
    s.d.stop();
  });

  it('uses the actual last exchange and then continues the planned ladder', async () => {
    const contexts: Array<{ stage: string; userText: string; assistantText: string; previousTexts: readonly string[] }> = [];
    const s = setup((context) => {
      contexts.push(context);
      return { text: context.stage === 'context' ? '走累了，脚酸着也不好受。' : `${context.stage}承接` };
    });
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs - 1);
    expect(s.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(contexts[0]).toEqual({ stage: 'context', userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。', previousTexts: [], memorySnapshot: '' });
    expect(s.requests).toEqual([{
      cue: 'followup', instruction: 'READ "走累了，脚酸着也不好受。"', fallbackText: '走累了，脚酸着也不好受。',
    }]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('走累了，脚酸着也不好受。');
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs);
    expect(s.requests).toHaveLength(2);
    expect(s.requests.at(-1)).toEqual({ cue: 'followup', instruction: 'READ "check承接"', fallbackText: 'check承接' });
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('check承接');
    await vi.advanceTimersByTimeAsync(cfg.leaveAfterMs);
    expect(s.requests).toHaveLength(3);
    expect(s.requests.at(-1)).toEqual({ cue: 'followup', instruction: 'READ "leave承接"', fallbackText: 'leave承接' });
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('leave承接');
    await vi.advanceTimersByTimeAsync(cfg.checkinAfterMs);
    expect(s.requests).toHaveLength(4);
    // Qwen renders `instruction`; a verbatim (direct-TTS) adapter would speak `fallbackText`. Both get the planned check-in.
    expect(s.requests.at(-1)).toEqual({ cue: 'followup', instruction: 'READ "checkin承接"', fallbackText: 'checkin承接' });
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.checkinText);
    await vi.advanceTimersByTimeAsync(cfg.restAfterMs);
    expect(s.restCount()).toBe(1);
    expect(contexts.map((c) => c.stage)).toEqual(['context', 'check', 'leave', 'checkin', 'rest']);
    s.d.stop();
  });

  it.each(['speech', 'activity', 'reply', 'mute', 'pause', 'stop', 'quiet', 'newContent'] as const)(
    'aborts and discards a late decision after %s', async event => {
      let finish!: (plan: { text: string }) => void;
      let signal!: AbortSignal;
      const s = setup((_context, current) => { signal = current; return new Promise(resolve => { finish = resolve; }); });
      s.answer();
      await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
      if (event === 'speech') s.d.onUserSpeech(true);
      if (event === 'activity') s.d.onUserActivity();
      if (event === 'reply') s.d.onAiTurnStarted();
      if (event === 'mute') s.d.setMuted(true);
      if (event === 'pause') s.d.pause();
      if (event === 'stop') s.d.stop();
      if (event === 'quiet') s.d.onUserFinal('安静一会');
      if (event === 'newContent') s.d.onUserFinal('我们聊聊树吧。');
      expect(signal).toBeDefined();
      expect(signal.aborted).toBe(true);
      finish({ text: '走累了，脚酸着也不好受。' });
      await vi.advanceTimersByTimeAsync(1);
      expect(s.requests).toEqual([]);
      s.d.stop();
    },
  );

  it('keeps the proactive ladder when the optional decision rejects', async () => {
    let calls = 0;
    const s = setup(async () => { calls++; throw new Error('synthetic_failure'); });
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.requests.map((r) => r.fallbackText)).toEqual([cfg.contextText]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.contextText);
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs);
    expect(s.requests.map((r) => r.fallbackText)).toEqual([cfg.contextText, cfg.checkContextText]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.checkContextText);
    await vi.advanceTimersByTimeAsync(cfg.leaveAfterMs);
    expect(s.requests.map((r) => r.fallbackText)).toEqual([cfg.contextText, cfg.checkContextText, cfg.leaveText]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.leaveText);
    await vi.advanceTimersByTimeAsync(cfg.checkinAfterMs);
    expect(s.requests.map((r) => r.fallbackText)).toEqual([cfg.contextText, cfg.checkContextText, cfg.leaveText, cfg.checkinText]);
    expect(calls).toBe(4);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.checkinText);
    await vi.advanceTimersByTimeAsync(cfg.restAfterMs);
    expect(calls).toBe(5);
    expect(s.restCount()).toBe(1);
    s.d.stop();
  });

  it('releases quiet only when new substantive content arrives', async () => {
    const s = setup(() => ({ text: '走累了，脚酸着也不好受。' }));
    s.d.onUserFinal('安静一会');
    s.d.onUserFinal('嗯');
    s.d.onAiTurnEnded('好。');
    await vi.advanceTimersByTimeAsync(600000);
    expect(s.requests).toEqual([]);
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.requests).toHaveLength(1);
    s.d.stop();
  });

  it('stays quiet after an acknowledgement in a substantive conversation', async () => {
    const s = setup(() => ({ text: '走累了，脚酸着也不好受。' }));
    s.answer();
    s.d.onUserFinal('我知道了。');
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('嗯。');
    await vi.advanceTimersByTimeAsync(600000);
    expect(s.requests).toEqual([]);
    s.d.stop();
  });

  it('does not pair a reconnect announcement with the previous user turn', async () => {
    const contexts: unknown[] = [];
    const s = setup(context => { contexts.push(context); return { text: '走累了，脚酸着也不好受。' }; });
    s.answer();
    s.d.pause();
    s.d.resume();
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.cue).toBe('resume');
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('又连上了。');
    await vi.advanceTimersByTimeAsync(600000);
    expect(contexts).toEqual([]);
    expect(s.requests).toHaveLength(1);
    s.d.stop();
  });

  // Regression: a substantive reply must keep the configured proactive ladder.
  it('continues context through check, leave and checkin after an approved context continuation', async () => {
    const s = setup((context) => ({ text: context.stage === 'context' ? '走累了，脚酸着也不好受。' : `${context.stage}承接` }));
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.requests).toHaveLength(1);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('走累了，脚酸着也不好受。');
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs - 1);
    expect(s.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.requests).toHaveLength(2);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('check承接');
    await vi.advanceTimersByTimeAsync(cfg.leaveAfterMs - 1);
    expect(s.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.requests).toHaveLength(3);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('leave承接');
    await vi.advanceTimersByTimeAsync(cfg.checkinAfterMs - 1);
    expect(s.requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.requests).toHaveLength(4);
    expect(s.requests.map((request) => request.fallbackText)).toEqual([
      '走累了，脚酸着也不好受。',
      'check承接',
      'leave承接',
      'checkin承接',
    ]);
    s.d.stop();
  });

  it('never repeats a planned line from an earlier stage: the stage copy speaks instead', async () => {
    const stages: string[] = [];
    const { d, requests } = setup((context) => {
      stages.push(context.stage);
      return { text: '同一句。' };
    });
    d.onUserFinal('今天走了很多路，脚有点酸。');
    d.onAiTurnStarted();
    d.onAiTurnEnded('今天走了不少地方。');
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(requests.at(-1)?.fallbackText).toBe('同一句。');
    d.onAiTurnStarted();
    d.onAiTurnEnded('同一句。');
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs);
    expect(stages).toEqual(['context', 'check']);
    expect(requests.at(-1)?.fallbackText).not.toBe('同一句。');
    expect(requests.at(-1)?.fallbackText.length).toBeGreaterThan(0);
    d.stop();
  });

  it('re-runs the interrupted silence step after a noise-hearing repair', async () => {
    const s = setup();
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded();
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded();
    await vi.advanceTimersByTimeAsync(cfg.leaveAfterMs);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded();
    await vi.advanceTimersByTimeAsync(cfg.checkinAfterMs);
    s.d.onAiTurnStarted();
    expect(s.requests).toHaveLength(4);
    s.d.onUserSpeech(true);
    s.d.onUserSpeech(false);
    s.d.onAssistantInterrupted();
    await vi.advanceTimersByTimeAsync(2500);
    expect(s.requests.at(-1)?.fallbackText).toBe('没听清，您再说一遍。');
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('没听清，您再说一遍。');
    await vi.advanceTimersByTimeAsync(cfg.checkinAfterMs);
    expect(s.requests).toHaveLength(6);
    expect(s.requests.at(-1)?.fallbackText).not.toBe('没听清，您再说一遍。');
    s.d.stop();
  });

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
});

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
