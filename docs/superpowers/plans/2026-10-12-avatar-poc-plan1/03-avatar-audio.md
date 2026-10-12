# Plan 1 · 03 avatar-core 音频与网络（Task 9–12）

> 先读 [00-overview.md](00-overview.md) 的 Global Constraints。浏览器 API（AudioContext、AudioWorklet、getUserMedia、MicVAD）相关代码无法在 vitest/node 中运行：**纯逻辑拆到独立模块做单元测试，浏览器胶水代码在 Task 14 用桌面 Chrome 手动验证。**

---

### Task 9: avatar-core 骨架与纯音频工具（PCM、口型、能量触发）

**Files:**
- Create: `avatar-core/package.json`, `avatar-core/tsconfig.json`, `avatar-core/vite.config.ts`, `avatar-core/index.html`, `avatar-core/src/main.ts`（占位）, `avatar-core/.env.example`, `avatar-core/scripts/copy-vad-assets.mjs`, `avatar-core/src/types/audioworklet.d.ts`, `avatar-core/src/audio/pcm.ts`, `avatar-core/src/audio/mouth.ts`, `avatar-core/src/audio/energy.ts`
- Test: `avatar-core/test/pcm.test.ts`, `avatar-core/test/mouth.test.ts`, `avatar-core/test/energy.test.ts`

**Depends on:** Task 1，且在 Task 2 提交之后开始（两者都 `npm install`，会同时改 `package-lock.json`）。完成后 Task 10–13 可以并行。

**Interfaces:**
- Produces:
  - `int16ToFloat32(src: Int16Array): Float32Array`、`float32ToInt16(src: Float32Array): Int16Array`、`rmsInt16(pcm: Int16Array): number`
  - `class LinearResampler(inRate, outRate)`：`process(input: Float32Array): Float32Array`（流式，跨块保持相位）
  - `class FrameChunker(frameSamples)`：`push(samples: Int16Array): Int16Array[]`
  - `interface AudioFeatures { rms: number; zcr: number }`、`computeFeatures(frame: Float32Array): AudioFeatures`
  - `interface MouthShape { jawOpen: number; funnel: number; stretch: number }`、`class MouthAnalyzer(opts?)`：`update(features, dtMs): MouthShape`、`reset()`
  - `class EnergyTrigger(thresholdRms = 1200, minMs = 150, frameMs = 20)`：`push(frame: Int16Array): boolean`、`count`

- [x] **Step 1: 包与构建配置**

`avatar-core/package.json`（`three` 必须固定 0.180.x，与 TalkingHead 依赖 `^0.180.0` 去重，避免打包两份 three）:

```json
{
  "name": "@anyidea/avatar-core",
  "private": true,
  "type": "module",
  "scripts": {
    "assets": "node scripts/copy-vad-assets.mjs",
    "dev": "npm run assets && vite",
    "build": "npm run assets && vite build",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@anyidea/protocol": "*",
    "@met4citizen/talkinghead": "1.7.0",
    "@ricky0123/vad-web": "0.0.31",
    "onnxruntime-web": "1.30.0",
    "three": "0.180.0"
  },
  "devDependencies": {
    "@types/three": "0.180.0",
    "typescript": "7.0.2",
    "vite": "8.3.4",
    "vitest": "5.0.3"
  }
}
```

`avatar-core/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

`avatar-core/vite.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 }, // loopback only: the dev page is opened on this machine
  optimizeDeps: { exclude: ['onnxruntime-web', '@ricky0123/vad-web'] },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: { input: { main: 'index.html' } }, // Task 17 adds the spike page
  },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
```

`avatar-core/.env.example`（只在 `vite dev` 桌面调试时读取；生产构建不使用）:

```
# Copy to .env.local (git-ignored). Desktop debugging only.
VITE_GATEWAY_URL=http://127.0.0.1:8787
VITE_APP_SECRET=same-as-gateway-APP_SECRET
```

`avatar-core/index.html`（占位，Task 14 补全 UI）:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>avatar-core</title>
    <style>
      html, body { margin: 0; height: 100%; background: #10131a; overflow: hidden; }
      #avatar { position: fixed; inset: 0; }
    </style>
  </head>
  <body>
    <div id="avatar"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`avatar-core/src/main.ts`（占位，保证 Task 14 之前 `vite build` 也能成功，Task 17 的 spike 页面因此不必等 Task 14；Task 14 整体替换）:

```ts
// Placeholder entry; replaced by the real app wiring in Task 14.
export {};
```

`avatar-core/scripts/copy-vad-assets.mjs`（文件名已按 vad-web 0.0.31 包内容核实）:

```js
// Copies Silero VAD + onnxruntime-web runtime files into public/vad so they are served same-origin.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(pkgRoot, 'public', 'vad');
mkdirSync(out, { recursive: true });

function findDist(pkg) {
  for (const base of [join(pkgRoot, 'node_modules'), join(pkgRoot, '..', 'node_modules')]) {
    const dist = join(base, pkg, 'dist');
    if (existsSync(dist)) return dist;
  }
  throw new Error(`Cannot find ${pkg}/dist; run npm install at the repo root`);
}

const vadDist = findDist('@ricky0123/vad-web');
for (const f of ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx', 'silero_vad_legacy.onnx']) {
  cpSync(join(vadDist, f), join(out, f));
}
const ortDist = findDist('onnxruntime-web');
const ortFiles = readdirSync(ortDist).filter((f) => /^ort-wasm.*\.(wasm|mjs)$/.test(f));
for (const f of ortFiles) cpSync(join(ortDist, f), join(out, f));
console.log(`copied ${3 + ortFiles.length} VAD assets to public/vad`);
```

`avatar-core/src/types/audioworklet.d.ts`:

```ts
// Minimal AudioWorkletGlobalScope declarations (TS ships no "audioworklet" lib).
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;
```

```bash
npm install
npm run assets -w avatar-core
ls avatar-core/public/vad
```

Expected: 打印 `copied N VAD assets`；目录里有 `vad.worklet.bundle.min.js`、`silero_vad_v5.onnx` 和若干 `ort-wasm*.wasm/.mjs`。`npm ls three` 只出现一个 `three@0.180.0`（deduped）。

- [x] **Step 2: 写失败的测试**

`avatar-core/test/pcm.test.ts`:

```ts
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
```

`avatar-core/test/mouth.test.ts`:

```ts
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
```

`avatar-core/test/energy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EnergyTrigger } from '../src/audio/energy.ts';

const loud = () => new Int16Array(320).fill(2000);
const quiet = () => new Int16Array(320);

describe('EnergyTrigger', () => {
  it('fires once per sustained loud segment', () => {
    const t = new EnergyTrigger(1200, 150, 20);
    const fired: boolean[] = [];
    for (let i = 0; i < 20; i++) fired.push(t.push(loud()));
    expect(fired.filter(Boolean)).toHaveLength(1);
    expect(fired.indexOf(true)).toBe(7); // 8 frames × 20 ms = 160 ms ≥ 150 ms
    t.push(quiet());
    for (let i = 0; i < 8; i++) t.push(loud());
    expect(t.count).toBe(2);
  });

  it('ignores short bursts', () => {
    const t = new EnergyTrigger(1200, 150, 20);
    for (let k = 0; k < 5; k++) {
      for (let i = 0; i < 5; i++) t.push(loud());
      t.push(quiet());
    }
    expect(t.count).toBe(0);
  });
});
```

- [x] **Step 3: 运行测试确认失败**

Run: `npm test -w avatar-core`
Expected: FAIL，无法解析 `../src/audio/pcm.ts` 等模块。

- [x] **Step 4: 实现**

`avatar-core/src/audio/pcm.ts`:

```ts
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
```

`avatar-core/src/audio/mouth.ts`:

```ts
import type { AudioFeatures } from './pcm.ts';

export interface MouthShape {
  jawOpen: number;
  /** Rounded lips (o/u). */
  funnel: number;
  /** Spread lips (i/e, fricatives). */
  stretch: number;
}

export interface MouthOptions {
  noiseFloor: number;
  gain: number;
  attackMs: number;
  releaseMs: number;
}

/** TUNABLE (estimates), tuned on device in Task 18. */
export const DEFAULT_MOUTH: MouthOptions = { noiseFloor: 0.01, gain: 6, attackMs: 30, releaseMs: 80 };

// TUNABLE: zcr band mapped to "bright" (spread lips) and "dark" (rounded lips).
export const ZCR_BRIGHT_START = 0.08;
export const ZCR_BRIGHT_RANGE = 0.12;
export const ZCR_DARK_START = 0.06;
export const ZCR_DARK_RANGE = 0.04;
// TUNABLE: mouth-shape gains applied to the smoothed jaw level.
export const JAW_OPEN_GAIN = 0.7;
export const FUNNEL_GAIN = 0.6;
export const STRETCH_GAIN = 0.5;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Approximate Mandarin lip-sync from loudness and brightness of the audio being played. */
export class MouthAnalyzer {
  private jaw = 0;

  constructor(private readonly o: MouthOptions = DEFAULT_MOUTH) {}

  update(f: AudioFeatures, dtMs: number): MouthShape {
    const target = clamp01((f.rms - this.o.noiseFloor) * this.o.gain);
    const tau = target > this.jaw ? this.o.attackMs : this.o.releaseMs;
    this.jaw += (target - this.jaw) * (1 - Math.exp(-dtMs / tau));
    if (this.jaw < 1e-4) this.jaw = 0;
    const bright = clamp01((f.zcr - ZCR_BRIGHT_START) / ZCR_BRIGHT_RANGE);
    const dark = clamp01((ZCR_DARK_START - f.zcr) / ZCR_DARK_RANGE);
    return { jawOpen: this.jaw * JAW_OPEN_GAIN, funnel: this.jaw * dark * FUNNEL_GAIN, stretch: this.jaw * bright * STRETCH_GAIN };
  }

  reset(): void {
    this.jaw = 0;
  }
}
```

`avatar-core/src/audio/energy.ts`:

```ts
import { rmsInt16 } from './pcm.ts';

// TUNABLE: defaults for the AEC spike energy trigger.
export const ENERGY_THRESHOLD_RMS = 1200;
export const ENERGY_MIN_MS = 150;
export const ENERGY_FRAME_MS = 20;

/** Counts sustained loud segments. Used by the AEC spike to compare capture paths A and B. */
export class EnergyTrigger {
  count = 0;
  private aboveMs = 0;
  private armed = true;

  constructor(
    private readonly thresholdRms = ENERGY_THRESHOLD_RMS,
    private readonly minMs = ENERGY_MIN_MS,
    private readonly frameMs = ENERGY_FRAME_MS,
  ) {}

  /** Returns true when a new trigger fires; re-arms after a quiet frame. */
  push(frame: Int16Array): boolean {
    if (rmsInt16(frame) >= this.thresholdRms) {
      this.aboveMs += this.frameMs;
      if (this.armed && this.aboveMs >= this.minMs) {
        this.armed = false;
        this.count++;
        return true;
      }
      return false;
    }
    this.aboveMs = 0;
    this.armed = true;
    return false;
  }
}
```

- [x] **Step 5: 运行测试确认通过**

Run: `npm test -w avatar-core`
Expected: 全部 PASS（pcm 8 个、mouth 4 个、energy 2 个）。

若 `opens faster than it closes` 失败：attack 一步 = `1-exp(-16/30)` ≈ 0.41，release 一步 = `1-exp(-16/80)` ≈ 0.18，前者乘以 target 0.7 后仍大于后者乘以 full 值，检查 `tau` 的分支是否写反。

- [x] **Step 6: 提交**

```bash
git add avatar-core package-lock.json
git commit -m "feat(avatar-core): scaffold and pure audio utilities (resampler, mouth, energy)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 播放器（PlaybackGate + AudioWorklet + PlaybackController）

**Files:**
- Create: `avatar-core/src/audio/playbackGate.ts`, `avatar-core/src/audio/player-worklet.ts`, `avatar-core/src/audio/player.ts`
- Test: `avatar-core/test/playbackGate.test.ts`

**Depends on:** Task 9。可与 Task 11/12/13 并行。

**Interfaces:**
- Consumes: `AI_SAMPLE_RATE`（Task 1）；`int16ToFloat32`、`LinearResampler`、`AudioFeatures`（Task 9）
- Produces:
  - `class PlaybackGate`：`active: number | null`、`start(seq)`、`accepts(seq): boolean`、`cancel(seq)`、`finish(seq)`、`resetBelow(lastSeq)`、`reset()`
  - `interface PlaybackEvents { onFirstAudio(seq): void; onEnded(seq, playedMs): void; onStopped(seq, playedMs): void; onProgress(seq, playedMs): void; onLevel(features: AudioFeatures, dtMs: number): void }`
  - `class PlaybackController(events)`：`init(): Promise<void>`、`resume(): Promise<void>`、`activeSeq`、`onResponseStart(seq)`、`push(seq, pcm24k)`、`end(seq)`、`interrupt(): { seq: number; playedMs: number } | null`、`cancelled(seq)`、`resetAfterResume(lastSeq)`、`resetForNewSession()`、`playedMsFor(seq)`、`contextState: AudioContextState | 'none'`（getter，Task 14 上报 `audio_context` 诊断用）

Worklet 消息协议（主线程 → worklet）：`{type:'push', seq, samples: Float32Array}`、`{type:'end', seq}`、`{type:'stop', fadeMs}`；（worklet → 主线程）：`{type:'started', seq}`、`{type:'progress', seq, playedSamples}`（约每 100 ms）、`{type:'drained', seq, playedSamples}`、`{type:'stopped', seq, playedSamples}`、`{type:'level', rms, zcr, samples}`（约每 16 ms）。

生命周期约定：
- 一条回复的"播放结束"只由 worklet 的 `drained` 触发；**没有任何音频的回复**（例如只有工具调用）收到 `end` 时，worklet 立即回 `drained(seq, 0)`，否则网关永远等不到 `playback.stopped(ended)`，Director 会被卡住。
- 门控状态按会话划分：`responseSeq` 只在一个会话内递增，新会话从 1 重新开始，所以新会话开始时必须 `resetForNewSession()`（清空已取消集合和下限），否则旧会话取消过的序号会把新会话的回复静音。续接同一会话时用 `resetAfterResume(lastSeq)`。

- [x] **Step 1: 写失败的测试**

`avatar-core/test/playbackGate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PlaybackGate } from '../src/audio/playbackGate.ts';

describe('PlaybackGate', () => {
  it('accepts only the active response', () => {
    const g = new PlaybackGate();
    expect(g.accepts(1)).toBe(false);
    g.start(1);
    expect(g.accepts(1)).toBe(true);
    expect(g.accepts(2)).toBe(false);
    g.start(2);
    expect(g.accepts(1)).toBe(false);
    expect(g.accepts(2)).toBe(true);
  });

  it('never accepts a cancelled response again', () => {
    const g = new PlaybackGate();
    g.start(3);
    g.cancel(3);
    expect(g.active).toBeNull();
    g.start(3);
    expect(g.accepts(3)).toBe(false);
  });

  it('finish clears only the matching response', () => {
    const g = new PlaybackGate();
    g.start(4);
    g.finish(5);
    expect(g.active).toBe(4);
    g.finish(4);
    expect(g.active).toBeNull();
  });

  it('after resume, rejects everything up to the last server sequence', () => {
    const g = new PlaybackGate();
    g.start(5);
    g.resetBelow(5);
    expect(g.active).toBeNull();
    g.start(5);
    expect(g.accepts(5)).toBe(false);
    g.start(6);
    expect(g.accepts(6)).toBe(true);
  });

  it('reset() forgets everything so a new session can reuse sequence numbers', () => {
    const g = new PlaybackGate();
    g.start(2);
    g.cancel(2);
    g.resetBelow(3);
    g.reset();
    g.start(2);
    expect(g.accepts(2)).toBe(true);
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -w avatar-core -- playbackGate`
Expected: FAIL，无法解析模块。

- [x] **Step 3: 实现 PlaybackGate**

`avatar-core/src/audio/playbackGate.ts`:

```ts
/** Decides which response's audio may be played. Guarantees no stale audio after cancel/resume. */
export class PlaybackGate {
  private activeSeq: number | null = null;
  private readonly cancelledSeqs = new Set<number>();
  private floor = 0;

  get active(): number | null {
    return this.activeSeq;
  }

  start(seq: number): void {
    if (seq <= this.floor || this.cancelledSeqs.has(seq)) return;
    this.activeSeq = seq;
  }

  accepts(seq: number): boolean {
    return seq === this.activeSeq && seq > this.floor && !this.cancelledSeqs.has(seq);
  }

  cancel(seq: number): void {
    this.cancelledSeqs.add(seq);
    if (this.activeSeq === seq) this.activeSeq = null;
  }

  finish(seq: number): void {
    if (this.activeSeq === seq) this.activeSeq = null;
  }

  resetBelow(lastSeq: number): void {
    this.floor = Math.max(this.floor, lastSeq);
    this.activeSeq = null;
  }

  /** New gateway session: sequence numbers start again from 1. */
  reset(): void {
    this.activeSeq = null;
    this.cancelledSeqs.clear();
    this.floor = 0;
  }
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npm test -w avatar-core -- playbackGate`
Expected: 5 个测试 PASS。

- [x] **Step 5: 实现播放 worklet（自包含，不 import 其他模块）**

`avatar-core/src/audio/player-worklet.ts`:

```ts
type InMsg =
  | { type: 'push'; seq: number; samples: Float32Array }
  | { type: 'end'; seq: number }
  | { type: 'stop'; fadeMs: number };

const LEVEL_INTERVAL_S = 0.016; // TUNABLE
const PROGRESS_INTERVAL_S = 0.1; // TUNABLE

class PlayerProcessor extends AudioWorkletProcessor {
  private queue: Float32Array[] = [];
  private offset = 0;
  private seq = -1;
  private played = 0;
  private startedSent = false;
  private ended = false;
  private stopping = false;
  private gain = 1;
  private gainStep = 0;
  private prevSample = 0;
  private accSq = 0;
  private accZc = 0;
  private accN = 0;
  private sinceProgress = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<InMsg>) => this.onMessage(e.data);
  }

  private onMessage(m: InMsg): void {
    if (m.type === 'push') {
      if (m.seq !== this.seq) this.reset(m.seq);
      this.queue.push(m.samples);
    } else if (m.type === 'end') {
      if (m.seq === this.seq) this.ended = true;
      else this.port.postMessage({ type: 'drained', seq: m.seq, playedSamples: 0 }); // a response without any audio
    } else if (this.seq >= 0 && !this.stopping) {
      this.stopping = true;
      this.gain = 1;
      this.gainStep = 1 / Math.max(1, (m.fadeMs / 1000) * sampleRate);
    }
  }

  private reset(seq: number): void {
    this.queue = [];
    this.offset = 0;
    this.seq = seq;
    this.played = 0;
    this.startedSent = false;
    this.ended = false;
    this.stopping = false;
    this.gain = 1;
  }

  private finishStop(): void {
    this.port.postMessage({ type: 'stopped', seq: this.seq, playedSamples: this.played });
    this.queue = [];
    this.offset = 0;
    this.seq = -1;
    this.stopping = false;
    this.ended = false;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const out = channels?.[0];
    if (!out) return true;
    let sumSq = 0;
    let zc = 0;
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      const head = this.queue[0];
      if (head) {
        s = head[this.offset++];
        if (this.offset >= head.length) {
          this.queue.shift();
          this.offset = 0;
        }
        this.played++;
        if (!this.startedSent) {
          this.startedSent = true;
          this.port.postMessage({ type: 'started', seq: this.seq });
        }
      }
      if (this.stopping) {
        s *= Math.max(0, this.gain);
        this.gain -= this.gainStep;
        if (this.gain <= 0) {
          this.finishStop();
          s = 0;
        }
      }
      out[i] = s;
      sumSq += s * s;
      if (s >= 0 !== this.prevSample >= 0) zc++;
      this.prevSample = s;
    }
    for (let c = 1; c < channels.length; c++) channels[c].set(out);

    this.accSq += sumSq;
    this.accZc += zc;
    this.accN += out.length;
    if (this.accN >= sampleRate * LEVEL_INTERVAL_S) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.accSq / this.accN), zcr: this.accZc / this.accN, samples: this.accN });
      this.accSq = 0;
      this.accZc = 0;
      this.accN = 0;
    }
    if (this.seq >= 0) {
      this.sinceProgress += out.length;
      if (this.sinceProgress >= sampleRate * PROGRESS_INTERVAL_S) {
        this.sinceProgress = 0;
        this.port.postMessage({ type: 'progress', seq: this.seq, playedSamples: this.played });
      }
      if (this.ended && this.queue.length === 0 && !this.stopping) {
        this.port.postMessage({ type: 'drained', seq: this.seq, playedSamples: this.played });
        this.seq = -1;
        this.ended = false;
      }
    }
    return true;
  }
}

registerProcessor('player', PlayerProcessor);
```

- [x] **Step 6: 实现 PlaybackController**

`avatar-core/src/audio/player.ts`:

```ts
import { AI_SAMPLE_RATE } from '@anyidea/protocol';
import { LinearResampler, int16ToFloat32, type AudioFeatures } from './pcm.ts';
import { PlaybackGate } from './playbackGate.ts';
import playerWorkletUrl from './player-worklet.ts?worker&url';

export interface PlaybackEvents {
  onFirstAudio(seq: number): void;
  onEnded(seq: number, playedMs: number): void;
  onStopped(seq: number, playedMs: number): void;
  onProgress(seq: number, playedMs: number): void;
  onLevel(features: AudioFeatures, dtMs: number): void;
}

type OutMsg =
  | { type: 'started'; seq: number }
  | { type: 'progress'; seq: number; playedSamples: number }
  | { type: 'drained'; seq: number; playedSamples: number }
  | { type: 'stopped'; seq: number; playedSamples: number }
  | { type: 'level'; rms: number; zcr: number; samples: number };

export const FADE_MS = 30; // TUNABLE
export const RESET_FADE_MS = 10; // TUNABLE

/** Plays streamed 24 kHz PCM with per-response gating and instant barge-in. */
export class PlaybackController {
  readonly gate = new PlaybackGate();
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private resampler: LinearResampler | null = null;
  private readonly playedSamples = new Map<number, number>();

  constructor(private readonly ev: PlaybackEvents) {}

  async init(): Promise<void> {
    const ctx = new AudioContext({ sampleRate: AI_SAMPLE_RATE, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(playerWorkletUrl);
    const node = new AudioWorkletNode(ctx, 'player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e: MessageEvent<OutMsg>) => this.onWorklet(e.data);
    node.connect(ctx.destination);
    if (ctx.sampleRate !== AI_SAMPLE_RATE) this.resampler = new LinearResampler(AI_SAMPLE_RATE, ctx.sampleRate);
    this.ctx = ctx;
    this.node = node;
  }

  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
  }

  get activeSeq(): number | null {
    return this.gate.active;
  }

  get contextState(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  onResponseStart(seq: number): void {
    this.gate.start(seq);
  }

  push(seq: number, pcm24k: Int16Array): void {
    if (!this.node || !this.gate.accepts(seq)) return;
    let samples = int16ToFloat32(pcm24k);
    if (this.resampler) samples = this.resampler.process(samples);
    if (samples.length === 0) return; // an empty frame would make the worklet read undefined (NaN)
    this.node.port.postMessage({ type: 'push', seq, samples }, [samples.buffer]);
  }

  end(seq: number): void {
    if (this.gate.accepts(seq)) this.node?.port.postMessage({ type: 'end', seq });
  }

  /** Barge-in: fade out and drop the active response. */
  interrupt(): { seq: number; playedMs: number } | null {
    const seq = this.gate.active;
    if (seq === null) return null;
    this.gate.cancel(seq);
    this.node?.port.postMessage({ type: 'stop', fadeMs: FADE_MS });
    return { seq, playedMs: this.playedMsFor(seq) };
  }

  /** The server cancelled a response. */
  cancelled(seq: number): void {
    const wasActive = this.gate.active === seq;
    this.gate.cancel(seq);
    if (wasActive) this.node?.port.postMessage({ type: 'stop', fadeMs: FADE_MS });
  }

  resetAfterResume(lastSeq: number): void {
    this.gate.resetBelow(lastSeq);
    this.node?.port.postMessage({ type: 'stop', fadeMs: RESET_FADE_MS });
  }

  /** A fresh gateway session (sequence numbers restart at 1). */
  resetForNewSession(): void {
    this.gate.reset();
    this.playedSamples.clear();
    this.node?.port.postMessage({ type: 'stop', fadeMs: RESET_FADE_MS });
  }

  playedMsFor(seq: number): number {
    const rate = this.ctx?.sampleRate ?? AI_SAMPLE_RATE;
    return ((this.playedSamples.get(seq) ?? 0) / rate) * 1000;
  }

  private onWorklet(m: OutMsg): void {
    const rate = this.ctx?.sampleRate ?? AI_SAMPLE_RATE;
    switch (m.type) {
      case 'started':
        this.ev.onFirstAudio(m.seq);
        break;
      case 'progress':
        this.playedSamples.set(m.seq, m.playedSamples);
        this.ev.onProgress(m.seq, (m.playedSamples / rate) * 1000);
        break;
      case 'drained':
        this.playedSamples.set(m.seq, m.playedSamples);
        this.gate.finish(m.seq);
        this.ev.onEnded(m.seq, (m.playedSamples / rate) * 1000);
        break;
      case 'stopped':
        this.playedSamples.set(m.seq, m.playedSamples);
        this.ev.onStopped(m.seq, (m.playedSamples / rate) * 1000);
        break;
      case 'level':
        this.ev.onLevel({ rms: m.rms, zcr: m.zcr }, (m.samples / rate) * 1000);
        break;
    }
  }
}
```

`avatar-core/test/player.test.ts`（最终评审修复：零长度帧会让 worklet 读到 undefined 产生 NaN，`push()` 直接丢弃；node 下无 AudioContext，用替身 port 验证）:

```ts
import { describe, expect, it } from 'vitest';
import { PlaybackController } from '../src/audio/player.ts';

describe('PlaybackController.push', () => {
  it('drops zero-length frames (the worklet would read undefined samples)', () => {
    const noop = () => {};
    const p = new PlaybackController({ onFirstAudio: noop, onEnded: noop, onStopped: noop, onProgress: noop, onLevel: noop });
    const posted: unknown[] = [];
    // No AudioContext in node: stand in for the worklet node's port.
    (p as unknown as { node: unknown }).node = { port: { postMessage: (m: unknown) => posted.push(m) } };
    p.onResponseStart(1);
    p.push(1, new Int16Array(0));
    expect(posted).toEqual([]);
    p.push(1, new Int16Array(4));
    expect(posted).toHaveLength(1);
  });
});
```

- [x] **Step 7: 类型检查与提交**

Run: `npm run typecheck -w avatar-core && npm test -w avatar-core`
Expected: 无类型错误；测试全部 PASS。若 `?worker&url` 导入报"找不到模块"，确认 `tsconfig.json` 的 `types` 含 `vite/client`。

worklet 加载方式的说明（基于 Vite 8.3.4 源码的判断，以 Task 14 Step 7 和 Task 17 的实际运行为准）：dev 下 `?worker&url` 以 module 方式提供并注入 `import "/@vite/env"`，生产构建输出 IIFE，两者都能被 `audioWorklet.addModule` 加载。若实测 `addModule` 报错，退路是把两个 worklet 改写成纯 JS 放到 `avatar-core/public/worklets/`，用 `new URL('./worklets/player-worklet.js', document.baseURI).href` 加载，并记入 `docs/blockers.md`。

```bash
git add avatar-core/src/audio avatar-core/test/playbackGate.test.ts avatar-core/test/player.test.ts
git commit -m "feat(avatar-core): gated AudioWorklet player with instant barge-in

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 麦克风采集与本地 VAD

**Files:**
- Create: `avatar-core/src/audio/capture-worklet.ts`, `avatar-core/src/audio/capture.ts`, `avatar-core/src/audio/vad.ts`
- Test: `avatar-core/test/vad.test.ts`

**Depends on:** Task 9。可与 Task 10/12/13 并行。

**Interfaces:**
- Consumes: `MIC_SAMPLE_RATE`、`MIC_FRAME_SAMPLES`（Task 1）；`LinearResampler`、`FrameChunker`、`float32ToInt16`（Task 9）
- Produces:
  - `type EchoMode = 'true' | 'all'`；`class MicCapture`：`start({ onFrame(pcm16k: Int16Array): void; echo: EchoMode }): Promise<MediaStream>`、`setEnabled(on)`、`stop()`、`settings(): MediaTrackSettings | null`
  - `interface DetectorOptions { frameMs; threshold; bargeInThreshold; startMs; endMs; hysteresis }`、`DEFAULT_DETECTOR`
  - `class SpeechDetector(opts?)`：`aiPlaying`、`speaking`、`onsetAt: number | null`、`push(probability, nowMs): 'start' | 'end' | null`、`reset()`
  - `class LocalVad`：`detector`、`start(stream, { onStart(onsetAt: number): void; onEnd(): void; onProbability?(p: number): void }): Promise<void>`、`set aiPlaying(v)`、`callbacks`、`destroy()`（说话中销毁会补发一次 `onEnd`；`start()` 先 `destroy()`）

- [x] **Step 1: 写失败的测试（SpeechDetector 纯逻辑）**

`avatar-core/test/vad.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LocalVad, SpeechDetector, vadAssetBase } from '../src/audio/vad.ts';

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

describe('vadAssetBase', () => {
  it('resolves against the dev server root', () => {
    expect(vadAssetBase('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173/vad/');
  });

  it('resolves against the page directory under a token prefix', () => {
    expect(vadAssetBase('http://127.0.0.1:41234/abcdef/index.html')).toBe('http://127.0.0.1:41234/abcdef/vad/');
  });

  it('drops query and hash from the base', () => {
    expect(vadAssetBase('http://127.0.0.1:41234/abcdef/spike-aec.html?x=1#y')).toBe('http://127.0.0.1:41234/abcdef/vad/');
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -w avatar-core -- vad`
Expected: FAIL，无法解析模块。

- [x] **Step 3: 实现 VAD**

`avatar-core/src/audio/vad.ts`:

```ts
// Type-only import: vad-web/onnxruntime-web load lazily in start(), so vitest (node) can import this module.
import type { MicVAD } from '@ricky0123/vad-web';

export interface DetectorOptions {
  frameMs: number;
  threshold: number;
  /** Higher threshold while the AI is speaking, to resist echo. */
  bargeInThreshold: number;
  startMs: number;
  endMs: number;
  hysteresis: number;
}

/** TUNABLE (estimates); Silero v5 frames are 512 samples @16 kHz = 32 ms. */
export const DEFAULT_DETECTOR: DetectorOptions = {
  frameMs: 32,
  threshold: 0.5,
  bargeInThreshold: 0.75,
  startMs: 150,
  endMs: 600,
  hysteresis: 0.15,
};

/** Turns per-frame speech probabilities into start/end events with hysteresis. */
export class SpeechDetector {
  aiPlaying = false;
  speaking = false;
  onsetAt: number | null = null;
  private aboveMs = 0;
  private belowMs = 0;
  private candidateAt: number | null = null;

  constructor(private readonly o: DetectorOptions = DEFAULT_DETECTOR) {}

  push(p: number, nowMs: number): 'start' | 'end' | null {
    const threshold = this.aiPlaying ? this.o.bargeInThreshold : this.o.threshold;
    if (!this.speaking) {
      if (p >= threshold) {
        if (this.candidateAt === null) this.candidateAt = nowMs;
        this.aboveMs += this.o.frameMs;
        if (this.aboveMs >= this.o.startMs) {
          this.speaking = true;
          this.onsetAt = this.candidateAt;
          this.aboveMs = 0;
          this.belowMs = 0;
          this.candidateAt = null;
          return 'start';
        }
      } else {
        this.aboveMs = 0;
        this.candidateAt = null;
      }
      return null;
    }
    if (p < threshold - this.o.hysteresis) {
      this.belowMs += this.o.frameMs;
      if (this.belowMs >= this.o.endMs) {
        this.speaking = false;
        this.belowMs = 0;
        return 'end';
      }
    } else {
      this.belowMs = 0;
    }
    return null;
  }

  /** Clears speaking and pending start/end state; aiPlaying is kept. */
  reset(): void {
    this.speaking = false;
    this.onsetAt = null;
    this.aboveMs = 0;
    this.belowMs = 0;
    this.candidateAt = null;
  }
}

/** Absolute vad/ asset URL under the page base; a relative path would resolve against the bundled JS in assets/. */
export function vadAssetBase(baseURI: string): string {
  return new URL('vad/', baseURI).href;
}

export interface VadCallbacks {
  onStart(onsetAt: number): void;
  onEnd(): void;
  onProbability?(p: number): void;
}

/** Silero VAD on the shared microphone stream; only probabilities are used from MicVAD. */
export class LocalVad {
  readonly detector: SpeechDetector;
  /** Callbacks from the last start(); destroy() uses them to close an open speech segment. */
  callbacks: VadCallbacks | null = null;
  private vad: MicVAD | null = null;

  constructor(opts: DetectorOptions = DEFAULT_DETECTOR) {
    this.detector = new SpeechDetector(opts);
  }

  set aiPlaying(v: boolean) {
    this.detector.aiPlaying = v;
  }

  async start(stream: MediaStream, cb: VadCallbacks): Promise<void> {
    await this.destroy();
    this.callbacks = cb;
    const { MicVAD } = await import('@ricky0123/vad-web');
    const assetBase = vadAssetBase(document.baseURI);
    this.vad = await MicVAD.new({
      model: 'v5',
      baseAssetPath: assetBase,
      onnxWASMBasePath: assetBase,
      getStream: async () => stream,
      pauseStream: async () => {},
      resumeStream: async () => stream,
      ortConfig: (ort) => {
        ort.env.wasm.numThreads = 1; // no cross-origin isolation in the WebView
      },
      onFrameProcessed: (probs) => {
        cb.onProbability?.(probs.isSpeech);
        const r = this.detector.push(probs.isSpeech, performance.now());
        if (r === 'start') cb.onStart(this.detector.onsetAt ?? performance.now());
        else if (r === 'end') cb.onEnd();
      },
      onSpeechStart: () => {},
      onSpeechEnd: () => {},
      onVADMisfire: () => {},
      onSpeechRealStart: () => {},
      startOnLoad: true,
    });
  }

  async destroy(): Promise<void> {
    // Emit the end edge so downstream (gateway localSpeaking) never stays stuck on.
    const wasSpeaking = this.detector.speaking;
    this.detector.reset();
    if (wasSpeaking) this.callbacks?.onEnd();
    await this.vad?.destroy();
    this.vad = null;
  }
}
```

注：`vad.ts` 顶部只做 `import type`，`MicVAD` 在 `start()` 里动态 import，所以 `vad.test.ts` 在 node 中只加载 `SpeechDetector` 纯逻辑，不会加载 vad-web / onnxruntime-web。已按 vad-web 0.0.31 的 `dist/real-time-vad.d.ts` 核实：`MicVAD.new` 接受上面全部选项（含 `getStream`/`pauseStream`/`resumeStream`/`ortConfig`/`startOnLoad`），实例有 `destroy()`；`onFrameProcessed` 的 `probs.isSpeech` 是 number。

注（Task 17 冒烟后修正）：`baseAssetPath`/`onnxWASMBasePath` 必须是基于 `document.baseURI` 的绝对 URL（`vadAssetBase`）。相对的 `./vad/` 在打包后被 ORT 的动态 `import()` 按 `assets/*.js` 解析成不存在的 `assets/vad/`，APK 内报 `no available backend found`（见 `docs/blockers.md` #5）。`document` 只在 `start()` 里访问，node 测试不受影响。

- [x] **Step 4: 运行测试确认通过**

Run: `npm test -w avatar-core -- vad`
Expected: 7 个测试 PASS。

- [x] **Step 5: 实现采集 worklet 与 MicCapture**

`avatar-core/src/audio/capture-worklet.ts`:

```ts
/** Batches microphone input into ~20 ms Float32 chunks for the main thread. */
const CHUNK_S = 0.02; // TUNABLE

class CaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(Math.round(sampleRate * CHUNK_S));
  private len = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let off = 0;
    while (off < input.length) {
      const take = Math.min(this.buf.length - this.len, input.length - off);
      this.buf.set(input.subarray(off, off + take), this.len);
      this.len += take;
      off += take;
      if (this.len === this.buf.length) {
        const out = this.buf;
        this.port.postMessage(out, [out.buffer]);
        this.buf = new Float32Array(out.length);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
```

`avatar-core/src/audio/capture.ts`:

```ts
import { MIC_FRAME_SAMPLES, MIC_SAMPLE_RATE } from '@anyidea/protocol';
import { FrameChunker, LinearResampler, float32ToInt16 } from './pcm.ts';
import captureWorkletUrl from './capture-worklet.ts?worker&url';

/** 'all' asks Chrome 141+ to cancel all page audio, not just remote WebRTC audio (spec §2.1). */
export type EchoMode = 'true' | 'all';

export interface CaptureOptions {
  onFrame(pcm16k: Int16Array): void;
  echo: EchoMode;
}

export class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;

  async start(o: CaptureOptions): Promise<MediaStream> {
    await this.stop();
    const audio = {
      channelCount: 1,
      echoCancellation: o.echo === 'all' ? 'all' : true,
      noiseSuppression: true,
      autoGainControl: true,
    } as unknown as MediaTrackConstraints; // 'all' is newer than the DOM typings
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(captureWorkletUrl);
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const sink = ctx.createGain();
      sink.gain.value = 0; // keeps the node pulled by the graph without making sound
      const resampler = new LinearResampler(ctx.sampleRate, MIC_SAMPLE_RATE);
      const chunker = new FrameChunker(MIC_FRAME_SAMPLES);
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        for (const frame of chunker.push(float32ToInt16(resampler.process(e.data)))) o.onFrame(frame);
      };
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
    } catch (err) {
      // Release the mic and context so the recording indicator turns off.
      stream.getTracks().forEach((t) => t.stop());
      await ctx?.close().catch(() => {});
      throw err;
    }
    this.stream = stream;
    this.ctx = ctx;
    return stream;
  }

  settings(): MediaTrackSettings | null {
    return this.stream?.getAudioTracks()[0]?.getSettings() ?? null;
  }

  setEnabled(on: boolean): void {
    this.stream?.getAudioTracks().forEach((t) => {
      t.enabled = on;
    });
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.stream = null;
    this.ctx = null;
  }
}
```

- [x] **Step 6: 类型检查与提交**

Run: `npm run typecheck -w avatar-core && npm test -w avatar-core`
Expected: 无类型错误；测试全部 PASS。

```bash
git add avatar-core/src/audio avatar-core/test/vad.test.ts
git commit -m "feat(avatar-core): mic capture worklet and Silero-based speech detector

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: GatewayClient（会话创建、WSS、断线续接）

**Files:**
- Create: `avatar-core/src/net/gatewayClient.ts`
- Test: `avatar-core/test/gatewayClient.test.ts`

**Depends on:** Task 9。只依赖 Task 8 写在文档里的 HTTP/WS 契约（不 import gateway 代码），可与 Task 7/8/10/11/13 并行；若 Task 8 的契约在执行中被改，先同步本任务。

**Interfaces:**
- Consumes: Task 8 的 HTTP/WS 契约；`encodeAudioFrame`、`decodeAudioFrame`、`FRAME_AI`、`FRAME_MIC`、`ClientMessage`、`ServerMessage`、`SessionTokens`、`AudioPath`
- Produces:
  - `interface WebSocketLike`、`type WebSocketCtor = new (url: string) => WebSocketLike`
  - `type ClientStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'`
  - `class GatewayClient(options: { baseUrl; appSecret; clientInfo: { platform: string; audioPath: AudioPath }; fetchFn?; WebSocketCtor?; maxResumeMs? }, events: { onMessage(m: ServerMessage); onAudio(seq, pcm); onStatus(s: ClientStatus) })`：`start(): Promise<void>`、`send(m: ClientMessage)`、`sendAudio(pcm16k)`、`close()`、`isOpen`
  - `class HttpError extends Error { status: number }`

续接逻辑：非用户主动断开 → 退避 500 ms、1 s、2 s、4 s（封顶 4 s）调用 `POST /session/resume` → 新 WS 发 `session.resume`（若会话从未收到 `session.ready`/`session.resumed`，即 `session.start` 未到达网关，则新 WS 改发 `session.start`）；退避计数与断开时间只在收到 `session.ready`/`session.resumed` 后清零（不在 `onopen` 清零），所以 open 后反复被网关关闭（如 4002）仍会在 `maxResumeMs` 后转为新建会话；`close()` 后在途的 POST 不再开新 WS，重连中调用 `close()` 立即发出 `closed`；`404/401` 或累计断开超过 `maxResumeMs`（默认 55 秒，小于网关 60 秒宽限期）→ 改为新建会话并发 `session.start`。

- [x] **Step 1: 写失败的测试**

`avatar-core/test/gatewayClient.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_AI, encodeAudioFrame, type ServerMessage } from '@anyidea/protocol';
import { GatewayClient, type ClientStatus, type WebSocketLike } from '../src/net/gatewayClient.ts';

class FakeWS implements WebSocketLike {
  static instances: FakeWS[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  send(d: string | Uint8Array) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
  json(i: number) { return JSON.parse(this.sent[i] as string); }
}

const tokens = (n: number) => ({ sessionId: 's1', connectToken: `c${n}`, resumeToken: `r${n}` });

function setup(responses: Array<{ status: number; body: unknown }>) {
  FakeWS.instances = [];
  const calls: Array<{ url: string; body: unknown; secret: string | null }> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null, secret: headers.get('x-app-secret') });
    const r = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  const messages: ServerMessage[] = [];
  const audio: Array<[number, number[]]> = [];
  const statuses: ClientStatus[] = [];
  const client = new GatewayClient(
    { baseUrl: 'http://gw.test', appSecret: 'sekret', clientInfo: { platform: 'android', audioPath: 'A' }, fetchFn, WebSocketCtor: FakeWS, maxResumeMs: 10_000 },
    { onMessage: (m) => messages.push(m), onAudio: (s, p) => audio.push([s, Array.from(p)]), onStatus: (s) => statuses.push(s) },
  );
  return { client, calls, messages, audio, statuses };
}

describe('GatewayClient', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('creates a session and sends session.start on open', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    expect(t.calls[0]).toEqual({ url: 'http://gw.test/session', body: {}, secret: 'sekret' });
    const ws = FakeWS.instances[0];
    expect(ws.url).toBe('ws://gw.test/ws?token=c1');
    expect(ws.binaryType).toBe('arraybuffer');
    ws.open();
    expect(ws.json(0)).toEqual({ type: 'session.start', clientInfo: { platform: 'android', audioPath: 'A' } });
    expect(t.statuses).toEqual(['connecting', 'open']);
  });

  it('routes text and audio frames', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    const ws = FakeWS.instances[0];
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ type: 'response.start', responseSeq: 1, kind: 'greeting' }) });
    const frame = encodeAudioFrame(FRAME_AI, 1, Int16Array.from([5, -5]));
    ws.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
    expect(t.messages).toEqual([{ type: 'response.start', responseSeq: 1, kind: 'greeting' }]);
    expect(t.audio).toEqual([[1, [5, -5]]]);
  });

  it('only sends when open', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    const ws = FakeWS.instances[0];
    t.client.send({ type: 'client.mute', muted: true });
    t.client.sendAudio(new Int16Array(320));
    expect(ws.sent).toEqual([]);
    ws.open();
    t.client.sendAudio(new Int16Array(320));
    expect(ws.sent[1]).toBeInstanceOf(Uint8Array);
  });

  it('resumes after an unexpected drop', async () => {
    const t = setup([{ status: 200, body: tokens(1) }, { status: 200, body: tokens(2) }]);
    await t.client.start();
    FakeWS.instances[0].open();
    FakeWS.instances[0].onmessage?.({ data: JSON.stringify({ type: 'session.ready', sessionId: 's1' }) });
    FakeWS.instances[0].drop();
    expect(t.statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(t.calls[1]).toEqual({ url: 'http://gw.test/session/resume', body: { sessionId: 's1', resumeToken: 'r1' }, secret: 'sekret' });
    const ws2 = FakeWS.instances[1];
    expect(ws2.url).toBe('ws://gw.test/ws?token=c2');
    ws2.open();
    expect(ws2.json(0)).toEqual({ type: 'session.resume', sessionId: 's1' });
  });

  it('starts a fresh session when the old one is gone', async () => {
    const t = setup([
      { status: 200, body: tokens(1) },
      { status: 404, body: { error: 'session_gone' } },
      { status: 200, body: tokens(3) },
    ]);
    await t.client.start();
    FakeWS.instances[0].open();
    FakeWS.instances[0].drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(t.calls.map((c) => c.url)).toEqual(['http://gw.test/session', 'http://gw.test/session/resume', 'http://gw.test/session']);
    const ws = FakeWS.instances[1];
    ws.open();
    expect(ws.json(0).type).toBe('session.start');
  });

  it('backs off while the gateway is unreachable, then falls back to a fresh session after maxResumeMs', async () => {
    const t = setup([{ status: 200, body: tokens(1) }, ...Array.from({ length: 5 }, () => ({ status: 503, body: {} })), { status: 200, body: tokens(9) }]);
    await t.client.start();
    FakeWS.instances[0].open();
    FakeWS.instances[0].drop();
    const resumes = () => t.calls.filter((c) => c.url.endsWith('/session/resume')).length;
    // Retries at 0.5, 1.5, 3.5, 7.5 s (backoff 500/1000/2000/4000 ms).
    await vi.advanceTimersByTimeAsync(7_500);
    expect(resumes()).toBe(4);
    expect(FakeWS.instances).toHaveLength(1);
    // 5th retry at 11.5 s fails; 11.5 s > maxResumeMs (10 s), so the client creates a fresh session instead of a 6th retry.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(resumes()).toBe(5);
    expect(t.calls.map((c) => c.url).at(-1)).toBe('http://gw.test/session');
    expect(FakeWS.instances).toHaveLength(2);
    const ws = FakeWS.instances[1];
    expect(ws.url).toBe('ws://gw.test/ws?token=c9');
    ws.open();
    expect(ws.json(0).type).toBe('session.start');
    expect(t.statuses.at(-1)).toBe('open');
  });

  it('falls back to a fresh session when post-open closes repeat without session.ready', async () => {
    const t = setup([{ status: 200, body: tokens(1) }, ...Array.from({ length: 30 }, (_, i) => ({ status: 200, body: tokens(i + 2) }))]);
    await t.client.start();
    // Upgrade aborts after the connect token was claimed: session.start never reached the gateway.
    FakeWS.instances[0].drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(t.calls[1].url).toBe('http://gw.test/session/resume');
    const ws2 = FakeWS.instances[1];
    ws2.open();
    // The session never started, so the new socket must start it rather than resume.
    expect(ws2.json(0).type).toBe('session.start');
    // From here the gateway closes every socket right after open (e.g. 4002 bad_state).
    for (let i = 0; i < 40 && !t.calls.slice(1).some((c) => c.url === 'http://gw.test/session'); i++) {
      FakeWS.instances.at(-1)!.open();
      FakeWS.instances.at(-1)!.drop();
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(t.calls.slice(1).some((c) => c.url === 'http://gw.test/session')).toBe(true);
    expect(FakeWS.instances.length).toBeLessThan(12);
    expect(t.calls.length).toBeLessThan(12);
    const fresh = FakeWS.instances.at(-1)!;
    fresh.open();
    expect(fresh.json(0).type).toBe('session.start');
    fresh.onmessage?.({ data: JSON.stringify({ type: 'session.ready', sessionId: 's1' }) });
    expect(t.statuses.at(-1)).toBe('open');
  });

  it('resets backoff only after session.resumed, then resumes again on the next drop', async () => {
    const t = setup([{ status: 200, body: tokens(1) }, { status: 200, body: tokens(2) }, { status: 200, body: tokens(3) }]);
    await t.client.start();
    const ws1 = FakeWS.instances[0];
    ws1.open();
    ws1.onmessage?.({ data: JSON.stringify({ type: 'session.ready', sessionId: 's1' }) });
    ws1.drop();
    await vi.advanceTimersByTimeAsync(500);
    const ws2 = FakeWS.instances[1];
    ws2.open();
    expect(ws2.json(0)).toEqual({ type: 'session.resume', sessionId: 's1' });
    ws2.onmessage?.({ data: JSON.stringify({ type: 'session.resumed', lastResponseSeq: 0 }) });
    ws2.drop();
    // Backoff was reset by session.resumed, so the next retry fires after the base delay.
    await vi.advanceTimersByTimeAsync(500);
    expect(t.calls.map((c) => c.url)).toEqual(['http://gw.test/session', 'http://gw.test/session/resume', 'http://gw.test/session/resume']);
    FakeWS.instances[2].open();
    expect(FakeWS.instances[2].json(0).type).toBe('session.resume');
  });

  it('close() during an in-flight reconnect POST opens no new socket', async () => {
    const t = setup([{ status: 200, body: tokens(1) }, { status: 200, body: tokens(2) }]);
    await t.client.start();
    FakeWS.instances[0].open();
    FakeWS.instances[0].drop();
    // Fire the retry timer; the resume POST is now pending.
    vi.advanceTimersByTime(500);
    expect(t.calls).toHaveLength(2);
    t.client.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(t.client.isOpen).toBe(false);
    expect(t.statuses.at(-1)).toBe('closed');
  });

  it('close() while reconnecting emits closed', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    FakeWS.instances[0].open();
    FakeWS.instances[0].drop();
    expect(t.statuses.at(-1)).toBe('reconnecting');
    t.client.close();
    expect(t.statuses.at(-1)).toBe('closed');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.calls).toHaveLength(1);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('close() ends the session without reconnecting', async () => {
    const t = setup([{ status: 200, body: tokens(1) }]);
    await t.client.start();
    const ws = FakeWS.instances[0];
    ws.open();
    t.client.close();
    expect(ws.json(0).type).toBe('session.start');
    expect(ws.json(1)).toEqual({ type: 'session.end' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWS.instances).toHaveLength(1);
    expect(t.statuses.at(-1)).toBe('closed');
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -w avatar-core -- gatewayClient`
Expected: FAIL，无法解析模块。

- [x] **Step 3: 实现**

`avatar-core/src/net/gatewayClient.ts`:

```ts
import {
  FRAME_AI,
  FRAME_MIC,
  decodeAudioFrame,
  encodeAudioFrame,
  type AudioPath,
  type ClientMessage,
  type ServerMessage,
  type SessionTokens,
} from '@anyidea/protocol';

export interface WebSocketLike {
  readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;
export type ClientStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface GatewayClientOptions {
  baseUrl: string;
  appSecret: string;
  clientInfo: { platform: string; audioPath: AudioPath };
  fetchFn?: typeof fetch;
  WebSocketCtor?: WebSocketCtor;
  /** Must stay below the gateway grace period (60 s). */
  maxResumeMs?: number;
}

export interface GatewayClientEvents {
  onMessage(m: ServerMessage): void;
  onAudio(seq: number, pcm: Int16Array): void;
  onStatus(s: ClientStatus): void;
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`http_${status}`);
  }
}

const OPEN = 1;

// TUNABLE: reconnect backoff (ms): base doubles per attempt up to the cap
export const RESUME_BACKOFF_BASE_MS = 500;
export const RESUME_BACKOFF_MAX_MS = 4000;
// TUNABLE: give up resuming after this long (must stay below gateway 60 s grace)
export const DEFAULT_MAX_RESUME_MS = 55_000;

export class GatewayClient {
  private ws: WebSocketLike | null = null;
  private tokens: SessionTokens | null = null;
  private closedByUser = false;
  // True once the gateway confirmed the session (session.ready / session.resumed).
  private sessionStarted = false;
  private disconnectedAt = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly o: GatewayClientOptions,
    private readonly ev: GatewayClientEvents,
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === OPEN;
  }

  async start(): Promise<void> {
    this.closedByUser = false;
    this.sessionStarted = false;
    this.tokens = await this.post('/session', {});
    if (this.closedByUser) return;
    this.open('session.start');
  }

  send(m: ClientMessage): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(m));
  }

  sendAudio(pcm16k: Int16Array): void {
    if (this.ws?.readyState === OPEN) this.ws.send(encodeAudioFrame(FRAME_MIC, 0, pcm16k));
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.send({ type: 'session.end' });
    if (this.ws) this.ws.close(1000);
    else this.ev.onStatus('closed');
  }

  private open(first: 'session.start' | 'session.resume'): void {
    const t = this.tokens;
    if (!t) return;
    const Ctor = this.o.WebSocketCtor ?? (WebSocket as unknown as WebSocketCtor);
    const url = `${this.o.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(t.connectToken)}`;
    const ws = new Ctor(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.ev.onStatus(first === 'session.start' ? 'connecting' : 'reconnecting');
    ws.onopen = () => {
      this.ev.onStatus('open');
      this.send(first === 'session.start' ? { type: 'session.start', clientInfo: this.o.clientInfo } : { type: 'session.resume', sessionId: t.sessionId });
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data) as ServerMessage;
        // Reset backoff only once the gateway accepted the session, not on mere socket open.
        if (m.type === 'session.ready' || m.type === 'session.resumed') {
          this.sessionStarted = true;
          this.attempt = 0;
          this.disconnectedAt = 0;
        }
        this.ev.onMessage(m);
        return;
      }
      if (e.data instanceof ArrayBuffer) {
        const frame = decodeAudioFrame(new Uint8Array(e.data));
        if (frame && frame.kind === FRAME_AI) this.ev.onAudio(frame.responseSeq, frame.pcm);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUser) {
        this.ev.onStatus('closed');
        return;
      }
      if (!this.disconnectedAt) this.disconnectedAt = Date.now();
      this.scheduleResume();
    };
  }

  private scheduleResume(): void {
    if (this.closedByUser) return;
    if (Date.now() - this.disconnectedAt > (this.o.maxResumeMs ?? DEFAULT_MAX_RESUME_MS)) {
      void this.restartFresh();
      return;
    }
    const delay = Math.min(RESUME_BACKOFF_MAX_MS, RESUME_BACKOFF_BASE_MS * 2 ** this.attempt++);
    this.ev.onStatus('reconnecting');
    this.retryTimer = setTimeout(() => void this.tryResume(), delay);
  }

  private async tryResume(): Promise<void> {
    if (this.closedByUser || !this.tokens) return;
    try {
      this.tokens = await this.post('/session/resume', { sessionId: this.tokens.sessionId, resumeToken: this.tokens.resumeToken });
      if (this.closedByUser) return;
      // A session that never started must be started, not resumed (gateway would close 4002).
      this.open(this.sessionStarted ? 'session.resume' : 'session.start');
    } catch (e) {
      if (this.closedByUser) return;
      if (e instanceof HttpError && (e.status === 404 || e.status === 401)) await this.restartFresh();
      else this.scheduleResume();
    }
  }

  private async restartFresh(): Promise<void> {
    if (this.closedByUser) return;
    this.attempt = 0;
    this.sessionStarted = false;
    try {
      this.tokens = await this.post('/session', {});
      if (this.closedByUser) return;
      this.disconnectedAt = 0;
      this.open('session.start');
    } catch {
      if (this.closedByUser) return;
      this.disconnectedAt = Date.now();
      this.scheduleResume();
    }
  }

  private async post(path: string, body: unknown): Promise<SessionTokens> {
    const fetchFn = this.o.fetchFn ?? fetch;
    const res = await fetchFn(`${this.o.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-secret': this.o.appSecret },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new HttpError(res.status);
    return (await res.json()) as SessionTokens;
  }
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npm test -w avatar-core -- gatewayClient`
Expected: 11 个测试 PASS。

若 "backs off ... falls back" 失败：退避序列为 500、1000、2000、4000、4000 ms，重试发生在断开后 0.5、1.5、3.5、7.5、11.5 秒；第 5 次重试（11.5 s）失败时累计断开已超过 `maxResumeMs: 10_000`，`scheduleResume` 不再排第 6 次重试，而是立即 `restartFresh()`（新建会话成功 → 新 WS 发 `session.start`）。确认 `scheduleResume` 每次都先检查 `Date.now() - disconnectedAt`，且 vitest 的假定时器同时接管了 `Date.now()`。

- [x] **Step 5: 全量测试、类型检查与提交**

Run: `npm test -w avatar-core && npm run typecheck -w avatar-core`
Expected: 全部 PASS。

```bash
git add avatar-core/src/net avatar-core/test/gatewayClient.test.ts
git commit -m "feat(avatar-core): gateway client with resume and fresh-session fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
