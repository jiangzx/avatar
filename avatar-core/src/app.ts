import type { AudioPath, ResponseKind, ServerMessage } from '@anyidea/protocol';
import { MicCapture, type EchoMode } from './audio/capture.ts';
import { MouthAnalyzer } from './audio/mouth.ts';
import { FADE_MS, PlaybackController } from './audio/player.ts';
import { LocalVad } from './audio/vad.ts';
import { ActionPlayer } from './avatar/actions.ts';
import { AvatarView } from './avatar/avatarView.ts';
import { nextState, type AvatarInput, type AvatarState } from './avatar/stateMachine.ts';
import { postToFlutter, type FromFlutter } from './bridge.ts';
import { GatewayClient } from './net/gatewayClient.ts';
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

export class AppController {
  private readonly playback: PlaybackController;
  private readonly capture = new MicCapture();
  private readonly vad = new LocalVad();
  private readonly mouth = new MouthAnalyzer();
  private readonly subtitles = new SubtitleTracker();
  private avatar: AvatarView | null = null;
  private actions: ActionPlayer | null = null;
  private client: GatewayClient | null = null;
  private state: AvatarState = 'idle';
  private muted = false;
  private ended = false;
  private readonly kinds = new Map<number, ResponseKind>();
  // Responses already reported as stopped/cancelled; late worklet events for them are ignored.
  private readonly closedSeqs = new Set<number>();
  // After session.resumed, every seq <= this is stale.
  private seqFloor = 0;
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
  ) {
    this.playback = new PlaybackController({
      onFirstAudio: (seq) => {
        // A late 'started' from an old response must not flip the state machine.
        if (this.playback.gate.accepts(seq)) this.onFirstAudio(seq);
      },
      onEnded: (seq, playedMs) => {
        if (this.isStale(seq)) return;
        this.closedSeqs.add(seq);
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

  async start(): Promise<void> {
    postToFlutter({ type: 'status', status: 'loading' });
    // Create and resume the player context first, while still inside the user gesture (desktop click).
    await this.playback.init();
    await this.resumeAudio();
    postToFlutter({ type: 'diag', key: 'audio_context', value: this.playback.contextState });
    if (this.playback.contextState !== 'running') this.resumeOnNextGesture();

    this.avatar = new AvatarView(this.el);
    await this.avatar.load(this.cfg.avatarUrl);
    this.actions = new ActionPlayer(this.avatar.talkingHead, { waveFbx: './animations/waving.fbx' });

    const stream = await this.capture.start({
      echo: this.cfg.echo,
      onFrame: (pcm) => {
        if (!this.muted && !this.ended) this.client?.sendAudio(pcm);
      },
    });
    postToFlutter({ type: 'diag', key: 'mic_settings', value: JSON.stringify(this.capture.settings()) });
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

    this.client = new GatewayClient(
      { baseUrl: this.cfg.gatewayUrl, appSecret: this.cfg.appSecret, clientInfo: { platform: 'android', audioPath: this.cfg.audioPath } },
      {
        onMessage: (m) => this.onServer(m),
        onAudio: (seq, pcm) => {
          if (!this.playback.gate.accepts(seq)) return; // stale/cancelled audio counts for nothing
          this.subtitles.onAudio(seq, pcm.length);
          this.playback.push(seq, pcm);
        },
        onStatus: (status) => postToFlutter({ type: 'status', status }),
      },
    );
    document.addEventListener('visibilitychange', () => this.avatar?.setRendering(!document.hidden));
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
        this.interruptPlayback(performance.now());
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
        () => postToFlutter({ type: 'diag', key: 'audio_context', value: this.playback.contextState }),
        () => undefined,
      );
    };
    document.addEventListener('pointerdown', retry, { once: true });
  }

  private isStale(seq: number): boolean {
    return seq <= this.seqFloor || this.closedSeqs.has(seq);
  }

  private onUserSpeechStart(onsetAt: number): void {
    this.transition('userSpeechStart');
    this.client?.send({ type: 'vad', state: 'speaking', t: Date.now() });
    this.interruptPlayback(onsetAt);
  }

  private interruptPlayback(onsetAt: number): void {
    const r = this.playback.interrupt();
    if (!r) return;
    this.closedSeqs.add(r.seq);
    this.client?.send({ type: 'playback.stopped', responseSeq: r.seq, playedMs: r.playedMs, reason: 'interrupted' });
    postToFlutter({ type: 'subtitle', role: 'assistant', text: this.subtitles.truncate(r.seq, r.playedMs), final: true });
    this.metric('interrupt_stop_ms', performance.now() + FADE_MS - onsetAt); // + fade-out
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
        this.playback.resetForNewSession();
        this.subtitles.reset();
        this.kinds.clear();
        this.closedSeqs.clear();
        this.seqFloor = 0;
        this.actions?.stopAll();
        this.resetSpeakingState();
        break;
      case 'session.resumed':
        this.playback.resetAfterResume(m.lastResponseSeq);
        this.seqFloor = Math.max(this.seqFloor, m.lastResponseSeq);
        this.actions?.stopAll();
        this.resetSpeakingState();
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
        if (!this.isStale(seq)) {
          const text = this.subtitles.truncate(seq, this.playback.playedMsFor(seq));
          postToFlutter({ type: 'subtitle', role: 'assistant', text, final: true });
        }
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
        postToFlutter({ type: 'subtitle', role: 'user', text: m.text, final: m.final });
        break;
      case 'transcript.assistant': {
        if (m.responseSeq <= this.seqFloor) break;
        const text = this.subtitles.onDelta(m.responseSeq, m.text);
        if (text !== null) postToFlutter({ type: 'subtitle', role: 'assistant', text, final: false });
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
        if (m.code === 'model_reconnecting') postToFlutter({ type: 'status', status: 'model_reconnecting' });
        else postToFlutter({ type: 'error', code: m.code });
        break;
    }
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
    postToFlutter({ type: 'state', state: next });

    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = next === 'thinking' ? setTimeout(() => this.transition('thinkingTimeout'), THINKING_TIMEOUT_MS) : null;

    if (this.nodTimer) clearInterval(this.nodTimer);
    this.nodTimer = next === 'listening' ? setInterval(() => this.actions?.nod(true), LISTEN_NOD_EVERY_MS) : null;
  }

  private metric(name: string, ms: number): void {
    postToFlutter({ type: 'metric', name, ms: Math.round(ms) });
  }
}
