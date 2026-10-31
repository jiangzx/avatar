// Decision engine (spec 2026-10-28 决策引擎). Pure: no I/O, no clock, no model call; < 1 ms per decision.
import type { MoodSummaryRecord, ProactiveTier, RelationshipStats, ThreadRecord } from '../../memory/store.ts';
import type { IntentKind, ProactivityConfig, ScoredKind } from './config.ts';

export const MOMENTS = ['sessionStart', 'silenceContext', 'silenceCheck', 'silenceLeave', 'silenceCheckin', 'silenceRest', 'topicExhausted'] as const;
export type Moment = (typeof MOMENTS)[number];
export type Familiarity = 'new' | 'familiar' | 'oldFriend';
/** ESConv order while the user is low: explore, then comfort, then suggest. */
export type CareStage = 'explore' | 'comfort' | 'suggest';

export interface DecisionContext {
  moment: Moment;
  /** Session clock (ms). */
  now: number;
  currentSessionId: string;
  tier: ProactiveTier;
  affect: { low: boolean; crisis: boolean; stage: CareStage };
  lastMood: MoodSummaryRecord | null;
  threads: readonly ThreadRecord[];
  /** Whether usable material exists; P3 back half gathers it. */
  has: { openLoop: boolean; interest: boolean; family: boolean; question?: boolean };
  /** Scored proactive lines so far this session / today (structural lines do not count). */
  sessionSpoken: number;
  todaySpoken: number;
  spokenKinds: ReadonlySet<ScoredKind>;
  mentionedThreads: ReadonlySet<string>;
  stats: ReadonlyArray<{ kind: string; accepted: number; rejected: number }>;
  userLeaving: boolean;
}

export interface Decision { kind: IntentKind; threadId?: string; score: number; candidates: number }

const DAY = 86_400_000;
const HOUR = 3_600_000;

const MOMENT_KINDS: Record<Moment, readonly ScoredKind[]> = {
  sessionStart: ['threadFollowup', 'moodCheck', 'routine'],
  silenceContext: ['threadFollowup', 'moodCheck', 'routine', 'interestTopic', 'continueThread', 'humanConnection'],
  silenceCheck: ['threadFollowup', 'interestTopic', 'continueThread', 'selfShare'],
  silenceLeave: ['interestTopic', 'selfShare'],
  silenceCheckin: [],
  silenceRest: [],
  topicExhausted: ['threadFollowup', 'interestTopic', 'humanConnection', 'selfShare'],
};

type Features = { relevance: number; urgency: number; importance: number; novelty: number };

export function beijingHour(at: number): number {
  return new Date(at + 8 * HOUR).getUTCHours();
}

export function familiarityOf(stats: RelationshipStats, cfg: ProactivityConfig): Familiarity {
  const f = cfg.familiarity;
  if (stats.sessions >= f.oldFriendMinSessions && stats.activeDays >= f.oldFriendMinDays) return 'oldFriend';
  if (stats.sessions >= f.familiarMinSessions && stats.activeDays >= f.familiarMinDays) return 'familiar';
  return 'new';
}

/** Q25: 0.5..1.5, smoothed by the configured prior. */
export function acceptanceMultiplier(kind: ScoredKind, stats: DecisionContext['stats'], cfg: ProactivityConfig): number {
  const row = stats.find((s) => s.kind === kind);
  const a = (row?.accepted ?? 0) + cfg.acceptance.priorAccepted;
  const total = a + (row?.rejected ?? 0) + cfg.acceptance.priorRejected;
  return total === 0 ? 1 : 0.5 + a / total;
}

/** Urgency (0..100) when this thread may be raised now, else null (spec 事项线 lifecycle). */
export function threadUrgency(thread: ThreadRecord, now: number, cfg: ProactivityConfig): number | null {
  const t = cfg.threads;
  if (thread.kind === 'event') {
    if (thread.mentionCount >= t.event.maxMentions) return null;
    if (now < thread.dueAt) return thread.dueAt - now <= t.event.preDays * DAY && thread.mentionCount === 0 ? t.urgency.eventBefore : null;
    if (now - thread.dueAt > t.event.postDays * DAY) return null;
    return thread.lastMentionedAt !== null && thread.lastMentionedAt >= thread.dueAt ? null : t.urgency.eventAfter;
  }
  if (thread.kind === 'concern') {
    if (thread.mentionCount >= t.concern.maxMentions || now - thread.createdAt > t.concern.expireDays * DAY) return null;
    if (thread.lastMentionedAt !== null && now - thread.lastMentionedAt < t.concern.intervalDays * DAY) return null;
    return t.urgency.concern;
  }
  if (thread.mentionCount >= t.plan.maxMentions) return null;
  const age = now - thread.createdAt;
  return age >= t.plan.minDays * DAY && age <= t.plan.maxDays * DAY ? t.urgency.plan : null;
}

function inRoutineWindow(now: number, cfg: ProactivityConfig): boolean {
  const hour = beijingHour(now);
  return Object.values(cfg.routine).some((w) => hour >= w.start && hour < w.end);
}

function moodIsLow(ctx: DecisionContext, cfg: ProactivityConfig): boolean {
  const m = ctx.lastMood;
  const recentLow = m !== null && ctx.now - m.createdAt <= cfg.mood.lookbackHours * HOUR
    && m.endEmotion === 'sad' && m.endIntensity >= cfg.mood.lowIntensity;
  return ctx.affect.low || recentLow;
}

/** Feature values for one kind, or null when it has nothing to say now. */
function featuresFor(kind: ScoredKind, ctx: DecisionContext, cfg: ProactivityConfig): Array<{ f: Features; threadId?: string }> {
  const base = cfg.kinds[kind].base;
  const novelty = ctx.spokenKinds.has(kind) ? 0 : 100;
  switch (kind) {
    case 'threadFollowup':
      return ctx.threads.flatMap((thread) => {
        if (thread.sourceSessionId === ctx.currentSessionId || ctx.mentionedThreads.has(thread.id)) return [];
        if (ctx.tier === 'quiet' && thread.kind !== 'event') return [];
        const urgency = threadUrgency(thread, ctx.now, cfg);
        if (urgency === null) return [];
        const importance = thread.sensitive ? cfg.threads.importance.sensitive : cfg.threads.importance.plain;
        return [{ f: { relevance: base.relevance, urgency, importance, novelty: 100 }, threadId: thread.id }];
      });
    case 'moodCheck': {
      if (!moodIsLow(ctx, cfg)) return [];
      const recent = ctx.lastMood !== null && ctx.now - ctx.lastMood.createdAt <= cfg.mood.recentHours * HOUR;
      const urgency = ctx.affect.low || recent ? base.urgency : cfg.mood.staleUrgency;
      const importance = ctx.lastMood?.crisis ? 100 : base.importance;
      return [{ f: { relevance: base.relevance, urgency, importance, novelty } }];
    }
    case 'routine':
      return inRoutineWindow(ctx.now, cfg) ? [{ f: { ...base, novelty } }] : [];
    case 'humanConnection':
      if (!ctx.has.family) return [];
      return [{ f: { ...base, relevance: ctx.affect.low ? cfg.humanConnection.lowRelevance : base.relevance, novelty } }];
    case 'continueThread':
      return ctx.has.openLoop ? [{ f: { ...base, novelty } }] : [];
    case 'interestTopic':
      return ctx.has.interest ? [{ f: { ...base, novelty } }] : [];
    case 'selfShare':
      return [{ f: { ...base, novelty } }];
  }
}

/** Hard rules that remove whole kinds before scoring. */
function allowed(kind: ScoredKind, ctx: DecisionContext, cfg: ProactivityConfig): boolean {
  if (!cfg.kinds[kind].enabled) return false;
  if (ctx.tier === 'quiet' && !(ctx.moment === 'sessionStart' && kind === 'threadFollowup')) return false;
  if (kind === 'threadFollowup' && ctx.mentionedThreads.size >= cfg.threads.maxPerSession) return false;
  // selfShare needs a locked question material at the two question-bearing silence moments.
  if (kind === 'selfShare' && (ctx.moment === 'silenceContext' || ctx.moment === 'silenceCheck')
    && !(ctx.has.question ?? ctx.has.interest)) return false;
  if (ctx.affect.low) {
    if (kind === 'interestTopic' || kind === 'selfShare') return false;
    if (kind === 'humanConnection' && ctx.affect.stage !== 'suggest') return false;
  }
  return true;
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

export function decide(ctx: DecisionContext, cfg: ProactivityConfig): Decision {
  if (ctx.moment === 'silenceCheckin') return { kind: 'presenceCheck', score: 0, candidates: 0 };
  if (ctx.moment === 'silenceRest') return { kind: 'restQuiet', score: 0, candidates: 0 };
  const tier = cfg.tiers[ctx.tier];
  const threshold = tier.threshold / 100;
  const fallback: Decision = { kind: ctx.moment === 'sessionStart' ? 'greetingPlain' : 'quiet', score: threshold, candidates: 0 };
  if (!cfg.enabled || ctx.affect.crisis || ctx.userLeaving) return fallback;
  const opening = ctx.moment === 'sessionStart';
  if (!opening && (ctx.sessionSpoken >= tier.maxPerSession || ctx.todaySpoken >= tier.maxPerDay)) return fallback;
  const fatigue = opening ? 1 : 1 - 0.5 * Math.min(1, ctx.sessionSpoken / Math.max(1, tier.maxPerSession));
  let best: Decision | null = null;
  let bestPriority = Number.POSITIVE_INFINITY;
  let candidates = 0;
  for (const kind of MOMENT_KINDS[ctx.moment]) {
    if (!allowed(kind, ctx, cfg)) continue;
    const w = cfg.kinds[kind].weights;
    const multiplier = acceptanceMultiplier(kind, ctx.stats, cfg);
    for (const { f, threadId } of featuresFor(kind, ctx, cfg)) {
      candidates++;
      const raw = (w.relevance * f.relevance + w.urgency * f.urgency + w.importance * f.importance + w.novelty * f.novelty) / 10_000;
      const score = round(raw * multiplier * fatigue);
      const priority = cfg.kinds[kind].priority;
      if (!best || score > best.score || (score === best.score && priority < bestPriority)) {
        best = { kind, score, candidates: 0, ...(threadId ? { threadId } : {}) };
        bestPriority = priority;
      }
    }
  }
  if (!best || best.score < threshold) return { ...fallback, candidates };
  return { ...best, candidates };
}
