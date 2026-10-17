export function rms(pcm: Int16Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += pcm[i]! * pcm[i]!;
  return end > start ? Math.sqrt(sum / (end - start)) : 0;
}

/** Cuts silence before the first and after the last window whose RMS reaches `threshold`. */
export function trimSilence(pcm: Int16Array, threshold: number, windowSamples: number, padSamples: number): Int16Array {
  let first = -1;
  let last = -1;
  for (let o = 0; o < pcm.length; o += windowSamples) {
    const end = Math.min(pcm.length, o + windowSamples);
    if (rms(pcm, o, end) >= threshold) {
      if (first < 0) first = o;
      last = end;
    }
  }
  if (first < 0) return new Int16Array(0);
  return pcm.slice(Math.max(0, first - padSamples), Math.min(pcm.length, last + padSamples));
}

export function normalizePeak(pcm: Int16Array, targetPeak: number): Int16Array {
  let peak = 0;
  for (const s of pcm) peak = Math.max(peak, Math.abs(s));
  if (peak === 0) return pcm.slice();
  const g = targetPeak / peak;
  return Int16Array.from(pcm, (s) => Math.max(-32768, Math.min(32767, Math.round(s * g))));
}

export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[\s\p{P}]/gu, '');
  return norm(a) === norm(b);
}
