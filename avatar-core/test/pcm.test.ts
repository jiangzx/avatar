import { describe, expect, it } from 'vitest';
import { FrameChunker, LinearResampler, computeFeatures, float32ToInt16, int16ToFloat32, rmsInt16 } from '../src/audio/pcm.ts';

describe('sample conversion', () => {
  it('round-trips int16 ↔ float32 with clipping', () => {
    expect(Array.from(float32ToInt16(Float32Array.from([0, 1, -1, 2, -2])))).toEqual([0, 32767, -32768, 32767, -32768]);
    const back = int16ToFloat32(Int16Array.from([16384, -16384]));
    expect(back[0]).toBeCloseTo(0.5);
    expect(back[1]).toBeCloseTo(-0.5);
  });
  it('computes RMS', () => {
    expect(rmsInt16(new Int16Array(0))).toBe(0);
    expect(rmsInt16(Int16Array.from([3, -3, 3, -3]))).toBe(3);
  });
});

describe('LinearResampler', () => {
  it('downsamples 48k → 16k across chunks with the right length', () => {
    const r = new LinearResampler(48000, 16000);
    let total = 0;
    for (let i = 0; i < 10; i++) total += r.process(new Float32Array(480).fill(0.25)).length;
    expect(Math.abs(total - 1600)).toBeLessThanOrEqual(1);
  });
  it('keeps a constant signal constant', () => {
    const r = new LinearResampler(44100, 16000);
    const out = [...r.process(new Float32Array(441).fill(0.5)), ...r.process(new Float32Array(441).fill(0.5))];
    expect(out.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });
  it('is a copy when rates match', () => {
    const r = new LinearResampler(24000, 24000);
    const input = Float32Array.from([1, 2, 3]);
    const out = r.process(input);
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(out).not.toBe(input);
  });
  it('upsamples 24k → 48k by interpolation', () => {
    const r = new LinearResampler(24000, 48000);
    expect(Array.from(r.process(Float32Array.from([0, 1, 0])))).toEqual([0, 0.5, 1, 0.5, 0]);
  });
});

describe('FrameChunker', () => {
  it('emits fixed-size frames and carries the remainder', () => {
    const c = new FrameChunker(4);
    expect(c.push(Int16Array.from([1, 2, 3]))).toEqual([]);
    const frames = c.push(Int16Array.from([4, 5, 6, 7, 8, 9]));
    expect(frames.map((f) => Array.from(f))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    expect(c.push(Int16Array.from([10, 11, 12])).map((f) => Array.from(f))).toEqual([[9, 10, 11, 12]]);
  });
});

describe('computeFeatures', () => {
  it('reports rms and zero-crossing rate', () => {
    const f = computeFeatures(Float32Array.from([0.5, -0.5, 0.5, -0.5]));
    expect(f.rms).toBeCloseTo(0.5);
    expect(f.zcr).toBeCloseTo(1);
    expect(computeFeatures(new Float32Array(4)).rms).toBe(0);
  });
});
