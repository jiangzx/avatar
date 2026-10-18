import { randomUUID } from 'node:crypto';
import {
  AI_SAMPLE_RATE,
  MIC_FRAME_SAMPLES,
  truncateByPlayback,
  type ClientMessage,
  type ResponseKind,
  type ServerMessage,
} from '@anyidea/protocol';
import { classifyAdapterError } from '../adapters/errorClass.ts';
import { PERFORM_ACTION_TOOL, type AdapterFactory, type ProactiveRequest, type RealtimeAdapter, type SessionConfig } from '../adapters/types.ts';
import { log } from '../log.ts';
import { runWithPolicy, type PolicySpec } from '../reliability/policy.ts';
import { ActionRouter } from './actions.ts';
import type { RoleCatalog } from '../roles/catalog.ts';
import { devContext, type SessionContext } from './context.ts';
import { Director } from './director.ts';
import { EmotionTagger, type EmotionConfig } from './emotion.ts';
import { InterruptCoordinator } from './interrupt.ts';
import { buildInstructions, historyBudget, type InstructionBudget } from './instructions.ts';
import { ConversationLedger, DEFAULT_LEDGER_OPTIONS, type LedgerOptions, type Summarizer } from './ledger.ts';
import { ReplyMetricsTracker, metricFields, type ReplyMetrics } from './metrics.ts';
import { DEFAULT_TOOL_TURN_TIMEOUT_MS } from './pacing.ts';
import { ToolTurn } from './toolTurn.ts';

export interface Transport {
  send(msg: ServerMessage): void;
  sendAudio(seq: number, pcm: Int16Array): void;
}

/** Persists one transcript turn. Implementations must not log the text. */
export interface TranscriptWriter {
  append(input: { ownerId: string; sessionId: string; role: 'user' | 'assistant'; text: string; now: number }): 'stored' | 'skipped' | 'rejected';
}

export interface SessionDeps {
  adapterFactory: AdapterFactory;
  summarizer: Summarizer;
  roles: RoleCatalog;
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
  summarizePolicy?: PolicySpec;
  maxOutputTokens?: number;
  /** Uplink resumes this long after playback ended (reason=ended) when the model owns turns. */
  tailGuardMs?: number;
  /** Tool-turn wait. Omitted in tests: DEFAULT_TOOL_TURN_TIMEOUT_MS, same as gateway/config/memory.json. */
  toolTurnTimeoutMs?: number;
  /** Instruction size budget (gateway/config/memory.json); undefined = unbounded (tests). */
  budget?: InstructionBudget;
  /** Fraction of modelContextTokenLimit that triggers a silent slim rebuild. */
  rebuildTriggerRatio?: number;
  /** Emotion lexicon (gateway/config/emotion.json); undefined = no avatar.emotion messages. */
  emotion?: EmotionConfig;
  /** Optional. flush() returns immediately when this is absent. */
  writer?: TranscriptWriter;
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
}

const MAX_REBUILD_MIC_FRAMES = 25;
/** 600 ms. The local detector confirms speech after 150 ms, so the onset is already in this buffer. */
const BARGE_PREROLL_FRAMES = 30;
/** Matches the client barge-in threshold. Playback echo sits well below it. */
const BARGE_PREROLL_RMS = 200;

/** Used only when no policy is injected (tests); production reads gateway/config/pacing.json. */
const DEFAULT_SUMMARIZE_POLICY: PolicySpec = { timeoutMs: 15_000, retries: 0, backoffMs: 1_000, maxBackoffMs: 1_000 };

export class Session {
  readonly ledger: ConversationLedger;
  readonly context: SessionContext;
  private readonly writer: TranscriptWriter | undefined;
  private readonly persona: string;
  private adapter: RealtimeAdapter;
  private transport: Transport | null = null;
  private readonly director: Director;
  private readonly emotion: EmotionTagger | null;
  private readonly interrupt: InterruptCoordinator;
  private readonly actions = new ActionRouter();
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

  constructor(
    private readonly deps: SessionDeps,
    ctx: SessionContext = devContext(deps.roles),
    readonly sessionId: string = randomUUID(),
  ) {
    this.writer = deps.writer;
    this.context = ctx;
    this.persona = deps.roles.buildPersona(ctx.roleId, ctx.styleId);
    const ledgerOpts = deps.ledger ?? DEFAULT_LEDGER_OPTIONS;
    // Summarize before the instruction budget would have to drop unsummarized turns.
    const history = deps.budget ? historyBudget(this.persona, deps.budget) : Number.POSITIVE_INFINITY;
    this.ledger = new ConversationLedger({ ...ledgerOpts, summarizeAfterTokens: Math.min(ledgerOpts.summarizeAfterTokens, history) });
    this.director = new Director(deps.roles.director(ctx.roleId), { requestResponse: (kind, request) => this.requestResponse(kind, request) });
    this.emotion = deps.emotion ? new EmotionTagger(deps.emotion, (emotion) => this.send({ type: 'avatar.emotion', emotion })) : null;
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
    await this.adapter.connect(this.sessionConfig());
    if (this.ended) {
      this.adapter.close();
      return;
    }
    this.director.onSessionStart(Boolean(this.context.memorySnapshot?.trim()));
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
        if (speaking && this.toolTurn.active) {
          const end = this.toolTurn.onUserSpeaking();
          if (end) this.releaseToolTurn(false);
        }
        if (speaking) this.vadSpeakingCount++;
        else this.vadSilentCount++;
        log('vad_edge', {
          state: msg.state,
          count: speaking ? this.vadSpeakingCount : this.vadSilentCount,
          activeSeq: this.interrupt.active ?? 0,
        });
        const playing = this.modelGenerating || this.interrupt.active !== null;
        if (speaking && playing) {
          this.streamBarge = true;
          this.flushBargePreroll();
        }
        this.interrupt.onLocalVad(speaking);
        this.director.onUserSpeech(speaking);
        if (!speaking) this.metrics.onLocalVadSilent();
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
          if (!toolOrigin && this.interrupt.active !== msg.responseSeq) break;
          this.streamBarge = false;
          this.bargePreroll.length = 0;
          this.finalize(s, false);
          this.interrupt.onResponseFinished(msg.responseSeq);
          this.uplinkResumeAt = Date.now() + (this.deps.tailGuardMs ?? 0);
          if (toolOrigin) {
            this.toolTurn.onOriginPlaybackEnded();
            this.maybeContinue();
          } else {
            this.director.onAiTurnEnded();
            this.maybeSlimContext();
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
        this.interrupt.cancelActive('local');
        this.onUserFinal(msg.text, true);
        this.adapter.sendUserText(msg.text);
        break;
      case 'session.start':
      case 'session.resume':
      case 'session.end':
        break; // lifecycle is handled by SessionManager
    }
  }

  /** Writes finalized assistant replies that are not yet stored. User finals are not flushed here. */
  flush(): void {
    if (!this.writer || !this.context.ownerId) return;
    for (const state of this.bySeq.values()) {
      if (!state.finalized || state.flushed || !state.text) continue;
      this.writer.append({
        ownerId: this.context.ownerId,
        sessionId: this.sessionId,
        role: 'assistant',
        text: state.text,
        now: Date.now(),
      });
      state.flushed = true;
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearToolTimer();
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.rebuildMicBuffer.length = 0;
    this.stopKeepalive();
    this.director.stop();
    this.emotion?.dispose();
    this.interrupt.dispose();
    this.adapter.removeAllListeners();
    this.adapter.close();
    this.ledger.clear();
    this.transport = null;
  }

  private send(msg: ServerMessage): void {
    this.transport?.send(msg);
  }

  private instructions(): string {
    return buildInstructions(
      { persona: this.persona, memorySnapshot: this.context.memorySnapshot, summary: this.ledger.summary, recent: this.ledger.recent },
      this.deps.budget,
    );
  }

  private sessionConfig(): SessionConfig {
    const instructions = this.instructions();
    this.lastInstructionsChars = instructions.length;
    return { instructions, tools: [PERFORM_ACTION_TOOL], voice: this.context.voice, ...(this.deps.maxOutputTokens !== undefined ? { maxOutputTokens: this.deps.maxOutputTokens } : {}) };
  }

  /** Sends fresh instructions to the live model session and remembers their size. */
  private pushInstructions(): void {
    const instructions = this.instructions();
    this.lastInstructionsChars = instructions.length;
    this.adapter.updateInstructions(instructions);
  }

  private requestResponse(kind: ResponseKind, request: ProactiveRequest): void {
    // Tool turns speak only through maybeContinue.
    if (this.toolTurn.active || this.ended || this.interrupt.active !== null || this.modelGenerating) return;
    this.pendingKind = kind;
    this.adapter.createResponse(request);
  }

  private createAdapter(): RealtimeAdapter {
    const a = this.deps.adapterFactory();
    const current = () => a === this.adapter && !this.ended;

    a.on('userSpeechStarted', () => {
      if (!current()) return;
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
      const s: ResponseState = { seq: ++this.seqCounter, kind: this.pendingKind ?? 'reply', text: '', audioMs: 0, playedMs: 0, finalized: false, flushed: false };
      this.pendingKind = null;
      this.byId.set(id, s);
      this.bySeq.set(s.seq, s);
      log('response_start', { seq: s.seq, kind: s.kind });
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
      if (name !== PERFORM_ACTION_TOOL.name) {
        a.sendToolResult(callId, { ok: false, error: 'unknown_tool' });
        return;
      }
      const { action, result } = this.actions.fromTool(args);
      a.sendToolResult(callId, result);
      const s = this.byId.get(id);
      if (s) this.metrics.onToolCall(s.seq);
      const cancelled = s ? this.interrupt.isCancelled(s.seq) : false;
      if (action && !cancelled) this.send({ type: 'avatar.action', action, source: 'tool' });
      if (s && !cancelled) this.beginToolTurn(s);
    });
    a.on('responseDone', (id) => {
      const s = this.live(a, id);
      if (s) {
        log('response_end', { seq: s.seq });
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
      log('model_auto_cancel', { seq: s.seq });
      this.finalize(s, true);
      if (this.toolTurn.active && s.seq === this.toolOriginSeq && this.toolTurn.onCancel()) this.releaseToolTurn(false);
    });
    a.on('error', (code, retryable) => {
      if (!current()) return;
      const errorClass = classifyAdapterError(code, this.toolTurn.active);
      log('adapter_error', { code, class: errorClass });
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
    log('response_cancel', { seq, source });
    this.modelGenerating = false;
    if (this.responseLive) this.adapter.cancelResponse();
    this.responseLive = false;
    this.send({ type: 'response.cancelled', responseSeq: seq });
    const s = this.bySeq.get(seq);
    if (s) this.finalize(s, true);
  }

  private finalize(s: ResponseState, interrupted: boolean): void {
    if (s.finalized) return;
    s.finalized = true;
    const m = this.metrics.finish(s.seq, interrupted ? 'interrupted' : 'ended');
    if (m) {
      log('reply_metrics', metricFields(m));
      this.deps.onReplyMetrics?.(m);
    }
    const text = interrupted ? truncateByPlayback(s.text, s.playedMs, s.audioMs) : s.text;
    s.text = text;
    this.ledger.addAssistant(text, Date.now(), interrupted);
    // Do not session.update here. An instructions refresh in the middle of a barge-in
    // drops the audio the server is still hearing, so the next question never lands.
    this.maybeSummarize();
  }

  private onUserFinal(text: string, echo: boolean): void {
    if (echo) this.send({ type: 'transcript.user', text, final: true });
    this.ledger.addUser(text, Date.now());
    if (this.writer && this.context.ownerId) {
      this.writer.append({
        ownerId: this.context.ownerId,
        sessionId: this.sessionId,
        role: 'user',
        text,
        now: Date.now(),
      });
    }
    this.turnsSinceRebuild++;
    this.charsSinceRebuild += text.length;
    this.director.onUserFinal(text);
    this.emotion?.onUserFinal(text);
    const action = this.actions.fromKeyword(text);
    if (action) this.send({ type: 'avatar.action', action, source: 'keyword' });
    this.maybeSummarize();
  }

  /** Clears a still-playing origin so the later continuation is not judged superseded. */
  private beginToolTurn(s: ResponseState): void {
    const active = this.interrupt.active;
    if (active !== null) {
      this.interrupt.onResponseFinished(active);
      this.send({ type: 'response.cancelled', responseSeq: active });
    }
    this.toolOriginSeq = s.seq;
    this.continuationAsked = false;
    this.originForcedEnd = false;
    this.toolTurn.start(s.seq);
    if (s.audioMs > 0) this.toolTurn.onOriginAudio();
    // Only the seq we just cancelled. A different active seq still needs a real playback.stopped.
    if (active === s.seq) {
      this.toolTurn.onOriginPlaybackEnded();
      this.originForcedEnd = true;
    }
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

  private maybeContinue(): void {
    if (this.ended || this.continuationAsked || !this.toolTurn.readyForContinuation()) return;
    this.continuationAsked = true;
    this.toolTurn.onContinuationRequested();
    const cfg = this.deps.roles.director(this.context.roleId);
    this.adapter.createResponse({
      cue: 'toolContinue',
      instruction: cfg.toolContinueInstruction,
      fallbackText: cfg.toolContinueText,
    });
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
    if (this.ended) return;
    // Continuation playback rearms silence later. Timeout and barge-in rearm now.
    this.director.releasePause(!allowSpeech);
  }

  private maybeSummarize(): void {
    if (!this.ledger.needsSummary() || this.summarizeInFlight) return;
    if (Date.now() < this.summarizeRetryAt) return;
    this.summarizeInFlight = true;
    void runWithPolicy('summarize', this.deps.summarizePolicy ?? DEFAULT_SUMMARIZE_POLICY, () => this.ledger.summarize(this.deps.summarizer)).then((r) => {
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
      log('summarize_failed', { code: r.code });
    });
  }

  private maybeSlimContext(): void {
    if (this.toolTurn.active) return;
    const limit = (this.deps.modelContextTokenLimit ?? 12_000) * (this.deps.rebuildTriggerRatio ?? 0.8);
    // The model holds the instructions it was last given plus everything said since the rebuild.
    const estimate = this.charsSinceRebuild + this.lastInstructionsChars;
    if (estimate > limit || this.turnsSinceRebuild >= (this.deps.rebuildAfterTurns ?? 30)) void this.rebuild('slim');
  }

  private async rebuild(reason: 'error' | 'closed' | 'slim'): Promise<void> {
    if (reason === 'slim' && this.toolTurn.active) return;
    if (this.rebuilding || this.rebuildTimer || this.ended) return;
    if (this.toolTurn.onRebuild()) this.releaseToolTurn(false);
    this.rebuilding = true;
    log('model_rebuild', { reason });
    if (reason !== 'slim') this.send({ type: 'error', code: 'model_reconnecting', retryable: true });
    this.interrupt.cancelActive('local'); // uses the old adapter
    // The old adapter's responseDone/cancel will never arrive; drop in-flight generation state.
    this.modelGenerating = false;
    this.responseLive = false;
    this.pendingKind = null;
    this.uplinkResumeAt = 0;
    const old = this.adapter;
    this.adapter = this.createAdapter();
    old.removeAllListeners();
    old.close();
    try {
      await this.adapter.connect(this.sessionConfig());
      this.syncInputMute();
      const buffered = this.rebuildMicBuffer.splice(0);
      if (!this.muted) for (const pcm of buffered) this.adapter.sendAudio(pcm);
      this.rebuildAttempt = 0;
      this.turnsSinceRebuild = 0;
      this.charsSinceRebuild = 0;
    } catch {
      log('model_rebuild_failed', { reason });
      this.send({ type: 'error', code: 'model_unavailable', retryable: true });
      this.scheduleRebuild(reason);
    } finally {
      this.rebuilding = false;
    }
  }

  private scheduleRebuild(reason: 'error' | 'closed' | 'slim'): void {
    if (this.ended || this.rebuildTimer) return;
    const base = this.deps.rebuildBackoffBaseMs ?? 1_000;
    const max = this.deps.rebuildBackoffMaxMs ?? 8_000;
    const delay = Math.min(base * 2 ** this.rebuildAttempt, max);
    this.rebuildAttempt++;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      void this.rebuild(reason);
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
