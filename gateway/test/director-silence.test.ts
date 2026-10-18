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
};

function setup(planContext?: DirectorDeps['planContext']) {
  const requests: ProactiveRequest[] = [];
  let rests = 0;
  const d = new Director(cfg, {
    requestResponse: (_kind, request) => requests.push(request),
    onQuietRest: () => { rests++; },
    ...(planContext ? { planContext } : {}),
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

  it.each(['missing', 'skip'] as const)('never requests speech after a %s decision, but still extracts at rest', async mode => {
    const s = setup(mode === 'skip' ? () => null : undefined);
    s.answer();
    await vi.advanceTimersByTimeAsync(182999);
    expect(s.requests).toEqual([]);
    expect(s.restCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.restCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(600000);
    expect(s.requests).toEqual([]);
    expect(s.restCount()).toBe(1);
    s.d.stop();
  });

  it('uses the actual last exchange and speaks one approved continuation without a generic ladder', async () => {
    const contexts: unknown[] = [];
    const s = setup(context => { contexts.push(context); return '走累了，脚酸着也不好受。'; });
    s.answer();
    await vi.advanceTimersByTimeAsync(2999);
    expect(s.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(contexts).toEqual([{ userText: '今天走了很多路，脚有点酸。', assistantText: '今天走了不少地方。' }]);
    expect(s.requests).toEqual([{
      cue: 'followup', instruction: 'READ "走累了，脚酸着也不好受。"', fallbackText: '走累了，脚酸着也不好受。',
    }]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('走累了，脚酸着也不好受。');
    await vi.advanceTimersByTimeAsync(600000);
    expect(s.requests).toHaveLength(1);
    expect(s.restCount()).toBe(1);
    s.d.stop();
  });

  it.each(['speech', 'activity', 'reply', 'mute', 'pause', 'stop', 'quiet', 'newContent'] as const)(
    'aborts and discards a late decision after %s', async event => {
      let finish!: (text: string) => void;
      let signal!: AbortSignal;
      const s = setup((_context, current) => { signal = current; return new Promise(resolve => { finish = resolve; }); });
      s.answer();
      await vi.advanceTimersByTimeAsync(3000);
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
      finish('走累了，脚酸着也不好受。');
      await vi.advanceTimersByTimeAsync(1);
      expect(s.requests).toEqual([]);
      s.d.stop();
    },
  );

  it('does not treat a rejected optional decision as a reason to speak', async () => {
    const s = setup(async () => { throw new Error('synthetic_failure'); });
    s.answer();
    await vi.advanceTimersByTimeAsync(600000);
    expect(s.requests).toEqual([]);
    s.d.stop();
  });

  it('releases quiet only when new substantive content arrives', async () => {
    const s = setup(() => '走累了，脚酸着也不好受。');
    s.d.onUserFinal('安静一会');
    s.d.onUserFinal('嗯');
    s.d.onAiTurnEnded('好。');
    await vi.advanceTimersByTimeAsync(600000);
    expect(s.requests).toEqual([]);
    s.answer();
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.requests).toHaveLength(1);
    s.d.stop();
  });

  it('stays quiet after an acknowledgement in a substantive conversation', async () => {
    const s = setup(() => '走累了，脚酸着也不好受。');
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
    const s = setup(context => { contexts.push(context); return '走累了，脚酸着也不好受。'; });
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

  it('does not restart the silence ladder after a noise-hearing repair', async () => {
    const s = setup();
    s.d.onAiTurnEnded();
    for (const wait of [3000, 6000, 6000]) {
      await vi.advanceTimersByTimeAsync(wait);
      s.d.onAiTurnStarted();
      if (wait === 3000 || s.requests.length < 3) s.d.onAiTurnEnded();
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
