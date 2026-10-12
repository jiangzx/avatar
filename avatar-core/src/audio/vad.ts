// Type-only import: vad-web/onnxruntime-web load lazily in start(), so vitest (node) can import this module.
import type { MicVAD } from '@ricky0123/vad-web';

export interface DetectorOptions {
  frameMs: number;
  threshold: number;
  /** Higher threshold while the AI is speaking, to resist echo. */
  bargeInThreshold: number;
  startMs: number;
  endMs: number;
  hysteresis: number;
}

/** TUNABLE (estimates); Silero v5 frames are 512 samples @16 kHz = 32 ms. */
export const DEFAULT_DETECTOR: DetectorOptions = {
  frameMs: 32,
  threshold: 0.5,
  bargeInThreshold: 0.75,
  startMs: 150,
  endMs: 600,
  hysteresis: 0.15,
};

/** Turns per-frame speech probabilities into start/end events with hysteresis. */
export class SpeechDetector {
  aiPlaying = false;
  speaking = false;
  onsetAt: number | null = null;
  private aboveMs = 0;
  private belowMs = 0;
  private candidateAt: number | null = null;

  constructor(private readonly o: DetectorOptions = DEFAULT_DETECTOR) {}

  push(p: number, nowMs: number): 'start' | 'end' | null {
    const threshold = this.aiPlaying ? this.o.bargeInThreshold : this.o.threshold;
    if (!this.speaking) {
      if (p >= threshold) {
        if (this.candidateAt === null) this.candidateAt = nowMs;
        this.aboveMs += this.o.frameMs;
        if (this.aboveMs >= this.o.startMs) {
          this.speaking = true;
          this.onsetAt = this.candidateAt;
          this.aboveMs = 0;
          this.belowMs = 0;
          this.candidateAt = null;
          return 'start';
        }
      } else {
        this.aboveMs = 0;
        this.candidateAt = null;
      }
      return null;
    }
    if (p < threshold - this.o.hysteresis) {
      this.belowMs += this.o.frameMs;
      if (this.belowMs >= this.o.endMs) {
        this.speaking = false;
        this.belowMs = 0;
        return 'end';
      }
    } else {
      this.belowMs = 0;
    }
    return null;
  }
}

export interface VadCallbacks {
  onStart(onsetAt: number): void;
  onEnd(): void;
  onProbability?(p: number): void;
}

/** Silero VAD on the shared microphone stream; only probabilities are used from MicVAD. */
export class LocalVad {
  readonly detector: SpeechDetector;
  private vad: MicVAD | null = null;

  constructor(opts: DetectorOptions = DEFAULT_DETECTOR) {
    this.detector = new SpeechDetector(opts);
  }

  set aiPlaying(v: boolean) {
    this.detector.aiPlaying = v;
  }

  async start(stream: MediaStream, cb: VadCallbacks): Promise<void> {
    const { MicVAD } = await import('@ricky0123/vad-web');
    this.vad = await MicVAD.new({
      model: 'v5',
      baseAssetPath: './vad/',
      onnxWASMBasePath: './vad/',
      getStream: async () => stream,
      pauseStream: async () => {},
      resumeStream: async () => stream,
      ortConfig: (ort) => {
        ort.env.wasm.numThreads = 1; // no cross-origin isolation in the WebView
      },
      onFrameProcessed: (probs) => {
        cb.onProbability?.(probs.isSpeech);
        const r = this.detector.push(probs.isSpeech, performance.now());
        if (r === 'start') cb.onStart(this.detector.onsetAt ?? performance.now());
        else if (r === 'end') cb.onEnd();
      },
      onSpeechStart: () => {},
      onSpeechEnd: () => {},
      onVADMisfire: () => {},
      onSpeechRealStart: () => {},
      startOnLoad: true,
    });
  }

  async destroy(): Promise<void> {
    await this.vad?.destroy();
    this.vad = null;
  }
}
