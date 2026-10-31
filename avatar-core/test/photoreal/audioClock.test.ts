import { describe, expect, it } from 'vitest';
import { AudioClock } from '../../src/spike/photoreal/audioClock.ts';

describe('AudioClock', () => {
  it('returns -1 before start', () => {
    const clock = new AudioClock(25);
    expect(clock.started).toBe(false);
    expect(clock.frameAt(10)).toBe(-1);
    expect(clock.mediaMsAt(10)).toBe(0);
  });

  it('maps context time to media time and frames', () => {
    const clock = new AudioClock(25);
    clock.start(10);
    expect(clock.frameAt(10)).toBe(0);
    expect(clock.frameAt(10.039)).toBe(0);
    expect(clock.frameAt(10.04)).toBe(1);
    expect(clock.frameAt(11)).toBe(25);
    expect(clock.mediaMsAt(10.5)).toBe(500);
  });

  it('clamps a context time before the start to zero', () => {
    const clock = new AudioClock(25);
    clock.start(10);
    expect(clock.mediaMsAt(9.5)).toBe(0);
    expect(clock.frameAt(9.5)).toBe(0);
  });

  it('resets back to the unstarted state', () => {
    const clock = new AudioClock(25);
    clock.start(10);
    clock.reset();
    expect(clock.started).toBe(false);
    expect(clock.frameAt(10)).toBe(-1);
  });

  it('rejects a bad fps', () => {
    expect(() => new AudioClock(0)).toThrow('fps');
    expect(() => new AudioClock(Number.NaN)).toThrow('fps');
  });
});
