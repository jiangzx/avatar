import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadDirectorConfig } from '../src/config.ts';
import type { ProactiveRequest } from '../src/adapters/types.ts';
import { Director, type DirectorDeps } from '../src/session/director.ts';

const { silenceDecision: _decisionConfig, ...base } = loadDirectorConfig(
  fileURLToPath(new URL('../roles/elder-companion/director.json', import.meta.url)),
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

function setup(planSilenceLine?: DirectorDeps['planSilenceLine']) {
  const requests: ProactiveRequest[] = [];
  let rests = 0;
  const d = new Director(cfg, {
    requestResponse: (_kind, request) => requests.push(request),
    onQuietRest: () => { rests++; },
    ...(planSilenceLine ? { planSilenceLine } : {}),
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
    expect(s.requests.at(-1)?.fallbackText).toBe('checkin承接');
    expect(contexts).toEqual([
      { stage: 'context', userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。', previousTexts: [] },
      { stage: 'check', userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。', previousTexts: ['context承接'] },
      { stage: 'leave', userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。', previousTexts: ['context承接', 'check承接'] },
      { stage: 'checkin', userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。', previousTexts: ['context承接', 'check承接', 'leave承接'] },
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
    expect(contexts[0]).toEqual({ stage: 'context', userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。', previousTexts: [] });
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
    // Qwen renders `instruction`; Seeduplex speaks `fallbackText`. Both carry the planned line.
    expect(s.requests.at(-1)).toEqual({ cue: 'followup', instruction: 'READ "checkin承接"', fallbackText: 'checkin承接' });
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('checkin承接');
    await vi.advanceTimersByTimeAsync(cfg.restAfterMs);
    expect(s.restCount()).toBe(1);
    expect(contexts.map((c) => c.stage)).toEqual(['context', 'check', 'leave', 'checkin']);
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

  it('does not restart the silence ladder after a noise-hearing repair', async () => {
    const s = setup();
    s.d.onAiTurnEnded();
    for (const wait of [cfg.contextAfterMs, cfg.checkAfterMs, cfg.leaveAfterMs]) {
      await vi.advanceTimersByTimeAsync(wait);
      s.d.onAiTurnStarted();
      if (wait === cfg.contextAfterMs || s.requests.length < 3) s.d.onAiTurnEnded();
    }
    expect(s.requests).toHaveLength(3);
    s.d.onUserSpeech(true);
    s.d.onUserSpeech(false);
    s.d.onAssistantInterrupted();
    await vi.advanceTimersByTimeAsync(2500);
    expect(s.requests.at(-1)?.fallbackText).toBe('没听清，您再说一遍。');
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('没听清，您再说一遍。');
    await vi.advanceTimersByTimeAsync(600000);
    expect(s.requests).toHaveLength(4);
    s.d.stop();
  });
});
