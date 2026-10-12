import { AI_SAMPLE_RATE, truncateByPlayback } from '@anyidea/protocol';

/** Keeps assistant subtitles in step with what the user actually heard. */
export class SubtitleTracker {
  private readonly text = new Map<number, string>();
  private readonly audioMs = new Map<number, number>();
  private readonly frozen = new Set<number>();

  onDelta(seq: number, delta: string): string | null {
    if (this.frozen.has(seq)) return null;
    const next = (this.text.get(seq) ?? '') + delta;
    this.text.set(seq, next);
    return next;
  }

  onAudio(seq: number, samples24k: number): void {
    this.audioMs.set(seq, (this.audioMs.get(seq) ?? 0) + (samples24k / AI_SAMPLE_RATE) * 1000);
  }

  truncate(seq: number, playedMs: number): string {
    if (this.frozen.has(seq)) return this.text.get(seq) ?? '';
    this.frozen.add(seq);
    const cut = truncateByPlayback(this.text.get(seq) ?? '', playedMs, this.audioMs.get(seq) ?? 0);
    this.text.set(seq, cut);
    return cut;
  }

  /** New gateway session: sequence numbers start again from 1. */
  reset(): void {
    this.text.clear();
    this.audioMs.clear();
    this.frozen.clear();
  }
}
