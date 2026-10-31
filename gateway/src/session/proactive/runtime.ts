// Per-session proactive runtime (spec 决策引擎, 意图渲染). Session counters live here; cross-session data
// is written only after the memory notice played and memory is not declined. No timers, no adapter.
import type { Language } from '@anyidea/protocol';
import type { ProactiveRequest } from '../../adapters/types.ts';
import { containsPhrase } from '../../i18n/text.ts';
import type { SilenceRules, TopicQuestionRules } from '../../i18n/types.ts';
import type { Logger } from '../../log/logger.ts';
import { isMemoryEvidence, type EvidenceRules } from '../../memory/evidence.ts';
import type { MemoryStore, MoodSummaryRecord, ProactiveTier, ThreadRecord, TopicAvoidSource } from '../../memory/store.ts';
import type { FallbackGroups, FallbackKey, IntentCopy, TopicCard } from '../../roles/types.ts';
import { isLow, type AffectCard } from '../affect.ts';
import { AcceptanceTracker, type Resolved, type Verdict } from './acceptance.ts';
import { beijingDay, buildIntent, careStage, questionMode, type IntentMaterial, type PlannedIntent } from './assemble.ts';
import { checkSpoken, violationsOf } from './check.ts';
import { SCORED_KINDS, type IntentKind, type ProactivityConfig, type ScoredKind } from './config.ts';
import { decide, familiarityOf, type Decision, type DecisionContext, type Familiarity, type Moment } from './engine.ts';
import { pickFallback } from './fallback.ts';
import {
  factChoices, pickMemoryMaterial, pickQuestionMaterial, pickTopicMaterial,
  type FactChoice, type QuestionMaterial, type RecentStatement,
} from './questionMaterial.ts';
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
  topicQuestion: TopicQuestionRules;
}

export interface ProactiveRuntimeDeps {
  cfg: ProactivityConfig;
  sessionId: string;
  store?: MemoryStore;
  ownerId?: string;
  agentId?: string;
  now: () => number;
  /** Injected for deterministic 70/30 tests; production uses Math.random. */
  random?: () => number;
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
const SWITCH_STALE_MS = 10_000;
const DAY = 86_400_000;

const isScored = (kind: string): kind is ScoredKind => (SCORED_KINDS as readonly string[]).includes(kind);
const hasAny = (text: string, phrases: readonly string[]) => phrases.some((phrase) => containsPhrase(text, phrase));
const TOPIC_SOURCES: readonly TopicAvoidSource[] = ['card', 'fact', 'pin', 'thread', 'stmt'];
const sourceOfKey = (key: string): TopicAvoidSource => {
  const prefix = key.slice(0, key.indexOf(':'));
  return (TOPIC_SOURCES as readonly string[]).includes(prefix) ? (prefix as TopicAvoidSource) : 'stmt';
};

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
  private questionFacts: FactChoice[] = [];
  private questionStatements: RecentStatement[] = [];
  private avoided = new Set<string>();
  private sessionSpoken = 0;
  private readonly spokenKinds = new Set<ScoredKind>();
  private readonly mentioned = new Set<string>();
  private readonly usedLines = new Map<string, number[]>();
  private leaving = false;
  private exhaustedSeen = 0;
  private exhaustedOk = false;
  private episodeQuestion: QuestionMaterial | null = null;
  private episodeAsked = false;
  private pendingSwitch: { language: Language; key: string; at: number; fromKind: ScoredKind } | null = null;
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
    this.logDecision('sessionStart', decision, decideMs);
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
      request, planned, language: input.language, line, topicIndex: null, spokeFallback: false,
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
    const topic = pickTopicMaterial(copy.topics, this.avoided, this.recentFor(TOPIC_KEY, copy.topics.length));
    if (topic?.exhausted) this.deps.logger.warn('proactive_topic_pool_exhausted', { cards: copy.topics.length });
    const family = this.familyLine(rules);
    const questionEnabled = this.deps.cfg.topicQuestion.enabled;
    const memory = questionEnabled ? this.pickQuestionMemory(rules, copy) : null;
    const questionAvailable = memory !== null || topic !== null;
    const ctx = this.context(moment, { low, crisis: input.card?.crisis ?? false, stage }, {
      openLoop: openLoop !== undefined, interest: questionAvailable, family: family !== undefined, question: questionAvailable,
    }, this.threads);
    const { decision, decideMs } = this.timedDecide(ctx);
    const question = this.questionFor(decision.kind, moment, memory, topic, questionEnabled);
    const material: IntentMaterial = {
      thread: this.threads.find((t) => t.id === decision.threadId),
      ...(openLoop ? { openLoop, openLoopSensitive: hasAny(openLoop, rules.healthWords) } : {}),
      ...(topic ? { topic: topic.material.text } : {}),
      ...(family ? { family } : {}),
      ...(question ? { question } : {}),
    };
    const planned = buildIntent(decision, {
      moment, now, language: input.language, familiarity: this.familiarity, affect: { low, stage },
      material, cfg: this.deps.cfg, saidWords: copy.intents.saidWhen, followUp: this.episodeAsked,
    });
    this.logDecision(moment, decision, decideMs);
    if (!planned) return { quiet: true };
    const key = planned.intent.fallbackKey as FallbackKey;
    const lines = copy.fallbacks[key];
    const index = pickFallback(lines.length, this.recentFor(key, this.deps.cfg.fallbackKeep));
    const text = lines[index]!;
    const request = renderIntent(planned, copy.intents, text);
    this.inFlight = {
      request, planned, language: input.language, line: { key, index, text },
      topicIndex: question?.cardIndex ?? null,
      spokeFallback: false,
      ...(decision.threadId ? { threadId: decision.threadId } : {}),
    };
    return { request };
  }

  /** One question material per silence episode; leave reuses it as a statement, never asks anew. */
  private questionFor(
    kind: IntentKind,
    moment: Moment,
    memory: QuestionMaterial | null,
    topic: { material: QuestionMaterial; exhausted: boolean } | null,
    enabled: boolean,
  ): QuestionMaterial | undefined {
    if (!enabled || (kind !== 'interestTopic' && kind !== 'selfShare')) return undefined;
    const mode = questionMode(kind, moment, enabled);
    if (kind === 'selfShare' && mode !== 'required') return undefined;
    if (kind === 'interestTopic' && mode === 'forbidden') return this.episodeQuestion ?? topic?.material;
    if (this.episodeQuestion) return this.episodeQuestion;
    const picked = pickQuestionMaterial({
      random: this.deps.random ?? Math.random,
      memoryRatio: this.deps.cfg.topicQuestion.memoryRatio,
      memory,
      topic,
    });
    if (!picked) return undefined;
    this.episodeQuestion = picked.material;
    return picked.material;
  }

  private pickQuestionMemory(rules: ProactiveRules, copy: ProactiveCopy): QuestionMaterial | null {
    if (!copy.intents) return null;
    const cfg = this.deps.cfg.topicQuestion;
    return pickMemoryMaterial({
      now: this.deps.now(),
      threads: this.threads,
      facts: this.questionFacts,
      statements: this.questionStatements,
      avoided: this.avoided,
      healthWords: rules.healthWords,
      evidence: rules.evidence,
      rules: rules.topicQuestion,
      factCategories: cfg.factCategories,
      saidWords: copy.intents.saidWhen,
      minStatementChars: cfg.minStatementChars,
      mentioned: this.mentioned,
    });
  }

  /** Built after the user's "换个话题" reply ends; null when stale, capped, blocked, or empty. */
  takeSwitchRequest(input: { card: AffectCard | null; lowIntensity: number }): ProactiveRequest | null {
    const pending = this.pendingSwitch;
    if (!pending) return null;
    this.pendingSwitch = null;
    const now = this.deps.now();
    if (now - pending.at > SWITCH_STALE_MS) {
      this.deps.logger.info('proactive_switch_cancelled', { code: 'timeout' });
      return null;
    }
    if (this.leaving || !this.deps.cfg.enabled) {
      this.deps.logger.info('proactive_switch_cancelled', { code: 'blocked' });
      return null;
    }
    const copy = this.deps.copy(pending.language);
    if (!copy.intents || !copy.fallbacks) return null;
    this.ensureLoaded();
    const tier = this.deps.cfg.tiers[this.tier];
    if (this.sessionSpoken >= tier.maxPerSession || this.todaySpoken >= tier.maxPerDay) {
      this.deps.logger.warn('proactive_switch_capped', { code: 'cap' });
      return null;
    }
    const rules = this.deps.rules(pending.language);
    const topic = pickTopicMaterial(copy.topics, this.avoided, this.recentFor(TOPIC_KEY, copy.topics.length));
    if (topic?.exhausted) this.deps.logger.warn('proactive_topic_pool_exhausted', { cards: copy.topics.length });
    const picked = pickQuestionMaterial({
      random: this.deps.random ?? Math.random,
      memoryRatio: this.deps.cfg.topicQuestion.memoryRatio,
      memory: this.pickQuestionMemory(rules, copy),
      topic,
    });
    if (!picked) {
      this.deps.logger.info('proactive_switch_cancelled', { code: 'no_material' });
      return null;
    }
    const low = isLow(input.card, input.lowIntensity);
    const stage = careStage(input.card);
    const material: IntentMaterial = {
      ...(topic ? { topic: topic.material.text } : {}),
      question: picked.material,
    };
    const planned = buildIntent({ kind: 'interestTopic', score: 1, candidates: 0 }, {
      moment: 'silenceContext', now, language: pending.language, familiarity: this.familiarity,
      affect: { low, stage }, material, cfg: this.deps.cfg, saidWords: copy.intents.saidWhen, followUp: false,
    });
    if (!planned) {
      this.deps.logger.info('proactive_switch_cancelled', { code: 'no_material' });
      return null;
    }
    const key = planned.intent.fallbackKey as FallbackKey;
    const lines = copy.fallbacks[key];
    const index = pickFallback(lines.length, this.recentFor(key, this.deps.cfg.fallbackKeep));
    const text = lines[index]!;
    const request = renderIntent(planned, copy.intents, text);
    this.inFlight = {
      request, planned, language: pending.language, line: { key, index, text },
      topicIndex: picked.material.cardIndex, spokeFallback: false,
    };
    this.episodeQuestion = picked.material;
    this.episodeAsked = false;
    this.deps.logger.info('proactive_switch', {
      fromKind: pending.fromKind, source: sourceOfKey(pending.key), delayMs: now - pending.at, capped: false,
    });
    return request;
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
    this.logDecision('topicExhausted', decision, decideMs);
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
      this.settle(this.acceptance.open({
        kind,
        ...(f.threadId ? { threadId: f.threadId } : {}),
        ...(f.planned.intent.questionKey ? { topicKey: f.planned.intent.questionKey } : {}),
      }), false);
    }
    if (f.planned.intent.constraints.question === 'required') this.episodeAsked = true;
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
    f.request = {
      ...speakLineRequest(intents, f.line.text),
      cue: f.request.cue,
      ...(f.request.topicKey ? { topicKey: f.request.topicKey } : {}),
    };
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
      : [
        ...intent.material.quotes.flatMap((q) => (q.said ? [q.text, q.said] : [q.text])),
        ...intent.material.facts,
        ...(intent.material.question ? [intent.material.question.text] : []),
      ];
    const rules = this.deps.rules(f.language);
    const check = checkSpoken(said, {
      material, question: intent.constraints.question, mustExpress: intent.constraints.mustExpress,
    }, { healthWords: rules.healthWords, silence: rules.silence });
    for (const v of violationsOf(check)) {
      this.deps.logger.warn('proactive_grounding_violation', { kind: intent.kind, violationKind: v.kind, count: v.count });
    }
  }

  onUserFinal(text: string, light: boolean, language: Language): void {
    const rules = this.deps.rules(language);
    const copy = this.deps.copy(language);
    if (!light) {
      this.episodeQuestion = null;
      this.episodeAsked = false;
    }
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
    const questionEnabled = this.deps.cfg.topicQuestion.enabled;
    const switchIntent = questionEnabled && !light && hasAny(text, rules.topicQuestion.switchPhrases);
    const topicDecline = questionEnabled && !light && hasAny(text, rules.topicQuestion.topicDeclinePhrases);
    if (this.pendingSwitch && !switchIntent) {
      this.pendingSwitch = null;
      this.deps.logger.info('proactive_switch_cancelled', { code: 'new_user' });
    }
    const declined = switchIntent || topicDecline
      || (!light && hasAny(text, [...rules.declinePhrases, ...copy.quietPhrases, ...rules.silence.tierDown]));
    const verdict: Verdict = light ? 'light' : declined ? 'decline' : 'content';
    const resolved = this.acceptance.onUserFinal(this.deps.now(), verdict);
    if (resolved?.line.topicKey && (switchIntent || topicDecline)) {
      const key = resolved.line.topicKey;
      const source = sourceOfKey(key);
      this.avoidTopic(key, source, this.deps.now());
      this.deps.logger.info('proactive_topic_declined', { source, keyType: source, switch: switchIntent });
      if (switchIntent) this.pendingSwitch = { language, key, at: this.deps.now(), fromKind: resolved.line.kind };
    }
    this.settle(resolved, declined);
  }

  /** Records one declined topic key in memory and after the memory notice. */
  private avoidTopic(key: string, source: TopicAvoidSource, now: number): void {
    this.avoided.add(key);
    this.write('topicAvoid', (store, ownerId, agentId) => { store.recordTopicAvoid(ownerId, agentId, key, source, now); });
  }

  /** After forget / decline: cached user words may be gone; read them again when next needed. */
  reload(): void {
    this.loaded = false;
    this.threads = [];
    this.recentLines = [];
    this.questionFacts = [];
    this.questionStatements = [];
    this.avoided.clear();
    this.episodeQuestion = null;
    this.episodeAsked = false;
    this.pendingSwitch = null;
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
    this.episodeQuestion = null;
    this.episodeAsked = false;
    this.pendingSwitch = null;
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

  private logDecision(moment: Moment, decision: Decision, decideMs: number): void {
    this.deps.logger.info('proactive_decision', {
      moment,
      kind: decision.kind,
      score: Math.round(decision.score * 100) / 100,
      candidates: decision.candidates,
      tier: this.tier,
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
      this.loadQuestionMaterial(store, ownerId, agentId, cfg);
      this.loadTopicAvoid(store, ownerId, agentId, cfg);
      this.lastHumanAt = store.proactiveLastAt(ownerId, agentId, 'humanConnection');
      this.loaded = true;
    } catch {
      this.loaded = false;
      this.tier = this.tierChosen ?? cfg.defaultTier;
      this.threads = [];
      this.recentLines = [];
      this.questionFacts = [];
      this.questionStatements = [];
      this.avoided.clear();
      this.lastMood = null;
      this.stats = [];
      this.familiarity = 'new';
      this.deps.logger.warn('proactive_prefetch_failed', { code: 'store_error' });
    }
  }

  /** Newest user line of each of the last N ended sessions within the configured day window. */
  private loadRecentStatements(
    store: MemoryStore, ownerId: string, agentId: string, cfg: ProactivityConfig, now: number,
  ): RecentStatement[] {
    const since = now - cfg.topicQuestion.recentDays * DAY;
    const sessions = store.listSessions(ownerId)
      .filter((session) => session.agentId === agentId && session.endedAt !== null && session.endedAt >= since)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, cfg.topicQuestion.recentSessions);
    const out: RecentStatement[] = [];
    for (const session of sessions) {
      const lines = store.listSessionUserLines(ownerId, agentId, session.id);
      for (let index = lines.length - 1; index >= 0; index--) {
        const text = lines[index]!.text;
        if (text.trim()) out.push({ text, saidAt: session.startedAt });
      }
    }
    return out;
  }

  /** Facts/statements are optional: a partial test store or a failed read must not disable proactivity. */
  private loadQuestionMaterial(store: MemoryStore, ownerId: string, agentId: string, cfg: ProactivityConfig): void {
    this.questionFacts = [];
    this.questionStatements = [];
    try {
      this.questionFacts = factChoices(
        store.listProfileFacts(ownerId),
        store.listAgentFacts(ownerId, agentId),
        store.listPinned(ownerId, agentId),
      );
      this.questionStatements = this.loadRecentStatements(store, ownerId, agentId, cfg, this.deps.now());
    } catch {
      this.questionFacts = [];
      this.questionStatements = [];
      this.deps.logger.warn('proactive_question_store_error', { code: 'store_error' });
    }
  }

  /** Negative preferences are optional: a partial store or a failed read must not disable proactivity. */
  private loadTopicAvoid(store: MemoryStore, ownerId: string, agentId: string, cfg: ProactivityConfig): void {
    try {
      const days = cfg.topicQuestion.declineCooldownDays;
      const since = days === 0 ? null : this.deps.now() - days * DAY;
      this.avoided = new Set(store.listTopicAvoid(ownerId, agentId, since).keys());
    } catch {
      this.avoided = new Set();
      this.deps.logger.warn('proactive_topic_avoid_store_error', { code: 'store_error' });
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
