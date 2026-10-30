import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadDirectorConfig } from '../src/config.ts';
import { loadI18n } from '../src/i18n/load.ts';
import type { Logger } from '../src/log/logger.ts';
import type { MemoryStore, MoodSummaryRecord, ThreadRecord } from '../src/memory/store.ts';
import { loadProactivity } from '../src/session/proactive/config.ts';
import { composeOpening } from '../src/session/proactive/render.ts';
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
    proactiveLastAt: vi.fn(() => null),
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

  it('opens a health event on the quote plus the care line; the fallback stays composed', () => {
    const quote = '我后天上午去医院复查腰。';
    const { runtime } = setup(MORNING, { listOpenThreads: vi.fn(() => [event({ sensitive: true, quote })]) });
    const request = runtime.openingLine(open)!;
    expect(request.cue).toBe('greeting');
    expect(request.instruction).toContain(`【${quote}】`);
    expect(request.instruction).toContain(zh.intents!.withCare);
    expect(request.instruction).toContain('「王叔」');
    expect(request.fallbackText.startsWith('王叔')).toBe(true);
    expect(zh.fallbacks!.threadSensitive.some((line) => request.fallbackText.endsWith(line))).toBe(true);
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
