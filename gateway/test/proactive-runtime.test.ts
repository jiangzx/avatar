import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadDirectorConfig } from '../src/config.ts';
import { loadI18n } from '../src/i18n/load.ts';
import type { Logger } from '../src/log/logger.ts';
import type { MemoryStore, ThreadRecord } from '../src/memory/store.ts';
import type { AffectCard } from '../src/session/affect.ts';
import { AcceptanceTracker } from '../src/session/proactive/acceptance.ts';
import { loadProactivity } from '../src/session/proactive/config.ts';
import { speakLineRequest } from '../src/session/proactive/render.ts';
import { nextTier, ProactiveRuntime, type SilenceInput } from '../src/session/proactive/runtime.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cfg = loadProactivity(`${root}config/proactivity.json`);
const zh = loadDirectorConfig(`${root}roles/elder-companion/zh/director.json`);
const i18n = loadI18n(`${root}config`);
const DAY = 86_400_000;
const AFTERNOON = Date.parse('2026-11-03T15:00:00+08:00');
const TOPICS = [{ id: 'meal', prompt: '今天吃了什么好吃的', fallbackText: '您今天吃了点什么好吃的？' }];

function fakeStore(over: Record<string, unknown> = {}) {
  const store = {
    getProactiveTier: vi.fn((): string | undefined => undefined),
    setProactiveTier: vi.fn(),
    proactiveStats: vi.fn(() => [] as Array<{ kind: string; accepted: number; rejected: number }>),
    recordProactiveOutcome: vi.fn(),
    proactiveDaily: vi.fn(() => 0),
    incrementProactiveDaily: vi.fn(() => 1),
    listOpenThreads: vi.fn(() => [] as ThreadRecord[]),
    markThreadMentioned: vi.fn(() => true),
    closeThread: vi.fn(() => true),
    listMoodSummaries: vi.fn(() => []),
    relationshipStats: vi.fn(() => ({ firstMetAt: null, sessions: 0, totalMinutes: 0, activeDays: 0, lastSessionAt: null, hourHistogram: Array(24).fill(0) })),
    recentUserMessages: vi.fn(() => [] as Array<{ text: string }>),
    recentFallbackLines: vi.fn(() => [] as number[]),
    recordFallbackLine: vi.fn(),
    proactiveLastAt: vi.fn((): number | null => null),
    ...over,
  };
  return store;
}
const fakeLogger = () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  return logger;
};

function setup(opts: { store?: ReturnType<typeof fakeStore>; persist?: boolean; intents?: boolean; topics?: typeof TOPICS } = {}) {
  let now = AFTERNOON;
  const store = opts.store ?? fakeStore();
  const logger = fakeLogger();
  const runtime = new ProactiveRuntime({
    cfg,
    sessionId: 's-now',
    store: store as unknown as MemoryStore,
    ownerId: 'o1',
    agentId: 'a1',
    now: () => now,
    canPersist: () => opts.persist ?? true,
    copy: () => (opts.intents === false
      ? { topics: opts.topics ?? TOPICS, quietPhrases: zh.quietPhrases }
      : { intents: zh.intents, fallbacks: zh.fallbacks, topics: opts.topics ?? TOPICS, quietPhrases: zh.quietPhrases }),
    rules: () => ({ silence: i18n.silence.zh, healthWords: i18n.memory.zh.healthWords, declinePhrases: i18n.affect.zh.declinePhrases, evidence: i18n.evidence }),
    logger: logger as unknown as Logger,
  });
  return { runtime, store, logger, advance: (ms: number) => { now += ms; }, at: () => now };
}

const input = (over: Partial<SilenceInput> = {}): SilenceInput => ({
  step: 'context', language: 'zh', hadContent: true, lastUtterance: '我家那盆君子兰今年还没开花。',
  knownName: true, card: null, lowIntensity: 2, ...over,
});
const thread = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: 't1', kind: 'concern', quote: '我有高血压，这几天量着有点高。', dueAt: AFTERNOON, sensitive: true, mentionCount: 0,
  lastMentionedAt: null, createdAt: AFTERNOON - 3 * DAY, sourceSessionId: 's-old', ...over,
});
const crisis: AffectCard = { emotion: 'sad', intensity: 3, trend: 'worse', need: 'vent', strategy: 'comfort', mismatch: false, crisis: true };
const requestOf = (r: ReturnType<ProactiveRuntime['silenceLine']>) => (r && 'request' in r ? r.request : null);

describe('silenceLine', () => {
  it('falls back to configured copy without intents, or before a name is known and nothing was said', () => {
    expect(setup({ intents: false }).runtime.silenceLine(input())).toBeNull();
    expect(setup().runtime.silenceLine(input({ hadContent: false, knownName: false }))).toBeNull();
  });

  it('continues the user’s own statement after a pause', () => {
    const { runtime, logger } = setup();
    const request = requestOf(runtime.silenceLine(input()))!;
    expect(request.instruction).toContain('【我家那盆君子兰今年还没开花。】');
    expect(request.instruction).toContain('刚才');
    expect(zh.fallbacks!.continueThread).toContain(request.fallbackText);
    expect(request.instruction).not.toContain(zh.intents!.withCare);
    expect(logger.info).toHaveBeenCalledWith('proactive_decision', expect.objectContaining({ moment: 'silenceContext', kind: 'continueThread', score: 0.68, tier: 'moderate', fallback: false }));
  });

  it('never uses a question as material (pitfall 1); a topic card is offered instead', () => {
    const request = requestOf(setup().runtime.silenceLine(input({ lastUtterance: '上次聊到哪儿了？' })))!;
    expect(request.instruction).not.toContain('上次聊到哪儿了');
    expect(request.instruction).toContain('【今天吃了什么好吃的】');
  });

  it('puts a health thread quote in the instruction and keeps the sensitive fallback', () => {
    const store = fakeStore({ listOpenThreads: vi.fn(() => [thread()]) });
    const request = requestOf(setup({ store }).runtime.silenceLine(input({ hadContent: false })))!;
    expect(request.instruction).toContain('【我有高血压，这几天量着有点高。】');
    expect(request.instruction).toContain(zh.intents!.withCare);
    expect(zh.fallbacks!.threadSensitive).toContain(request.fallbackText);
  });

  it('puts a health open-loop quote in the instruction and keeps the continue fallback', () => {
    const request = requestOf(setup().runtime.silenceLine(input({ lastUtterance: '最近膝盖疼得睡不着。' })))!;
    expect(request.instruction).toContain('【最近膝盖疼得睡不着。】');
    expect(request.instruction).toContain(zh.intents!.withCare);
    expect(zh.fallbacks!.continueThread).toContain(request.fallbackText);
  });

  it('grounds the family nudge in a remembered line without health words', () => {
    const store = fakeStore({ recentUserMessages: vi.fn(() => [{ text: '女儿陪我去医院复查了。' }, { text: '闺女在深圳工作，一年也就回来一两趟。' }]) });
    const request = requestOf(setup({ store, topics: [] }).runtime.silenceLine(input({ hadContent: false })))!;
    expect(request.instruction).toContain('【闺女在深圳工作，一年也就回来一两趟。】');
    expect(request.instruction).toContain('之前');
    expect(store.recentUserMessages).toHaveBeenCalledWith('o1', 'a1', cfg.material.familyLookback);
  });

  it('nudges toward family at most once per minIntervalDays', () => {
    const family = { recentUserMessages: vi.fn(() => [{ text: '闺女在深圳工作，一年也就回来一两趟。' }]) };
    const recent = fakeStore({ ...family, proactiveLastAt: vi.fn(() => AFTERNOON - 3 * DAY) });
    expect(setup({ store: recent, topics: [] }).runtime.silenceLine(input({ hadContent: false }))).toEqual({ quiet: true });
    const old = fakeStore({ ...family, proactiveLastAt: vi.fn(() => AFTERNOON - 8 * DAY) });
    expect(requestOf(setup({ store: old, topics: [] }).runtime.silenceLine(input({ hadContent: false })))!.instruction).toContain('闺女');
  });

  it('stays quiet in the quiet tier and in a crisis, but always checks in and rests', () => {
    const quietTier = setup({ store: fakeStore({ getProactiveTier: vi.fn(() => 'quiet') }) });
    expect(quietTier.runtime.silenceLine(input())).toEqual({ quiet: true });
    const checkin = requestOf(quietTier.runtime.silenceLine(input({ step: 'checkin' })))!;
    expect(zh.fallbacks!.presenceCheck).toContain(checkin.fallbackText);
    // checkin asks whether the user is still there; only rest bans questions.
    expect(checkin.instruction).not.toContain(zh.intents!.noQuestion);
    const s = setup();
    expect(s.runtime.silenceLine(input({ card: crisis }))).toEqual({ quiet: true });
    const rest = requestOf(s.runtime.silenceLine(input({ step: 'rest', card: crisis })))!;
    expect(rest.instruction).toContain(zh.intents!.purposes.restQuiet);
    expect(rest.instruction).toContain(zh.intents!.noQuestion);
  });

  it('stops the ladder once the user says goodbye, until they say something else', () => {
    const { runtime } = setup();
    runtime.onUserFinal('好了，我去睡了', false, 'zh');
    expect(runtime.silenceLine(input())).toEqual({ close: true });
    runtime.onUserFinal('嗯', true, 'zh');
    expect(runtime.silenceLine(input())).toEqual({ close: true });
    runtime.onUserFinal('等等，还有件事想跟你说。', false, 'zh');
    expect(requestOf(runtime.silenceLine(input()))).not.toBeNull();
  });

  it('decides on empty context when the store fails', () => {
    const store = fakeStore({ listOpenThreads: vi.fn(() => { throw new Error('sqlite_busy'); }) });
    const s = setup({ store });
    expect(requestOf(s.runtime.silenceLine(input({ lastUtterance: '上次聊到哪儿了？' })))!.instruction).toContain('今天吃了什么好吃的');
    expect(s.logger.warn).toHaveBeenCalledWith('proactive_prefetch_failed', { code: 'store_error' });
  });

  it('retries prefetch after a store failure and then honours a saved quiet tier', () => {
    const getProactiveTier = vi.fn()
      .mockImplementationOnce(() => { throw new Error('sqlite_busy'); })
      .mockReturnValueOnce('quiet');
    const store = fakeStore({ getProactiveTier });
    const s = setup({ store });
    expect(s.runtime.silenceLine(input())).not.toEqual({ quiet: true });
    expect(s.logger.warn).toHaveBeenCalledWith('proactive_prefetch_failed', { code: 'store_error' });
    expect(s.runtime.silenceLine(input())).toEqual({ quiet: true });
    expect(getProactiveTier).toHaveBeenCalledTimes(2);
  });

  it('retries prefetch on the next Beijing day after a successful load then a store failure', () => {
    const getProactiveTier = vi.fn()
      .mockReturnValueOnce('quiet')
      .mockImplementationOnce(() => { throw new Error('sqlite_busy'); })
      .mockReturnValueOnce('quiet');
    const store = fakeStore({ getProactiveTier });
    const s = setup({ store });
    expect(s.runtime.silenceLine(input())).toEqual({ quiet: true });
    s.advance(DAY);
    expect(s.runtime.silenceLine(input())).not.toEqual({ quiet: true });
    expect(s.logger.warn).toHaveBeenCalledWith('proactive_prefetch_failed', { code: 'store_error' });
    expect(s.runtime.silenceLine(input())).toEqual({ quiet: true });
    expect(getProactiveTier).toHaveBeenCalledTimes(3);
  });
});

describe('counting, mentions and persistence', () => {
  it('counts a started line, marks the thread, remembers the fallback line, and offers the thread once', () => {
    const store = fakeStore({ listOpenThreads: vi.fn(() => [thread()]) });
    const s = setup({ store });
    const request = requestOf(s.runtime.silenceLine(input({ hadContent: false })))!;
    expect(s.runtime.owns(request)).toBe(true);
    s.runtime.onLineStarted(request);
    expect(store.markThreadMentioned).toHaveBeenCalledWith('o1', 't1', AFTERNOON);
    expect(store.incrementProactiveDaily).toHaveBeenCalledWith('o1', 'a1', '2026-11-03');
    // Health quotes are no longer fallbackOnly, so the line is recorded only if the timeout path speaks it.
    expect(store.recordFallbackLine).not.toHaveBeenCalled();
    expect(zh.fallbacks!.threadSensitive).toContain(request.fallbackText);
    s.runtime.onLineEnded(zh.fallbacks!.threadSensitive[0]!, false);
    const next = requestOf(s.runtime.silenceLine(input({ step: 'check', hadContent: false })))!;
    expect(next.instruction).toContain('今天吃了什么好吃的');
  });

  it('keeps counts in memory only when memory is not allowed', () => {
    const store = fakeStore({ listOpenThreads: vi.fn(() => [thread()]) });
    const s = setup({ store, persist: false });
    const request = requestOf(s.runtime.silenceLine(input({ hadContent: false })))!;
    s.runtime.onLineStarted(request);
    s.runtime.onUserFinal('你少说点吧', false, 'zh');
    expect(store.markThreadMentioned).not.toHaveBeenCalled();
    expect(store.incrementProactiveDaily).not.toHaveBeenCalled();
    expect(store.recordFallbackLine).not.toHaveBeenCalled();
    expect(store.setProactiveTier).not.toHaveBeenCalled();
    expect(store.recordProactiveOutcome).not.toHaveBeenCalled();
  });

  it('drops a refused request without counting it', () => {
    const store = fakeStore();
    const s = setup({ store });
    const request = requestOf(s.runtime.silenceLine(input()))!;
    s.runtime.onRequestRefused(request);
    expect(s.runtime.owns(request)).toBe(false);
    s.runtime.onLineStarted(request);
    expect(store.incrementProactiveDaily).not.toHaveBeenCalled();
  });
});

describe('acceptance (Q25)', () => {
  const started = (store = fakeStore({ listOpenThreads: vi.fn(() => [thread({ sensitive: false, quote: '最近总睡不踏实。' })]) })) => {
    const s = setup({ store });
    const request = requestOf(s.runtime.silenceLine(input({ hadContent: false })))!;
    s.runtime.onLineStarted(request);
    s.advance(2_000);
    s.runtime.onLineEnded('上回说睡不踏实，这两天好些了吗？', false);
    return s;
  };

  it('a real reply inside the window is accepted', () => {
    const s = started();
    s.advance(5_000);
    s.runtime.onUserFinal('好多了，昨天还去公园走了走。', false, 'zh');
    expect(s.store.recordProactiveOutcome).toHaveBeenCalledWith('o1', 'a1', 'threadFollowup', 'accepted', s.at());
    expect(s.logger.info).toHaveBeenCalledWith('proactive_outcome', { kind: 'threadFollowup', outcome: 'accepted' });
  });

  it('a decline is rejected and closes the thread; a light reply does not count', () => {
    const s = started();
    s.runtime.onUserFinal('嗯', true, 'zh');
    expect(s.store.recordProactiveOutcome).not.toHaveBeenCalled();
    s.runtime.onUserFinal('别问了', false, 'zh');
    expect(s.store.recordProactiveOutcome).toHaveBeenCalledWith('o1', 'a1', 'threadFollowup', 'rejected', s.at());
    expect(s.store.closeThread).toHaveBeenCalledWith('o1', 't1', 'declined', s.at());
  });

  it('no reply before the window ends, or before the session ends, is rejected', () => {
    const late = started();
    late.advance(cfg.acceptance.windowMs + 1);
    late.runtime.silenceLine(input({ step: 'check', hadContent: false }));
    expect(late.store.recordProactiveOutcome).toHaveBeenCalledWith('o1', 'a1', 'threadFollowup', 'rejected', late.at());
    const ended = started();
    ended.runtime.end();
    expect(ended.store.recordProactiveOutcome).toHaveBeenCalledWith('o1', 'a1', 'threadFollowup', 'rejected', ended.at());
  });

  it('tracker: barge-in counts, a new line rejects the unanswered one', () => {
    const t = new AcceptanceTracker(15_000);
    expect(t.open({ kind: 'routine' })).toBeNull();
    expect(t.onUserFinal(1_000, 'content')).toEqual({ line: { kind: 'routine' }, outcome: 'accepted' });
    t.open({ kind: 'selfShare' });
    t.ended(0);
    expect(t.open({ kind: 'routine' })).toEqual({ line: { kind: 'selfShare' }, outcome: 'rejected' });
    expect(t.expire(10)).toBeNull();
  });
});

describe('tier by voice', () => {
  it('moves one step and stays inside the range', () => {
    const rules = i18n.silence.zh;
    expect(nextTier('moderate', '你少说点吧', rules)).toBe('quiet');
    expect(nextTier('quiet', '你少说点吧', rules)).toBeNull();
    expect(nextTier('moderate', '多跟我聊聊', rules)).toBe('active');
    expect(nextTier('active', '多跟我聊聊', rules)).toBeNull();
    expect(nextTier('moderate', '今天天气不错', rules)).toBeNull();
  });

  it('persists the new tier and the next silence follows it', () => {
    const s = setup();
    s.runtime.onUserFinal('你少说点吧', false, 'zh');
    expect(s.store.setProactiveTier).toHaveBeenCalledWith('o1', 'a1', 'quiet', AFTERNOON);
    expect(s.logger.info).toHaveBeenCalledWith('proactive_tier_changed', { from: 'moderate', to: 'quiet' });
    expect(s.runtime.silenceLine(input())).toEqual({ quiet: true });
  });
});

describe('fallback, post-hoc check and topic exhaustion', () => {
  it('gives the fallback line once when nothing was heard', () => {
    const s = setup();
    const request = requestOf(s.runtime.silenceLine(input()))!;
    const fallback = s.runtime.fallbackFor(request)!;
    expect(fallback).toEqual(speakLineRequest(zh.intents!, request.fallbackText));
    expect(s.runtime.fallbackFor(request)).toBeNull();
    expect(s.runtime.owns(fallback)).toBe(true);
    expect(s.logger.warn).toHaveBeenCalledWith('proactive_fallback', { kind: 'continueThread', code: 'no_audio' });
    s.runtime.onLineStarted(fallback);
    expect(s.store.recordFallbackLine).toHaveBeenCalledWith('o1', 'a1', 'continueThread', 0, AFTERNOON, cfg.fallbackKeep);
  });

  it('logs material-outside health words in what was actually said', () => {
    const s = setup();
    const request = requestOf(s.runtime.silenceLine(input()))!;
    s.runtime.onLineStarted(request);
    s.runtime.onLineEnded('君子兰不开花别着急，您记得按时吃药。', false);
    expect(s.logger.warn).toHaveBeenCalledWith('proactive_grounding_violation', expect.objectContaining({ kind: 'continueThread', violationKind: 'health' }));
    const cut = setup();
    const r2 = requestOf(cut.runtime.silenceLine(input()))!;
    cut.runtime.onLineStarted(r2);
    cut.runtime.onLineEnded('您记得按时吃', true);
    expect(cut.logger.warn).not.toHaveBeenCalledWith('proactive_grounding_violation', expect.anything());
  });

  it('approves the topic-exhaustion hint once per arming, as self-talk only', () => {
    const s = setup();
    const at = { language: 'zh' as const, card: null, lowIntensity: 2 };
    expect(s.runtime.approveExhausted(1, at)).toBe(true);
    expect(s.runtime.approveExhausted(1, at)).toBe(true);
    const decisions = s.logger.info.mock.calls.filter((c) => c[0] === 'proactive_decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]![1]).toMatchObject({ moment: 'topicExhausted', kind: 'selfShare' });
    expect(s.store.incrementProactiveDaily).toHaveBeenCalledTimes(1);
    const quiet = setup({ store: fakeStore({ getProactiveTier: vi.fn(() => 'quiet') }) });
    expect(quiet.runtime.approveExhausted(1, at)).toBe(false);
    expect(setup({ intents: false }).runtime.approveExhausted(1, at)).toBe(true);
  });
});
