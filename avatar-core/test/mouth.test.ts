import { describe, expect, it } from 'vitest';
import { MouthAnalyzer } from '../src/audio/mouth.ts';

describe('MouthAnalyzer', () => {
  it('stays closed in silence', () => {
    const m = new MouthAnalyzer();
    const s = m.update({ rms: 0.002, zcr: 0.01 }, 16);
    expect(s).toEqual({ jawOpen: 0, funnel: 0, stretch: 0 });
  });

  it('opens with loud low-frequency sound and rounds the lips', () => {
    const m = new MouthAnalyzer();
    let s = m.update({ rms: 0.2, zcr: 0.015 }, 16);
    for (let i = 0; i < 10; i++) s = m.update({ rms: 0.2, zcr: 0.015 }, 16);
    expect(s.jawOpen).toBeGreaterThan(0.5);
    expect(s.funnel).toBeGreaterThan(s.stretch);
  });

  it('stretches the lips for bright, noisy sound', () => {
    const m = new MouthAnalyzer();
    let s = m.update({ rms: 0.2, zcr: 0.4 }, 16);
    for (let i = 0; i < 10; i++) s = m.update({ rms: 0.2, zcr: 0.4 }, 16);
    expect(s.stretch).toBeGreaterThan(s.funnel);
  });

  it('opens faster than it closes', () => {
    const m = new MouthAnalyzer();
    const opened = m.update({ rms: 0.2, zcr: 0.1 }, 16).jawOpen;
    for (let i = 0; i < 20; i++) m.update({ rms: 0.2, zcr: 0.1 }, 16);
    const full = m.update({ rms: 0.2, zcr: 0.1 }, 16).jawOpen;
    const closing = m.update({ rms: 0, zcr: 0 }, 16).jawOpen;
    expect(full - closing).toBeLessThan(opened); // one release step moves less than one attack step
    m.reset();
    expect(m.update({ rms: 0, zcr: 0 }, 16).jawOpen).toBe(0);
  });
});
