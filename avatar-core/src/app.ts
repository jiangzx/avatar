import type { AudioPath, ResponseKind, ServerMessage } from '@anyidea/protocol';
import { MicCapture, type EchoMode } from './audio/capture.ts';
import { MouthAnalyzer } from './audio/mouth.ts';
import { FADE_MS, PlaybackController, type PlaybackEvents } from './audio/player.ts';
import { LocalVad } from './audio/vad.ts';
import { ActionPlayer } from './avatar/actions.ts';
import { AvatarView } from './avatar/avatarView.ts';
import { nextState, type AvatarInput, type AvatarState } from './avatar/stateMachine.ts';
import { postToFlutter, type FromFlutter, type ToFlutter } from './bridge.ts';
import { GatewayClient, type GatewayClientEvents, type GatewayClientOptions } from './net/gatewayClient.ts';
import { SubtitleTracker } from './subtitles.ts';

export interface AppConfig {
  gatewayUrl: string;
  appSecret: string;
  audioPath: AudioPath;
  avatarUrl: string;
  echo: EchoMode;
}

export const THINKING_TIMEOUT_MS = 8000; // TUNABLE
export const LISTEN_NOD_EVERY_MS = 3500; // TUNABLE (estimate)
export const PROGRESS_SEND_EVERY = 2; // TUNABLE: forward every Nth worklet progress tick
export const AUDIO_RESUME_WAIT_MS = 500; // TUNABLE: max wait for AudioContext.resume() without a gesture

/** Bridge error code for a failure; never carries user content. */
export function errorCode(e: unknown): string {
  if (e instanceof DOMException) return e.name; // e.g. NotAllowedError for the microphone
  if (e instanceof Error) return e.message.slice(0, 64);
  return 'unknown';
}

// Narrow views of the collaborators, so tests can pass fakes.
export type PlaybackLike = Pick<
  PlaybackController,
  'gate' | 'init' | 'resume' | 'activeSeq' | 'contextState' | 'onResponseStart' | 'push' | 'end' | 'interrupt' | 'cancelled' | 'resetAfterResume' | 'resetForNewSession' | 'playedMsFor'
>;
export type CaptureLike = Pick<MicCapture, 'start' | 'stop' | 'setEnabled' | 'settings'>;
export type VadLike = Pick<LocalVad, 'start' | 'destroy' | 'aiPlaying'>;
export type AvatarLike = Pick<AvatarView, 'load' | 'talkingHead' | 'setMouth' | 'setEmotion' | 'enterState' | 'setActing' | 'setRendering'>;
export type ActionsLike = Pick<ActionPlayer, 'play' | 'stopAll' | 'nod'>;
export type ClientLike = Pick<GatewayClient, 'start' | 'send' | 'sendAudio' | 'close'>;
export interface DocLike {
  readonly hidden: boolean;
  addEventListener(type: string, fn: () => void, opts?: AddEventListenerOptions): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface AppDeps {
  createPlayback(ev: PlaybackEvents): PlaybackLike;
  capture: CaptureLike;
  vad: VadLike;
  createAvatar(el: HTMLElement): AvatarLike;
  createActions(avatar: AvatarLike): ActionsLike;
  createClient(o: GatewayClientOptions, ev: GatewayClientEvents): ClientLike;
  post(m: ToFlutter): void;
  doc: DocLike;
}

export function browserDeps(): AppDeps {
  return {
    createPlayback: (ev) => new PlaybackController(ev),
    capture: new MicCapture(),
    vad: new LocalVad(),
    createAvatar: (el) => new AvatarView(el),
    createActions: (avatar) => new ActionPlayer(avatar.talkingHead, { waveFbx: './animations/waving.fbx' }, { setActing: (active) => avatar.setActing(active) }),
    createClient: (o, ev) => new GatewayClient(o, ev),
    post: postToFlutter,
    doc: document,
  };
}

export class AppController {
  private readonly playback: PlaybackLike;
  private readonly capture: CaptureLike;
  private readonly vad: VadLike;
  private readonly post: (m: ToFlutter) => void;
  private readonly mouth = new MouthAnalyzer();
  private readonly subtitles = new SubtitleTracker();
  private avatar: AvatarLike | null = null;
  private actions: ActionsLike | null = null;
  private client: ClientLike | null = null;
  private state: AvatarState = 'idle';
  private muted = false;
  private ended = false;
  private readonly kinds = new Map<number, ResponseKind>();
  // Responses already reported as stopped/cancelled; late worklet events for them are ignored.
  private readonly closedSeqs = new Set<number>();
  // After session.resumed, every seq <= this is stale.
  private seqFloor = 0;
  // Assistant response whose subtitle was last sent as non-final.
  private liveSubtitleSeq: number | null = null;
  private sessionStartAt = 0;
  private greetingMeasured = false;
  private userSpeechEndAt: number | null = null;
  private lastUserFinalAt: number | null = null;
  private progressTick = 0;
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private nodTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly cfg: AppConfig,
    private readonly deps: AppDeps = browserDeps(),
  ) {
    this.capture = deps.capture;
    this.vad = deps.vad;
    this.post = deps.post;
    this.playback = deps.createPlayback({
      onFirstAudio: (seq) => {
        // A late 'started' from an old response must not flip the state machine.
        if (this.playback.gate.accepts(seq)) this.onFirstAudio(seq);
      },
      onEnded: (seq, playedMs) => {
        if (this.isStale(seq)) return;
        this.closedSeqs.add(seq);
        if (this.liveSubtitleSeq === seq) this.liveSubtitleSeq = null;
        this.client?.send({ type: 'playback.stopped', responseSeq: seq, playedMs, reason: 'ended' });
        this.clearSpeaking();
        this.transition('playbackEnded');
      },
      onStopped: () => {
        // Always follows our own interrupt/cancel/reset, which already reported; only tidy up if nothing newer plays.
        if (this.playback.activeSeq === null) this.clearSpeaking();
      },
      onProgress: (seq, playedMs) => {
        if (this.isStale(seq)) return;
        if (++this.progressTick % PROGRESS_SEND_EVERY === 0) this.client?.send({ type: 'playback.progress', responseSeq: seq, playedMs });
      },
      onLevel: (features, dtMs) => {
        const shape = this.mouth.update(features, dtMs);
        if (this.state === 'speaking') this.avatar?.setMouth(shape);
      },
    });
  }

  /** On failure: releases mic/VAD/session, posts a bridge error, then rethrows. */
  async start(): Promise<void> {
    try {
      await this.startSteps();
    } catch (e) {
      if (this.ended) {
        // shutdown() already ran; release what was started after it.
        await this.vad.destroy().catch(() => undefined);
        await this.capture.stop().catch(() => undefined);
      } else {
        await this.shutdown();
      }
      this.post({ type: 'error', code: errorCode(e) });
      try {
        this.avatar?.setRendering(false);
      } catch {
        // best effort
      }
      throw e;
    }
  }

  private async startSteps(): Promise<void> {
    this.post({ type: 'status', status: 'loading' });
    // Create and resume the player context first, while still inside the user gesture (desktop click).
    await this.playback.init();
    await this.resumeAudio();
    this.post({ type: 'diag', key: 'audio_context', value: this.playback.contextState });
    if (this.playback.contextState !== 'running') {
      this.post({ type: 'status', status: 'audio_suspended' });
      this.resumeOnNextGesture();
    }

    this.avatar = this.deps.createAvatar(this.el);
    await this.avatar.load(this.cfg.avatarUrl, () => this.post({ type: 'diag', key: 'avatar_fallback', value: '1' }));
    this.actions = this.deps.createActions(this.avatar);

    const stream = await this.capture.start({
      echo: this.cfg.echo,
      onFrame: (pcm) => {
        if (!this.muted && !this.ended) this.client?.sendAudio(pcm);
      },
    });
    this.post({ type: 'diag', key: 'mic_settings', value: JSON.stringify(this.capture.settings()) });
    await this.vad.start(stream, {
      onStart: (onsetAt) => this.onUserSpeechStart(onsetAt),
      onEnd: () => this.onUserSpeechEnd(),
    });
    if (this.ended) {
      // 'end' arrived while starting: release what shutdown() could not see yet.
      await this.vad.destroy().catch(() => undefined);
      await this.capture.stop().catch(() => undefined);
      return;
    }

    this.client = this.deps.createClient(
      { baseUrl: this.cfg.gatewayUrl, appSecret: this.cfg.appSecret, clientInfo: { platform: 'android', audioPath: this.cfg.audioPath } },
      {
        onMessage: (m) => this.onServer(m),
        onAudio: (seq, pcm) => {
          if (!this.playback.gate.accepts(seq)) return; // stale/cancelled audio counts for nothing
          this.subtitles.onAudio(seq, pcm.length);
          this.playback.push(seq, pcm);
        },
        onStatus: (status) => this.post({ type: 'status', status }),
      },
    );
    const doc = this.deps.doc;
    doc.addEventListener('visibilitychange', () => {
      if (!this.ended) this.avatar?.setRendering(!doc.hidden);
    });
    this.sessionStartAt = performance.now();
    await this.client.start();
  }

  handleFlutter(m: FromFlutter): void {
    switch (m.type) {
      case 'mute':
        this.muted = m.muted;
        this.capture.setEnabled(!m.muted);
        this.client?.send({ type: 'client.mute', muted: m.muted });
        break;
      case 'end':
        void this.shutdown();
        break;
      case 'debugText':
        if (this.ended) break;
        this.lastUserFinalAt = performance.now();
        this.interruptPlayback(null); // not a barge-in: no interrupt_stop_ms
        this.client?.send({ type: 'debug.userText', text: m.text });
        break;
      case 'config':
        break; // handled in main.ts
    }
  }

  /** End: VAD first (its end edge goes out as vad silent), then the mic, then session.end. */
  private async shutdown(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.finalizeLiveSubtitle();
    const r = this.playback.interrupt(); // no metric: this is not a barge-in
    if (r) this.closedSeqs.add(r.seq);
    this.actions?.stopAll();
    await this.vad.destroy().catch(() => undefined);
    await this.capture.stop().catch(() => undefined); // releases the microphone
    this.client?.close();
    this.resetSpeakingState();
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    if (this.nodTimer) clearInterval(this.nodTimer);
    this.thinkingTimer = null;
    this.nodTimer = null;
  }

  private async resumeAudio(): Promise<void> {
    // resume() can stay pending forever without a user gesture; never block start() on it.
    await Promise.race([this.playback.resume().catch(() => undefined), new Promise((r) => setTimeout(r, AUDIO_RESUME_WAIT_MS))]);
  }

  private resumeOnNextGesture(): void {
    const retry = () => {
      void this.playback.resume().then(
        () => this.post({ type: 'diag', key: 'audio_context', value: this.playback.contextState }),
        () => undefined,
      );
    };
    this.deps.doc.addEventListener('pointerdown', retry, { once: true });
  }

  private isStale(seq: number): boolean {
    return seq <= this.seqFloor || this.closedSeqs.has(seq);
  }

  private onUserSpeechStart(onsetAt: number): void {
    this.transition('userSpeechStart');
    this.client?.send({ type: 'vad', state: 'speaking', t: Date.now() });
    this.interruptPlayback(onsetAt);
  }

  /** onsetAt null: not a voice barge-in, so no interrupt_stop_ms metric. */
  private interruptPlayback(onsetAt: number | null): void {
    const r = this.playback.interrupt();
    if (!r) return;
    this.closedSeqs.add(r.seq);
    this.client?.send({ type: 'playback.stopped', responseSeq: r.seq, playedMs: r.playedMs, reason: 'interrupted' });
    this.postFinalSubtitle(r.seq, r.playedMs);
    if (onsetAt !== null) this.metric('interrupt_stop_ms', performance.now() + FADE_MS - onsetAt); // + fade-out
    this.clearSpeaking();
    this.actions?.stopAll();
  }

  private onUserSpeechEnd(): void {
    this.userSpeechEndAt = performance.now();
    this.client?.send({ type: 'vad', state: 'silent', t: Date.now() });
    this.transition('userSpeechEnd');
  }

  private onFirstAudio(seq: number): void {
    const now = performance.now();
    const kind = this.kinds.get(seq);
    if (kind === 'greeting' && !this.greetingMeasured) {
      this.greetingMeasured = true;
      this.metric('greeting_ms', now - this.sessionStartAt);
    }
    if (kind === 'reply' && this.userSpeechEndAt !== null) this.metric('first_response_ms', now - this.userSpeechEndAt);
    this.userSpeechEndAt = null;
    this.transition('firstAudio');
  }

  private onServer(m: ServerMessage): void {
    switch (m.type) {
      case 'session.ready':
        // New session (first start or fallback after the old one expired): sequence numbers restart at 1.
        this.finalizeLiveSubtitle();
        this.playback.resetForNewSession();
        this.subtitles.reset();
        this.kinds.clear();
        this.closedSeqs.clear();
        this.seqFloor = 0;
        this.actions?.stopAll();
        this.resetSpeakingState();
        this.client?.send({ type: 'client.mute', muted: this.muted }); // a mute sent while offline was dropped
        break;
      case 'session.resumed':
        this.finalizeLiveSubtitle();
        this.playback.resetAfterResume(m.lastResponseSeq);
        this.seqFloor = Math.max(this.seqFloor, m.lastResponseSeq);
        this.actions?.stopAll();
        this.resetSpeakingState();
        this.client?.send({ type: 'client.mute', muted: this.muted }); // a mute sent while offline was dropped
        break;
      case 'response.start':
        this.kinds.set(m.responseSeq, m.kind);
        this.playback.onResponseStart(m.responseSeq);
        if (this.playback.activeSeq === m.responseSeq) this.vad.aiPlaying = true;
        break;
      case 'response.end':
        this.playback.end(m.responseSeq);
        break;
      case 'response.cancelled': {
        const seq = m.responseSeq;
        const wasActive = this.playback.activeSeq === seq;
        if (!this.isStale(seq)) this.postFinalSubtitle(seq, this.playback.playedMsFor(seq));
        this.closedSeqs.add(seq);
        this.playback.cancelled(seq);
        // Only touch the avatar if no newer response is playing.
        if (wasActive || this.playback.activeSeq === null) {
          this.clearSpeaking();
          this.actions?.stopAll();
          this.transition('cancelled');
        }
        break;
      }
      case 'transcript.user':
        if (m.final) this.lastUserFinalAt = performance.now();
        this.post({ type: 'subtitle', role: 'user', text: m.text, final: m.final });
        break;
      case 'transcript.assistant': {
        if (m.responseSeq <= this.seqFloor) break;
        const text = this.subtitles.onDelta(m.responseSeq, m.text);
        if (text === null) break;
        this.liveSubtitleSeq = m.responseSeq;
        this.post({ type: 'subtitle', role: 'assistant', text, final: false });
        break;
      }
      case 'avatar.action':
        this.actions?.play(m.action);
        if (this.lastUserFinalAt !== null) {
          this.metric('action_latency_ms', performance.now() - this.lastUserFinalAt);
          this.lastUserFinalAt = null;
        }
        break;
      case 'avatar.emotion':
        this.avatar?.setEmotion(m.emotion);
        break;
      case 'metric':
        this.metric(m.name, m.ms);
        break;
      case 'error':
        if (m.code === 'model_reconnecting') this.post({ type: 'status', status: 'model_reconnecting' });
        else this.post({ type: 'error', code: m.code });
        break;
    }
  }

  private postFinalSubtitle(seq: number, playedMs: number): void {
    if (this.liveSubtitleSeq === seq) this.liveSubtitleSeq = null;
    this.post({ type: 'subtitle', role: 'assistant', text: this.subtitles.truncate(seq, playedMs), final: true });
  }

  /** Session change or end: close a half-shown assistant line at what was actually played. */
  private finalizeLiveSubtitle(): void {
    const seq = this.liveSubtitleSeq;
    if (seq === null) return;
    this.postFinalSubtitle(seq, this.playback.playedMsFor(seq));
  }

  private clearSpeaking(): void {
    this.vad.aiPlaying = false;
    this.avatar?.setMouth(null);
  }

  private resetSpeakingState(): void {
    this.clearSpeaking();
    this.transition('cancelled');
  }

  private transition(input: AvatarInput): void {
    const next = nextState(this.state, input);
    if (next === this.state) return;
    this.state = next;
    this.avatar?.enterState(next);
    this.post({ type: 'state', state: next });

    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = next === 'thinking' ? setTimeout(() => this.transition('thinkingTimeout'), THINKING_TIMEOUT_MS) : null;

    if (this.nodTimer) clearInterval(this.nodTimer);
    this.nodTimer = next === 'listening' ? setInterval(() => this.actions?.nod(true), LISTEN_NOD_EVERY_MS) : null;
  }

  private metric(name: string, ms: number): void {
    this.post({ type: 'metric', name, ms: Math.round(ms) });
  }
}
