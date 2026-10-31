import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AI_SAMPLE_RATE,
  DEFAULT_CHARACTER_ID,
  LANGUAGES,
  MIC_FRAME_SAMPLES,
  truncateByPlayback,
  type ClientMessage,
  type Language,
  type ResponseKind,
  type ServerMessage,
} from '@anyidea/protocol';
import { classifyAdapterError } from '../adapters/errorClass.ts';
import type { AdapterFactory, ProactiveRequest, RealtimeAdapter, SessionConfig } from '../adapters/types.ts';
import type { CharacterRegistry } from '../characters/registry.ts';
import { defaultLogger, type Logger } from '../log/logger.ts';
import { sessionLogBinding } from './logBinding.ts';
import { unique } from '../unique.ts';
import { memoryViewSource, renderMemoryViews } from '../memory/snapshot.ts';
import type { MemoryStore } from '../memory/store.ts';
import { withUsageTag, type TextModelClient } from '../memory/textClient.ts';
import type { UsageAttribution, UsageKind, UsageRecorder } from '../usage/types.ts';
import { MemoryWorker, type MemoryExtractor } from '../memory/worker.ts';
import { runWithPolicy, type PolicySpec } from '../reliability/policy.ts';
import { ActionRouter } from './actions.ts';
import { AffectTracker, affectSummaryFields, isLow, type AffectCard, type AffectConfig, type AffectSummary } from './affect.ts';
import type { ProactivityConfig } from './proactive/config.ts';
import type { RealtimeConfig } from '../realtime/models.ts';
import { ProactiveRuntime } from './proactive/runtime.ts';
import { summarizeMood } from './mood.ts';
import { renderAffect } from './affectRender.ts';
import type { TranscriptWriter } from '../memory/writer.ts';
import { DEFAULT_I18N } from '../i18n/load.ts';
import { containsPhrase } from '../i18n/text.ts';
import type { I18nBundle, LanguageRules } from '../i18n/types.ts';
import type { RoleCatalog } from '../roles/catalog.ts';
import { PROMPT_LABELS } from '../roles/labels.ts';
import { devContext, type SessionContext } from './context.ts';
import { Director, type DirectorConfig, type SilenceContext, type SilencePlan } from './director.ts';
import { EmotionTagger, type EmotionConfig } from './emotion.ts';
import { InterruptCoordinator } from './interrupt.ts';
import { buildInstructions, historyBudget, type InstructionBudget } from './instructions.ts';
import { detectLanguage, explicitLanguage } from './language.ts';
import { ConversationLedger, DEFAULT_LEDGER_OPTIONS, type LedgerOptions, type Summarizer } from './ledger.ts';
import { RestReminderClock, type RestReminderConfig } from './restReminder.ts';
import { ReplyMetricsTracker, metricFields, type ReplyMetrics } from './metrics.ts';
import { DEFAULT_TOOL_TURN_TIMEOUT_MS, loadMemoryBudget, type PacingConfig } from './pacing.ts';
import { PushGate, type PushRequest } from './pushGate.ts';
import { shouldSpeakBridge, slimClockAction } from './slim.ts';
import { ToolTurn } from './toolTurn.ts';
import { TurnFinals } from './turnAccess.ts';
import { createToolRegistry, type ToolOutcome, type ToolRegistry } from './tools/registry.ts';

export interface Transport {
  send(msg: ServerMessage): void;
  sendAudio(seq: number, pcm: Int16Array): void;
}

export type { TranscriptWriter };

type RebuildReason = 'error' | 'closed' | 'slim' | 'forget' | 'decline';

function waitsForMemoryJob(name: string, args: unknown): boolean {
  if (name === 'forget_memory') return true;
  if (name !== 'set_memory_consent') return false;
  let value = args;
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return false; }
  }
  if (!value || typeof value !== 'object') return false;
  const row = value as { granted?: unknown; confirmed?: unknown };
  return row.granted === 'declined' && row.confirmed === true;
}

function toolPayload(outcome: ToolOutcome): { ok: boolean; error?: string; text?: string } {
  const payload: { ok: boolean; error?: string; text?: string } = { ok: outcome.ok };
  if (outcome.error) payload.error = outcome.error;
  if (outcome.text) payload.text = outcome.text;
  return payload;
}

export interface SessionDeps {
  adapterFactory: AdapterFactory;
  summarizer: Summarizer;
  roles: RoleCatalog;
  /** Character cards. Optional for tests; production always passes it. Without it the role is roles.defaultRole(). */
  characters?: CharacterRegistry;
  textClient?: TextModelClient;
  ledger?: LedgerOptions;
  confirmWindowMs?: number;
  modelContextTokenLimit?: number;
  rebuildAfterTurns?: number;
  rebuildBackoffBaseMs?: number;
  rebuildBackoffMaxMs?: number;
  /** The upstream model detects turns itself. Drop mic uplink while a reply is active and for tailGuardMs after playback; Director follow-ups still apply. */
  modelOwnsTurns?: boolean;
  /** Receives each finalized reply's metrics (eval harness). Production only logs them. */
  onReplyMetrics?: (m: ReplyMetrics) => void;
  /** Usage sink for realtime replies. Unset in eval and most tests, so nothing is billed there. */
  usage?: UsageRecorder;
  /** Adapter and model billed for realtime replies. Unset in eval and most tests. */
  usageSource?: { adapter: 'qwen' | 'mock'; model: string };
  summarizePolicy?: PolicySpec;
  maxOutputTokens?: number;
  /** Uplink resumes this long after playback ended (reason=ended) when the model owns turns. */
  tailGuardMs?: number;
  /** Tool-turn wait. Omitted in tests: DEFAULT_TOOL_TURN_TIMEOUT_MS, same as gateway/config/memory.json. */
  toolTurnTimeoutMs?: number;
  /** pin_memory limits (gateway/config/memory.json). Omitted in tests: the registry reads that file. */
  pin?: { maxPerCharacter: number; maxChars: Record<Language, number>; finalWaitMs: number };
  /** list_memory cap (gateway/config/memory.json). Omitted in tests: the registry reads that file. */
  listMaxItems?: number;
  /** Instruction size budget (gateway/config/memory.json); undefined = unbounded (tests). */
  budget?: InstructionBudget;
  /** Per-language instruction budgets; the current language's entry wins over `budget`. */
  budgets?: Partial<Record<Language, InstructionBudget>>;
  /** Fallback history room when no per-language budget is available (tests). */
  maxHistoryChars?: number;
  /** Loaded language packs for memory views and evidence rules. Defaults to DEFAULT_I18N. */
  i18n?: I18nBundle;
  /** Recall snippet cap (gateway/config/memory.json). Defaults to 80. */
  recallClipChars?: number;
  /** Recall phrasing deadline (gateway/config/memory.json). Defaults to 1500. */
  recallPhraseTimeoutMs?: number;
  /** The memory notice is verified by these words in its transcript (or verbatim fallback). */
  noticeKeywords?: readonly string[];
  /** Per-language notice keywords; a notice is verified in the language it was requested in. */
  noticeKeywordsByLanguage?: Partial<Record<Language, readonly string[]>>;
  /** Fraction of modelContextTokenLimit that triggers a silent slim rebuild. */
  rebuildTriggerRatio?: number;
  /** Interval slim rebuild (gateway/config/pacing.json slim). */
  slim?: PacingConfig['slim'];
  /** Push seam pacing (gateway/config/pacing.json push). Omitted in tests: DEFAULT_PUSH. */
  push?: PacingConfig['push'];
  /** Rest reminder thresholds (gateway/config/pacing.json restReminder). Omitted = reminders off (tests). */
  restReminder?: RestReminderConfig;
  /** Clock for tests; production uses Date.now. */
  now?: () => number;
  /** Emotion lexicon (gateway/config/emotion.json); undefined = no avatar.emotion messages. */
  emotion?: EmotionConfig;
  /** Affect analyzer (gateway/config/affect.json). Runs only with a textClient and enabled=true. */
  affect?: AffectConfig;
  /** Current model capability and resolved voices; undefined in bare unit tests. */
  realtime?: RealtimeConfig;
  /** proactivity.json from the session snapshot; read by the decision engine (P3). */
  proactivity?: ProactivityConfig;
  /** Optional. flush() returns immediately when this is absent. */
  writer?: TranscriptWriter;
  /** Optional. Dev sessions omit this, so turns and silence do not enqueue extraction. */
  worker?: MemoryExtractor;
  /** Optional. Dev sessions have no owner store, so memory tools report memory_unavailable. */
  store?: MemoryStore;
  /** User finals between extracts. Defaults to 10, matching gateway/config/memory.json. */
  extractEveryUserTurns?: number;
  /** Rest delay used when a worker is injected. Matches extractSilenceMs. */
  extractSilenceMs?: number;
  /** Voice for this session's character in a language; undefined = adapter default. index.ts resolves the card, then the env default. */
  voiceFor?: (language: Language) => string | undefined;
  /** Loaded language rules (gateway/config/i18n). Undefined = script heuristic only (tests). */
  languageRules?: LanguageRules;
  /** Root logger; the session binds sid/oid/char itself. Omitted in tests: the stdout default. */
  logger?: Logger;
}

interface ResponseState {
  seq: number;
  kind: ResponseKind;
  text: string;
  audioMs: number;
  playedMs: number;
  finalized: boolean;
  /** Set once flush() has handed this reply to the writer. */
  flushed: boolean;
  /** Set when responseDone arrives, including before the tool call. */
  responseDone: boolean;
  /** Set when playback.stopped reason=ended arrives for this seq. */
  playbackEnded: boolean;
}

const MAX_REBUILD_MIC_FRAMES = 25;
/** 600 ms. The local detector confirms speech after 150 ms, so the onset is already in this buffer. */
const BARGE_PREROLL_FRAMES = 30;
/** Matches the client barge-in threshold. Playback echo sits well below it. */
const BARGE_PREROLL_RMS = 200;

/** Used only when no policy is injected (tests); production reads gateway/config/pacing.json. */
const DEFAULT_SUMMARIZE_POLICY: PolicySpec = { timeoutMs: 15_000, retries: 0, backoffMs: 1_000, maxBackoffMs: 1_000 };

/** Used only when SessionDeps.push is omitted (tests); production reads gateway/config/pacing.json. */
const DEFAULT_PUSH: PacingConfig['push'] = { minIntervalMs: 0, noResponseAfterMs: 5_000 };
/** Read once at startup. Tests without deps.pin use pinFinalWaitMs from this file. */
const MEMORY_DEFAULTS = loadMemoryBudget(fileURLToPath(new URL('../../config/memory.json', import.meta.url)));

export class Session {
  readonly ledger: ConversationLedger;
  readonly context: SessionContext;
  private readonly log: Logger;
  private readonly writer: TranscriptWriter | undefined;
  private readonly i18n: I18nBundle;
  private language: Language;
  /** Role pack of this session's character; fixed for the session. */
  private readonly roleId: string;
  /** Held after an explicit language request so later speech does not flip the reply language. */
  private languageLock: Language | null = null;
  private readonly personas = new Map<Language, string>();
  /** Every live session.update goes through here (blockers #48). */
  private readonly gate: PushGate;
  private readonly push: PacingConfig['push'];
  /** True once connect() succeeded on the current adapter; false while rebuilding. */
  private adapterReady = false;
  /** Runs from a user final (or a proactive request) until a response starts; closes the push seam. */
  private replyWatch: NodeJS.Timeout | null = null;
  /** A response started since the last speaking edge; a later final is then not reported. */
  private responseSinceSpeech = false;
  private adapter: RealtimeAdapter;
  private transport: Transport | null = null;
  private readonly director: Director;
  /** Decision engine runtime (P3); null when proactivity.json is not injected (most tests). */
  private readonly proactive: ProactiveRuntime | null;
  /** Engine request sent but not started yet; its fallback timer runs. */
  private proactiveRequest: ProactiveRequest | null = null;
  private proactiveTimer: NodeJS.Timeout | null = null;
  /** Seq of the engine line on air, for the post-hoc check. */
  private proactiveSeq: number | null = null;
  private readonly emotion: EmotionTagger | null;
  /** Null without a text model client or when affect.json disables it: lexicon-only emotion, as before. */
  private readonly affect: AffectTracker | null;
  private readonly interrupt: InterruptCoordinator;
  private readonly actions = new ActionRouter();
  /** One registry per language; recall copy and tool handling follow the current language. */
  private readonly tools = new Map<Language, ToolRegistry>();
  private readonly metrics = new ReplyMetricsTracker();
  private readonly byId = new Map<string, ResponseState>();
  private readonly bySeq = new Map<number, ResponseState>();
  private seqCounter = 0;
  private pendingKind: ResponseKind | null = null;
  private muted = false;
  private keepalive: NodeJS.Timeout | null = null;
  private turnsSinceRebuild = 0;
  private charsSinceRebuild = 0;
  /** Length of the instructions the live model session currently holds. */
  private lastInstructionsChars = 0;
  private rebuilding = false;
  private ended = false;
  /** Recent mic frames dropped while a reply was playing, so a barge-in can include its onset. */
  private bargePreroll: Int16Array[] = [];
  /** Once the user barges in, keep streaming so the server VAD hears the whole utterance. */
  private streamBarge = false;
  /** True only while the upstream response has not finished. Cancelling a finished one drops the next turn. */
  private responseLive = false;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private rebuildAttempt = 0;
  /** Interval slim clock: next due time, deferral start and its own timer. */
  private slimDueAt = 0;
  private slimDeferredSince: number | null = null;
  private slimTimer: NodeJS.Timeout | null = null;
  /** Rest reminder clock; started with the session, stopped in end() like the slim clock. */
  private restClock: RestReminderClock | null = null;
  /** Local VAD speaking state; part of the slim seam. */
  private userSpeaking = false;
  private readonly rebuildMicBuffer: Int16Array[] = [];
  private summarizeRetryAt = 0;
  private summarizeBackoffMs = 1_000;
  private summarizeInFlight = false;
  private vadSpeakingCount = 0;
  private vadSilentCount = 0;
  private modelGenerating = false;
  private uplinkResumeAt = 0;
  private readonly toolTurn: ToolTurn;
  private toolTimer: NodeJS.Timeout | null = null;
  /** Seq passed to toolTurn.start. Playback for any other seq is ignored. */
  private toolOriginSeq: number | null = null;
  /** Set in the same breath as onContinuationRequested. readyForContinuation stays true after that. */
  private continuationAsked = false;
  /** True when this turn's own cancel stands in for playback.stopped. */
  private originForcedEnd = false;
  /** Seq of the in-flight memory notice, associated when its response actually starts. */
  private noticeSeq: number | null = null;
  /** A notice request is outstanding but no response has started yet. */
  private noticePendingRequest = false;
  /** Language the outstanding notice was requested in; its keywords must not follow later switches. */
  private noticeLanguage: Language | null = null;
  private noticeFallback: string | null = null;
  private noticeVerbatim = false;
  /** User finals since the session started. Every Nth one enqueues extraction. */
  private userTurns = 0;
  /** Spoken after this tool turn, from memory.json. Null keeps the generic tool-continue line. */
  private pendingToolLine: string | null = null;
  /** Grounded line from a recall result; preferred over the generic continue copy. */
  private pendingToolSpeak: { text: string; found: boolean } | null = null;
  /** Forget and confirmed decline rebuild before that line. */
  private pendingToolRebuild: 'forget' | 'decline' | null = null;
  /** Confirm line waiting for the replacement adapter to connect. */
  private confirmLine: string | null = null;
  /** User utterance for this turn. Cleared when that reply is finalized. */
  private turnUserText: string | null = null;
  /** User finals for tools that need the user's own words (pin_memory, spec §6). */
  private readonly turns = new TurnFinals(() => this.ledger.recent, () => this.log);
  /** Forget/decline is waiting on the owner queue. Origin done during this still counts. */
  private memoryToolWaiting = false;
  /** User finals during a forget/decline turn are not stored. */
  private dropUserFinals = false;
  /** Origin seqs whose assistant text must not enter the ledger or the transcript. */
  private readonly dropTranscriptSeqs = new Set<number>();
  /** A forget/decline rebuild arrived while another rebuild was in progress. */
  private rebuildAgain: 'forget' | 'decline' | null = null;
  /** Latest accepted analyzer card; session memory only, never logged. */
  private affectCard: AffectCard | null = null;
  /** Highest card intensity this session; feeds the end-of-session mood summary. */
  private moodPeak = 0;
  /** Affect text the last push request was made for. */
  private affectRendered = '';
  /** affect_crisis is logged at most once per session. */
  private crisisLogged = false;
  /** Last validated open loop from an accepted card; planner input only, never logged. */
  private openLoop: string | undefined;
  /** First-meet opening, picked once per language so a cut-off opening repeats the same sentence. */
  private firstMeetLine: { language: Language; text: string } | null = null;
  /** First meetings only: director configs whose greetingText is the card's no-name line. */
  private readonly firstMeetDirectors = new Map<Language, DirectorConfig>();

  constructor(
    private readonly deps: SessionDeps,
    ctx: SessionContext = devContext(deps.roles, deps.characters, DEFAULT_CHARACTER_ID),
    readonly sessionId: string = randomUUID(),
    private readonly noticePending = false,
  ) {
    this.log = (deps.logger ?? defaultLogger()).child(sessionLogBinding(sessionId, ctx));
    this.writer = deps.writer;
    this.context = ctx;
    this.roleId = deps.characters?.roleOf(ctx.characterId) ?? deps.roles.defaultRole();
    this.i18n = deps.i18n ?? DEFAULT_I18N;
    this.push = deps.push ?? DEFAULT_PUSH;
    this.gate = new PushGate({
      seamOpen: () => this.pushSeamOpen(),
      send: (update) => this.sendSessionUpdate(update),
      now: () => this.now(),
      minIntervalMs: this.push.minIntervalMs,
    });
    this.proactive = deps.proactivity ? new ProactiveRuntime({
      cfg: deps.proactivity,
      sessionId,
      ...(deps.store ? { store: deps.store } : {}),
      ...(ctx.ownerId ? { ownerId: ctx.ownerId } : {}),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      now: () => this.now(),
      canPersist: () => this.memoryGate() === 'ok',
      copy: (language) => {
        const d = this.directorConfig(language);
        return {
          ...(d.intents ? { intents: d.intents } : {}),
          ...(d.fallbacks ? { fallbacks: d.fallbacks } : {}),
          topics: d.topics ?? [],
          quietPhrases: d.quietPhrases,
          ...(d.greetingNameTexts ? { greetingNameTexts: d.greetingNameTexts } : {}),
          ...(d.greetingCareTexts ? { greetingHeads: d.greetingCareTexts } : {}),
        };
      },
      rules: (language) => ({
        silence: this.i18n.silence[language],
        healthWords: this.i18n.memory[language].healthWords,
        declinePhrases: this.i18n.affect[language].declinePhrases,
        evidence: this.i18n.evidence,
      }),
      logger: this.log,
    }) : null;
    this.language = this.resolveLanguage(ctx.language ?? deps.roles.defaultLanguage(this.roleId));
    // The resolver rendered with the role's default language; render again in the session language.
    this.refreshMemorySnapshot();
    const initialPersona = this.personaFor(this.language);
    const ledgerOpts = deps.ledger ?? DEFAULT_LEDGER_OPTIONS;
    // Summarize before the instruction budget would have to drop unsummarized turns.
    const initialBudget = this.budgetFor(this.language);
    const languageRoom = initialBudget
      ? historyBudget(initialPersona, initialBudget, PROMPT_LABELS[this.language])
      : undefined;
    const history = languageRoom ?? deps.maxHistoryChars ?? Number.POSITIVE_INFINITY;
    this.ledger = new ConversationLedger({ ...ledgerOpts, summarizeAfterTokens: Math.min(ledgerOpts.summarizeAfterTokens, history) });
    const extractor = deps.worker;
    const ownerId = ctx.ownerId;
    const agentId = ctx.agentId;
    this.director = new Director(
      (language) => this.directorConfig(language),
      {
        requestResponse: (kind, request) => this.requestResponse(kind, request),
        restReminderRequest: () => this.restReminderRequest(),
        firstMeetGreeting: () => this.firstMeetGreeting(),
        openingRequest: () => this.proactive?.openingLine({ language: this.language, name: this.greetingName(), firstMeet: this.context.firstMeet }) ?? null,
        safeGreeting: () => this.safeGreeting(),
        ...(this.proactive ? { planProactiveLine: (context, signal) => this.planProactiveLine(context, signal) } : {}),
        ...(extractor && ownerId && agentId ? { onQuietRest: () => { void extractor.enqueue(ownerId, agentId, 'silence', this.language); } } : {}),
        logger: this.log,
      },
      this.noticePending,
      extractor ? deps.extractSilenceMs : undefined,
      this.language,
    );
    this.emotion = deps.emotion ? new EmotionTagger(deps.emotion, (emotion) => this.send({ type: 'avatar.emotion', emotion })) : null;
    const affectConfig = deps.affect;
    this.affect = deps.textClient && affectConfig?.enabled
      ? new AffectTracker({
          client: withUsageTag(deps.textClient, { kind: 'affect', attribution: this.usageAttribution() }),
          config: affectConfig,
          prompt: (language) => deps.roles.affectPrompt(ctx.characterId, language),
          history: () => this.ledger.recent,
          evidence: this.i18n.evidence,
          safety: this.i18n.safety,
          // Accepted cards stay on the tracker (this.affect.card); the session mirrors the latest one.
          onCard: (card) => this.onAffectCard(card),
          declinePhrases: (language) => this.i18n.affect[language].declinePhrases,
          logger: this.log,
        })
      : null;
    this.interrupt = new InterruptCoordinator({
      confirmWindowMs: deps.confirmWindowMs ?? 300,
      cancel: (seq, source) => this.cancel(seq, source),
    });
    this.toolTurn = new ToolTurn(Date.now, deps.toolTurnTimeoutMs ?? DEFAULT_TOOL_TURN_TIMEOUT_MS);
    this.adapter = this.createAdapter();
  }

  get lastResponseSeq(): number {
    return this.seqCounter;
  }

  get falseInterruptions(): number {
    return this.interrupt.falseInterruptions;
  }

  async start(transport: Transport): Promise<void> {
    this.transport = transport;
    // Spec 连接期间预取: the opening decision reads the store now, not after connect.
    this.proactive?.prefetch();
    await this.adapter.connect(this.sessionConfig());
    // connect() already carried the latest instructions and voice.
    this.adapterReady = true;
    this.gate.clearPending();
    if (this.ended) {
      this.adapter.close();
      return;
    }
    this.director.onSessionStart(this.openingHasMemory());
    this.startRestReminder();
    this.armSlimInterval();
  }

  attachTransport(transport: Transport): void {
    this.transport = transport;
    this.stopKeepalive();
    transport.send({ type: 'session.resumed', lastResponseSeq: this.seqCounter });
    this.director.resume();
  }

  detachTransport(): void {
    this.transport = null;
    this.director.pause();
    this.interrupt.cancelActive('local');
    // A 'vad silent' sent during the drop is lost: reset the speaking flags.
    this.interrupt.onLocalVad(false);
    this.director.onUserSpeech(false);
    this.userSpeaking = false;
    this.startKeepalive();
  }

  handleMicAudio(pcm: Int16Array): void {
    if (this.muted || this.ended || this.toolTurn.active) return;
    if (this.rebuilding || this.rebuildTimer) {
      if (this.rebuildMicBuffer.length < MAX_REBUILD_MIC_FRAMES) this.rebuildMicBuffer.push(pcm.slice());
      return;
    }
    // Drop playback echo until the user actually barges in. Then stream, including the onset,
    // so the server VAD can hear the new question while the old reply is still open.
    const playing = this.modelGenerating || this.interrupt.active !== null;
    if (this.deps.modelOwnsTurns && playing && !this.streamBarge) {
      this.rememberBargePreroll(pcm);
      return;
    }
    // Speaker tail after a reply played to the end must not become the next model turn.
    if (this.deps.modelOwnsTurns && !this.streamBarge && Date.now() < this.uplinkResumeAt) return;
    this.flushBargePreroll();
    this.adapter.sendAudio(pcm);
  }

  private rememberBargePreroll(pcm: Int16Array): void {
    this.bargePreroll.push(pcm.slice());
    if (this.bargePreroll.length > BARGE_PREROLL_FRAMES) this.bargePreroll.shift();
  }

  /** Sends the buffered onset from the first loud frame. Quiet echo before it stays dropped. */
  private flushBargePreroll(): void {
    const frames = this.bargePreroll.splice(0);
    const start = frames.findIndex((frame) => this.frameRms(frame) >= BARGE_PREROLL_RMS);
    if (start < 0) return;
    for (let i = start; i < frames.length; i++) this.adapter.sendAudio(frames[i]!);
  }

  private frameRms(pcm: Int16Array): number {
    if (pcm.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
    return Math.sqrt(sum / pcm.length);
  }

  handleClientMessage(msg: ClientMessage): void {
    if (this.ended) return;
    switch (msg.type) {
      case 'vad': {
        const speaking = msg.state === 'speaking';
        this.userSpeaking = speaking;
        if (speaking) this.onSpeakingEdge();
        // A new speaking edge marks a new utterance: late finals of the memory-tool turn
        // arrived before this edge and stay dropped, while this utterance is stored.
        if (speaking) this.dropUserFinals = false;
        // A new utterance: a tool still waiting for the previous turn's final gets null.
        if (speaking) this.turns.interrupt();
        // Cancel only a continuation that was already requested. The origin ends on the client path.
        if (speaking && this.toolTurn.active && this.continuationAsked) {
          this.adapter.cancelResponse();
          this.toolTurn.onUserSpeaking();
          this.releaseToolTurn(false);
        }
        if (speaking) this.vadSpeakingCount++;
        else this.vadSilentCount++;
        this.log.info('vad_edge', {
          state: msg.state,
          count: speaking ? this.vadSpeakingCount : this.vadSilentCount,
          activeSeq: this.interrupt.active ?? 0,
        });
        const playing = this.modelGenerating || this.interrupt.active !== null;
        if (speaking && playing) {
          this.streamBarge = true;
          this.flushBargePreroll();
        }
        const activeBefore = this.interrupt.active;
        this.interrupt.onLocalVad(speaking);
        // A gateway-side cancel (local VAD confirmed during the model's confirm window) never
        // produces a client playback.stopped, so tell the Director after its speaking edge.
        const gatewayCancelled = speaking && activeBefore !== null && this.interrupt.active === null;
        this.director.onUserSpeech(speaking);
        if (gatewayCancelled) this.director.onAssistantInterrupted();
        if (!speaking) {
          this.metrics.onLocalVadSilent();
          this.tickSlim();
        }
        break;
      }
      case 'playback.progress': {
        const s = this.bySeq.get(msg.responseSeq);
        if (s) s.playedMs = Math.max(s.playedMs, msg.playedMs);
        break;
      }
      case 'playback.stopped': {
        const s = this.bySeq.get(msg.responseSeq);
        if (!s) break;
        s.playedMs = Math.max(s.playedMs, msg.playedMs);
        if (msg.reason === 'interrupted') {
          const wasActive = this.interrupt.active === msg.responseSeq;
          const toolOrigin = this.toolTurn.active && msg.responseSeq === this.toolOriginSeq;
          this.interrupt.onClientInterrupted(msg.responseSeq);
          this.streamBarge = false;
          this.bargePreroll.length = 0;
          this.finalize(s, true);
          this.uplinkResumeAt = 0; // the user may be talking: no speaker tail to guard against
          if (wasActive) this.director.onAssistantInterrupted();
          if (toolOrigin && this.toolTurn.onCancel()) this.releaseToolTurn(false);
        } else {
          const toolOrigin = this.toolTurn.active && msg.responseSeq === this.toolOriginSeq;
          // Stale end (already cancelled/superseded, a newer turn may be active): ignore.
          // A tool origin stays eligible after the forced finish clears interrupt.active.
          if (!toolOrigin && this.interrupt.active !== msg.responseSeq) {
            break;
          }
          s.playbackEnded = true;
          this.streamBarge = false;
          this.bargePreroll.length = 0;
          this.finalize(s, false);
          this.interrupt.onResponseFinished(msg.responseSeq);
          // finalize() ran while this response was still the active interrupt; this is the seam.
          this.gate.flush();
          this.uplinkResumeAt = Date.now() + (this.deps.tailGuardMs ?? 0);
          this.finishNotice(msg.responseSeq);
          if (toolOrigin) {
            this.toolTurn.onOriginPlaybackEnded();
            this.maybeContinue();
          } else {
            this.director.onAiTurnEnded(s.text);
            this.maybeSlimContext();
            this.tickSlim();
          }
        }
        break;
      }
      case 'client.mute':
        this.muted = msg.muted;
        this.director.setMuted(msg.muted);
        this.syncInputMute();
        break;
      case 'debug.userText':
        if (!this.adapter.supportsUserText) {
          this.log.warn('debug_text_unsupported');
          this.send({ type: 'error', code: 'debug_text_unsupported', retryable: false });
          break;
        }
        this.interrupt.cancelActive('local');
        this.dropUserFinals = false; // a deliberate new turn, not a late transcript
        this.responseSinceSpeech = false;
        this.onUserFinal(msg.text, true);
        this.adapter.sendUserText(msg.text);
        break;
      case 'session.start':
      case 'session.resume':
      case 'session.end':
        break; // lifecycle is handled by SessionManager
    }
  }

  /** Tells the client why the session is ending (e.g. owner_banned) before the socket goes. */
  notifyEnd(code: string): void {
    this.send({ type: 'error', code, retryable: false });
  }

  /** Writes finalized assistant replies that are not yet stored. User finals are not flushed here. */
  flush(): void {
    const { ownerId, agentId } = this.context;
    if (!this.writer || !ownerId || !agentId) return;
    for (const state of this.bySeq.values()) {
      if (!state.finalized || state.flushed || !state.text) continue;
      if (this.dropTranscriptSeqs.has(state.seq)) {
        state.flushed = true;
        continue;
      }
      try {
        this.writer.append({
          ownerId,
          agentId,
          sessionId: this.sessionId,
          role: 'assistant',
          text: state.text,
          now: this.now(),
        });
        state.flushed = true;
      } catch {
        this.log.error('transcript_write_failed', { role: 'assistant' });
      }
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.turns.interrupt();
    this.clearToolTimer();
    this.clearReplyWatch();
    this.gate.dispose();
    this.stopSlimClock();
    this.restClock?.stop();
    this.restClock = null;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.rebuildMicBuffer.length = 0;
    this.stopKeepalive();
    this.director.stop();
    this.clearProactiveTimer();
    this.proactiveRequest = null;
    this.proactive?.end();
    this.emotion?.dispose();
    if (this.affect) {
      const summary = this.affect.summary();
      this.log.info('affect_summary', affectSummaryFields(summary));
      this.recordMood(summary);
      this.affect.dispose();
    }
    this.interrupt.dispose();
    this.adapter.removeAllListeners();
    this.adapter.close();
    this.ledger.clear();
    this.transport = null;
  }

  get currentLanguage(): Language {
    return this.language;
  }

  /** Initial language from session.start; before connect it simply rides on the connect payload. */
  setInitialLanguage(language: Language): void {
    this.applyLanguage(language);
  }

  private applyLanguage(language: Language): void {
    const next = this.resolveLanguage(language);
    // Session-end extraction reads this context, so it must track the latest language.
    this.context.language = next;
    if (next === this.language) return;
    this.language = next;
    this.director.setLanguage(next);
    const budget = this.budgetFor(next);
    if (budget) {
      // Never postpone summarization for a smaller target-language budget.
      this.ledger.setSummarizeAfterTokens(historyBudget(this.personaFor(next), budget, PROMPT_LABELS[next]));
    }
    // Same store data, new labels, addressing patterns, and evidence rules.
    this.refreshMemorySnapshot();
    // Voice and instructions travel together at the next seam. Undefined voice = adapter default.
    this.gate.request({ instructions: true, voice: { value: this.voiceFor(next) } });
  }

  private resolveLanguage(language: Language): Language {
    const supported = this.deps.roles.supportedLanguages(this.roleId);
    if (supported.includes(language)) return language;
    this.log.warn('language_unsupported', { roleId: this.roleId, language });
    return this.deps.roles.defaultLanguage(this.roleId);
  }

  private personaFor(language: Language): string {
    const cached = this.personas.get(language);
    if (cached !== undefined) return cached;
    const base = this.deps.roles.buildPersona(this.context.characterId, language);
    // Open item 2: familiarity is fixed for the session, so the tone rides on the cached persona.
    const tones = this.directorConfig(language).familiarityTones;
    const tone = tones && this.proactive ? tones[this.proactive.familiarityTier()] : '';
    const persona = tone ? `${base}\n\n${tone}` : base;
    this.personas.set(language, persona);
    return persona;
  }

  private budgetFor(language: Language): InstructionBudget | undefined {
    return this.deps.budgets?.[language] ?? this.deps.budget;
  }

  /** Billing identity for this session's model calls. */
  private usageAttribution(): UsageAttribution {
    return { ownerId: this.context.ownerId ?? null, agentId: this.context.agentId ?? null, sessionId: this.sessionId, characterId: this.context.characterId };
  }

  /** The shared text client, tagged so its calls are billed to this session. */
  private textFor(kind: UsageKind): TextModelClient | undefined {
    const client = this.deps.textClient;
    return client ? withUsageTag(client, { kind, attribution: this.usageAttribution() }) : undefined;
  }

  /** One usage row per finalized reply; interrupted replies keep whatever usage the model reported. */
  private recordReplyUsage(m: ReplyMetrics): void {
    const { usage, usageSource } = this.deps;
    if (!usage || !usageSource) return;
    usage.record({
      kind: 'realtime_reply',
      adapter: usageSource.adapter,
      model: usageSource.model,
      usage: m.usage,
      attribution: this.usageAttribution(),
      firstAudioMs: m.speechToFirstAudioMs ?? m.vadToFirstAudioMs,
      genMs: m.genMs,
      errorCode: m.errorCode,
    });
  }

  /** Silence steps ask the decision engine; null = the configured stage copy. The opening never comes here with a known name. */
  private planProactiveLine(context: SilenceContext, _signal: AbortSignal): SilencePlan | null {
    if (context.stage === 'greeting' || !this.proactive) return null;
    const line = this.proactive.silenceLine({
      step: context.stage,
      language: this.language,
      hadContent: context.userText !== '',
      lastUtterance: context.userText,
      knownName: this.greetingName() !== null,
      card: this.affectCard,
      lowIntensity: this.deps.affect?.lowIntensity ?? Number.POSITIVE_INFINITY,
      ...(this.openLoop ? { openLoop: this.openLoop } : {}),
    });
    if (line && 'request' in line) return { text: line.request.fallbackText, request: line.request };
    if (line && 'quiet' in line) return { text: null, quiet: true };
    if (line && 'close' in line) return { text: null, close: true };
    return null;
  }

  private send(msg: ServerMessage): void {
    this.transport?.send(msg);
  }

  private instructions(): string {
    const labels = PROMPT_LABELS[this.language];
    return buildInstructions(
      {
        persona: this.personaFor(this.language),
        affect: this.affectSection(),
        pinned: this.context.pinnedMemory,
        memorySnapshot: this.context.memorySnapshot,
        summary: this.ledger.summary,
        recent: this.ledger.recent,
      },
      this.budgetFor(this.language),
      labels,
    );
  }

  /** Current affect render in the session language; '' without an analyzer, or with no card and no hint. */
  private affectSection(): string {
    const config = this.deps.affect;
    if (!config || !this.affect) return '';
    // Topic exhaustion is a proactive moment (spec 话题聊干): the hint only rides along when the engine approves.
    const armed = this.affect.exhaustedArmed
      && (this.proactive?.approveExhausted(this.affect.exhaustedArmedCount, { language: this.language, card: this.affectCard, lowIntensity: config.lowIntensity }) ?? true);
    return renderAffect(this.affectCard, this.i18n.affect[this.language], {
      exhaustedArmed: armed,
      lowIntensity: config.lowIntensity,
    });
  }

  /** Ask the gate for one instructions push, only when the rendered affect text changed. */
  private syncAffectRender(): void {
    if (this.ended) return;
    const text = this.affectSection();
    if (text === this.affectRendered) return;
    this.affectRendered = text;
    this.gate.request({ instructions: true });
  }

  /** Accepted analyzer card: store it, drive the avatar, log a crisis once, then re-render. */
  private onAffectCard(card: AffectCard): void {
    const config = this.deps.affect;
    if (this.ended || !config) return;
    this.affectCard = card;
    this.moodPeak = Math.max(this.moodPeak, card.intensity);
    // The tracker already checked the open loop against the user's own lines.
    if (card.openLoop) this.openLoop = card.openLoop;
    if (card.crisis && !this.crisisLogged) {
      this.crisisLogged = true;
      this.log.warn('affect_crisis');
    }
    this.emotion?.onAffect(card, isLow(card, config.lowIntensity));
    this.syncAffectRender();
  }

  /** Forget/decline: drop the session copy of the card. The rebuild reconnects with fresh instructions, so no push is requested. */
  private clearAffect(): void {
    this.affectCard = null;
    this.affectRendered = '';
    // The open loop is the user's own words; forget/decline must drop it too (spec §8).
    this.openLoop = undefined;
    this.emotion?.releaseHold();
    this.proactive?.reload();
  }

  /** End of session: one labels-only mood row (spec 情绪轨迹). The store applies the notice/consent gate. */
  private recordMood(summary: AffectSummary): void {
    const store = this.deps.store;
    const { ownerId, agentId } = this.context;
    if (!store || !ownerId || !agentId) return;
    const mood = summarizeMood(summary, this.affectCard, this.moodPeak, this.sessionId);
    if (!mood) return;
    try {
      store.recordMoodSummary(ownerId, agentId, mood, this.now());
    } catch {
      this.log.error('mood_summary_write_failed');
    }
  }

  private sessionConfig(): SessionConfig {
    const instructions = this.instructions();
    this.lastInstructionsChars = instructions.length;
    return { instructions, tools: this.toolsFor(this.language).specs(), voice: this.voiceFor(this.language), ...(this.deps.maxOutputTokens !== undefined ? { maxOutputTokens: this.deps.maxOutputTokens } : {}) };
  }

  /** The character's voice for this language, resolved by index.ts; undefined = adapter default. */
  private voiceFor(language: Language): string | undefined {
    return this.deps.voiceFor?.(language);
  }

  private toolsFor(language: Language): ToolRegistry {
    let tools = this.tools.get(language);
    if (!tools) {
      const i18n = this.deps.i18n ?? DEFAULT_I18N;
      tools = createToolRegistry({
        language,
        memory: i18n.memory[language],
        evidence: i18n.evidence,
        recentQueries: i18n.recentQueries,
        recallPrompt: this.deps.roles.recallPrompt(this.context.characterId, language),
        safety: i18n.safety,
        clipChars: this.deps.recallClipChars ?? 80,
        phraseTimeoutMs: this.deps.recallPhraseTimeoutMs ?? 1_500,
        pinLimits: this.deps.pin
          ? { maxPerCharacter: this.deps.pin.maxPerCharacter, maxChars: this.deps.pin.maxChars[language] }
          : undefined,
        healthWords: unique(LANGUAGES.flatMap((code) => i18n.memory[code].healthWords)),
        // Tests without deps.pin use the shipped default from gateway/config/memory.json.
        turnFinalTimeoutMs: this.deps.pin?.finalWaitMs ?? MEMORY_DEFAULTS.pinFinalWaitMs,
        listMaxItems: this.deps.listMaxItems,
      });
      this.tools.set(language, tools);
    }
    return tools;
  }

  /** Pin write gate (spec §5): declined, or the one-time notice has not played yet. Fails closed. */
  private memoryGate(): 'ok' | 'declined' | 'notice_pending' {
    const ownerId = this.context.ownerId;
    const owner = ownerId ? this.deps.store?.getOwner(ownerId) : undefined;
    if (!owner || owner.memoryConsent === 'declined') return 'declined';
    return owner.notifiedAt == null ? 'notice_pending' : 'ok';
  }

  /** Queues fresh instructions for the next push seam. */
  private pushInstructions(): void {
    this.gate.request({ instructions: true });
  }

  /** Seam for session.update: slim seam, nothing generating, no reply awaited, adapter connected. */
  private pushSeamOpen(): boolean {
    return !this.ended && this.adapterReady && !this.modelGenerating && this.replyWatch === null && this.slimSeamOpen();
  }

  /** The gate's only sink. Instructions are rendered now, so the newest state is what goes out. */
  private sendSessionUpdate(update: PushRequest): void {
    const instructions = update.instructions ? this.instructions() : undefined;
    if (instructions !== undefined) this.lastInstructionsChars = instructions.length;
    this.log.debug('session_push', { instructions: instructions !== undefined, voice: update.voice !== undefined });
    if (this.adapter.updateSession) {
      this.adapter.updateSession({
        ...(instructions !== undefined ? { instructions } : {}),
        ...(update.voice ? { voice: update.voice } : {}),
      });
      return;
    }
    if (update.voice) this.adapter.updateVoice(update.voice.value);
    if (instructions !== undefined) this.adapter.updateInstructions(instructions);
  }

  /** Local or server speech began: a new utterance, so drop the reply watch. */
  private onSpeakingEdge(): void {
    this.responseSinceSpeech = false;
    this.clearReplyWatch();
  }

  /**
   * Holds the push seam shut until a response starts. After a substantive final, expiry logs
   * no_response_after_final (content-free); either way it flushes, since no reply formed.
   */
  private watchReply(logOnExpiry: boolean): void {
    this.clearReplyWatch();
    const startedAt = this.now();
    this.replyWatch = setTimeout(() => {
      this.replyWatch = null;
      if (this.ended) return;
      if (logOnExpiry) this.log.warn('no_response_after_final', { sinceFinalMs: this.now() - startedAt });
      this.gate.flush();
    }, this.push.noResponseAfterMs);
    this.replyWatch.unref?.();
  }

  private clearReplyWatch(): void {
    if (this.replyWatch) clearTimeout(this.replyWatch);
    this.replyWatch = null;
  }

  /** A stored final opens a new push turn and shuts the seam until its reply starts. */
  private onTurnFinal(text: string): void {
    this.gate.onUserFinal();
    // A live reply already shuts the seam and is this final's answer.
    if (this.responseLive || this.modelGenerating) return;
    // Qwen can finalize the transcript after its reply started: stay shut, but do not report.
    this.watchReply(!this.responseSinceSpeech && !this.director.isLightFinal(text));
  }

  private requestResponse(kind: ResponseKind, request: ProactiveRequest): void {
    // Tool turns speak only through maybeContinue.
    if (this.toolTurn.active || this.ended || this.interrupt.active !== null || this.modelGenerating) {
      if (request.cue === 'memoryNotice') this.director.onNoticeMissed();
      if (request.cue === 'restReminder') this.director.onReminderMissed();
      if (this.proactive?.owns(request)) this.proactive.onRequestRefused(request);
      return;
    }
    if (request.cue === 'memoryNotice') {
      this.noticePendingRequest = true;
      this.noticeLanguage = this.language;
      this.noticeFallback = request.fallbackText;
      this.noticeVerbatim = this.adapter.verbatimFallback;
    }
    this.pendingKind = kind;
    // Last seam before the proactive line; the watch keeps it shut until that line starts.
    this.gate.flush();
    // Watch before createResponse: an adapter that emits responseStarted synchronously clears it at once.
    this.watchReply(false);
    // Before createResponse: an adapter may start the response synchronously.
    if (this.proactive?.owns(request)) this.watchProactive(request, kind);
    this.adapter.createResponse(request);
  }

  /** Spec 兜底: no response.created within fallbackAfterMs → read the fallback line once. */
  private watchProactive(request: ProactiveRequest, kind: ResponseKind): void {
    this.clearProactiveTimer();
    this.proactiveRequest = request;
    const waitMs = this.deps.proactivity?.fallbackAfterMs ?? 3_000;
    this.proactiveTimer = setTimeout(() => {
      this.proactiveTimer = null;
      if (this.proactiveRequest !== request || !this.proactive) return;
      const busy = this.ended || !this.adapterReady || this.modelGenerating || this.responseLive
        || this.userSpeaking || this.toolTurn.active || this.interrupt.active !== null;
      // No response.cancel here (pitfall 打断与沉默 #6): we only add a line when nothing is on air.
      const fallback = busy ? null : this.proactive.fallbackFor(request);
      if (!fallback) {
        this.proactive.onRequestRefused(request);
        this.proactiveRequest = null;
        return;
      }
      this.proactiveRequest = fallback;
      this.pendingKind = kind;
      this.watchReply(false);
      this.adapter.createResponse(fallback);
    }, waitMs);
    this.proactiveTimer.unref?.();
  }

  private clearProactiveTimer(): void {
    if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
  }

  /** Playback ended for the notice seq is the only completion signal. */
  private finishNotice(seq: number): void {
    if (seq !== this.noticeSeq) return;
    if (!this.noticeVerified(seq)) {
      this.log.warn('memory_notice_unverified');
      this.missNotice(seq);
      return;
    }
    if (this.writer && this.context.ownerId) {
      try {
        this.writer.markNotified(this.context.ownerId, this.now());
      } catch {
        // The user heard it; failing to persist only means the next session asks again.
        this.log.error('memory_notice_write_failed');
      }
    }
    this.noticeSeq = null;
    this.noticePendingRequest = false;
    this.noticeLanguage = null;
    this.noticeFallback = null;
    this.director.onNoticePlayed();
  }

  /** Qwen may paraphrase the notice; direct-TTS adapters speak the fallback we supplied. */
  private noticeVerified(seq: number): boolean {
    const language = this.noticeLanguage;
    const keywords = (language ? this.deps.noticeKeywordsByLanguage?.[language] : undefined)
      ?? this.deps.noticeKeywords
      ?? [];
    if (keywords.length === 0) return true;
    const text = this.noticeVerbatim ? this.noticeFallback ?? '' : this.bySeq.get(seq)?.text ?? '';
    return keywords.some((keyword) => containsPhrase(text, keyword));
  }

  /** The notice seq will not play out. Retry later; do not mark notified. */
  private missNotice(seq: number): void {
    if (seq !== this.noticeSeq) return;
    this.noticeSeq = null;
    this.noticePendingRequest = false;
    this.noticeLanguage = null;
    this.noticeFallback = null;
    this.director.onNoticeMissed();
  }

  private createAdapter(): RealtimeAdapter {
    const a = this.deps.adapterFactory();
    const current = () => a === this.adapter && !this.ended;

    a.on('userSpeechStarted', () => {
      if (!current()) return;
      this.onSpeakingEdge();
      this.director.onUserActivity();
      this.interrupt.onModelSpeechStarted();
    });
    a.on('userSpeechStopped', () => {
      if (current()) this.metrics.onSpeechStopped();
    });
    a.on('responseUsage', (id, usage) => {
      const s = current() ? this.byId.get(id) : undefined;
      if (s) this.metrics.onUsage(s.seq, usage);
    });
    a.on('userTranscript', (text, final) => {
      if (!current()) return;
      this.director.onUserActivity();
      if (final) this.onUserFinal(text, true);
      else this.send({ type: 'transcript.user', text, final: false });
    });
    a.on('responseStarted', (id) => {
      if (!current()) return;
      const s: ResponseState = { seq: ++this.seqCounter, kind: this.pendingKind ?? 'reply', text: '', audioMs: 0, playedMs: 0, finalized: false, flushed: false, responseDone: false, playbackEnded: false };
      this.pendingKind = null;
      const engineRequest = this.proactiveRequest;
      if (engineRequest && (s.kind === 'followup' || s.kind === 'greeting')) {
        this.proactiveRequest = null;
        this.clearProactiveTimer();
        this.proactiveSeq = s.seq;
        this.proactive?.onLineStarted(engineRequest);
      }
      this.byId.set(id, s);
      this.bySeq.set(s.seq, s);
      // Keep recent finalized ids so a late tool call can still see its cancelled state,
      // but do not retain every adapter response id for the whole session.
      if (this.byId.size > 128) {
        for (const [oldId, oldState] of this.byId) {
          if (this.byId.size <= 128) break;
          if (oldState.finalized) this.byId.delete(oldId);
        }
      }
      if (this.noticePendingRequest) {
        this.noticePendingRequest = false;
        this.noticeSeq = s.seq;
      }
      this.log.child({ seq: s.seq }).info('response_start', { kind: s.kind });
      this.clearReplyWatch();
      this.responseSinceSpeech = true;
      this.metrics.onResponseStarted(s.seq, s.kind);
      this.emotion?.onResponseStart(s.seq);
      this.modelGenerating = true;
      this.responseLive = true;
      this.director.onAiTurnStarted();
      const superseded = this.interrupt.onResponseStart(s.seq);
      if (superseded !== null) {
        // The previous reply is still playing on the client: stop it there first, then record what was heard.
        this.send({ type: 'response.cancelled', responseSeq: superseded });
        const prev = this.bySeq.get(superseded);
        if (prev) this.finalize(prev, true);
      }
      this.send({ type: 'response.start', responseSeq: s.seq, kind: s.kind });
      if (!this.transport) this.interrupt.cancelActive('local'); // nobody is listening
    });
    a.on('audioDelta', (id, pcm) => {
      const s = this.live(a, id);
      if (!s) return;
      this.noteToolAudio(s);
      if (s.audioMs === 0) this.metrics.onFirstAudio(s.seq);
      s.audioMs += (pcm.length / AI_SAMPLE_RATE) * 1000;
      this.transport?.sendAudio(s.seq, pcm);
    });
    a.on('textDelta', (id, text) => {
      const s = this.live(a, id);
      if (!s) return;
      s.text += text;
      this.metrics.onText(s.seq, text.length);
      this.emotion?.onAssistantDelta(s.seq, text);
      this.charsSinceRebuild += text.length;
      this.send({ type: 'transcript.assistant', responseSeq: s.seq, text });
    });
    a.on('toolCall', (id, callId, name, args) => {
      if (!current()) return;
      void this.onToolCall(a, id, callId, name, args);
    });
    a.on('responseDone', (id) => {
      const s = this.live(a, id);
      if (s) {
        s.responseDone = true;
        this.log.child({ seq: s.seq }).info('response_end');
        this.metrics.onDone(s.seq);
        this.send({ type: 'response.end', responseSeq: s.seq });
        this.modelGenerating = false;
        this.responseLive = false;
        if (this.toolTurn.active && s.seq === this.toolOriginSeq) {
          this.toolTurn.onOriginDone();
          // The client does not report playback.stopped after response.cancelled.
          if (this.originForcedEnd) this.finalize(s, false);
          this.maybeContinue();
        } else if (this.toolTurn.active && this.continuationAsked && s.seq !== this.toolOriginSeq) {
          this.toolTurn.onContinuationStarted();
          const end = this.toolTurn.onContinuationDone(s.audioMs > 0);
          if (end) this.releaseToolTurn(true);
        }
      }
    });
    a.on('responseCancelled', (id) => {
      if (!current()) return;
      const s = this.byId.get(id);
      if (!s || !this.interrupt.onModelAutoCancelled(s.seq)) return;
      this.modelGenerating = false;
      this.responseLive = false;
      this.log.child({ seq: s.seq }).info('model_auto_cancel');
      this.finalize(s, true);
      const missedNotice = s.seq === this.noticeSeq;
      this.missNotice(s.seq);
      const released = this.toolTurn.active && s.seq === this.toolOriginSeq && this.toolTurn.onCancel();
      if (released) this.releaseToolTurn(false);
      else if (missedNotice) this.director.onAiTurnEnded();
    });
    a.on('error', (code, retryable, detail) => {
      if (!current()) return;
      const errorClass = classifyAdapterError(code, this.toolTurn.active);
      const fields = {
        source: 'realtime',
        code,
        class: errorClass,
        ...(detail?.httpStatus !== undefined ? { http_status: detail.httpStatus } : {}),
        ...(detail?.requestId ? { upstream_request_id: detail.requestId } : {}),
      };
      if (errorClass === 'fatal') this.log.error('upstream_error', fields);
      else if (errorClass === 'retryable') this.log.warn('upstream_error', fields);
      else this.log.info('upstream_error', fields);
      this.metrics.onError(code);
      if (errorClass === 'ignorable') return;
      if (errorClass === 'retryable') void this.rebuild('error');
      else this.send({ type: 'error', code, retryable: false });
    });
    a.on('closed', () => {
      if (current()) void this.rebuild('closed');
    });
    return a;
  }

  /** Response state if it belongs to the current adapter and is still deliverable. */
  private live(a: RealtimeAdapter, id: string): ResponseState | null {
    if (a !== this.adapter || this.ended) return null;
    const s = this.byId.get(id);
    if (!s || s.finalized || this.interrupt.isCancelled(s.seq)) return null;
    return s;
  }

  private cancel(seq: number, source: string): void {
    this.log.child({ seq }).info('response_cancel', { source });
    this.modelGenerating = false;
    if (this.responseLive) this.adapter.cancelResponse();
    this.responseLive = false;
    this.send({ type: 'response.cancelled', responseSeq: seq });
    const s = this.bySeq.get(seq);
    if (s) this.finalize(s, true);
    if (seq === this.noticeSeq) this.missNotice(seq);
  }

  private finalize(s: ResponseState, interrupted: boolean): void {
    if (s.finalized) return;
    s.finalized = true;
    const m = this.metrics.finish(s.seq, interrupted ? 'interrupted' : 'ended');
    if (m) {
      this.log.child({ seq: m.seq }).info('reply_metrics', metricFields(m));
      this.deps.onReplyMetrics?.(m);
      this.recordReplyUsage(m);
    }
      const text = interrupted ? truncateByPlayback(s.text, s.playedMs, s.audioMs) : s.text;
    s.text = text;
    if (s.seq === this.proactiveSeq) {
      this.proactiveSeq = null;
      this.proactive?.onLineEnded(text, interrupted);
    }
    if (!this.dropTranscriptSeqs.has(s.seq)) this.ledger.addAssistant(text, Date.now(), interrupted);
    this.turnUserText = null;
    this.turns.onTurnClosed();
    // Do not session.update here. An instructions refresh in the middle of a barge-in
    // drops the audio the server is still hearing, so the next question never lands.
    this.maybeSummarize();
  }

  private onUserFinal(text: string, echo: boolean): void {
    // Before the language check: its push must find the seam already shut.
    if (!this.dropUserFinals) this.onTurnFinal(text);
    const rules = this.deps.languageRules;
    const requested = rules ? explicitLanguage(text, rules) : null;
    if (requested) this.languageLock = requested;
    // An explicit request stays in force. Otherwise the script heuristic can still move the session.
    const nextLanguage = requested ?? (this.languageLock ?? detectLanguage(text, this.language, rules));
    if (nextLanguage !== this.language) {
      this.log.info('language_set', { language: nextLanguage, locked: this.languageLock !== null });
      this.applyLanguage(nextLanguage);
    }
    if (echo) this.send({ type: 'transcript.user', text, final: true });
    if (this.dropUserFinals) {
      // Kept out of the ledger and the transcript; a waiting pin may still use the words (spec §6).
      this.turns.onFinal(text, null, false);
      return;
    }
    this.turnUserText = text;
    this.ledger.addUser(text, Date.now());
    let messageId: string | null = null;
    if (this.writer && this.context.ownerId && this.context.agentId) {
      try {
        messageId = this.writer.append({
          ownerId: this.context.ownerId,
          agentId: this.context.agentId,
          sessionId: this.sessionId,
          role: 'user',
          text,
          now: this.now(),
        }).messageId ?? null;
      } catch {
        this.log.error('transcript_write_failed', { role: 'user' });
      }
    }
    this.turns.onFinal(text, messageId, true);
    this.turnsSinceRebuild++;
    this.charsSinceRebuild += text.length;
    const extractor = this.deps.worker;
    const ownerId = this.context.ownerId;
    const agentId = this.context.agentId;
    if (extractor && ownerId && agentId) {
      this.userTurns += 1;
      const every = this.deps.extractEveryUserTurns ?? 10;
      if (this.userTurns % every === 0) void extractor.enqueue(ownerId, agentId, 'turns', this.language);
    }
    this.director.onUserFinal(text);
    this.proactive?.onUserFinal(text, this.director.isLightFinal(text), this.language);
    this.emotion?.onUserFinal(text);
    // Same whole-utterance light check as the Director; light replies never cost a model call.
    if (this.affect) {
      if (this.director.isLightFinal(text)) this.affect.onLightFinal(text, this.language);
      else this.affect.onUserFinal(text, this.language);
    }
    const action = this.actions.fromKeyword(text);
    if (action) this.send({ type: 'avatar.action', action, source: 'keyword' });
    // The tracker may have armed or dropped the topic-exhaustion hint on this final.
    this.syncAffectRender();
    this.maybeSummarize();
  }

  /** Clears a still-playing origin so the later continuation is not judged superseded. */
  private beginToolTurn(s: ResponseState): void {
    if (this.toolTurn.active) {
      this.toolTurn.start(s.seq);
      return;
    }
    const active = this.interrupt.active;
    const alreadyDone = s.responseDone;
    // A finished origin keeps playing until the client reports playback.stopped.
    if (active !== null && !alreadyDone) {
      this.missNotice(active);
      this.interrupt.onResponseFinished(active);
      this.send({ type: 'response.cancelled', responseSeq: active });
    }
    this.toolOriginSeq = s.seq;
    this.continuationAsked = false;
    this.originForcedEnd = false;
    this.toolTurn.start(s.seq);
    if (s.audioMs > 0) this.toolTurn.onOriginAudio();
    // Only the seq we just cancelled. A different active seq still needs a real playback.stopped.
    if (!alreadyDone && active === s.seq) {
      this.toolTurn.onOriginPlaybackEnded();
      this.originForcedEnd = true;
    }
    if (alreadyDone) this.toolTurn.onOriginDone();
    // A clean stop that already arrived still counts. An interrupt does not.
    if (s.playbackEnded) this.toolTurn.onOriginPlaybackEnded();
    this.armToolTimer();
    this.director.pause();
  }

  private noteToolAudio(s: ResponseState): void {
    if (!this.toolTurn.active) return;
    if (s.seq === this.toolOriginSeq && !this.continuationAsked) {
      this.toolTurn.onOriginAudio();
      return;
    }
    if (!this.continuationAsked || s.seq === this.toolOriginSeq) return;
    this.toolTurn.onContinuationStarted();
    const end = this.toolTurn.onContinuationAudio();
    if (end) this.releaseToolTurn(true);
  }

  private async onToolCall(a: RealtimeAdapter, id: string, callId: string, name: string, args: unknown): Promise<void> {
    if (a !== this.adapter || this.ended) return;
    const s = this.byId.get(id);
    const cancelled = s ? this.interrupt.isCancelled(s.seq) : false;
    const slow = Boolean(s) && !cancelled && waitsForMemoryJob(name, args);
    if (slow && s) {
      this.dropTranscriptSeqs.add(s.seq);
      this.dropUserFinals = true;
      this.memoryToolWaiting = true;
      this.beginToolTurn(s);
    }
    const triggerText = this.turnUserText ?? undefined;
    const recallClient = this.textFor('recall_wrap');
    const outcome = await this.toolsFor(this.language).handle(name, args, {
      ownerId: this.context.ownerId,
      agentId: this.context.agentId,
      characterId: this.context.characterId,
      sessionId: this.sessionId,
      store: this.deps.store,
      worker: this.deps.worker instanceof MemoryWorker ? this.deps.worker : undefined,
      ...(recallClient ? { textClient: recallClient } : {}),
      ledger: this.ledger,
      actions: this.actions,
      now: this.now(),
      ...(triggerText ? { triggerText } : {}),
      turn: this.turns.access(),
      memoryGate: () => this.memoryGate(),
      logger: this.log,
    });
    this.memoryToolWaiting = false;
    if (a !== this.adapter || this.ended) return;
    this.log.info('tool_invoked', { name: name.slice(0, 64), ok: outcome.ok, ...(outcome.error ? { code: outcome.error } : {}) });
    a.sendToolResult(callId, toolPayload(outcome));
    if (s) this.metrics.onToolCall(s.seq);
    if (outcome.ok && outcome.action && !cancelled) this.send({ type: 'avatar.action', action: outcome.action, source: 'tool' });
    // A pin must reach the next reply. Re-render now; the gate pushes at the next seam.
    if (outcome.ok && outcome.refreshSnapshot) {
      this.refreshMemorySnapshot();
      this.pushInstructions();
    }
    // The origin may have been cut off while the handler waited. Only the non-slow branch
    // opens a tool turn here; forget/decline already opened theirs before the wait.
    const cancelledNow = cancelled || (s ? this.interrupt.isCancelled(s.seq) : false);
    const continues = slow ? this.toolTurn.active : (Boolean(s) && !cancelledNow) || this.toolTurn.active;
    if (!outcome.ok) {
      // A failure never speaks the success line. A grounded refusal line is still spoken.
      if (!slow && continues && outcome.spokenText && !this.pendingToolSpeak) {
        this.pendingToolSpeak = { text: outcome.spokenText, found: false };
      }
      if (slow) {
        this.maybeContinue();
        return;
      }
      if (s && !cancelledNow) {
        this.beginToolTurn(s);
        this.maybeContinue();
      }
      return;
    }
    // Lines are kept only when a tool turn will speak them.
    if (!continues) return;
    if (outcome.confirmText) this.pendingToolLine = outcome.confirmText;
    if (outcome.spokenText && (!this.pendingToolSpeak || (!this.pendingToolSpeak.found && outcome.spokenFound === true))) {
      this.pendingToolSpeak = { text: outcome.spokenText, found: outcome.spokenFound === true };
    }
    if (outcome.rebuild) {
      if (outcome.rebuild === 'decline') this.director.cancelNotice();
      this.pendingToolRebuild = outcome.rebuild;
      if (s) this.dropTranscriptSeqs.add(s.seq);
    }
    if (slow) {
      this.maybeContinue();
      return;
    }
    if (s && !cancelledNow) {
      this.beginToolTurn(s);
      this.maybeContinue();
    }
  }

  private maybeContinue(): void {
    if (this.memoryToolWaiting) return;
    if (this.ended || this.continuationAsked || !this.toolTurn.readyForContinuation()) return;
    this.continuationAsked = true;
    this.toolTurn.onContinuationRequested();
    const line = this.pendingToolLine;
    const speak = this.pendingToolSpeak;
    const rebuild = this.pendingToolRebuild;
    this.pendingToolLine = null;
    this.pendingToolSpeak = null;
    this.pendingToolRebuild = null;
    if (rebuild && line) {
      void this.speakAfterRebuild(rebuild, line);
      return;
    }
    if (line) {
      this.adapter.createResponse({ cue: 'toolContinue', instruction: line, fallbackText: line });
      return;
    }
    if (speak) {
      // The line quotes the user's own retrieved words; never let the model rewrite it.
      this.adapter.createResponse({
        cue: 'toolContinue',
        instruction: `请直接说下面这句话，不要改写：${speak.text}`,
        fallbackText: speak.text,
      });
      return;
    }
    const cfg = this.deps.roles.director(this.context.characterId, this.language);
    this.adapter.createResponse({
      cue: 'toolContinue',
      instruction: cfg.toolContinueInstruction,
      fallbackText: cfg.toolContinueText,
    });
  }

  /** Rebuild first. The confirm is spoken only after that adapter connects. */
  private async speakAfterRebuild(reason: 'forget' | 'decline', line: string): Promise<void> {
    this.confirmLine = line;
    await this.rebuild(reason, true);
  }

  private speakConfirm(): void {
    const line = this.confirmLine;
    if (!line) return;
    this.confirmLine = null;
    this.adapter.createResponse({ cue: 'toolContinue', instruction: line, fallbackText: line });
  }

  private armToolTimer(): void {
    this.clearToolTimer();
    const timeoutMs = this.deps.toolTurnTimeoutMs ?? DEFAULT_TOOL_TURN_TIMEOUT_MS;
    this.toolTimer = setTimeout(() => {
      this.toolTimer = null;
      if (this.ended || this.toolTurn.tick() !== 'timeout') return;
      this.releaseToolTurn(false);
    }, timeoutMs);
  }

  private clearToolTimer(): void {
    if (!this.toolTimer) return;
    clearTimeout(this.toolTimer);
    this.toolTimer = null;
  }

  /** allowSpeech is true only when the continuation itself ended the turn. */
  private releaseToolTurn(allowSpeech: boolean): void {
    this.clearToolTimer();
    this.continuationAsked = false;
    this.originForcedEnd = false;
    this.toolOriginSeq = null;
    this.pendingToolLine = null;
    this.pendingToolSpeak = null;
    this.pendingToolRebuild = null;
    this.confirmLine = null;
    // Keep dropping late finals until the next speaking edge; see the vad handler.
    this.memoryToolWaiting = false;
    this.turnUserText = null;
    this.turns.onTurnClosed();
    if (this.ended) return;
    // Continuation playback rearms silence later. Timeout and barge-in rearm now.
    this.director.releasePause(!allowSpeech);
    this.gate.flush();
  }

  private maybeSummarize(): void {
    if (!this.ledger.needsSummary() || this.summarizeInFlight) return;
    if (Date.now() < this.summarizeRetryAt) return;
    this.summarizeInFlight = true;
    void runWithPolicy('summarize', this.deps.summarizePolicy ?? DEFAULT_SUMMARIZE_POLICY, () => this.ledger.summarize(this.deps.summarizer, this.language), { logger: this.log }).then((r) => {
      this.summarizeInFlight = false;
      if (r.ok) {
        this.summarizeRetryAt = 0;
        this.summarizeBackoffMs = 1_000;
        if (r.value && !this.ended) this.pushInstructions();
        return;
      }
      // The policy already logged policy_failed with the code; keep the cross-call cool-down.
      this.summarizeRetryAt = Date.now() + this.summarizeBackoffMs;
      this.summarizeBackoffMs = Math.min(this.summarizeBackoffMs * 2, 30_000);
      this.log.warn('summarize_failed', { code: r.code });
    });
  }

  private maybeSlimContext(): void {
    if (this.toolTurn.active) return;
    const limit = (this.deps.modelContextTokenLimit ?? 12_000) * (this.deps.rebuildTriggerRatio ?? 0.8);
    // The model holds the instructions it was last given plus everything said since the rebuild.
    const estimate = this.charsSinceRebuild + this.lastInstructionsChars;
    if (estimate > limit || this.turnsSinceRebuild >= (this.deps.rebuildAfterTurns ?? 30)) void this.rebuild('slim');
  }

  private async rebuild(reason: RebuildReason, keepToolTurn = false): Promise<void> {
    if (reason === 'slim' && this.toolTurn.active) return;
    if (this.rebuilding || this.rebuildTimer || this.ended) {
      if (reason === 'forget' || reason === 'decline') this.rebuildAgain = reason;
      return;
    }
    this.turns.interrupt();
    // The old upstream will never answer; the new one is not ready for session.update yet.
    // Must come before releaseToolTurn, whose flush would otherwise send to the closing adapter.
    this.clearReplyWatch();
    this.adapterReady = false;
    if (!keepToolTurn && this.toolTurn.onRebuild()) this.releaseToolTurn(false);
    this.director.pause();
    if (this.noticePendingRequest) {
      // The request never produced a response; do not let a later reply inherit it.
      this.noticePendingRequest = false;
      this.noticeLanguage = null;
      this.noticeFallback = null;
      this.director.onNoticeMissed();
    }
    this.rebuilding = true;
    const startedAt = this.now();
    if (reason === 'slim') this.send({ type: 'presence', phase: 'refreshing' });
    else if (reason !== 'forget' && reason !== 'decline') {
      this.send({ type: 'error', code: 'model_reconnecting', retryable: true });
    }
    this.interrupt.cancelActive('local'); // uses the old adapter
    this.director.onAssistantInterrupted(); // paused: clears aiBusy and any notice claim
    // The old adapter's responseDone/cancel will never arrive; drop in-flight generation state.
    this.modelGenerating = false;
    this.responseLive = false;
    this.pendingKind = null;
    this.uplinkResumeAt = 0;
    const old = this.adapter;
    this.adapter = this.createAdapter();
    old.removeAllListeners();
    old.close();
    let connected = false;
    let bridge = false;
    try {
      if (reason === 'forget' || reason === 'decline') {
        // The store just dropped user content; the analyzer must not keep its own copy.
        this.affect?.reset();
        this.clearAffect();
        this.refreshMemorySnapshot();
      }
      await this.adapter.connect(this.sessionConfig());
      connected = true;
      // connect() carried the latest instructions and voice; nothing is left to push.
      this.adapterReady = true;
      this.gate.clearPending();
      this.syncInputMute();
      const buffered = this.rebuildMicBuffer.splice(0);
      if (!this.muted) for (const pcm of buffered) this.adapter.sendAudio(pcm);
      this.rebuildAttempt = 0;
      this.turnsSinceRebuild = 0;
      this.charsSinceRebuild = 0;
    } catch {
      this.log.error('model_rebuild_failed', { reason });
      // A silent slim rebuild never surfaces reconnect copy; presence ready ends the thinking pose.
      if (reason !== 'slim') this.send({ type: 'error', code: 'model_unavailable', retryable: true });
      this.scheduleRebuild(reason);
    } finally {
      this.rebuilding = false;
      if (reason === 'slim') bridge = this.finishSlimRebuild(connected, startedAt);
      this.armSlimInterval();
      const elapsedMs = this.now() - startedAt;
      this.log.info('model_rebuild', { reason, elapsedMs, bridge });
      const again = this.rebuildAgain;
      this.rebuildAgain = null;
      if (again && !this.ended) await this.rebuild(again, true);
      else if (connected) {
        if (this.transport && !this.toolTurn.active) this.director.releasePause(false);
        this.speakConfirm();
      }
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Slim rebuild finished. Returns true when the bridge line covered the dead air. */
  private finishSlimRebuild(connected: boolean, startedAt: number): boolean {
    if (!connected) {
      // Nothing was spoken and no adapter answered: release the client's thinking pose.
      this.send({ type: 'presence', phase: 'ready' });
      return false;
    }
    const slim = this.deps.slim;
    const line = slim ? slim.bridge[this.language] : '';
    if (line && shouldSpeakBridge(this.now() - startedAt, slim!.bridgeAfterMs, slim!.enabled)) {
      // Do not send presence ready: the bridge audio is what ends the thinking pose.
      this.watchReply(false);
      this.adapter.createResponse({ cue: 'contextBridge', instruction: line, fallbackText: line });
      return true;
    }
    this.send({ type: 'presence', phase: 'ready' });
    return false;
  }

  private slimSeamOpen(): boolean {
    return !this.toolTurn.active && !this.userSpeaking && !this.responseLive && this.interrupt.active === null;
  }

  /** Registers the interval after the reconnect, or the deferral deadline while the seam stays closed. */
  private armSlimClock(dueAt: number): void {
    if (this.ended) return;
    if (this.slimTimer) clearTimeout(this.slimTimer);
    this.slimDueAt = dueAt;
    this.slimTimer = setTimeout(() => {
      this.slimTimer = null;
      this.tickSlim();
    }, Math.max(0, dueAt - this.now()));
    this.slimTimer.unref?.();
  }

  /** The model session is fresh again: restart the interval, clear any deferral. */
  private armSlimInterval(): void {
    const slim = this.deps.slim;
    if (!slim?.enabled) return;
    this.slimDeferredSince = null;
    this.armSlimClock(this.now() + slim.intervalMs);
  }

  /** Continuous use is per phone (spec §5); a dev session without one starts its own stretch. */
  private startRestReminder(): void {
    const cfg = this.deps.restReminder;
    if (!cfg || this.ended) return;
    this.restClock = new RestReminderClock(this.context.continuousSince ?? this.now(), cfg, {
      now: () => this.now(),
      setTimer: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return timer;
      },
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      onDue: () => this.director.onRestReminderDue(),
    });
    this.restClock.start();
  }

  /** The configured line, spoken verbatim: no readable example, no negation (pitfall #3). */
  private restReminderRequest(): ProactiveRequest {
    const text = this.i18n.memory[this.language].restReminderText;
    return { cue: 'restReminder', instruction: `请直接说下面这句话，不要改写：${text}`, fallbackText: text };
  }

  private stopSlimClock(): void {
    if (this.slimTimer) clearTimeout(this.slimTimer);
    this.slimTimer = null;
    this.slimDeferredSince = null;
  }

  /** One clock reading: defer while the seam is closed, rebuild when it opens or the deadline passes. */
  private tickSlim(): void {
    const slim = this.deps.slim;
    if (!slim?.enabled || this.ended) return;
    const now = this.now();
    const action = slimClockAction({
      enabled: slim.enabled,
      now,
      dueAt: this.slimDueAt,
      deferredSince: this.slimDeferredSince,
      maxDeferMs: slim.maxDeferMs,
      seamOpen: this.slimSeamOpen(),
    });
    if (action === 'idle') return;
    if (action === 'defer') {
      // Idempotent: the deadline is always measured from the first deferral.
      if (this.slimDeferredSince === null) this.slimDeferredSince = now;
      this.armSlimClock(this.slimDeferredSince + slim.maxDeferMs);
      return;
    }
    this.slimDeferredSince = null;
    // Another rebuild in flight owns the rearming; its finally restarts the interval.
    if (this.rebuilding || this.rebuildTimer) return;
    void this.rebuild('slim');
  }

  /** Re-reads the store. Empty renders remove the views. Slim rebuilds skip this. */
  private refreshMemorySnapshot(): void {
    const store = this.deps.store;
    const ownerId = this.context.ownerId;
    const agentId = this.context.agentId;
    const maxChars = this.budgetFor(this.language)?.snapshotMaxChars;
    if (!store || !ownerId || !agentId || maxChars === undefined) return;
    const views = renderMemoryViews({
      ...memoryViewSource(store, ownerId, agentId),
      maxChars,
      labels: PROMPT_LABELS[this.language],
      rules: {
        addressingPatterns: this.i18n.memory[this.language].addressingPatterns,
        evidence: this.i18n.evidence,
      },
    });
    if (views.full) this.context.memorySnapshot = views.full;
    else delete this.context.memorySnapshot;
    if (views.greeting) {
      this.context.greetingMemorySnapshot = views.greeting;
      this.context.greetingHasTopic = views.hasTopic;
    } else {
      delete this.context.greetingMemorySnapshot;
      delete this.context.greetingHasTopic;
    }
    if (views.proactive) this.context.proactiveMemorySnapshot = views.proactive;
    else delete this.context.proactiveMemorySnapshot;
    if (views.pinnedBlock) this.context.pinnedMemory = views.pinnedBlock;
    else delete this.context.pinnedMemory;
  }

  /** First meeting with a known name: a card template with {name}. Never the planner. */
  private firstMeetGreeting(): string | undefined {
    const characters = this.deps.characters;
    if (!this.context.firstMeet || !characters) return undefined;
    const name = this.greetingName();
    if (!name) return undefined;
    const picked = this.firstMeetLine;
    if (picked && picked.language === this.language) return picked.text;
    const templates = characters.greetingsFirstMeet(this.context.characterId, this.language);
    const text = templates[Math.floor(Math.random() * templates.length)]!.replaceAll('{name}', name);
    this.firstMeetLine = { language: this.language, text };
    return text;
  }

  /** First meeting: the card's no-name line replaces greetingText as the planner-failure fallback. */
  private directorConfig(language: Language): DirectorConfig {
    const base = this.deps.roles.director(this.context.characterId, language);
    const characters = this.deps.characters;
    if (!this.context.firstMeet || !characters) return base;
    let config = this.firstMeetDirectors.get(language);
    if (!config) {
      config = { ...base, greetingText: characters.greetingNoName(this.context.characterId, language) };
      this.firstMeetDirectors.set(language, config);
    }
    return config;
  }

  /** A first meeting without a name opens like a session with no memory: introduce yourself, ask the name. */
  private openingHasMemory(): boolean {
    if (!this.context.memorySnapshot?.trim()) return false;
    return !(this.context.firstMeet && !this.greetingName());
  }

  /** Name-template opening when the engine has none; null when no name is known. */
  private safeGreeting(): string | null {
    const name = this.greetingName();
    if (!name) return null;
    const config = this.deps.roles.director(this.context.characterId, this.language);
    const templates = config.greetingNameTexts;
    if (!templates || templates.length === 0) return config.greetingMemoryText ?? null;
    return templates[Math.floor(Math.random() * templates.length)]!.replaceAll('{name}', name);
  }

  /** Stored name from the greeting snapshot, read with the current language's labels. */
  private greetingName(): string | null {
    const snapshot = this.context.greetingMemorySnapshot;
    if (!snapshot) return null;
    const labels = PROMPT_LABELS[this.language];
    const namePrefix = `${labels.addressing}${labels.separator}`;
    const nameLine = snapshot.split('\n').find((line) => line.startsWith(namePrefix));
    return nameLine?.slice(namePrefix.length).trim() || null;
  }

  private scheduleRebuild(reason: RebuildReason): void {
    if (this.ended || this.rebuildTimer) return;
    const base = this.deps.rebuildBackoffBaseMs ?? 1_000;
    const max = this.deps.rebuildBackoffMaxMs ?? 8_000;
    const delay = Math.min(base * 2 ** this.rebuildAttempt, max);
    this.rebuildAttempt++;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      void this.rebuild(reason, reason === 'forget' || reason === 'decline');
    }, delay);
  }

  private startKeepalive(): void {
    if (this.keepalive) return;
    const silence = new Int16Array(MIC_FRAME_SAMPLES);
    this.keepalive = setInterval(() => {
      if (!this.rebuilding && !this.ended && !this.toolTurn.active) this.adapter.sendAudio(silence);
    }, 20);
  }

  private syncInputMute(): void {
    const adapter = this.adapter as RealtimeAdapter & { setInputMuted?: (muted: boolean) => void };
    adapter.setInputMuted?.(this.muted);
  }

  private stopKeepalive(): void {
    if (!this.keepalive) return;
    clearInterval(this.keepalive);
    this.keepalive = null;
  }
}
