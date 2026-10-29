import type { AudioClock } from './audioClock.ts';

export interface InterruptedAt {
  frame: number;
  playedMs: number;
}

/** Freezes the visible frame and reports how much real audio was heard. */
export function interruptedAt(clock: AudioClock, ctxTime: number, totalFrames: number): InterruptedAt {
  if (!Number.isInteger(totalFrames) || totalFrames <= 0) throw new Error('totalFrames');
  // Round to whole ms: ctxTime arithmetic can land just below a frame boundary.
  const playedMs = Math.round(clock.mediaMsAt(ctxTime));
  const frame = Math.max(0, Math.min(totalFrames - 1, clock.frameAt(ctxTime)));
  return { frame, playedMs };
}
