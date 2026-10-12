import { MIC_FRAME_SAMPLES, MIC_SAMPLE_RATE } from '@anyidea/protocol';
import { FrameChunker, LinearResampler, float32ToInt16 } from './pcm.ts';
import captureWorkletUrl from './capture-worklet.ts?worker&url';

/** 'all' asks Chrome 141+ to cancel all page audio, not just remote WebRTC audio (spec §2.1). */
export type EchoMode = 'true' | 'all';

export interface CaptureOptions {
  onFrame(pcm16k: Int16Array): void;
  echo: EchoMode;
}

export class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;

  async start(o: CaptureOptions): Promise<MediaStream> {
    await this.stop();
    const audio = {
      channelCount: 1,
      echoCancellation: o.echo === 'all' ? 'all' : true,
      noiseSuppression: true,
      autoGainControl: true,
    } as unknown as MediaTrackConstraints; // 'all' is newer than the DOM typings
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(captureWorkletUrl);
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const sink = ctx.createGain();
      sink.gain.value = 0; // keeps the node pulled by the graph without making sound
      const resampler = new LinearResampler(ctx.sampleRate, MIC_SAMPLE_RATE);
      const chunker = new FrameChunker(MIC_FRAME_SAMPLES);
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        for (const frame of chunker.push(float32ToInt16(resampler.process(e.data)))) o.onFrame(frame);
      };
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
    } catch (err) {
      // Release the mic and context so the recording indicator turns off.
      stream.getTracks().forEach((t) => t.stop());
      await ctx?.close().catch(() => {});
      throw err;
    }
    this.stream = stream;
    this.ctx = ctx;
    return stream;
  }

  settings(): MediaTrackSettings | null {
    return this.stream?.getAudioTracks()[0]?.getSettings() ?? null;
  }

  setEnabled(on: boolean): void {
    this.stream?.getAudioTracks().forEach((t) => {
      t.enabled = on;
    });
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.stream = null;
    this.ctx = null;
  }
}
