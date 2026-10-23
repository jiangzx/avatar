import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushGate, type PushRequest } from '../src/session/pushGate.ts';

function gate(minIntervalMs = 0) {
  let open = true;
  const sent: PushRequest[] = [];
  const g = new PushGate({
    seamOpen: () => open,
    send: (update) => sent.push(update),
    now: () => Date.now(),
    minIntervalMs,
  });
  return { g, sent, setOpen: (value: boolean) => { open = value; } };
}

describe('PushGate', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends at once when the seam is open', () => {
    const { g, sent } = gate();
    g.request({ instructions: true });
    expect(sent).toEqual([{ instructions: true }]);
    expect(g.hasPending).toBe(false);
  });

  it('holds while the seam is closed and sends on the next flush', () => {
    const { g, sent, setOpen } = gate();
    setOpen(false);
    g.request({ instructions: true });
    g.flush();
    expect(sent).toEqual([]);
    expect(g.hasPending).toBe(true);
    setOpen(true);
    g.flush();
    expect(sent).toEqual([{ instructions: true }]);
    expect(g.hasPending).toBe(false);
  });

  it('merges requests into one update and keeps the latest voice', () => {
    const { g, sent, setOpen } = gate();
    setOpen(false);
    g.request({ voice: { value: 'voice-en' } });
    g.request({ instructions: true });
    g.request({ voice: { value: 'voice-zh' } });
    setOpen(true);
    g.flush();
    expect(sent).toEqual([{ instructions: true, voice: { value: 'voice-zh' } }]);
  });

  it('keeps an explicit default voice as a voice change', () => {
    const { g, sent } = gate();
    g.request({ voice: { value: undefined } });
    expect(sent).toHaveLength(1);
    expect('voice' in sent[0]!).toBe(true);
    expect(sent[0]!.voice).toEqual({ value: undefined });
  });

  it('ignores an empty request', () => {
    const { g, sent } = gate();
    g.request({});
    expect(sent).toEqual([]);
    expect(g.hasPending).toBe(false);
  });

  it('sends at most once per user turn', () => {
    const { g, sent } = gate();
    g.request({ instructions: true });
    g.request({ voice: { value: 'voice-zh' } });
    expect(sent).toHaveLength(1);
    expect(g.hasPending).toBe(true);
    g.onUserFinal();
    expect(sent).toHaveLength(1); // a new turn only lifts the cap; it does not flush
    g.flush();
    expect(sent).toEqual([{ instructions: true }, { voice: { value: 'voice-zh' } }]);
  });

  it('waits out the minimum interval and then flushes by itself', async () => {
    const { g, sent } = gate(1_000);
    g.request({ instructions: true });
    g.onUserFinal();
    await vi.advanceTimersByTimeAsync(300);
    g.request({ instructions: true });
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(699);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
  });

  it('checks the seam again when the interval timer fires', async () => {
    const { g, sent, setOpen } = gate(1_000);
    g.request({ instructions: true });
    g.onUserFinal();
    g.request({ instructions: true });
    setOpen(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(1);
    expect(g.hasPending).toBe(true);
    setOpen(true);
    g.flush();
    expect(sent).toHaveLength(2);
  });

  it('drops pending work on clearPending and lets the fresh session take one push', () => {
    const { g, sent, setOpen } = gate();
    g.request({ instructions: true });
    setOpen(false);
    g.request({ voice: { value: 'voice-zh' } });
    g.clearPending();
    expect(g.hasPending).toBe(false);
    setOpen(true);
    g.flush();
    expect(sent).toHaveLength(1);
    g.request({ instructions: true });
    expect(sent).toHaveLength(2);
  });

  it('never sends after dispose', async () => {
    const { g, sent } = gate(1_000);
    g.request({ instructions: true });
    g.onUserFinal();
    g.request({ instructions: true });
    g.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    g.request({ instructions: true });
    g.flush();
    expect(sent).toHaveLength(1);
    expect(g.hasPending).toBe(false);
  });
});
