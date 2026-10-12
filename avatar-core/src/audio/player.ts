import { AI_SAMPLE_RATE } from '@anyidea/protocol';
import { LinearResampler, int16ToFloat32, type AudioFeatures } from './pcm.ts';
import { PlaybackGate } from './playbackGate.ts';
import playerWorkletUrl from './player-worklet.ts?worker&url';

export interface PlaybackEvents {
  onFirstAudio(seq: number): void;
  onEnded(seq: number, playedMs: number): void;
  onStopped(seq: number, playedMs: number): void;
  onProgress(seq: number, playedMs: number): void;
  onLevel(features: AudioFeatures, dtMs: number): void;
}

type OutMsg =
  | { type: 'started'; seq: number }
  | { type: 'progress'; seq: number; playedSamples: number }
  | { type: 'drained'; seq: number; playedSamples: number }
  | { type: 'stopped'; seq: number; playedSamples: number }
  | { type: 'level'; rms: number; zcr: number; samples: number };

export const FADE_MS = 30; // TUNABLE
export const RESET_FADE_MS = 10; // TUNABLE

/** Plays streamed 24 kHz PCM with per-response gating and instant barge-in. */
export class PlaybackController {
  readonly gate = new PlaybackGate();
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private resampler: LinearResampler | null = null;
  private readonly playedSamples = new Map<number, number>();

  constructor(private readonly ev: PlaybackEvents) {}

  async init(): Promise<void> {
    const ctx = new AudioContext({ sampleRate: AI_SAMPLE_RATE, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(playerWorkletUrl);
    const node = new AudioWorkletNode(ctx, 'player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e: MessageEvent<OutMsg>) => this.onWorklet(e.data);
    node.connect(ctx.destination);
    if (ctx.sampleRate !== AI_SAMPLE_RATE) this.resampler = new LinearResampler(AI_SAMPLE_RATE, ctx.sampleRate);
    this.ctx = ctx;
    this.node = node;
  }

  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
  }

  get activeSeq(): number | null {
    return this.gate.active;
  }

  get contextState(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  onResponseStart(seq: number): void {
    this.gate.start(seq);
  }

  push(seq: number, pcm24k: Int16Array): void {
    if (!this.node || !this.gate.accepts(seq)) return;
    let samples = int16ToFloat32(pcm24k);
    if (this.resampler) samples = this.resampler.process(samples);
    this.node.port.postMessage({ type: 'push', seq, samples }, [samples.buffer]);
  }

  end(seq: number): void {
    if (this.gate.accepts(seq)) this.node?.port.postMessage({ type: 'end', seq });
  }

  /** Barge-in: fade out and drop the active response. */
  interrupt(): { seq: number; playedMs: number } | null {
    const seq = this.gate.active;
    if (seq === null) return null;
    this.gate.cancel(seq);
    this.node?.port.postMessage({ type: 'stop', fadeMs: FADE_MS });
    return { seq, playedMs: this.playedMsFor(seq) };
  }

  /** The server cancelled a response. */
  cancelled(seq: number): void {
    const wasActive = this.gate.active === seq;
    this.gate.cancel(seq);
    if (wasActive) this.node?.port.postMessage({ type: 'stop', fadeMs: FADE_MS });
  }

  resetAfterResume(lastSeq: number): void {
    this.gate.resetBelow(lastSeq);
    this.node?.port.postMessage({ type: 'stop', fadeMs: RESET_FADE_MS });
  }

  /** A fresh gateway session (sequence numbers restart at 1). */
  resetForNewSession(): void {
    this.gate.reset();
    this.playedSamples.clear();
    this.node?.port.postMessage({ type: 'stop', fadeMs: RESET_FADE_MS });
  }

  playedMsFor(seq: number): number {
    const rate = this.ctx?.sampleRate ?? AI_SAMPLE_RATE;
    return ((this.playedSamples.get(seq) ?? 0) / rate) * 1000;
  }

  private onWorklet(m: OutMsg): void {
    const rate = this.ctx?.sampleRate ?? AI_SAMPLE_RATE;
    switch (m.type) {
      case 'started':
        this.ev.onFirstAudio(m.seq);
        break;
      case 'progress':
        this.playedSamples.set(m.seq, m.playedSamples);
        this.ev.onProgress(m.seq, (m.playedSamples / rate) * 1000);
        break;
      case 'drained':
        this.playedSamples.set(m.seq, m.playedSamples);
        this.gate.finish(m.seq);
        this.ev.onEnded(m.seq, (m.playedSamples / rate) * 1000);
        break;
      case 'stopped':
        this.playedSamples.set(m.seq, m.playedSamples);
        this.ev.onStopped(m.seq, (m.playedSamples / rate) * 1000);
        break;
      case 'level':
        this.ev.onLevel({ rms: m.rms, zcr: m.zcr }, (m.samples / rate) * 1000);
        break;
    }
  }
}
