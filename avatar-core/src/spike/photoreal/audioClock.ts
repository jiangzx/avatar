/** Maps AudioContext.currentTime to media time and 25 fps frame indices. */
export class AudioClock {
  private startedAt: number | null = null;

  constructor(readonly fps: number) {
    if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps');
  }

  start(ctxTime: number): void {
    if (!Number.isFinite(ctxTime)) throw new Error('ctxTime');
    this.startedAt = ctxTime;
  }

  reset(): void {
    this.startedAt = null;
  }

  get started(): boolean {
    return this.startedAt !== null;
  }

  mediaMsAt(ctxTime: number): number {
    if (this.startedAt === null) return 0;
    return Math.max(0, (ctxTime - this.startedAt) * 1000);
  }

  frameAt(ctxTime: number): number {
    if (this.startedAt === null) return -1;
    // Tiny epsilon absorbs float noise at exact frame boundaries (e.g. 40 ms at 25 fps).
    return Math.floor((this.mediaMsAt(ctxTime) * this.fps) / 1000 + 1e-9);
  }
}
