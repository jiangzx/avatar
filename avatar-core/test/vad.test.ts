import { describe, expect, it } from 'vitest';
import { LocalVad, SpeechDetector } from '../src/audio/vad.ts';

const opts = { frameMs: 32, threshold: 0.5, bargeInThreshold: 0.75, startMs: 150, endMs: 600, hysteresis: 0.15 };

function feed(d: SpeechDetector, p: number, frames: number, t0: number) {
  const events: Array<{ e: string; t: number }> = [];
  for (let i = 0; i < frames; i++) {
    const t = t0 + i * 32;
    const r = d.push(p, t);
    if (r) events.push({ e: r, t });
  }
  return events;
}

describe('SpeechDetector', () => {
  it('starts after sustained speech and records the onset time', () => {
    const d = new SpeechDetector(opts);
    const ev = feed(d, 0.9, 6, 1000);
    expect(ev).toEqual([{ e: 'start', t: 1000 + 4 * 32 }]); // 5 frames × 32 ms = 160 ms
    expect(d.onsetAt).toBe(1000);
    expect(d.speaking).toBe(true);
  });

  it('ends after sustained silence below threshold minus hysteresis', () => {
    const d = new SpeechDetector(opts);
    feed(d, 0.9, 6, 0);
    expect(feed(d, 0.4, 10, 1000)).toEqual([]); // 0.4 is not below 0.35
    const ev = feed(d, 0.1, 20, 2000);
    expect(ev).toEqual([{ e: 'end', t: 2000 + 18 * 32 }]); // 19 frames × 32 ms = 608 ms
    expect(d.speaking).toBe(false);
  });

  it('requires a higher probability while the AI is playing', () => {
    const d = new SpeechDetector(opts);
    d.aiPlaying = true;
    expect(feed(d, 0.6, 10, 0)).toEqual([]);
    expect(feed(d, 0.8, 6, 1000).map((x) => x.e)).toEqual(['start']);
  });

  it('a single dip resets the start counter', () => {
    const d = new SpeechDetector(opts);
    feed(d, 0.9, 4, 0);
    feed(d, 0.1, 1, 128);
    expect(feed(d, 0.9, 4, 160)).toEqual([]);
    expect(d.speaking).toBe(false);
  });

  it('reset clears speaking and pending start state', () => {
    const d = new SpeechDetector(opts);
    feed(d, 0.9, 4, 0); // candidate pending, one frame short of start
    d.reset();
    expect(feed(d, 0.9, 1, 128)).toEqual([]);
    expect(d.speaking).toBe(false);
    expect(d.onsetAt).toBeNull();
  });
});

describe('LocalVad.destroy', () => {
  function vadWithCounter() {
    const v = new LocalVad(opts);
    const calls = { end: 0 };
    v.callbacks = { onStart: () => {}, onEnd: () => calls.end++ };
    return { v, calls };
  }

  it('emits exactly one end when destroyed mid-speech', async () => {
    const { v, calls } = vadWithCounter();
    feed(v.detector, 0.9, 6, 0);
    expect(v.detector.speaking).toBe(true);
    await v.destroy();
    await v.destroy();
    expect(calls.end).toBe(1);
    expect(v.detector.speaking).toBe(false);
  });

  it('emits nothing when destroyed while silent', async () => {
    const { v, calls } = vadWithCounter();
    await v.destroy();
    expect(calls.end).toBe(0);
  });
});
