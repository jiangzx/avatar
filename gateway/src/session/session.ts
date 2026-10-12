import {
  AI_SAMPLE_RATE,
  MIC_FRAME_SAMPLES,
  truncateByPlayback,
  type ClientMessage,
  type ResponseKind,
  type ServerMessage,
} from '@anyidea/protocol';
import { PERFORM_ACTION_TOOL, type AdapterFactory, type RealtimeAdapter, type SessionConfig } from '../adapters/types.ts';
import { log } from '../log.ts';
import { ActionRouter } from './actions.ts';
import { Director, type DirectorConfig } from './director.ts';
import { InterruptCoordinator } from './interrupt.ts';
import { ConversationLedger, DEFAULT_LEDGER_OPTIONS, type LedgerOptions, type Summarizer } from './ledger.ts';

export interface Transport {
  send(msg: ServerMessage): void;
  sendAudio(seq: number, pcm: Int16Array): void;
}

export interface SessionDeps {
  adapterFactory: AdapterFactory;
  summarizer: Summarizer;
  persona: string;
  director: DirectorConfig;
  ledger?: LedgerOptions;
  confirmWindowMs?: number;
  modelContextTokenLimit?: number;
  rebuildAfterTurns?: number;
}

interface ResponseState {
  seq: number;
  kind: ResponseKind;
  text: string;
  audioMs: number;
  playedMs: number;
  finalized: boolean;
}

export class Session {
  readonly ledger: ConversationLedger;
  private adapter: RealtimeAdapter;
  private transport: Transport | null = null;
  private readonly director: Director;
  private readonly interrupt: InterruptCoordinator;
  private readonly actions = new ActionRouter();
  private readonly byId = new Map<string, ResponseState>();
  private readonly bySeq = new Map<number, ResponseState>();
  private seqCounter = 0;
  private pendingKind: ResponseKind | null = null;
  private muted = false;
  private keepalive: NodeJS.Timeout | null = null;
  private turnsSinceRebuild = 0;
  private charsSinceRebuild = 0;
  private rebuilding = false;
  private ended = false;

  constructor(private readonly deps: SessionDeps) {
    this.ledger = new ConversationLedger(deps.ledger ?? DEFAULT_LEDGER_OPTIONS);
    this.director = new Director(deps.director, { requestResponse: (kind, text) => this.requestResponse(kind, text) });
    this.interrupt = new InterruptCoordinator({
      confirmWindowMs: deps.confirmWindowMs ?? 300,
      cancel: (seq, source) => this.cancel(seq, source),
    });
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
    this.director.onSessionStart();
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
    this.startKeepalive();
  }

  handleMicAudio(pcm: Int16Array): void {
    if (this.muted || this.rebuilding || this.ended) return;
    this.adapter.sendAudio(pcm);
  }

  handleClientMessage(msg: ClientMessage): void {
    if (this.ended) return;
    switch (msg.type) {
      case 'vad': {
        const speaking = msg.state === 'speaking';
        this.interrupt.onLocalVad(speaking);
        this.director.onUserSpeech(speaking);
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
          this.interrupt.onClientInterrupted(msg.responseSeq);
          this.finalize(s, true);
        } else {
          // Stale end (already cancelled/superseded, a newer turn may be active): ignore.
          if (this.interrupt.active !== msg.responseSeq) break;
          this.finalize(s, false);
          this.interrupt.onResponseFinished(msg.responseSeq);
          this.director.onAiTurnEnded();
          this.maybeSlimContext();
        }
        break;
      }
      case 'client.mute':
        this.muted = msg.muted;
        this.director.setMuted(msg.muted);
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

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.stopKeepalive();
    this.director.stop();
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
    return this.ledger.buildInstructions(this.deps.persona);
  }

  private sessionConfig(): SessionConfig {
    return { instructions: this.instructions(), tools: [PERFORM_ACTION_TOOL] };
  }

  private requestResponse(kind: ResponseKind, instructions: string): void {
    if (this.ended || this.interrupt.active !== null) return; // never talk over an active response
    this.pendingKind = kind;
    this.adapter.createResponse(instructions);
  }

  private createAdapter(): RealtimeAdapter {
    const a = this.deps.adapterFactory();
    const current = () => a === this.adapter && !this.ended;

    a.on('userSpeechStarted', () => {
      if (!current()) return;
      this.director.onUserActivity();
      this.interrupt.onModelSpeechStarted();
    });
    a.on('userTranscript', (text, final) => {
      if (!current()) return;
      this.director.onUserActivity();
      if (final) this.onUserFinal(text, true);
      else this.send({ type: 'transcript.user', text, final: false });
    });
    a.on('responseStarted', (id) => {
      if (!current()) return;
      const s: ResponseState = { seq: ++this.seqCounter, kind: this.pendingKind ?? 'reply', text: '', audioMs: 0, playedMs: 0, finalized: false };
      this.pendingKind = null;
      this.byId.set(id, s);
      this.bySeq.set(s.seq, s);
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
      s.audioMs += (pcm.length / AI_SAMPLE_RATE) * 1000;
      this.transport?.sendAudio(s.seq, pcm);
    });
    a.on('textDelta', (id, text) => {
      const s = this.live(a, id);
      if (!s) return;
      s.text += text;
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
      const cancelled = s ? this.interrupt.isCancelled(s.seq) : false;
      if (action && !cancelled) this.send({ type: 'avatar.action', action, source: 'tool' });
    });
    a.on('responseDone', (id) => {
      const s = this.live(a, id);
      if (s) this.send({ type: 'response.end', responseSeq: s.seq });
    });
    a.on('responseCancelled', (id) => {
      if (!current()) return;
      const s = this.byId.get(id);
      if (!s || !this.interrupt.onModelAutoCancelled(s.seq)) return;
      log('model_auto_cancel', { seq: s.seq });
      this.send({ type: 'response.cancelled', responseSeq: s.seq });
      this.finalize(s, true);
    });
    a.on('error', (code, retryable) => {
      if (!current()) return;
      log('adapter_error', { code, retryable });
      if (retryable) void this.rebuild('error');
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
    this.adapter.cancelResponse();
    this.send({ type: 'response.cancelled', responseSeq: seq });
    const s = this.bySeq.get(seq);
    if (s) this.finalize(s, true);
  }

  private finalize(s: ResponseState, interrupted: boolean): void {
    if (s.finalized) return;
    s.finalized = true;
    const text = interrupted ? truncateByPlayback(s.text, s.playedMs, s.audioMs) : s.text;
    this.ledger.addAssistant(text, Date.now(), interrupted);
    // Skip the note when nothing was played: an empty quote would mislead the model.
    if (interrupted && text.length > 0 && !this.adapter.supportsPlaybackTruncate) {
      this.adapter.injectContextNote(`助手上一句只说到：「${text}」，被用户打断。`);
    }
    this.maybeSummarize();
  }

  private onUserFinal(text: string, echo: boolean): void {
    if (echo) this.send({ type: 'transcript.user', text, final: true });
    this.ledger.addUser(text, Date.now());
    this.turnsSinceRebuild++;
    this.charsSinceRebuild += text.length;
    this.director.onUserFinal(text);
    const action = this.actions.fromKeyword(text);
    if (action) this.send({ type: 'avatar.action', action, source: 'keyword' });
    this.maybeSummarize();
  }

  private maybeSummarize(): void {
    if (!this.ledger.needsSummary()) return;
    this.ledger
      .summarize(this.deps.summarizer)
      .then((applied) => {
        if (applied && !this.ended) this.adapter.updateInstructions(this.instructions());
      })
      .catch(() => log('summarize_failed'));
  }

  private maybeSlimContext(): void {
    const limit = (this.deps.modelContextTokenLimit ?? 12_000) * 0.8;
    const estimate = this.charsSinceRebuild + this.instructions().length;
    if (estimate > limit || this.turnsSinceRebuild >= (this.deps.rebuildAfterTurns ?? 30)) void this.rebuild('slim');
  }

  private async rebuild(reason: 'error' | 'closed' | 'slim'): Promise<void> {
    if (this.rebuilding || this.ended) return;
    this.rebuilding = true;
    log('model_rebuild', { reason });
    if (reason !== 'slim') this.send({ type: 'error', code: 'model_reconnecting', retryable: true });
    this.interrupt.cancelActive('local'); // uses the old adapter
    const old = this.adapter;
    this.adapter = this.createAdapter();
    old.removeAllListeners();
    old.close();
    try {
      await this.adapter.connect(this.sessionConfig());
      this.turnsSinceRebuild = 0;
      this.charsSinceRebuild = 0;
    } catch {
      log('model_rebuild_failed', { reason });
      this.send({ type: 'error', code: 'model_unavailable', retryable: true });
    } finally {
      this.rebuilding = false;
    }
  }

  private startKeepalive(): void {
    if (this.keepalive) return;
    const silence = new Int16Array(MIC_FRAME_SAMPLES);
    this.keepalive = setInterval(() => {
      if (!this.rebuilding && !this.ended) this.adapter.sendAudio(silence);
    }, 20);
  }

  private stopKeepalive(): void {
    if (!this.keepalive) return;
    clearInterval(this.keepalive);
    this.keepalive = null;
  }
}
