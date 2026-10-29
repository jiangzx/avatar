import { describe, expect, it } from 'vitest';
import filterbank from '../../src/spike/photoreal/mel-filterbank.json';
import { MelSpectrogram, melWindow } from '../../src/spike/photoreal/mel.ts';
import fixture from '../fixtures/photoreal/mel-fixture.json';

describe('MelSpectrogram', () => {
  it('matches the Wav2Lip reference fixture', () => {
    const pcm = Float32Array.from(fixture.pcm16, (v) => v / 32768);
    const mel = new MelSpectrogram(filterbank);
    const out = mel.process(pcm);
    expect(mel.frames).toBe(fixture.frames);
    expect(out.length).toBe(fixture.bins * fixture.frames);
    let maxDiff = 0;
    for (let i = 0; i < out.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(out[i] - fixture.mel[i]));
    }
    expect(maxDiff).toBeLessThan(1e-3);
  });

  it('rejects a filterbank whose width does not match n_fft', () => {
    expect(() => new MelSpectrogram({ bins: 80, fftBins: 400, data: Array.from({ length: 80 }, () => new Array(400).fill(0)) })).toThrow('mel');
  });
});

describe('melWindow', () => {
  const frames = 100;
  const bins = 2;
  const mel = new Float32Array(bins * frames);
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < frames; t++) mel[b * frames + t] = b * 1000 + t;
  }

  it('takes a 16-frame window at 25 fps', () => {
    const w = melWindow(mel, frames, bins, 25, 25);
    expect(w.length).toBe(32);
    expect(w[0]).toBe(80);
    expect(w[15]).toBe(95);
    expect(w[16]).toBe(1080);
    expect(w[31]).toBe(1095);
  });

  it('clamps the last window to the end of the mel', () => {
    const w = melWindow(mel, frames, bins, 99, 25);
    expect(w[0]).toBe(84);
    expect(w[15]).toBe(99);
  });

  it('zero-fills when the mel is shorter than the window', () => {
    const short = new Float32Array([1, 2, 3]);
    const w = melWindow(short, 3, 1, 0, 25, 16);
    expect(w[0]).toBe(1);
    expect(w[1]).toBe(2);
    expect(w[2]).toBe(3);
    expect(w[3]).toBe(0);
  });
});

it('logs the 1 s mel time', () => {
  const pcm = new Float32Array(16000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 220 * i) / 16000) * 0.2;
  const started = performance.now();
  new MelSpectrogram(filterbank).process(pcm);
  console.log(`mel 1s = ${(performance.now() - started).toFixed(1)} ms`);
});
