export interface MelFilterbank {
  bins: number;
  fftBins: number;
  data: number[][];
}

const N_FFT = 800;
const HOP = 200;
const WIN = 800;
const PAD = N_FFT / 2;
const FFT_BINS = N_FFT / 2 + 1; // 401
const PREEMPHASIS = 0.97;
const MIN_LEVEL_DB = -100;
const REF_LEVEL_DB = 20;
const MAX_ABS = 4;
const MIN_LEVEL = 1e-5;

/** Wav2Lip's mel front-end: pre-emphasis, reflect-padded STFT, Slaney mel, symmetric normalisation. */
export class MelSpectrogram {
  private readonly hann: Float32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly fb: Float32Array;
  private frameCount = 0;

  constructor(filterbank: MelFilterbank) {
    if (
      filterbank.bins <= 0 ||
      filterbank.fftBins !== FFT_BINS ||
      filterbank.data.length !== filterbank.bins ||
      filterbank.data.some((row) => row.length !== FFT_BINS)
    ) {
      throw new Error('mel: filterbank shape');
    }
    this.hann = new Float32Array(WIN);
    for (let n = 0; n < WIN; n++) this.hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / WIN);
    this.cos = new Float32Array(FFT_BINS * N_FFT);
    this.sin = new Float32Array(FFT_BINS * N_FFT);
    for (let k = 0; k < FFT_BINS; k++) {
      for (let n = 0; n < N_FFT; n++) {
        const angle = (2 * Math.PI * k * n) / N_FFT;
        this.cos[k * N_FFT + n] = Math.cos(angle);
        this.sin[k * N_FFT + n] = Math.sin(angle);
      }
    }
    this.fb = new Float32Array(filterbank.bins * FFT_BINS);
    for (let b = 0; b < filterbank.bins; b++) {
      for (let k = 0; k < FFT_BINS; k++) this.fb[b * FFT_BINS + k] = filterbank.data[b][k];
    }
  }

  get frames(): number {
    return this.frameCount;
  }

  process(pcm: Float32Array): Float32Array {
    if (pcm.length === 0) throw new Error('mel: empty pcm');
    const n = pcm.length;
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) y[i] = pcm[i] - (i > 0 ? PREEMPHASIS * pcm[i - 1] : 0);

    this.frameCount = 1 + Math.floor(n / HOP);
    const bins = this.fb.length / FFT_BINS;
    const out = new Float32Array(bins * this.frameCount);
    const frame = new Float32Array(N_FFT);
    const mag = new Float32Array(FFT_BINS);

    for (let t = 0; t < this.frameCount; t++) {
      const start = t * HOP - PAD;
      for (let j = 0; j < N_FFT; j++) frame[j] = reflectAt(y, start + j) * this.hann[j];

      for (let k = 0; k < FFT_BINS; k++) {
        let re = 0;
        let im = 0;
        const base = k * N_FFT;
        for (let j = 0; j < N_FFT; j++) {
          const s = frame[j];
          re += s * this.cos[base + j];
          im -= s * this.sin[base + j];
        }
        mag[k] = Math.hypot(re, im);
      }

      for (let b = 0; b < bins; b++) {
        let sum = 0;
        const base = b * FFT_BINS;
        for (let k = 0; k < FFT_BINS; k++) sum += this.fb[base + k] * mag[k];
        const db = 20 * Math.log10(Math.max(MIN_LEVEL, sum)) - REF_LEVEL_DB;
        const norm = (2 * MAX_ABS * (db - MIN_LEVEL_DB)) / -MIN_LEVEL_DB - MAX_ABS;
        out[b * this.frameCount + t] = Math.min(MAX_ABS, Math.max(-MAX_ABS, norm));
      }
    }
    return out;
  }
}

/** Takes the 16 mel frames used by one video frame, matching inference.py. */
export function melWindow(
  mel: Float32Array,
  frames: number,
  bins: number,
  frameIndex: number,
  fps: number,
  step = 16,
): Float32Array {
  if (frames <= 0 || bins <= 0 || step <= 0) throw new Error('melWindow');
  const start = Math.floor((frameIndex * 80) / fps);
  const s = Math.max(0, Math.min(start, frames - step));
  const out = new Float32Array(bins * step);
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < step; t++) {
      const src = s + t;
      if (src < frames) out[b * step + t] = mel[b * frames + src];
    }
  }
  return out;
}

function reflectAt(y: Float32Array, index: number): number {
  const n = y.length;
  if (n === 0) return 0;
  if (n === 1) return y[0];
  let i = index;
  while (i < 0 || i >= n) {
    if (i < 0) i = -i;
    if (i >= n) i = 2 * (n - 1) - i;
  }
  return y[i];
}
