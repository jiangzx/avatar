# Task 3: mel 前端与 Python 基准

**Files:**
- Create: `avatar-core/src/spike/photoreal/mel.ts`
- Create: `avatar-core/test/photoreal/mel.test.ts`
- Consume: `avatar-core/src/spike/photoreal/mel-filterbank.json`（T1 生成）
- Consume: `avatar-core/test/fixtures/photoreal/mel-fixture.json`（T1 生成）

**Interfaces:**
- Consumes: `MelFilterbank`（`{ bins: number; fftBins: number; data: number[][] }`）。
- Produces:
  - `class MelSpectrogram { constructor(filterbank: MelFilterbank); process(pcm16k: Float32Array): Float32Array; get frames(): number }`
  - `melWindow(mel: Float32Array, frames: number, bins: number, frameIndex: number, fps: number, step?: number): Float32Array`

背景：Wav2Lip 的 mel 前端是 `preemphasis(0.97)` → `librosa.stft(n_fft=800, hop=200, win=800, center=True, pad_mode='reflect', hann periodic)` → `|D|` → 80 带 Slaney mel → `20log10(max(1e-5, ·)) - 20` → 对称归一化到 [-4, 4]。T1 的 `make_mel_fixture.py` 用 Wav2Lip 的 `audio.py` 生成基准；本任务用 TS 直接 DFT 复刻，测试对齐到 1e-3。直接 DFT 不是最终性能优化；先证明数值正确，T7 再决定是否换混合基 FFT。

- [ ] **Step 1: 写失败测试**

`avatar-core/test/photoreal/mel.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w avatar-core -- test/photoreal/mel.test.ts
```

Expected: FAIL，报 `mel.ts` 不存在，或 `mel-filterbank.json`/`mel-fixture.json` 未生成。

如果 JSON 未生成：先回 T1 的 Step 12 跑资产脚本；不要把 JSON 手写或复制来源不明的文件。

- [ ] **Step 3: 写实现**

`avatar-core/src/spike/photoreal/mel.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w avatar-core -- test/photoreal/mel.test.ts
```

Expected: PASS，2 个 describe、5 项通过；最大误差 < 1e-3。

如果 fixture 对齐失败，先确认 T1 的 `make_mel_fixture.py` 已强制 `pad_mode='reflect'`，并且 fixture 的 `pcm16` 是先量化再算 mel。不要通过放宽容差来掩盖 padding/window 错误。

- [ ] **Step 5: 记录一次 1 秒 mel 的耗时（不进断言）**

在测试文件末尾加一个 `it('logs the 1 s mel time', ...)`：

```ts
it('logs the 1 s mel time', () => {
  const pcm = new Float32Array(16000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 220 * i) / 16000) * 0.2;
  const started = performance.now();
  new MelSpectrogram(filterbank).process(pcm);
  console.log(`mel 1s = ${(performance.now() - started).toFixed(1)} ms`);
});
```

```bash
npm test -w avatar-core -- test/photoreal/mel.test.ts
```

Expected: PASS；输出 `mel 1s = ... ms`。把数值记进 T7 报告。如果 > 1000 ms，不改容差；T7 决定优化或把 mel 预计算进页面加载时间。

- [ ] **Step 6: 回归与提交**

```bash
npm test -w avatar-core
npm run typecheck -w avatar-core
```

Expected: 全量通过；typecheck 无输出。

```bash
git add avatar-core/src/spike/photoreal/mel.ts \
  avatar-core/test/photoreal/mel.test.ts
git commit -m "feat(photoreal): add the Wav2Lip mel front-end"
```

注意：`mel-filterbank.json` 和 `mel-fixture.json` 已在 T1 提交；本任务不再重复添加。
