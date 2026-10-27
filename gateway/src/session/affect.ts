// Session-scoped affect analysis. Cards, lines and counters stay in memory; logs carry no labels or text.
import { readFileSync } from 'node:fs';
import type { Language } from '@anyidea/protocol';
import { z } from 'zod';
import type { SafetyRules } from '../config.ts';
import type { EvidenceRules } from '../i18n/types.ts';
import { defaultLogger, type Logger } from '../log/logger.ts';
import { isMemoryEvidence } from '../memory/evidence.ts';
import { normalizeForMatch } from '../memory/grounding.ts';
import { scanText } from '../memory/scan.ts';
import type { TextModelClient } from '../memory/textClient.ts';
import { runWithPolicy, type PolicySpec } from '../reliability/policy.ts';
import type { LedgerEntry } from './ledger.ts';
import { TopicExhaustion } from './topicExhaustion.ts';

export const AFFECT_EMOTIONS = ['neutral', 'happy', 'sad', 'love'] as const; // same values as EMOTIONS
export const AFFECT_NEEDS = ['vent', 'share_joy', 'help', 'chat', 'topic_exhausted'] as const;
export const AFFECT_STRATEGIES = ['comfort', 'reflect', 'affirm', 'ask', 'disclose', 'suggest'] as const;
export const AFFECT_TRENDS = ['better', 'worse', 'flat'] as const;

/** Contract bound from the spec; the analyzer prompt states the same limit. */
const OPEN_LOOP_MAX_CHARS = 60;

export interface AffectCard {
  emotion: (typeof AFFECT_EMOTIONS)[number];
  intensity: 1 | 2 | 3;
  trend: (typeof AFFECT_TRENDS)[number];
  need: (typeof AFFECT_NEEDS)[number];
  strategy: (typeof AFFECT_STRATEGIES)[number];
  mismatch: boolean;
  crisis: boolean;
  openLoop?: string;
}

const CardFields = {
  emotion: z.enum(AFFECT_EMOTIONS),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  trend: z.enum(AFFECT_TRENDS),
  need: z.enum(AFFECT_NEEDS),
  strategy: z.enum(AFFECT_STRATEGIES),
  mismatch: z.boolean(),
  crisis: z.boolean(),
};

const OpenLoopSchema = z.string().trim().min(1).max(OPEN_LOOP_MAX_CHARS);
/** The card without openLoop: an invalid openLoop drops only that field, not the card. */
const BaseCardSchema = z.object(CardFields).strict();

export const AffectCardSchema: z.ZodType<AffectCard> = z.object({
  ...CardFields,
  openLoop: OpenLoopSchema.optional(),
}).strict();

export interface AffectConfig {
  enabled: boolean;
  historyEntries: number;
  sessionLinesMax: number;
  maxInputChars: number;
  maxTokens: number;
  temperature: number;
  policy: PolicySpec;
  lowIntensity: number;
  exhausted: { shortMaxChars: number; shortStreakTrigger: number; cooldownTurns: number; declineCooldownTurns: number };
  care: { maxAgeDays: number; timeoutMs: number; maxChars: Record<Language, number>; quoteMaxChars: number; maxTokens: number; temperature: number };
  timeZone: string;
  solarTermWindowDays: number;
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const AffectConfigSchema = z.object({
  enabled: z.boolean(),
  historyEntries: z.number().int().min(0).max(20),
  sessionLinesMax: z.number().int().min(1).max(2_000),
  maxInputChars: z.number().int().min(200).max(10_000),
  maxTokens: z.number().int().min(32).max(1_000),
  temperature: z.number().min(0).max(1),
  policy: z.object({
    timeoutMs: z.number().int().min(300).max(10_000),
    // Latest-wins: a retry would answer a turn the user has already moved past.
    retries: z.literal(0),
    backoffMs: z.number().int().min(0).max(10_000),
    maxBackoffMs: z.number().int().min(0).max(10_000),
  }).strict(),
  lowIntensity: z.number().int().min(1).max(3),
  exhausted: z.object({
    shortMaxChars: z.number().int().min(1).max(20),
    // Arming happens one short reply before the trigger, so the trigger must be at least 2.
    shortStreakTrigger: z.number().int().min(2).max(10),
    cooldownTurns: z.number().int().min(0).max(50),
    declineCooldownTurns: z.number().int().min(0).max(100),
  }).strict(),
  care: z.object({
    maxAgeDays: z.number().int().min(1).max(30),
    // The opening waits for this; keep it short regardless of the analyzer policy.
    timeoutMs: z.number().int().min(300).max(3_000),
    // Per language: 40 CJK characters and 40 Latin characters are very different lengths.
    maxChars: z.object({ zh: z.number().int().min(10).max(200), ja: z.number().int().min(10).max(200), en: z.number().int().min(10).max(200) }).strict(),
    quoteMaxChars: z.number().int().min(10).max(500),
    maxTokens: z.number().int().min(32).max(400),
    temperature: z.number().min(0).max(1),
  }).strict(),
  timeZone: z.string().min(1).refine(validTimeZone, { message: 'unknown time zone' }),
  solarTermWindowDays: z.number().int().min(0).max(7),
}).strict().superRefine((config, ctx) => {
  if (config.policy.maxBackoffMs < config.policy.backoffMs) {
    ctx.addIssue({ code: 'custom', path: ['policy', 'maxBackoffMs'], message: 'maxBackoffMs must be >= backoffMs' });
  }
  if (config.exhausted.declineCooldownTurns < config.exhausted.cooldownTurns) {
    ctx.addIssue({ code: 'custom', path: ['exhausted', 'declineCooldownTurns'], message: 'declineCooldownTurns must be >= cooldownTurns' });
  }
});

/** gateway/config/affect.json; throws on any unknown key or out-of-range value. */
export function loadAffectConfig(path: string): AffectConfig {
  return AffectConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Low mood: crisis, or sad with enough intensity or getting worse. Trend counts only for sad. */
export function isLow(card: AffectCard | null, lowIntensity: number): boolean {
  if (!card) return false;
  if (card.crisis) return true;
  return card.emotion === 'sad' && (card.intensity >= lowIntensity || card.trend === 'worse');
}

export interface AffectSummary {
  calls: number;
  failures: number;
  byEmotion: Record<AffectCard['emotion'], number>;
  crisis: 0 | 1;
  exhaustedArmed: number;
  exhaustedRevoked: number;
}

/** log() takes flat fields only; counts, never labels per turn. */
export function affectSummaryFields(summary: AffectSummary): Record<string, number> {
  return {
    calls: summary.calls,
    failures: summary.failures,
    crisis: summary.crisis,
    exhaustedArmed: summary.exhaustedArmed,
    exhaustedRevoked: summary.exhaustedRevoked,
    emotionNeutral: summary.byEmotion.neutral,
    emotionHappy: summary.byEmotion.happy,
    emotionSad: summary.byEmotion.sad,
    emotionLove: summary.byEmotion.love,
  };
}

export interface AffectTrackerDeps {
  client: TextModelClient;
  config: AffectConfig;
  prompt: (language: Language) => string;
  history: () => readonly LedgerEntry[];
  evidence: EvidenceRules;
  safety: SafetyRules;
  /** Called with each accepted card (never with a stale one). */
  onCard: (card: AffectCard) => void;
  /** Decline phrases for the final's language (i18n affect.json); missing means no decline cooldown. */
  declinePhrases?: (language: Language) => readonly string[];
  /** Session child logger. Omitted in tests: the stdout default. */
  logger?: Logger;
}

type CardEnums = Omit<AffectCard, 'openLoop'>;

interface AffectInput {
  language: Language;
  current: string;
  history: { role: LedgerEntry['role']; text: string }[];
  previous?: CardEnums;
}

/** JSON mode should give bare JSON; tolerate a code fence or stray prose around it. */
function parseJsonObject(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
}

function enumsOf(card: AffectCard): CardEnums {
  return {
    emotion: card.emotion,
    intensity: card.intensity,
    trend: card.trend,
    need: card.need,
    strategy: card.strategy,
    mismatch: card.mismatch,
    crisis: card.crisis,
  };
}

/** One per session. Analyzes non-light finals with the shared text model; the newest final wins. */
export class AffectTracker {
  private latest: AffectCard | null = null;
  private seq = 0;
  private inflight: AbortController | null = null;
  /** This session's user finals, newest last. Ledger summaries drop old lines; openLoop must not. */
  private readonly lines: string[] = [];
  private calls = 0;
  private failures = 0;
  private readonly byEmotion: Record<AffectCard['emotion'], number> = { neutral: 0, happy: 0, sad: 0, love: 0 };
  private crisisSeen = false;
  private disposed = false;
  /** Topic-exhaustion counters; session memory only. */
  private readonly exhaustion: TopicExhaustion;

  constructor(private readonly deps: AffectTrackerDeps) {
    this.exhaustion = new TopicExhaustion(deps.config.exhausted);
  }

  private get log(): Logger { return this.deps.logger ?? defaultLogger(); }

  get card(): AffectCard | null {
    return this.latest;
  }

  /** T4 sets this; T2 always returns false. */
  get exhaustedArmed(): boolean {
    return this.exhaustion.armed;
  }

  /** Non-light user final. Starts one analysis; aborts the previous one. */
  onUserFinal(text: string, language: Language): void {
    if (this.disposed) return;
    this.exhaustion.onFinal(text, false, this.deps.declinePhrases?.(language) ?? []);
    this.remember(text);
    const user = this.buildInput(text, language);
    if (user === null) {
      // This newer final still supersedes any analysis in flight (latest wins), even though it is skipped.
      this.seq += 1;
      this.inflight?.abort();
      this.inflight = null;
      this.log.info('affect', { outcome: 'skipped', ms: 0, code: 'input_budget' });
      return;
    }
    this.inflight?.abort();
    const own = new AbortController();
    this.inflight = own;
    const seq = ++this.seq;
    this.calls += 1;
    this.analyze(seq, own, user, language).catch(() => this.log.warn('affect_card_failed'));
  }

  /** Light or short final: T2 only records the line; T4 adds the exhaustion counters. */
  onLightFinal(text: string, language: Language): void {
    if (this.disposed) return;
    this.exhaustion.onFinal(text, true, this.deps.declinePhrases?.(language) ?? []);
    this.remember(text);
  }

  summary(): AffectSummary {
    return {
      calls: this.calls,
      failures: this.failures,
      byEmotion: { ...this.byEmotion },
      crisis: this.crisisSeen ? 1 : 0,
      exhaustedArmed: this.exhaustion.armedCount,
      exhaustedRevoked: this.exhaustion.revokedCount,
    };
  }

  dispose(): void {
    this.disposed = true;
    // Bumping seq turns any result still in flight into a stale one.
    this.seq += 1;
    this.inflight?.abort();
    this.inflight = null;
  }

  /** Forget/decline: drop the card, this session's user lines, and any analysis in flight. Counters stay. */
  reset(): void {
    this.seq += 1;
    this.inflight?.abort();
    this.inflight = null;
    this.latest = null;
    this.lines.length = 0;
    this.exhaustion.reset();
  }

  private remember(text: string): void {
    const line = text.trim();
    if (!line) return;
    this.lines.push(line);
    const overflow = this.lines.length - this.deps.config.sessionLinesMax;
    if (overflow > 0) this.lines.splice(0, overflow);
  }

  /** Quoted JSON within maxInputChars, trimming the oldest history first. Null when even the final alone does not fit. */
  private buildInput(text: string, language: Language): string | null {
    const { historyEntries, maxInputChars } = this.deps.config;
    const entries = this.deps.history();
    const last = entries.at(-1);
    // The session adds the final to the ledger first; it is `current`, not history.
    const prior = last && last.role === 'user' && last.text === text ? entries.slice(0, -1) : entries;
    const input: AffectInput = {
      language,
      current: text,
      history: (historyEntries > 0 ? prior.slice(-historyEntries) : []).map((entry) => ({ role: entry.role, text: entry.text })),
      ...(this.latest ? { previous: enumsOf(this.latest) } : {}),
    };
    let user = JSON.stringify(input);
    while (user.length > maxInputChars && input.history.length > 0) {
      input.history.shift();
      user = JSON.stringify(input);
    }
    return user.length <= maxInputChars ? user : null;
  }

  private async analyze(seq: number, own: AbortController, user: string, language: Language): Promise<void> {
    const started = Date.now();
    const { client, config } = this.deps;
    const result = await runWithPolicy('affect', config.policy, async (timeoutSignal) => {
      const raw = await client.complete({
        system: this.deps.prompt(language),
        user,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        jsonMode: true,
        signal: AbortSignal.any([own.signal, timeoutSignal]),
      });
      if (own.signal.aborted) throw new Error('affect_cancelled');
      return raw;
    }, { classify: () => 'ignorable', logger: this.log });
    const ms = Date.now() - started;
    if (seq !== this.seq || own.signal.aborted) {
      this.log.info('affect', { outcome: 'stale', ms });
      return;
    }
    this.inflight = null;
    if (!result.ok) {
      this.failures += 1;
      this.log.warn('affect', { outcome: 'failed', ms, code: result.code });
      return;
    }
    const card = this.parseCard(result.value);
    if (!card) {
      this.failures += 1;
      this.log.warn('affect', { outcome: 'failed', ms, code: 'invalid' });
      return;
    }
    this.latest = card;
    this.byEmotion[card.emotion] += 1;
    if (card.crisis) this.crisisSeen = true;
    this.exhaustion.onCard(card, isLow(card, this.deps.config.lowIntensity));
    this.log.info('affect', { outcome: 'ok', ms });
    this.deps.onCard(card);
  }

  /** The whole card must match the schema; an ungrounded openLoop drops only that field. */
  private parseCard(raw: string): AffectCard | null {
    let value: unknown;
    try {
      value = parseJsonObject(raw);
    } catch {
      return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { openLoop, ...fields } = value as Record<string, unknown>;
    const base = BaseCardSchema.safeParse(fields);
    if (!base.success) return null;
    const loop = this.groundedOpenLoop(openLoop);
    return loop ? { ...base.data, openLoop: loop } : base.data;
  }

  /** Verbatim piece of one of this session's user statements, clean under the safety scan. */
  private groundedOpenLoop(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const parsed = OpenLoopSchema.safeParse(value);
    if (!parsed.success) return null;
    const text = parsed.data;
    const key = normalizeForMatch(text);
    if (!key) return null;
    const { evidence, safety } = this.deps;
    if (!isMemoryEvidence(text, evidence) || scanText(text, safety) !== 'allow') return null;
    return this.lines.some((line) => normalizeForMatch(line).includes(key) && isMemoryEvidence(line, evidence)) ? text : null;
  }
}
