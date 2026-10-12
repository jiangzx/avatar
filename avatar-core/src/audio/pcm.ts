export function int16ToFloat32(src: Int16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] / 32768;
  return out;
}

export function float32ToInt16(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

export function rmsInt16(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

/** Streaming linear-interpolation resampler; keeps phase across chunks. */
export class LinearResampler {
  private readonly step: number;
  private pos = 0;
  private prev = 0;

  constructor(readonly inRate: number, readonly outRate: number) {
    this.step = inRate / outRate;
  }

  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input.slice();
    const n = input.length;
    if (n === 0) return new Float32Array(0);
    const out: number[] = [];
    // pos is relative to input[0]; a negative pos interpolates between the previous chunk's last sample and input[0].
    while (this.pos <= n - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i < 0 ? this.prev : input[i];
      const b = i + 1 < n ? input[i + 1] : a;
      out.push(a + (b - a) * frac);
      this.pos += this.step;
    }
    this.pos -= n;
    this.prev = input[n - 1];
    return Float32Array.from(out);
  }
}

export class FrameChunker {
  private readonly buf: Int16Array;
  private len = 0;

  constructor(private readonly frameSamples: number) {
    this.buf = new Int16Array(frameSamples);
  }

  push(samples: Int16Array): Int16Array[] {
    const frames: Int16Array[] = [];
    let off = 0;
    while (off < samples.length) {
      const take = Math.min(this.frameSamples - this.len, samples.length - off);
      this.buf.set(samples.subarray(off, off + take), this.len);
      this.len += take;
      off += take;
      if (this.len === this.frameSamples) {
        frames.push(this.buf.slice());
        this.len = 0;
      }
    }
    return frames;
  }
}

export interface AudioFeatures {
  rms: number;
  /** Zero crossings per sample, 0..1. */
  zcr: number;
}

export function computeFeatures(frame: Float32Array): AudioFeatures {
  if (frame.length === 0) return { rms: 0, zcr: 0 };
  let sum = 0;
  let crossings = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i];
    if (i > 0 && frame[i] >= 0 !== frame[i - 1] >= 0) crossings++;
  }
  return { rms: Math.sqrt(sum / frame.length), zcr: frame.length > 1 ? crossings / (frame.length - 1) : 0 };
}
