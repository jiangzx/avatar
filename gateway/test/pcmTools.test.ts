import { describe, expect, it } from 'vitest';
import { normalizePeak, sameText, trimSilence } from '../scripts/lib/pcm-tools.ts';

describe('pcm tools', () => {
  it('trims leading and trailing silence but keeps a pad', () => {
    const pcm = new Int16Array(4800);
    pcm.fill(5000, 2400, 3360); // 40 ms of sound at 100–140 ms
    const out = trimSilence(pcm, 300, 480, 240);
    expect(out.length).toBe(960 + 2 * 240);
    expect(out[240]).toBe(5000);
  });

  it('returns empty audio when everything is silent', () => {
    expect(trimSilence(new Int16Array(4800), 300, 480, 240).length).toBe(0);
  });

  it('normalizes the peak without clipping', () => {
    const out = normalizePeak(new Int16Array([1000, -2000, 500]), 16000);
    expect(Array.from(out)).toEqual([8000, -16000, 4000]);
  });

  it('compares transcripts ignoring punctuation and spaces', () => {
    expect(sameText('嗯，我想想。', '嗯 我想想')).toBe(true);
    expect(sameText('嗯，我想一想。', '嗯，我想想。')).toBe(false);
  });
});
