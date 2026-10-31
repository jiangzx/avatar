import { describe, expect, it } from 'vitest';
import { AudioClock } from '../../src/spike/photoreal/audioClock.ts';
import { interruptedAt } from '../../src/spike/photoreal/interrupt.ts';

describe('interruptedAt', () => {
  it('returns frame 0 and 0 ms before start', () => {
    const clock = new AudioClock(25);
    expect(interruptedAt(clock, 10, 250)).toEqual({ frame: 0, playedMs: 0 });
  });

  it('freezes the frame and reports played media time', () => {
    const clock = new AudioClock(25);
    clock.start(10);
    expect(interruptedAt(clock, 12.04, 250)).toEqual({ frame: 51, playedMs: 2040 });
  });

  it('clamps past the last frame', () => {
    const clock = new AudioClock(25);
    clock.start(10);
    expect(interruptedAt(clock, 40, 250)).toEqual({ frame: 249, playedMs: 30_000 });
  });

  it('rejects an empty clip', () => {
    const clock = new AudioClock(25);
    expect(() => interruptedAt(clock, 10, 0)).toThrow('totalFrames');
  });
});
