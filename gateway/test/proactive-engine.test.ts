import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MoodSummaryRecord, ThreadRecord } from '../src/memory/store.ts';
import { loadProactivity, type ProactivityConfig } from '../src/session/proactive/config.ts';
import { acceptanceMultiplier, beijingHour, decide, familiarityOf, threadUrgency, type DecisionContext } from '../src/session/proactive/engine.ts';

const cfg = loadProactivity(fileURLToPath(new URL('../config/proactivity.json', import.meta.url)));
const DAY = 86_400_000;
const HOUR = 3_600_000;
// 08:30 Beijing: inside the morning routine window.
const NOW = Date.parse('2026-11-03T08:30:00+08:00');
// 15:00 Beijing: outside every routine window.
const AFTERNOON = Date.parse('2026-11-03T15:00:00+08:00');

const ctx = (over: Partial<DecisionContext> = {}): DecisionContext => ({
  moment: 'silenceCheck',
  now: AFTERNOON,
  currentSessionId: 's-now',
  tier: 'moderate',
  affect: { low: false, crisis: false, stage: 'explore' },
  lastMood: null,
  threads: [],
  has: { openLoop: false, interest: false, family: false },
  sessionSpoken: 0,
  todaySpoken: 0,
  spokenKinds: new Set(),
  mentionedThreads: new Set(),
  stats: [],
  userLeaving: false,
  ...over,
});
const thread = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: 't1', kind: 'concern', quote: '最近膝盖疼', dueAt: NOW, sensitive: false, mentionCount: 0, lastMentionedAt: null,
  createdAt: NOW - DAY, sourceSessionId: 's-old', ...over,
});
const sadMood = (over: Partial<MoodSummaryRecord> = {}): MoodSummaryRecord => ({
  id: 'm1', sessionId: 's-old', dominant: 'sad', peakIntensity: 2, endEmotion: 'sad', endIntensity: 2, endTrend: 'flat', crisis: false,
  createdAt: NOW - 10 * HOUR, ...over,
});

describe('structural moments and hard rules', () => {
  it('always checks in and rests at those steps, even in a crisis', () => {
    expect(decide(ctx({ moment: 'silenceCheckin', affect: { low: true, crisis: true, stage: 'explore' } }), cfg).kind).toBe('presenceCheck');
    expect(decide(ctx({ moment: 'silenceRest' }), cfg).kind).toBe('restQuiet');
  });

  it('starts no new topic in a crisis, when the user is leaving, or when switched off', () => {
    const rich = { has: { openLoop: true, interest: true, family: true } };
    expect(decide(ctx({ ...rich, affect: { low: true, crisis: true, stage: 'explore' } }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ ...rich, userLeaving: true }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ ...rich }), { ...cfg, enabled: false }).kind).toBe('quiet');
    expect(decide(ctx({ ...rich, moment: 'sessionStart', affect: { low: true, crisis: true, stage: 'explore' } }), cfg).kind).toBe('greetingPlain');
  });

  it('stays quiet once the session or daily cap is reached, but the opening still speaks', () => {
    const rich = { has: { openLoop: true, interest: true, family: true } };
    expect(decide(ctx({ ...rich, sessionSpoken: cfg.tiers.moderate.maxPerSession }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ ...rich, todaySpoken: cfg.tiers.moderate.maxPerDay }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ moment: 'sessionStart', now: NOW, todaySpoken: 99 }), cfg).kind).toBe('routine');
  });
});

describe('scoring', () => {
  it('picks the highest score above the tier threshold', () => {
    // interestTopic 0.59 > selfShare 0.57 at the check step.
    const d = decide(ctx({ has: { openLoop: false, interest: true, family: false } }), cfg);
    expect(d).toEqual({ kind: 'interestTopic', score: 0.59, candidates: 2 });
  });

  it('gets quieter as the session goes on (fatigue)', () => {
    // After 2 of 4 lines: interestTopic 0.4425 and selfShare 0.4275 are both under 0.45.
    expect(decide(ctx({ has: { openLoop: false, interest: true, family: false }, sessionSpoken: 2 }), cfg).kind).toBe('quiet');
  });

  it('opens with a mood check after a low last session, ahead of a due event and the morning greeting', () => {
    const d = decide(ctx({
      moment: 'sessionStart', now: NOW, lastMood: sadMood(),
      threads: [thread({ kind: 'event', dueAt: NOW - 5 * HOUR, sensitive: true })],
    }), cfg);
    expect(d.kind).toBe('moodCheck');
    expect(d.score).toBe(0.9);
  });

  it('opens with a due event before the morning greeting', () => {
    const d = decide(ctx({ moment: 'sessionStart', now: NOW, threads: [thread({ kind: 'event', dueAt: NOW - 5 * HOUR, sensitive: true })] }), cfg);
    expect(d).toMatchObject({ kind: 'threadFollowup', threadId: 't1', score: 0.865 });
  });

  it('opens with a plain greeting when nothing clears the threshold', () => {
    expect(decide(ctx({ moment: 'sessionStart', now: AFTERNOON }), cfg)).toEqual({ kind: 'greetingPlain', score: 0.45, candidates: 0 });
  });

  it('lowers a kind the user keeps turning down', () => {
    expect(acceptanceMultiplier('routine', [{ kind: 'routine', accepted: 0, rejected: 10 }], cfg)).toBeCloseTo(0.5 + 2 / 14, 10);
    expect(acceptanceMultiplier('routine', [], cfg)).toBe(1);
    expect(acceptanceMultiplier('routine', [], { ...cfg, acceptance: { ...cfg.acceptance, priorAccepted: 0, priorRejected: 0 } })).toBe(1);
    const d = decide(ctx({ moment: 'sessionStart', now: NOW, stats: [{ kind: 'routine', accepted: 0, rejected: 10 }] }), cfg);
    expect(d.kind).toBe('routine');
    expect(d.score).toBeCloseTo(0.74 * (0.5 + 2 / 14), 5);
  });

  it('breaks ties by priority', () => {
    const same = { ...cfg, kinds: { ...cfg.kinds, selfShare: { ...cfg.kinds.selfShare, weights: cfg.kinds.interestTopic.weights, base: cfg.kinds.interestTopic.base } } };
    expect(decide(ctx({ has: { openLoop: false, interest: true, family: false } }), same).kind).toBe('interestTopic');
  });
});

describe('tiers, mood and threads', () => {
  it('quiet tier: only a due event at the opening, nothing during silence', () => {
    const due = thread({ kind: 'event', dueAt: NOW - 5 * HOUR });
    expect(decide(ctx({ tier: 'quiet', has: { openLoop: true, interest: true, family: true } }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ tier: 'quiet', moment: 'sessionStart', now: NOW, lastMood: sadMood() }), cfg).kind).toBe('greetingPlain');
    expect(decide(ctx({ tier: 'quiet', moment: 'sessionStart', now: NOW, threads: [due] }), cfg)).toMatchObject({ kind: 'threadFollowup', threadId: 't1' });
  });

  it('low mood: no topic change or self-talk; family nudge only at the suggest stage', () => {
    const has = { openLoop: false, interest: true, family: true };
    expect(decide(ctx({ moment: 'topicExhausted', has, affect: { low: true, crisis: false, stage: 'comfort' } }), cfg).kind).toBe('quiet');
    expect(decide(ctx({ moment: 'topicExhausted', has, affect: { low: true, crisis: false, stage: 'suggest' } }), cfg).kind).toBe('humanConnection');
  });

  it('skips threads from this session, threads already mentioned, and stops at the per-session thread cap', () => {
    // Afternoon opening: no routine window, no mood, so only threads can beat the plain greeting.
    const start = { moment: 'sessionStart' as const, now: AFTERNOON };
    const fresh = thread({ id: 'fresh', sourceSessionId: 's-now' });
    const told = thread({ id: 'told' });
    expect(decide(ctx({ ...start, threads: [fresh] }), cfg).kind).toBe('greetingPlain');
    expect(decide(ctx({ ...start, threads: [told], mentionedThreads: new Set(['told']) }), cfg).kind).toBe('greetingPlain');
    expect(decide(ctx({ ...start, threads: [thread({ id: 'other' })], mentionedThreads: new Set(['a', 'b']) }), cfg).kind).toBe('greetingPlain');
    expect(decide(ctx({ ...start, threads: [thread({ id: 'other' })] }), cfg)).toMatchObject({ kind: 'threadFollowup', threadId: 'other', score: 0.615 });
  });
});

describe('threadUrgency', () => {
  it('events: once before (within preDays), once after (within postDays)', () => {
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW + 20 * HOUR }), NOW, cfg)).toBe(80);
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW + 2 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW + 20 * HOUR, mentionCount: 1, lastMentionedAt: NOW - HOUR }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW - DAY, mentionCount: 1, lastMentionedAt: NOW - 2 * DAY }), NOW, cfg)).toBe(100);
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW - DAY, mentionCount: 2, lastMentionedAt: NOW - 2 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW - DAY, mentionCount: 1, lastMentionedAt: NOW - HOUR }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'event', dueAt: NOW - 8 * DAY }), NOW, cfg)).toBeNull();
  });

  it('concerns: first mention right away, then every intervalDays, up to maxMentions and expireDays', () => {
    expect(threadUrgency(thread(), NOW, cfg)).toBe(60);
    expect(threadUrgency(thread({ mentionCount: 1, lastMentionedAt: NOW - 2 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ mentionCount: 1, lastMentionedAt: NOW - 3 * DAY }), NOW, cfg)).toBe(60);
    expect(threadUrgency(thread({ mentionCount: 3, lastMentionedAt: NOW - 5 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ createdAt: NOW - 15 * DAY }), NOW, cfg)).toBeNull();
  });

  it('plans: between minDays and maxDays after creation, once', () => {
    expect(threadUrgency(thread({ kind: 'plan', createdAt: NOW - 2 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'plan', createdAt: NOW - 4 * DAY }), NOW, cfg)).toBe(50);
    expect(threadUrgency(thread({ kind: 'plan', createdAt: NOW - 8 * DAY }), NOW, cfg)).toBeNull();
    expect(threadUrgency(thread({ kind: 'plan', createdAt: NOW - 4 * DAY, mentionCount: 1 }), NOW, cfg)).toBeNull();
  });
});

describe('helpers', () => {
  it('reads the Beijing hour', () => {
    expect(beijingHour(NOW)).toBe(8);
    expect(beijingHour(Date.parse('2026-11-03T00:05:00+08:00'))).toBe(0);
  });

  it('derives familiarity from ended sessions and active days', () => {
    const stats = (sessions: number, activeDays: number) => ({ firstMetAt: 1, sessions, totalMinutes: 0, activeDays, lastSessionAt: 1, hourHistogram: Array(24).fill(0) });
    expect(familiarityOf(stats(2, 2), cfg)).toBe('new');
    expect(familiarityOf(stats(3, 1), cfg)).toBe('new');
    expect(familiarityOf(stats(3, 2), cfg)).toBe('familiar');
    expect(familiarityOf(stats(15, 10), cfg)).toBe('oldFriend');
  });
});

const _typecheck: ProactivityConfig = cfg;
void _typecheck;
