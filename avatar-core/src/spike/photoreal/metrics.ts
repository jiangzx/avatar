/** Content-free measurements for the photoreal spike. */
export class Metrics {
  provider = '';
  modelLoadMs = 0;
  melBuildMs = 0;
  prebufferWaitMs = 0;
  firstLipAfterAudioMs: number | null = null;
  framesShown = 0;
  repeatedFrames = 0;
  maxBehind = 0;
  inferenceCount = 0;
  inferenceTotalMs = 0;
  inferenceMaxMs = 0;
  interruptLatencyMs: number | null = null;
  lastAudioMs = 0;
  offline = false;

  recordInference(ms: number): void {
    this.inferenceCount++;
    this.inferenceTotalMs += ms;
    this.inferenceMaxMs = Math.max(this.inferenceMaxMs, ms);
  }

  onShown(audioMs: number, repeated: boolean, behind: number, hasPatch: boolean): void {
    this.framesShown++;
    if (repeated) this.repeatedFrames++;
    this.maxBehind = Math.max(this.maxBehind, behind);
    this.lastAudioMs = audioMs;
    if (hasPatch && this.firstLipAfterAudioMs === null) this.firstLipAfterAudioMs = audioMs;
  }

  interrupt(ms: number): void {
    if (this.interruptLatencyMs === null) this.interruptLatencyMs = ms;
  }

  markOffline(): void {
    this.offline = true;
  }

  toJSON(): Record<string, unknown> {
    const fps = this.lastAudioMs > 0 ? (this.framesShown * 1000) / this.lastAudioMs : 0;
    return {
      provider: this.provider,
      modelLoadMs: Math.round(this.modelLoadMs),
      melBuildMs: Math.round(this.melBuildMs),
      prebufferWaitMs: Math.round(this.prebufferWaitMs),
      firstLipAfterAudioMs: this.firstLipAfterAudioMs === null ? null : Math.round(this.firstLipAfterAudioMs),
      fps: Number(fps.toFixed(2)),
      framesShown: this.framesShown,
      repeatedFrames: this.repeatedFrames,
      maxBehind: this.maxBehind,
      inferenceCount: this.inferenceCount,
      inferenceAvgMs: this.inferenceCount === 0 ? 0 : Number((this.inferenceTotalMs / this.inferenceCount).toFixed(2)),
      inferenceMaxMs: Number(this.inferenceMaxMs.toFixed(2)),
      interruptLatencyMs: this.interruptLatencyMs === null ? null : Math.round(this.interruptLatencyMs),
      offline: this.offline,
    };
  }
}
