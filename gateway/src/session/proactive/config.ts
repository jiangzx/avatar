import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Intent kinds the engine scores (spec 意图类型). Overlay key segments allow no underscore, hence camelCase. */
export const SCORED_KINDS = ['threadFollowup', 'moodCheck', 'continueThread', 'routine', 'humanConnection', 'interestTopic', 'selfShare'] as const;
export type ScoredKind = (typeof SCORED_KINDS)[number];
/** Structural kinds are decided by rules, not scores. */
export type IntentKind = ScoredKind | 'presenceCheck' | 'restQuiet' | 'greetingPlain' | 'quiet';
export const PROACTIVE_TIERS = ['quiet', 'moderate', 'active'] as const;

// 0..100 everywhere: whole steps in the admin console, divided by 100 in the engine.
const Pct = z.number().int().min(0).max(100);
const Count = (max: number) => z.number().int().min(0).max(max);
const Days = (min: number, max: number) => z.number().int().min(min).max(max);

const Tier = z.object({ threshold: Pct, maxPerSession: Count(20), maxPerDay: Count(60) }).strict();

const Kind = z.object({
  enabled: z.boolean(),
  /** Tie-break: lower wins. */
  priority: z.number().int().min(1).max(20),
  weights: z.object({ relevance: Pct, urgency: Pct, importance: Pct, novelty: Pct }).strict()
    .refine((w) => w.relevance + w.urgency + w.importance + w.novelty === 100, { message: 'weights must sum to 100' }),
  /** Feature values when nothing more specific applies; see engine.ts for the computed ones. */
  base: z.object({ relevance: Pct, urgency: Pct, importance: Pct }).strict(),
}).strict();

const Window = z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) }).strict()
  .refine((w) => w.end > w.start, { message: 'window end must be after start' });

export const ProactivitySchema = z.object({
  enabled: z.boolean(),
  defaultTier: z.enum(PROACTIVE_TIERS),
  tiers: z.object({ quiet: Tier, moderate: Tier, active: Tier }).strict(),
  acceptance: z.object({
    priorAccepted: Count(20),
    priorRejected: Count(20),
    /** A non-light reply within this window after a proactive line counts as accepted. */
    windowMs: z.number().int().min(3_000).max(60_000),
  }).strict(),
  familiarity: z.object({
    familiarMinSessions: Count(100),
    familiarMinDays: Count(100),
    oldFriendMinSessions: Count(1_000),
    oldFriendMinDays: Count(1_000),
  }).strict().refine((f) => f.oldFriendMinSessions >= f.familiarMinSessions && f.oldFriendMinDays >= f.familiarMinDays, { message: 'old friend thresholds must not be below familiar ones' }),
  threads: z.object({
    maxPerSession: Count(5),
    event: z.object({ preDays: Days(0, 7), postDays: Days(1, 30), maxMentions: Days(1, 5) }).strict(),
    concern: z.object({ intervalDays: Days(1, 30), maxMentions: Days(1, 10), expireDays: Days(1, 90) }).strict(),
    plan: z.object({ minDays: Days(0, 30), maxDays: Days(1, 90), maxMentions: Days(1, 5) }).strict()
      .refine((p) => p.maxDays > p.minDays, { message: 'plan maxDays must be after minDays' }),
    urgency: z.object({ eventAfter: Pct, eventBefore: Pct, concern: Pct, plan: Pct }).strict(),
    importance: z.object({ sensitive: Pct, plain: Pct }).strict(),
  }).strict(),
  mood: z.object({
    lookbackHours: z.number().int().min(1).max(336),
    recentHours: z.number().int().min(1).max(168),
    /** Same scale as affect cards: 1..3. */
    lowIntensity: z.number().int().min(1).max(3),
    staleUrgency: Pct,
  }).strict(),
  routine: z.object({ morning: Window, noon: Window, evening: Window, night: Window }).strict(),
  humanConnection: z.object({ lowRelevance: Pct }).strict(),
  kinds: z.object({
    threadFollowup: Kind, moodCheck: Kind, continueThread: Kind, routine: Kind,
    humanConnection: Kind, interestTopic: Kind, selfShare: Kind,
  }).strict(),
  maxChars: z.number().int().min(10).max(120),
  fallbackAfterMs: z.number().int().min(500).max(10_000),
  fallbackKeep: Count(10),
}).strict();

export type ProactivityConfig = z.infer<typeof ProactivitySchema>;

export function loadProactivity(path: string): ProactivityConfig {
  return ProactivitySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
