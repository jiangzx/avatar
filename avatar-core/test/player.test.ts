import { describe, expect, it } from 'vitest';
import { PlaybackController } from '../src/audio/player.ts';

describe('PlaybackController.push', () => {
  it('drops zero-length frames (the worklet would read undefined samples)', () => {
    const noop = () => {};
    const p = new PlaybackController({ onFirstAudio: noop, onEnded: noop, onStopped: noop, onProgress: noop, onLevel: noop });
    const posted: unknown[] = [];
    // No AudioContext in node: stand in for the worklet node's port.
    (p as unknown as { node: unknown }).node = { port: { postMessage: (m: unknown) => posted.push(m) } };
    p.onResponseStart(1);
    p.push(1, new Int16Array(0));
    expect(posted).toEqual([]);
    p.push(1, new Int16Array(4));
    expect(posted).toHaveLength(1);
  });
});
