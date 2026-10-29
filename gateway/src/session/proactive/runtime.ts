// Per-session proactive runtime (spec 决策引擎, 意图渲染). Session counters live here; cross-session data
// is written only after the memory notice played and memory is not declined. No timers, no adapter.
import type { Language } from '@anyidea/protocol';
import type { ProactiveRequest } from '../../adapters/types.ts';
import { containsPhrase } from '../../i18n/text.ts';
import type { SilenceRules } from '../../i18n/types.ts';
import type { Logger } from '../../log/logger.ts';
import { isMemoryEvidence, type EvidenceRules } from '../../memory/evidence.ts';
import type { MemoryStore, MoodSummaryRecord, ProactiveTier, ThreadRecord } from '../../memory/store.ts';
import type { FallbackGroups, FallbackKey, IntentCopy, TopicCard } from '../../roles/types.ts';
import { isLow, type AffectCard } from '../affect.ts';
import { AcceptanceTracker, type Resolved, type Verdict } from './acceptance.ts';
import { beijingDay, buildIntent, careStage, type IntentMaterial, type PlannedIntent } from './assemble.ts';
import { checkSpoken, violationsOf } from './check.ts';
import { SCORED_KINDS, type ProactivityConfig, type ScoredKind } from './config.ts';
import { decide, familiarityOf, type Decision, type DecisionContext, type Familiarity, type Moment } from './engine.ts';
import { pickFallback } from './fallback.ts';
import { composeOpening, renderIntent, speakLineRequest } from './render.ts';

// Same step names as the Director's ladder; the session maps a planner stage to one of these.
export type SilenceStep = 'context' | 'check' | 'leave' | 'checkin' | 'rest';
export type ProactiveLineResult = { request: ProactiveRequest } | { quiet: true } | { close: true } | null;

export interface ProactiveCopy {
  intents?: IntentCopy;
  fallbacks?: FallbackGroups;
  topics: readonly TopicCard[];
  quietPhrases: readonly string[];
  /** Name templates for a plain opening's fallback ({name}). */
  greetingNameTexts?: readonly string[];
  /** Opening heads ({name}) placed before a kind's fallback line. */
  greetingHeads?: readonly string[];
}

export interface ProactiveRules {
  silence: SilenceRules;
  healthWords: readonly string[];
  declinePhrases: readonly string[];
  evidence: EvidenceRules;
}

export interface ProactiveRuntimeDeps {
  cfg: ProactivityConfig;
  sessionId: string;
  store?: MemoryStore;
  ownerId?: string;
  agentId?: string;
  now: () => number;
  /** Memory notice played and memory not declined (Session.memoryGate() === 'ok'). */
  canPersist: () => boolean;
  copy: (language: Language) => ProactiveCopy;
  rules: (language: Language) => ProactiveRules;
  logger: Logger;
}

export interface SilenceInput {
  step: SilenceStep;
  language: Language;
  hadContent: boolean;
  /** The user's last substantive line in this session; '' when none. */
  lastUtterance: string;
  knownName: boolean;
  card: AffectCard | null;
  lowIntensity: number;
  /** Validated open loop from the latest card. */
  openLoop?: string;
}

const MOMENT_OF: Record<SilenceStep, Moment> = {
  context: 'silenceContext', check: 'silenceCheck', leave: 'silenceLeave', checkin: 'silenceCheckin', rest: 'silenceRest',
};
const TIERS: readonly ProactiveTier[] = ['quiet', 'moderate', 'active'];
const TOPIC_KEY = 'topicCard';
const NAME_KEY = 'greetingName';
const DAY = 86_400_000;

const isScored = (kind: string): kind is ScoredKind => (SCORED_KINDS as readonly string[]).includes(kind);
const hasAny = (text: string, phrases: readonly string[]) => phrases.some((phrase) => containsPhrase(text, phrase));

/** One step down or up by voice; null when nothing matched, both matched, or already at the end. */
export function nextTier(tier: ProactiveTier, text: string, rules: Pick<SilenceRules, 'tierDown' | 'tierUp'>): ProactiveTier | null {
  const down = hasAny(text, rules.tierDown);
  const up = hasAny(text, rules.tierUp);
  if (down === up) return null;
  const index = TIERS.indexOf(tier) + (down ? -1 : 1);
  return index < 0 || index >= TIERS.length ? null : TIERS[index]!;
}

interface InFlight {
  request: ProactiveRequest;
  planned: PlannedIntent;
  threadId?: string;
  language: Language;
  line: { key: string; index: number; text: string };
  topicIndex: number | null;
  /** The fallback line itself is what gets spoken. */
  spokeFallback: boolean;
}

export class ProactiveRuntime {
  private loaded = false;
  private day = '';
  private tier: ProactiveTier;
  /** Tier chosen by voice in this session; survives a reload. */
  private tierChosen: ProactiveTier | null = null;
  private stats: Array<{ kind: string; accepted: number; rejected: number }> = [];
  private todaySpoken = 0;
  private threads: ThreadRecord[] = [];
  private lastMood: MoodSummaryRecord | null = null;
  private lastHumanAt: number | null = null;
  private familiarity: Familiarity = 'new';
  private recentLines: string[] = [];
  private sessionSpoken = 0;
  private readonly spokenKinds = new Set<ScoredKind>();
  private readonly mentioned = new Set<string>();
  private readonly usedLines = new Map<string, number[]>();
  private leaving = false;
  private exhaustedSeen = 0;
  private exhaustedOk = false;
  private inFlight: InFlight | null = null;
  private live: InFlight | null = null;
  private opening: { language: Language; request: ProactiveRequest } | null = null;
  private readonly acceptance: AcceptanceTracker;

  constructor(private readonly deps: ProactiveRuntimeDeps) {
    this.tier = deps.cfg.defaultTier;
    this.acceptance = new AcceptanceTracker(deps.cfg.acceptance.windowMs);
  }

  /** Spec 连接期间预取: read the decision context before the opening is needed. */
  prefetch(): void {
    this.ensureLoaded();
  }

  familiarityTier(): Familiarity {
    this.ensureLoaded();
    return this.familiarity;
  }

  /** Known-name opening (spec 开场, Q15). The same request is returned for a retry in the same language. */
  openingLine(input: { language: Language; name: string | null; firstMeet: boolean }): ProactiveRequest | null {
    if (input.firstMeet || !input.name) return null;
    const copy = this.deps.copy(input.language);
    const names = copy.greetingNameTexts ?? [];
    const heads = copy.greetingHeads ?? [];
    if (!copy.intents || !copy.fallbacks || names.length === 0 || heads.length === 0) return null;
    if (this.opening?.language === input.language) return this.opening.request;
    this.ensureLoaded();
    const now = this.deps.now();
    const name = input.name;
    const ctx = this.context('sessionStart', { low: false, crisis: false, stage: 'explore' }, { openLoop: false, interest: false, family: false }, this.threads);
    const { decision, decideMs } = this.timedDecide(ctx);
    const planned = buildIntent(decision, {
      moment: 'sessionStart', now, language: input.language, familiarity: this.familiarity, affect: { low: false, stage: 'explore' },
      material: { thread: this.threads.find((t) => t.id === decision.threadId) }, cfg: this.deps.cfg, saidWords: copy.intents.saidWhen,
    });
    this.logDecision('sessionStart', decision, planned, decideMs);
    if (!planned) return null;
    let line: InFlight['line'];
    if (planned.intent.kind === 'greetingPlain') {
      const index = pickFallback(names.length, this.recentFor(NAME_KEY, names.length));
      line = { key: NAME_KEY, index, text: names[index]!.replaceAll('{name}', () => name) };
    } else {
      const key = planned.intent.fallbackKey as FallbackKey;
      const lines = copy.fallbacks[key];
      const index = pickFallback(lines.length, this.recentFor(key, this.deps.cfg.fallbackKeep));
      const head = heads[pickFallback(heads.length, [])]!;
      line = { key, index, text: composeOpening(head, name, lines[index]!) };
    }
    // The opening keeps the greeting cue: Mock scripts and response kinds key on it.
    const request: ProactiveRequest = { ...renderIntent(planned, copy.intents, line.text, { name }), cue: 'greeting' };
    this.inFlight = {
      request, planned, language: input.language, line, topicIndex: null, spokeFallback: planned.fallbackOnly,
      ...(decision.threadId ? { threadId: decision.threadId } : {}),
    };
    this.opening = { language: input.language, request };
    return request;
  }

  silenceLine(input: SilenceInput): ProactiveLineResult {
    const copy = this.deps.copy(input.language);
    if (!copy.intents || !copy.fallbacks) return null;
    // The opening asked for a name and nothing has been said yet: the configured copy keeps asking.
    if (!input.hadContent && !input.knownName) return null;
    // Q6: never hold on to a user who is leaving.
    if (this.leaving) return { close: true };
    this.ensureLoaded();
    this.settle(this.acceptance.expire(this.deps.now()), false);
    const rules = this.deps.rules(input.language);
    const moment = MOMENT_OF[input.step];
    const now = this.deps.now();
    const low = isLow(input.card, input.lowIntensity);
    const stage = careStage(input.card);
    const openLoop = this.openLoopFor(input, rules);
    const topic = this.pickTopic(copy.topics);
    const family = this.familyLine(rules);
    const ctx = this.context(moment, { low, crisis: input.card?.crisis ?? false, stage }, {
      openLoop: openLoop !== undefined, interest: topic !== null, family: family !== undefined,
    }, this.threads);
    const { decision, decideMs } = this.timedDecide(ctx);
    const material: IntentMaterial = {
      thread: this.threads.find((t) => t.id === decision.threadId),
      ...(openLoop ? { openLoop, openLoopSensitive: hasAny(openLoop, rules.healthWords) } : {}),
      ...(topic ? { topic: topic.card.prompt } : {}),
      ...(family ? { family } : {}),
    };
    const planned = buildIntent(decision, {
      moment, now, language: input.language, familiarity: this.familiarity, affect: { low, stage },
      material, cfg: this.deps.cfg, saidWords: copy.intents.saidWhen,
    });
    this.logDecision(moment, decision, planned, decideMs);
    if (!planned) return { quiet: true };
    const key = planned.intent.fallbackKey as FallbackKey;
    const lines = copy.fallbacks[key];
    const index = pickFallback(lines.length, this.recentFor(key, this.deps.cfg.fallbackKeep));
    const text = lines[index]!;
    const request = renderIntent(planned, copy.intents, text);
    this.inFlight = {
      request, planned, language: input.language, line: { key, index, text },
      topicIndex: planned.intent.kind === 'interestTopic' && topic ? topic.index : null,
      spokeFallback: planned.fallbackOnly,
      ...(decision.threadId ? { threadId: decision.threadId } : {}),
    };
    return { request };
  }

  /** Topic exhaustion (spec 话题聊干): one decision per arming, self-talk only. */
  approveExhausted(armedCount: number, input: { language: Language; card: AffectCard | null; lowIntensity: number }): boolean {
    if (armedCount === this.exhaustedSeen) return this.exhaustedOk;
    this.exhaustedSeen = armedCount;
    const copy = this.deps.copy(input.language);
    if (!copy.intents || !copy.fallbacks) {
      this.exhaustedOk = true;
      return true;
    }
    this.ensureLoaded();
    const ctx = this.context('topicExhausted', {
      low: isLow(input.card, input.lowIntensity), crisis: input.card?.crisis ?? false, stage: careStage(input.card),
    }, { openLoop: false, interest: false, family: false }, []);
    const { decision, decideMs } = this.timedDecide(ctx);
    this.logDecision('topicExhausted', decision, null, decideMs);
    this.exhaustedOk = decision.kind === 'selfShare';
    if (this.exhaustedOk) this.countSpoken('selfShare');
    return this.exhaustedOk;
  }

  owns(request: ProactiveRequest): boolean {
    return this.inFlight?.request === request;
  }

  onRequestRefused(request: ProactiveRequest): void {
    if (this.owns(request)) this.inFlight = null;
  }

  onLineStarted(request: ProactiveRequest): void {
    const f = this.inFlight;
    if (!f || f.request !== request) return;
    this.inFlight = null;
    this.live = f;
    const kind = f.planned.intent.kind;
    const now = this.deps.now();
    if (isScored(kind)) {
      this.countSpoken(kind);
      if (kind === 'humanConnection') this.lastHumanAt = now;
      if (f.threadId) {
        this.mentioned.add(f.threadId);
        const id = f.threadId;
        this.write('mention', (store, ownerId) => { store.markThreadMentioned(ownerId, id, now); });
      }
      this.settle(this.acceptance.open({ kind, ...(f.threadId ? { threadId: f.threadId } : {}) }), false);
    }
    if (f.spokeFallback) this.rememberUsed(f.line.key, f.line.index, this.deps.cfg.fallbackKeep);
    if (f.topicIndex !== null) this.rememberUsed(TOPIC_KEY, f.topicIndex, this.deps.copy(f.language).topics.length);
  }

  /** Nothing was heard in time: read the same intent's fallback line, once. */
  fallbackFor(request: ProactiveRequest): ProactiveRequest | null {
    const f = this.inFlight;
    // A read-out line (health group or an earlier fallback) is never asked for twice.
    if (!f || f.request !== request || f.spokeFallback) return null;
    const intents = this.deps.copy(f.language).intents;
    if (!intents) return null;
    f.spokeFallback = true;
    f.request = { ...speakLineRequest(intents, f.line.text), cue: f.request.cue };
    this.deps.logger.warn('proactive_fallback', { kind: f.planned.intent.kind, code: 'no_audio' });
    return f.request;
  }

  onLineEnded(text: string, interrupted: boolean): void {
    const f = this.live;
    if (!f) return;
    this.live = null;
    this.acceptance.ended(this.deps.now());
    const said = text.trim();
    if (interrupted || !said) return;
    const intent = f.planned.intent;
    const material = f.spokeFallback
      ? [f.line.text]
      : [...intent.material.quotes.flatMap((q) => (q.said ? [q.text, q.said] : [q.text])), ...intent.material.facts];
    const rules = this.deps.rules(f.language);
    const check = checkSpoken(said, {
      material, allowQuestion: intent.constraints.allowQuestion, mustExpress: intent.constraints.mustExpress,
    }, { healthWords: rules.healthWords, silence: rules.silence });
    for (const v of violationsOf(check)) {
      this.deps.logger.warn('proactive_grounding_violation', { kind: intent.kind, violationKind: v.kind, count: v.count });
    }
  }

  onUserFinal(text: string, light: boolean, language: Language): void {
    const rules = this.deps.rules(language);
    const copy = this.deps.copy(language);
    if (!light) this.leaving = hasAny(text, rules.silence.farewell);
    this.ensureLoaded();
    const tier = nextTier(this.tier, text, rules.silence);
    if (tier) {
      const from = this.tier;
      this.tier = tier;
      this.tierChosen = tier;
      const now = this.deps.now();
      this.write('tier', (store, ownerId, agentId) => { store.setProactiveTier(ownerId, agentId, tier, now); });
      this.deps.logger.info('proactive_tier_changed', { from, to: tier });
    }
    const declined = !light && hasAny(text, [...rules.declinePhrases, ...copy.quietPhrases, ...rules.silence.tierDown]);
    const verdict: Verdict = light ? 'light' : declined ? 'decline' : 'content';
    this.settle(this.acceptance.onUserFinal(this.deps.now(), verdict), declined);
  }

  /** After forget / decline: cached user words may be gone; read them again when next needed. */
  reload(): void {
    this.loaded = false;
    this.threads = [];
    this.recentLines = [];
    this.lastMood = null;
    this.stats = [];
    this.familiarity = 'new';
    this.opening = null;
  }

  end(): void {
    this.settle(this.acceptance.flush(), false);
    this.inFlight = null;
    this.live = null;
    this.opening = null;
  }

  private context(moment: Moment, affect: DecisionContext['affect'], has: DecisionContext['has'], threads: readonly ThreadRecord[]): DecisionContext {
    return {
      moment,
      now: this.deps.now(),
      currentSessionId: this.deps.sessionId,
      tier: this.tier,
      affect,
      lastMood: this.lastMood,
      threads,
      has,
      sessionSpoken: this.sessionSpoken,
      todaySpoken: this.todaySpoken,
      spokenKinds: this.spokenKinds,
      mentionedThreads: this.mentioned,
      stats: this.stats,
      userLeaving: false,
    };
  }

  private timedDecide(ctx: DecisionContext): { decision: Decision; decideMs: number } {
    const started = performance.now();
    const decision = decide(ctx, this.deps.cfg);
    return { decision, decideMs: Math.round(performance.now() - started) };
  }

  private logDecision(moment: Moment, decision: Decision, planned: PlannedIntent | null, decideMs: number): void {
    this.deps.logger.info('proactive_decision', {
      moment,
      kind: decision.kind,
      score: Math.round(decision.score * 100) / 100,
      candidates: decision.candidates,
      tier: this.tier,
      fallback: planned?.fallbackOnly ?? false,
      decideMs,
    });
  }

  private countSpoken(kind: ScoredKind): void {
    this.sessionSpoken += 1;
    this.spokenKinds.add(kind);
    this.todaySpoken += 1;
    const day = beijingDay(this.deps.now());
    this.write('daily', (store, ownerId, agentId) => {
      const count = store.incrementProactiveDaily(ownerId, agentId, day);
      if (count > 0) this.todaySpoken = Math.max(this.todaySpoken, count);
    });
  }

  private settle(resolved: Resolved | null, declined: boolean): void {
    if (!resolved) return;
    const { line, outcome } = resolved;
    const now = this.deps.now();
    this.deps.logger.info('proactive_outcome', { kind: line.kind, outcome });
    const row = this.stats.find((s) => s.kind === line.kind);
    if (row) row[outcome] += 1;
    else this.stats.push({ kind: line.kind, accepted: outcome === 'accepted' ? 1 : 0, rejected: outcome === 'rejected' ? 1 : 0 });
    this.write('outcome', (store, ownerId, agentId) => { store.recordProactiveOutcome(ownerId, agentId, line.kind, outcome, now); });
    const threadId = line.threadId;
    if (threadId && outcome === 'rejected' && declined) {
      this.threads = this.threads.filter((t) => t.id !== threadId);
      this.write('close', (store, ownerId) => { store.closeThread(ownerId, threadId, 'declined', now); });
    }
  }

  /** Prefetch once per Beijing day; a failure is empty context for this decision and is retried next time. */
  private ensureLoaded(): void {
    const day = beijingDay(this.deps.now());
    if (this.loaded && day === this.day) return;
    if (day !== this.day) this.todaySpoken = 0;
    this.day = day;
    const { store, ownerId, agentId, cfg } = this.deps;
    this.tier = this.tierChosen ?? cfg.defaultTier;
    if (!store || !ownerId || !agentId) {
      this.loaded = true;
      return;
    }
    try {
      this.tier = this.tierChosen ?? store.getProactiveTier(ownerId, agentId) ?? cfg.defaultTier;
      this.stats = store.proactiveStats(ownerId, agentId);
      this.todaySpoken = Math.max(this.todaySpoken, store.proactiveDaily(ownerId, agentId, day));
      this.threads = store.listOpenThreads(ownerId, agentId);
      this.lastMood = store.listMoodSummaries(ownerId, agentId, 1)[0] ?? null;
      this.familiarity = familiarityOf(store.relationshipStats(ownerId, agentId), cfg);
      this.recentLines = store.recentUserMessages(ownerId, agentId, cfg.material.familyLookback).map((row) => row.text);
      this.lastHumanAt = store.proactiveLastAt(ownerId, agentId, 'humanConnection');
      this.loaded = true;
    } catch {
      this.loaded = false;
      this.tier = this.tierChosen ?? cfg.defaultTier;
      this.threads = [];
      this.recentLines = [];
      this.lastMood = null;
      this.stats = [];
      this.familiarity = 'new';
      this.deps.logger.warn('proactive_prefetch_failed', { code: 'store_error' });
    }
  }

  /** continueThread material: the card's open loop, else the user's last statement (never a question). */
  private openLoopFor(input: SilenceInput, rules: ProactiveRules): string | undefined {
    const loop = input.openLoop?.trim();
    if (loop) return loop;
    const last = input.lastUtterance.trim();
    return input.hadContent && last && isMemoryEvidence(last, rules.evidence) ? last : undefined;
  }

  /** Newest remembered statement naming family, without health words. */
  private familyLine(rules: ProactiveRules): string | undefined {
    const last = this.lastHumanAt;
    if (last !== null && this.deps.now() - last < this.deps.cfg.humanConnection.minIntervalDays * DAY) return undefined;
    return this.recentLines.find((line) => isMemoryEvidence(line, rules.evidence)
      && hasAny(line, rules.silence.familyWords) && !hasAny(line, rules.healthWords));
  }

  private pickTopic(topics: readonly TopicCard[]): { index: number; card: TopicCard } | null {
    if (topics.length === 0) return null;
    const index = pickFallback(topics.length, this.recentFor(TOPIC_KEY, topics.length));
    return { index, card: topics[index]! };
  }

  /** Used indexes, newest first: this session's, then the store's. */
  private recentFor(key: string, limit: number): number[] {
    const local = this.usedLines.get(key) ?? [];
    let stored: number[] = [];
    const { store, ownerId, agentId } = this.deps;
    if (store && ownerId && agentId) {
      try {
        stored = store.recentFallbackLines(ownerId, agentId, key, limit);
      } catch {
        stored = [];
      }
    }
    return [...local, ...stored];
  }

  private rememberUsed(key: string, index: number, keep: number): void {
    const list = [index, ...(this.usedLines.get(key) ?? []).filter((i) => i !== index)].slice(0, Math.max(1, keep));
    this.usedLines.set(key, list);
    const now = this.deps.now();
    this.write('fallback', (store, ownerId, agentId) => { store.recordFallbackLine(ownerId, agentId, key, index, now, keep); });
  }

  /** Cross-session writes: only after the notice and without a decline. Failures never stop speech. */
  private write(code: string, body: (store: MemoryStore, ownerId: string, agentId: string) => void): void {
    const { store, ownerId, agentId } = this.deps;
    if (!store || !ownerId || !agentId || !this.deps.canPersist()) return;
    try {
      body(store, ownerId, agentId);
    } catch {
      this.deps.logger.error('proactive_store_failed', { code });
    }
  }
}
