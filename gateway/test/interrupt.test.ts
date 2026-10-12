import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterruptCoordinator, type CancelSource } from '../src/session/interrupt.ts';

function make() {
  const cancels: Array<[number, CancelSource]> = [];
  const c = new InterruptCoordinator({ confirmWindowMs: 300, cancel: (seq, src) => cancels.push([seq, src]) });
  return { c, cancels };
}

describe('InterruptCoordinator', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('cancels immediately when the client reports an interruption', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onClientInterrupted(1);
    expect(cancels).toEqual([[1, 'local']]);
    expect(c.isCancelled(1)).toBe(true);
    expect(c.active).toBeNull();
  });

  it('ignores interruptions for responses that are not active', () => {
    const { c, cancels } = make();
    c.onResponseStart(2);
    c.onClientInterrupted(1);
    expect(cancels).toEqual([]);
  });

  it('cancels on model speech when local VAD already hears the user', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onLocalVad(true);
    c.onModelSpeechStarted();
    expect(cancels).toEqual([[1, 'model']]);
  });

  it('waits for local confirmation within the window', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onModelSpeechStarted();
    expect(cancels).toEqual([]);
    vi.advanceTimersByTime(200);
    c.onLocalVad(true);
    expect(cancels).toEqual([[1, 'model']]);
  });

  it('ignores model-only speech (likely echo) after the window', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onModelSpeechStarted();
    vi.advanceTimersByTime(301);
    c.onLocalVad(true);
    expect(cancels).toEqual([]);
    expect(c.active).toBe(1);
  });

  it('does nothing on model speech when no response is active', () => {
    const { c, cancels } = make();
    c.onModelSpeechStarted();
    c.onLocalVad(true);
    expect(cancels).toEqual([]);
  });

  it('counts model auto-cancels without local speech as false interruptions', () => {
    const { c } = make();
    c.onResponseStart(1);
    expect(c.onModelAutoCancelled(1)).toBe(true);
    expect(c.falseInterruptions).toBe(1);
    expect(c.onModelAutoCancelled(1)).toBe(false);
    c.onResponseStart(2);
    c.onLocalVad(true);
    c.onModelAutoCancelled(2);
    expect(c.falseInterruptions).toBe(1);
  });

  it('cancels each response at most once', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onClientInterrupted(1);
    c.cancelActive('local');
    c.onClientInterrupted(1);
    expect(cancels).toHaveLength(1);
  });

  it('clears the active response when playback finishes', () => {
    const { c, cancels } = make();
    c.onResponseStart(1);
    c.onResponseFinished(1);
    c.onClientInterrupted(1);
    expect(c.active).toBeNull();
    expect(cancels).toEqual([]);
  });

  it('reports a still-playing response superseded by a new one, without cancelling the model', () => {
    const { c, cancels } = make();
    expect(c.onResponseStart(1)).toBeNull();
    expect(c.onResponseStart(2)).toBe(1);
    expect(c.isCancelled(1)).toBe(true);
    expect(c.active).toBe(2);
    expect(cancels).toEqual([]);
    c.onResponseFinished(2);
    expect(c.onResponseStart(3)).toBeNull();
  });
});
