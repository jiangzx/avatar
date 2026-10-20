import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseKind } from '@anyidea/protocol';
import type { ProactiveRequest } from '../src/adapters/types.ts';
import { Director, type DirectorConfig, type SilenceContext, type SilencePlan } from '../src/session/director.ts';

const cfg: DirectorConfig = {
  followupAfterMs: 8000,
  idleNoticeAfterMs: 25000,
  maxConsecutive: 2,
  maxPerWindow: 3,
  windowMs: 300000,
  contextAfterMs: 5000,
  checkAfterMs: 10000,
  leaveAfterMs: 10000,
  checkinAfterMs: 10000,
  quietPhrases: ['别说了'],
  greetingInstruction: 'G',
  greetingText: 'greeting',
  followupInstruction: 'F',
  followupText: 'followup',
  idleNoticeInstruction: 'I',
  idleNoticeText: 'idle',
  resumeInstruction: 'R',
  resumeText: 'resume',
  toolContinueInstruction: 'C',
  toolContinueText: '好。',
  memoryNoticeInstruction: 'N',
  memoryNoticeText: '记着。',
  contextInstruction: 'CTX',
  presenceInstruction: 'HERE',
  presenceText: '我在',
  checkInstruction: 'CHECK',
  checkText: '还在吗',
  leaveInstruction: 'LEAVE',
  leaveText: '先安静',
  lightPhrases: ['嗯', '哦', '好', '行', '好的', '嗯嗯', '我知道了', '知道了', '知道啦', '明白了', '明白啦'],
  topicInstruction: '聊聊{topic}',
  topics: [{ id: 'a', prompt: '天气', fallbackText: '天气不错。' }],
};

function make(c: DirectorConfig = cfg) {
  const calls: Array<[ResponseKind, string]> = [];
  const d = new Director(c, { requestResponse: (k, r) => calls.push([k, r.instruction]) });
  return { d, calls };
}

describe('Director', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('passes cue and fallback text with each request', () => {
    const reqs: ProactiveRequest[] = [];
    const d = new Director(cfg, { requestResponse: (_k, r) => reqs.push(r) });
    d.onSessionStart();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.resume();
    expect(reqs).toEqual([
      { cue: 'greeting', instruction: 'G', fallbackText: 'greeting' },
      { cue: 'followup', instruction: 'HERE', fallbackText: '我在' },
      { cue: 'followup', instruction: 'CHECK', fallbackText: '还在吗' },
      { cue: 'followup', instruction: 'LEAVE', fallbackText: '先安静' },
      { cue: 'resume', instruction: 'R', fallbackText: 'resume' },
    ]);
  });

  it('greets on session start', () => {
    const { d, calls } = make();
    d.onSessionStart();
    expect(calls).toEqual([['greeting', 'G']]);
  });

  it('swaps the copy pack on setLanguage without resetting ladder state', () => {
    const zh = { ...cfg, greetingText: 'zh-greeting', presenceText: 'zh-presence', checkText: 'zh-check' };
    const en = { ...cfg, greetingText: 'en-greeting', presenceText: 'en-presence', checkText: 'en-check' };
    const reqs: ProactiveRequest[] = [];
    const d = new Director((language) => language === 'en' ? en : zh, { requestResponse: (_k, r) => reqs.push(r) });

    d.onSessionStart();
    expect(reqs.at(-1)).toEqual({ cue: 'greeting', instruction: 'G', fallbackText: 'zh-greeting' });

    // Arm the first silence step after the opening, then swap the pack mid-ladder.
    d.onAiTurnEnded();
    d.setLanguage('en');
    vi.advanceTimersByTime(5000);
    expect(reqs.at(-1)).toEqual({ cue: 'followup', instruction: 'HERE', fallbackText: 'en-presence' });

    // The ladder moved on to its next stage instead of restarting at the greeting.
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    expect(reqs.at(-1)).toEqual({ cue: 'followup', instruction: 'CHECK', fallbackText: 'en-check' });
    expect(reqs.filter((r) => r.cue === 'greeting')).toHaveLength(1);
  });

  it('opens from memory when a snapshot exists, and introduces itself when it does not', () => {
    const withMemory = make({ ...cfg, greetingMemoryInstruction: 'MEM', greetingMemoryText: '又见到您了' });
    const reqs: ProactiveRequest[] = [];
    const remembered = new Director({ ...cfg, greetingMemoryInstruction: 'MEM', greetingMemoryText: '又见到您了' }, {
      requestResponse: (_k, r) => reqs.push(r),
    });
    remembered.onSessionStart(true);
    expect(reqs).toEqual([{ cue: 'greeting', instruction: 'MEM', fallbackText: '又见到您了' }]);
    withMemory.d.onSessionStart(false);
    expect(withMemory.calls).toEqual([['greeting', 'G']]);
  });

  it('plans a varied greeting from memory instead of a fixed line', () => {
    const contexts: SilenceContext[] = [];
    const reqs: ProactiveRequest[] = [];
    const line = '您好呀，又见面了。上次说的公园后来去了吗？';
    const d = new Director({
      ...cfg,
      silenceDecision: {
        instruction: 'D', speakInstruction: 'SAY {continuation}',
        maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
        policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      },
    }, {
      requestResponse: (_k, r) => reqs.push(r),
      planProactiveLine: context => { contexts.push(context); return { text: line }; },
      getMemorySnapshot: () => '上次聊到想去公园。',
    });
    d.onSessionStart(true);
    expect(contexts).toEqual([{
      stage: 'greeting', userText: '', assistantText: '', previousTexts: [], memorySnapshot: '上次聊到想去公园。',
    }]);
    expect(reqs).toEqual([{ cue: 'greeting', instruction: `SAY ${JSON.stringify(line)}`, fallbackText: line }]);
  });

  it('uses the deterministic name-only greeting instead of planning an invented topic', () => {
    const reqs: ProactiveRequest[] = [];
    let planned = 0;
    const d = new Director(cfg, {
      requestResponse: (_k, r) => reqs.push(r),
      planProactiveLine: () => { planned += 1; return { text: '上次聊到您喜欢听京剧' }; },
      getMemorySnapshot: () => '称呼：王叔',
      safeGreeting: () => '王叔，又见面啦，今天想聊点什么呀？',
    });
    d.onSessionStart(true);
    expect(planned).toBe(0);
    expect(reqs).toEqual([{
      cue: 'greeting',
      instruction: '王叔，又见面啦，今天想聊点什么呀？',
      fallbackText: '王叔，又见面啦，今天想聊点什么呀？',
    }]);
  });

  it('plans the first silence step after a recall question instead of speaking fallback copy', () => {
    const contexts: SilenceContext[] = [];
    const reqs: ProactiveRequest[] = [];
    const d = new Director(cfg, {
      requestResponse: (_k, r) => reqs.push(r),
      planProactiveLine: (context) => { contexts.push(context); return { text: '上次聊电影挺有意思，您想接着聊哪部？' }; },
      safeGreeting: () => 'greeting',
    });
    d.onSessionStart();
    d.onUserFinal('上次咱聊到哪了？聊电影了吗？');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    expect(contexts[0]?.userText).toBe('上次咱聊到哪了？聊电影了吗？');
    expect(reqs.some((request) => request.fallbackText === '上次聊电影挺有意思，您想接着聊哪部？')).toBe(true);
    expect(reqs.some((request) => request.fallbackText === cfg.contextText)).toBe(false);
  });

  it('falls back to configured copy when a plan is declined, and drops a stale greeting plan', async () => {
    const declined = make();
    const noPlan = new Director(cfg, {
      requestResponse: (k, r) => declined.calls.push([k, r.instruction]),
      planProactiveLine: () => null,
    });
    noPlan.onSessionStart();
    expect(declined.calls).toEqual([['greeting', 'G']]);

    const reqs: ProactiveRequest[] = [];
    let finish!: (plan: SilencePlan | null) => void;
    const late = new Director(cfg, {
      requestResponse: (_k, r) => reqs.push(r),
      planProactiveLine: () => new Promise(resolve => { finish = resolve; }),
    });
    late.onSessionStart();
    late.onUserSpeech(true);
    finish({ text: '您好呀，又见面了。今天想聊点什么？' });
    await Promise.resolve();
    expect(reqs).toEqual([]);
  });

  it('keeps a greeting plan through model-side noise but drops it on a real user turn', async () => {
    let finish!: (plan: SilencePlan | null) => void;
    const reqs: ProactiveRequest[] = [];
    const d = new Director(cfg, {
      requestResponse: (_k, r) => reqs.push(r),
      planProactiveLine: () => new Promise(resolve => { finish = resolve; }),
    });
    d.onSessionStart();
    d.onUserActivity();
    const line = '您好呀，又见面了。今天想聊点什么？';
    finish({ text: line });
    await Promise.resolve();
    expect(reqs).toEqual([{ cue: 'greeting', instruction: 'G', fallbackText: line }]);
  });

  it('plans every conversational stage, including the check-in and rest', () => {
    const stages: string[] = [];
    const d = new Director({
      ...cfg,
      restAfterMs: 180000,
      silenceDecision: {
        instruction: 'D', speakInstruction: 'SAY {continuation}',
        maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
        policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      },
    }, {
      requestResponse: () => {},
      planProactiveLine: context => { stages.push(context.stage); return { text: '接着聊' }; },
    });
    d.onSessionStart();
    d.onUserFinal('今天去公园了');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(180000);
    expect(stages).toEqual(['greeting', 'context', 'check', 'leave', 'checkin', 'rest']);
  });

  it('plans the opening follow from memory when the user has not spoken', () => {
    const contexts: SilenceContext[] = [];
    const d = new Director(cfg, {
      requestResponse: () => {},
      planProactiveLine: context => { contexts.push(context); return { text: '上次说的公园后来去了吗？' }; },
      getMemorySnapshot: () => '上次聊到想去公园。',
    });
    d.onSessionStart();
    d.onAiTurnEnded('greeting');
    vi.advanceTimersByTime(5000);
    expect(contexts[1]).toEqual({
      stage: 'context', userText: '', assistantText: 'greeting', previousTexts: [], memorySnapshot: '上次聊到想去公园。',
    });
  });

  it('uses the full memory only for the greeting and the safe view afterwards', () => {
    const contexts: SilenceContext[] = [];
    const d = new Director(cfg, {
      requestResponse: () => {},
      planProactiveLine: context => { contexts.push(context); return { text: '接着聊' }; },
      getMemorySnapshot: (stage) => stage === 'greeting' ? 'FULL' : 'SAFE',
    });
    d.onSessionStart();
    d.onAiTurnEnded('greeting');
    vi.advanceTimersByTime(5000);
    expect(contexts[0]?.memorySnapshot).toBe('FULL');
    expect(contexts[1]?.memorySnapshot).toBe('SAFE');
  });

  it('repeats the opening instead of the presence line when the greeting is cut off', () => {
    const { d, calls } = make();
    d.onSessionStart();
    d.onAssistantInterrupted();
    vi.advanceTimersByTime(799);
    expect(calls).toEqual([['greeting', 'G']]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['greeting', 'G'], ['greeting', 'G']]);
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([['greeting', 'G'], ['greeting', 'G']]);
  });

  it('says it is here, then checks, then leaves, and does not speak again', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(4999);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['followup', 'HERE']]);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    expect(calls).toEqual([['followup', 'HERE'], ['followup', 'CHECK']]);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    expect(calls).toEqual([['followup', 'HERE'], ['followup', 'CHECK'], ['followup', 'LEAVE']]);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    expect(calls).toHaveLength(3);
  });

  it('continues the opening instead of saying it is merely here', () => {
    const calls: Array<[ResponseKind, string]> = [];
    const d = new Director({ ...cfg, openingFollowInstruction: 'OPEN', openingFollowText: '称呼', memoryFollowText: '接着' }, {
      requestResponse: (k, r) => calls.push([k, r.instruction]),
    });
    d.onSessionStart(false);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([['greeting', 'G'], ['followup', 'OPEN']]);
  });

  it('anchors the first silence step to the user\'s own words', () => {
    const { d, calls } = make({ ...cfg, contextInstruction: '只围绕「{utterance}」' });
    d.onUserFinal('孙子周末来看我');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([['followup', '只围绕「孙子周末来看我」']]);
  });

  it('treats an acknowledgement of the assistant as light, not a new story', () => {
    const { d, calls } = make();
    d.onUserFinal('孙子周末来看我');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnEnded();
    d.onUserFinal('我知道了');
    vi.advanceTimersByTime(9999);
    expect(calls).toEqual([['followup', 'CTX']]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['followup', 'CTX']]);
  });

  it('continues the last concrete thing instead of a topic card', () => {
    const reqs: ProactiveRequest[] = [];
    const d = new Director(cfg, { requestResponse: (_k, r) => reqs.push(r), planProactiveLine: () => ({ text: '承接' }) });
    d.onUserFinal('孙子周末来看我');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    expect(reqs).toEqual([{ cue: 'followup', instruction: 'CTX', fallbackText: '承接' }]);
  });

  it('treats a longer sentence that merely contains a light word as new content', () => {
    const { d, calls } = make();
    d.onUserFinal('今天还行');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([['followup', 'CTX']]);
  });

  it('keeps opening checks contextual after a substantive continuation', () => {
    const openReqs: ProactiveRequest[] = [];
    const open = new Director({
      ...cfg,
      checkInstruction: 'CHECK_NAME',
      checkText: '您还方便吗，称呼不急',
      checkContextInstruction: '点到「{utterance}」，可以不回',
      checkContextText: '您还方便吗，刚才那件事先放着',
      checkMemoryInstruction: 'CHECK_MEMORY',
      checkMemoryText: '您还方便吗，刚才那件事不急',
    }, { requestResponse: (_k, r) => openReqs.push(r) });
    open.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    open.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    expect(openReqs.at(-1)).toEqual({ cue: 'followup', instruction: 'CHECK_NAME', fallbackText: '您还方便吗，称呼不急' });

    const remembered: ProactiveRequest[] = [];
    const memory = new Director({
      ...cfg,
      checkInstruction: 'CHECK_NAME',
      checkText: '您还方便吗，称呼不急',
      checkMemoryInstruction: 'CHECK_MEMORY',
      checkMemoryText: '您还方便吗，刚才那件事不急',
    }, { requestResponse: (_k, r) => remembered.push(r) });
    memory.onSessionStart(true);
    memory.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    memory.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    expect(remembered.at(-1)).toEqual({ cue: 'followup', instruction: 'CHECK_MEMORY', fallbackText: '您还方便吗，刚才那件事不急' });

    const talked: ProactiveRequest[] = [];
    const d = new Director({
      ...cfg,
      checkContextInstruction: '点到「{utterance}」，可以不回',
      checkContextText: '您还方便吗，刚才那件事先放着',
    }, { requestResponse: (_k, r) => talked.push(r), planProactiveLine: context => ({ text: `${context.stage}承接` }) });
    d.onUserFinal('孙子周末来看我');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    expect(talked).toEqual([
      { cue: 'followup', instruction: 'CTX', fallbackText: 'context承接' },
      { cue: 'followup', instruction: 'CTX', fallbackText: 'check承接' },
    ]);
  });

  it('a light reply after content waits quietly instead of starting another ladder', () => {
    const { d, calls } = make();
    d.onUserFinal('孙子周末来看我');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnEnded();
    d.onUserFinal('嗯。');
    vi.advanceTimersByTime(9999);
    expect(calls).toEqual([['followup', 'CTX']]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['followup', 'CTX']]);
    d.onAiTurnEnded();
    d.onUserFinal('好');
    vi.advanceTimersByTime(60000);
    expect(calls).toHaveLength(1);
  });

  it('fires the quiet-rest hook once per stretch when silence reaches rest', () => {
    const rests: number[] = [];
    const d = new Director(cfg, {
      requestResponse: () => {},
      onQuietRest: () => rests.push(Date.now()),
    }, false, 1_000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(999);
    expect(rests).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(rests).toHaveLength(1);
    d.onAssistantInterrupted();
    vi.advanceTimersByTime(1_000);
    expect(rests).toHaveLength(1);
    d.onUserFinal('今天去公园了');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(1_000);
    expect(rests).toHaveLength(2);
  });

  it('after the short leave, a few quiet minutes gets one looser line and then stops', () => {
    const reqs: ProactiveRequest[] = [];
    const d = new Director({ ...cfg, restAfterMs: 180000, restInstruction: 'REST', restText: '放空' }, {
      requestResponse: (_k, r) => reqs.push(r),
    });
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(179999);
    expect(reqs).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(reqs.at(-1)).toEqual({ cue: 'followup', instruction: 'REST', fallbackText: '放空' });
    d.onAiTurnEnded();
    vi.advanceTimersByTime(600000);
    expect(reqs).toHaveLength(4);
  });

  it('a light reply after the short leave does not speak at once, and the looser line can still come later', () => {
    const { d, calls } = make({ ...cfg, restAfterMs: 180000, restInstruction: 'REST', restText: '放空' });
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    d.onUserFinal('嗯');
    vi.advanceTimersByTime(179999);
    expect(calls.map((c) => c[1])).toEqual(['HERE', 'CHECK', 'LEAVE']);
    vi.advanceTimersByTime(1);
    expect(calls.at(-1)).toEqual(['followup', 'REST']);
  });

  it('starts again from the new thing after the leave line', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    d.onUserFinal('今天去公园了');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    expect(calls.at(-1)).toEqual(['followup', 'CTX']);
  });

  it('user activity cancels the timer and the next silence starts over', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(4000);
    d.onUserActivity();
    vi.advanceTimersByTime(10000);
    expect(calls).toEqual([]);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([['followup', 'HERE']]);
  });

  it('never fires while the user is speaking', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(1000);
    d.onUserSpeech(true);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(30000);
    expect(calls).toEqual([]);
    d.onUserSpeech(false);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([['followup', 'HERE']]);
  });

  it('stops after a quiet phrase without the leave line', () => {
    const { d, calls } = make();
    d.onUserFinal('你先别说了好吗');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
  });

  it('still speaks the three silence lines when the resume window is already full', () => {
    const { d, calls } = make({ ...cfg, maxPerWindow: 0 });
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(10000);
    expect(calls).toHaveLength(3);
    d.resume();
    expect(calls).toHaveLength(3);
  });

  it('is silent while muted or paused, and announces on resume', () => {
    const { d, calls } = make();
    d.setMuted(true);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    d.setMuted(false);
    d.pause();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
    d.resume();
    expect(calls).toEqual([['followup', 'R']]);
  });

  it('repeats the unfinished silence step when playback is cut off and the user is already quiet', () => {
    const { d, calls } = make();
    d.onUserFinal('今天去公园了');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnStarted();
    d.onAssistantInterrupted();
    vi.advanceTimersByTime(4999);
    expect(calls).toEqual([['followup', 'CTX']]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['followup', 'CTX'], ['followup', 'CTX']]);
  });

  it('waits for the reply after a barge-in, then continues silence', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnStarted();
    d.onUserSpeech(true);
    d.onAssistantInterrupted();
    d.onUserSpeech(false);
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual([['followup', 'HERE']]);
    d.onAiTurnStarted();
    vi.advanceTimersByTime(30000);
    expect(calls).toEqual([['followup', 'HERE']]);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([['followup', 'HERE'], ['followup', 'HERE']]);
  });

  it('speaks again when a barge-in never becomes a reply', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onAiTurnStarted();
    d.onUserSpeech(true);
    d.onUserSpeech(false);
    d.onAssistantInterrupted();
    vi.advanceTimersByTime(2499);
    expect(calls).toEqual([['followup', 'HERE']]);
    vi.advanceTimersByTime(1);
    expect(calls[1]?.[1]).toContain('没听清');
  });

  it('follows up when the user goes quiet and no reply starts (e.g. a false interruption)', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    d.onUserSpeech(true);
    d.onUserSpeech(false);
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([['followup', 'HERE']]);
  });

  it('a starting AI turn cancels the pending follow-up', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    d.onUserSpeech(true);
    d.onUserSpeech(false);
    vi.advanceTimersByTime(1500);
    d.onAiTurnStarted();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
  });

  it('does not announce the resume line after a quiet request', () => {
    const { d, calls } = make();
    d.onUserFinal('别说了');
    d.pause();
    d.resume();
    expect(calls).toEqual([]);
  });

  it('applies the per-window limit to resume announcements', () => {
    const { d, calls } = make({ ...cfg, maxPerWindow: 1 });
    d.pause();
    d.resume();
    d.pause();
    d.resume();
    expect(calls).toEqual([['followup', 'R']]);
  });

  it('releases a pause without the reconnect line and can rearm silence', () => {
    const rearm = make();
    rearm.d.pause();
    rearm.d.onAiTurnStarted();
    rearm.d.releasePause(true);
    expect(rearm.calls).toEqual([]);
    vi.advanceTimersByTime(4999);
    expect(rearm.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(rearm.calls).toEqual([['followup', 'HERE']]);

    const held = make();
    held.d.pause();
    held.d.onAiTurnStarted();
    held.d.releasePause(false);
    vi.advanceTimersByTime(60000);
    expect(held.calls).toEqual([]);
  });

  it('does nothing after stop', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    d.stop();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
  });

  it('requests the memory notice after the opening when notice is pending', () => {
    const reqs: ProactiveRequest[] = [];
    const d = new Director({
      ...cfg,
      memoryNoticeInstruction: '用下面这句告诉对方，以后聊天的内容会记住，方便下次接着聊。不要加问题。',
      memoryNoticeText: '之后咱们聊的事，我会记着，下次还能接着说。',
    }, { requestResponse: (_k, r) => reqs.push(r) }, true);
    d.onSessionStart();
    d.onAiTurnEnded();
    expect(reqs).toEqual([
      { cue: 'greeting', instruction: 'G', fallbackText: 'greeting' },
      {
        cue: 'memoryNotice',
        instruction: '用下面这句告诉对方，以后聊天的内容会记住，方便下次接着聊。不要加问题。',
        fallbackText: '之后咱们聊的事，我会记着，下次还能接着说。',
      },
    ]);
  });

  it('retries a cancelled memory notice at the next idle, ignoring the cap and quiet phrases', () => {
    const reqs: ProactiveRequest[] = [];
    const d = new Director({
      ...cfg,
      maxPerWindow: 0,
      memoryNoticeInstruction: '用下面这句告诉对方，以后聊天的内容会记住，方便下次接着聊。不要加问题。',
      memoryNoticeText: '之后咱们聊的事，我会记着，下次还能接着说。',
    }, { requestResponse: (_k, r) => reqs.push(r) }, true);
    d.onSessionStart();
    d.onAiTurnEnded();
    d.onAiTurnStarted();
    d.onUserSpeech(true);
    d.onAssistantInterrupted();
    expect(reqs.filter((r) => r.cue === 'memoryNotice')).toHaveLength(1);
    d.onUserSpeech(false);
    expect(reqs.filter((r) => r.cue === 'memoryNotice')).toHaveLength(1);
    d.onUserFinal('别说了');
    expect(reqs.filter((r) => r.cue === 'memoryNotice')).toEqual([
      {
        cue: 'memoryNotice',
        instruction: '用下面这句告诉对方，以后聊天的内容会记住，方便下次接着聊。不要加问题。',
        fallbackText: '之后咱们聊的事，我会记着，下次还能接着说。',
      },
      {
        cue: 'memoryNotice',
        instruction: '用下面这句告诉对方，以后聊天的内容会记住，方便下次接着聊。不要加问题。',
        fallbackText: '之后咱们聊的事，我会记着，下次还能接着说。',
      },
    ]);
  });

  it('requests the notice again when a turn ends before playback has ended', () => {
    const reqs: ProactiveRequest[] = [];
    const d = new Director({
      ...cfg,
      memoryNoticeInstruction: '用下面这句告诉对方，以后聊天的内容会记住，方便下次接着聊。不要加问题。',
      memoryNoticeText: '之后咱们聊的事，我会记着，下次还能接着说。',
    }, { requestResponse: (_k, r) => reqs.push(r) }, true);
    d.onSessionStart();
    d.onAiTurnEnded();
    d.onAiTurnStarted();
    d.onAiTurnEnded();
    expect(reqs.filter((r) => r.cue === 'memoryNotice')).toHaveLength(2);
    d.onNoticePlayed();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    expect(reqs.filter((r) => r.cue === 'memoryNotice')).toHaveLength(2);
    expect(reqs.at(-1)?.cue).toBe('followup');
  });
});
