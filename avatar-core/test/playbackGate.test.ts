import { describe, expect, it } from 'vitest';
import { PlaybackGate } from '../src/audio/playbackGate.ts';

describe('PlaybackGate', () => {
  it('accepts only the active response', () => {
    const g = new PlaybackGate();
    expect(g.accepts(1)).toBe(false);
    g.start(1);
    expect(g.accepts(1)).toBe(true);
    expect(g.accepts(2)).toBe(false);
    g.start(2);
    expect(g.accepts(1)).toBe(false);
    expect(g.accepts(2)).toBe(true);
  });

  it('never accepts a cancelled response again', () => {
    const g = new PlaybackGate();
    g.start(3);
    g.cancel(3);
    expect(g.active).toBeNull();
    g.start(3);
    expect(g.accepts(3)).toBe(false);
  });

  it('finish clears only the matching response', () => {
    const g = new PlaybackGate();
    g.start(4);
    g.finish(5);
    expect(g.active).toBe(4);
    g.finish(4);
    expect(g.active).toBeNull();
  });

  it('after resume, rejects everything up to the last server sequence', () => {
    const g = new PlaybackGate();
    g.start(5);
    g.resetBelow(5);
    expect(g.active).toBeNull();
    g.start(5);
    expect(g.accepts(5)).toBe(false);
    g.start(6);
    expect(g.accepts(6)).toBe(true);
  });

  it('reset() forgets everything so a new session can reuse sequence numbers', () => {
    const g = new PlaybackGate();
    g.start(2);
    g.cancel(2);
    g.resetBelow(3);
    g.reset();
    g.start(2);
    expect(g.accepts(2)).toBe(true);
  });
});
