# Task 5: Canvas 合成、指标与固定片段端到端

**Files:**
- Create: `avatar-core/src/spike/photoreal/compositor.ts`
- Create: `avatar-core/src/spike/photoreal/assets.ts`
- Create: `avatar-core/src/spike/photoreal/metrics.ts`
- Create: `avatar-core/src/spike/photoreal/page.ts`
- Modify: `avatar-core/photoreal/src/main.ts`
- Create: `avatar-core/test/photoreal/compositor.test.ts`
- Create: `avatar-core/test/photoreal/assets.test.ts`
- Create: `avatar-core/test/photoreal/metrics.test.ts`

**Interfaces:**
- Consumes: T2 的 `AudioClock`/`chooseFrame`；T3 的 `MelSpectrogram`/`melWindow`；T4 的 `packFace`/`patchToRgba`/`packBatch`/`Wav2LipRunner`；T1 的 manifest/资产。
- Produces:
  - `clampBox(box: FaceBox, width: number, height: number): FaceBox`
  - `drawComposite(ctx: CanvasRenderingContext2D, frame: CanvasImageSource, face: CanvasImageSource, patch: ImageData | null, box: FaceBox, patchCanvas: HTMLCanvasElement): void`
  - `pcmBytesToInt16(buffer: ArrayBuffer): Int16Array`
  - `class Metrics { ... }`
  - `startPage(): Promise<void>`

背景：这一段只做固定片段。页面加载后先把整段 mel 和整段帧算完（固定片段可以预计算），再点「开始」起音频；音频时钟是主时钟，渲染循环按 `chooseFrame` 取帧。推理跟不上时重复最后一帧，音频不等人。

- [ ] **Step 1: 写 compositor 的失败测试**

`avatar-core/test/photoreal/compositor.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { clampBox } from '../../src/spike/photoreal/compositor.ts';

describe('clampBox', () => {
  it('keeps a box inside the frame', () => {
    expect(clampBox({ x1: 100, y1: 50, x2: 300, y2: 400 }, 640, 480)).toEqual({
      x1: 100,
      y1: 50,
      x2: 300,
      y2: 400,
    });
  });

  it('clamps negative and oversized coordinates', () => {
    expect(clampBox({ x1: -10, y1: 5, x2: 700, y2: 480 }, 640, 480)).toEqual({
      x1: 0,
      y1: 5,
      x2: 640,
      y2: 480,
    });
  });

  it('forces a non-empty box', () => {
    expect(clampBox({ x1: 10, y1: 10, x2: 10, y2: 10 }, 640, 480)).toEqual({
      x1: 10,
      y1: 10,
      x2: 11,
      y2: 11,
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w avatar-core -- test/photoreal/compositor.test.ts
```

Expected: FAIL，报 `compositor.ts` 不存在。

- [ ] **Step 3: 写 compositor 实现**

`avatar-core/src/spike/photoreal/compositor.ts`：

```ts
import type { FaceBox } from './types.ts';

export function clampBox(box: FaceBox, width: number, height: number): FaceBox {
  const x1 = Math.max(0, Math.min(width - 1, Math.round(box.x1)));
  const y1 = Math.max(0, Math.min(height - 1, Math.round(box.y1)));
  const x2 = Math.max(x1 + 1, Math.min(width, Math.round(box.x2)));
  const y2 = Math.max(y1 + 1, Math.min(height, Math.round(box.y2)));
  return { x1, y1, x2, y2 };
}

export function drawComposite(
  ctx: CanvasRenderingContext2D,
  frame: CanvasImageSource,
  face: CanvasImageSource,
  patch: ImageData | null,
  box: FaceBox,
  patchCanvas: HTMLCanvasElement,
): void {
  const b = clampBox(box, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(frame, 0, 0);
  const w = b.x2 - b.x1;
  const h = b.y2 - b.y1;
  if (patch) {
    const patchCtx = patchCanvas.getContext('2d');
    if (!patchCtx) throw new Error('patch canvas 2d');
    patchCtx.putImageData(patch, 0, 0);
    ctx.drawImage(patchCanvas, b.x1, b.y1, w, h);
  } else {
    ctx.drawImage(face, b.x1, b.y1, w, h);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w avatar-core -- test/photoreal/compositor.test.ts
```

Expected: PASS，1 个文件 3 项通过。

- [ ] **Step 5: 写 assets 的失败测试与实现**

`avatar-core/test/photoreal/assets.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { pcmBytesToInt16 } from '../../src/spike/photoreal/assets.ts';

describe('pcmBytesToInt16', () => {
  it('views little-endian 16-bit samples', () => {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setInt16(0, 123, true);
    view.setInt16(2, -456, true);
    expect(Array.from(pcmBytesToInt16(buffer))).toEqual([123, -456]);
  });

  it('rejects an odd byte length', () => {
    expect(() => pcmBytesToInt16(new ArrayBuffer(3))).toThrow('pcm');
  });
});
```

`avatar-core/src/spike/photoreal/assets.ts`：

```ts
import { parseSampleManifest } from './manifest.ts';
import type { SampleManifest } from './types.ts';

export function pcmBytesToInt16(buffer: ArrayBuffer): Int16Array {
  if (buffer.byteLength % 2 !== 0) throw new Error('pcm: odd bytes');
  return new Int16Array(buffer);
}

export async function fetchManifest(url: string): Promise<SampleManifest> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`manifest ${response.status}`);
  return parseSampleManifest(await response.json());
}

export async function fetchImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image ${response.status}`);
  return createImageBitmap(await response.blob());
}

export async function fetchPcm(url: string): Promise<Int16Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`pcm ${response.status}`);
  return pcmBytesToInt16(await response.arrayBuffer());
}
```

```bash
npm test -w avatar-core -- test/photoreal/assets.test.ts
```

Expected: PASS，1 个文件 2 项通过。

- [ ] **Step 6: 写 metrics 的失败测试**

`avatar-core/test/photoreal/metrics.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { Metrics } from '../../src/spike/photoreal/metrics.ts';

describe('Metrics', () => {
  it('tracks inference, first lip, repeats and gaps', () => {
    const m = new Metrics();
    m.recordInference(10);
    m.recordInference(20);
    m.onShown(100, false, 0, true);
    m.onShown(140, true, 2, true);
    m.onShown(180, false, 0, false);
    const j = m.toJSON();
    expect(j.inferenceAvgMs).toBe(15);
    expect(j.inferenceMaxMs).toBe(20);
    expect(j.firstLipAfterAudioMs).toBe(100);
    expect(j.repeatedFrames).toBe(1);
    expect(j.maxBehind).toBe(2);
    expect(j.framesShown).toBe(3);
  });

  it('records interrupt latency once', () => {
    const m = new Metrics();
    m.interrupt(42);
    m.interrupt(99);
    expect(m.toJSON().interruptLatencyMs).toBe(42);
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

```bash
npm test -w avatar-core -- test/photoreal/metrics.test.ts
```

Expected: FAIL，报 `metrics.ts` 不存在。

- [ ] **Step 8: 写 metrics 实现**

`avatar-core/src/spike/photoreal/metrics.ts`：

```ts
/** Content-free measurements for the photoreal spike. */
export class Metrics {
  provider = '';
  modelLoadMs = 0;
  melBuildMs = 0;
  prebufferWaitMs = 0;
  firstLipAfterAudioMs: number | null = null;
  framesShown = 0;
  repeatedFrames = 0;
  maxBehind = 0;
  inferenceCount = 0;
  inferenceTotalMs = 0;
  inferenceMaxMs = 0;
  interruptLatencyMs: number | null = null;
  lastAudioMs = 0;

  recordInference(ms: number): void {
    this.inferenceCount++;
    this.inferenceTotalMs += ms;
    this.inferenceMaxMs = Math.max(this.inferenceMaxMs, ms);
  }

  onShown(audioMs: number, repeated: boolean, behind: number, hasPatch: boolean): void {
    this.framesShown++;
    if (repeated) this.repeatedFrames++;
    this.maxBehind = Math.max(this.maxBehind, behind);
    this.lastAudioMs = audioMs;
    if (hasPatch && this.firstLipAfterAudioMs === null) this.firstLipAfterAudioMs = audioMs;
  }

  interrupt(ms: number): void {
    if (this.interruptLatencyMs === null) this.interruptLatencyMs = ms;
  }

  toJSON(): Record<string, unknown> {
    const fps = this.lastAudioMs > 0 ? (this.framesShown * 1000) / this.lastAudioMs : 0;
    return {
      provider: this.provider,
      modelLoadMs: Math.round(this.modelLoadMs),
      melBuildMs: Math.round(this.melBuildMs),
      prebufferWaitMs: Math.round(this.prebufferWaitMs),
      firstLipAfterAudioMs: this.firstLipAfterAudioMs === null ? null : Math.round(this.firstLipAfterAudioMs),
      fps: Number(fps.toFixed(2)),
      framesShown: this.framesShown,
      repeatedFrames: this.repeatedFrames,
      maxBehind: this.maxBehind,
      inferenceCount: this.inferenceCount,
      inferenceAvgMs: this.inferenceCount === 0 ? 0 : Number((this.inferenceTotalMs / this.inferenceCount).toFixed(2)),
      inferenceMaxMs: Number(this.inferenceMaxMs.toFixed(2)),
      interruptLatencyMs: this.interruptLatencyMs === null ? null : Math.round(this.interruptLatencyMs),
    };
  }
}
```

- [ ] **Step 9: 跑测试确认通过**

```bash
npm test -w avatar-core -- test/photoreal/metrics.test.ts
```

Expected: PASS，1 个文件 2 项通过。

- [ ] **Step 10: 写页面**

`avatar-core/src/spike/photoreal/page.ts`：

```ts
import { int16ToFloat32, LinearResampler } from '../../audio/pcm.ts';
import { fetchImage, fetchManifest, fetchPcm } from './assets.ts';
import { AudioClock } from './audioClock.ts';
import { chooseFrame } from './frameScheduler.ts';
import { drawComposite } from './compositor.ts';
import { DEFAULT_PHOTOREAL_CONFIG } from './config.ts';
import { packFace, patchToRgba } from './face.ts';
import { melWindow, MelSpectrogram } from './mel.ts';
import filterbank from './mel-filterbank.json';
import { Metrics } from './metrics.ts';
import { packBatch, Wav2LipRunner } from './wav2lipRunner.ts';

const cfg = DEFAULT_PHOTOREAL_CONFIG;
const FACE = cfg.faceSize;
const BATCH = cfg.batchFrames;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

export async function startPage(): Promise<void> {
  const canvas = el<HTMLCanvasElement>('stage');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d');
  const status = el<HTMLPreElement>('status');
  const startBtn = el<HTMLButtonElement>('start');
  const interruptBtn = el<HTMLButtonElement>('interrupt');
  const copyBtn = el<HTMLButtonElement>('copy');
  startBtn.disabled = true;
  interruptBtn.disabled = true;
  copyBtn.disabled = true;

  const stats = new Metrics();
  const forceWasm = new URLSearchParams(location.search).get('ep') === 'wasm';
  const webgpu = !forceWasm && 'gpu' in navigator;
  stats.provider = webgpu ? 'webgpu' : 'wasm';

  status.textContent = 'loading manifest...';
  const manifest = await fetchManifest('/spike/photoreal/manifest.json');
  canvas.width = manifest.width;
  canvas.height = manifest.height;

  status.textContent = `loading ${manifest.frames.length} frames...`;
  const frames = await Promise.all(manifest.frames.map((f) => fetchImage(f.frameUrl)));
  const faces = await Promise.all(manifest.frames.map((f) => fetchImage(f.faceUrl)));
  const faceRgba = faces.map((bitmap) => {
    const c = document.createElement('canvas');
    c.width = FACE;
    c.height = FACE;
    const g = c.getContext('2d');
    if (!g) throw new Error('face 2d');
    g.drawImage(bitmap, 0, 0, FACE, FACE);
    return g.getImageData(0, 0, FACE, FACE).data;
  });

  status.textContent = 'loading pcm...';
  const pcm24 = await fetchPcm(manifest.pcmUrl);
  const pcm16 = new LinearResampler(manifest.pcmSampleRate, cfg.melSampleRate).process(int16ToFloat32(pcm24));

  status.textContent = 'building mel...';
  const melStart = performance.now();
  const mel = new MelSpectrogram(filterbank);
  const melData = mel.process(pcm16);
  stats.melBuildMs = performance.now() - melStart;

  status.textContent = 'loading model...';
  const modelStart = performance.now();
  const runner = await Wav2LipRunner.create('/spike/photoreal/wav2lip.onnx', { webgpu });
  stats.modelLoadMs = performance.now() - modelStart;
  stats.provider = runner.provider;
  startBtn.disabled = false;

  const total = manifest.frames.length;
  const patches: (ImageData | null)[] = new Array(total).fill(null);
  const patchCanvas = document.createElement('canvas');
  patchCanvas.width = FACE;
  patchCanvas.height = FACE;

  let readyThrough = -1;
  let nextFrame = 0;
  let lastShown = -1;
  let closedShown = false;
  let interrupted = false;
  let running = false;
  let finished = false;
  let source: AudioBufferSourceNode | null = null;
  let audioCtx: AudioContext | null = null;
  let clock: AudioClock | null = null;
  let prebufferResolve: (() => void) | null = null;
  let prebufferTimer: ReturnType<typeof setTimeout> | null = null;

  const showReady = (): void => {
    status.textContent = [
      `provider=${stats.provider}`,
      `frames=${total}`,
      `ready=${readyThrough + 1}/${total}`,
      `modelLoad=${Math.round(stats.modelLoadMs)} ms`,
      `melBuild=${Math.round(stats.melBuildMs)} ms`,
      `melFrames=${mel.frames}`,
      `webgpu=${webgpu ? 'requested' : 'off'}`,
    ].join('\n');
  };
  showReady();

  function resolvePrebuffer(): void {
    if (readyThrough >= cfg.prebufferFrames && prebufferResolve) {
      prebufferResolve();
      prebufferResolve = null;
    }
  }

  async function fill(): Promise<void> {
    while (nextFrame < total && !interrupted) {
      const count = Math.min(BATCH, total - nextFrame);
      const melWindows: Float32Array[] = [];
      const faceTensors: Float32Array[] = [];
      for (let i = 0; i < count; i++) {
        const f = nextFrame + i;
        melWindows.push(melWindow(melData, mel.frames, cfg.melBins, f, cfg.fps, cfg.melWindow));
        faceTensors.push(packFace(faceRgba[f], FACE));
      }
      const packed = packBatch(melWindows, faceTensors, count, BATCH, cfg.melWindow, FACE, cfg.melBins);
      const started = performance.now();
      const out = await runner.infer(packed, BATCH);
      stats.recordInference(performance.now() - started);
      for (let i = 0; i < count; i++) {
        patches[nextFrame + i] = new ImageData(patchToRgba(out, i * 3 * FACE * FACE, FACE), FACE, FACE);
      }
      nextFrame += count;
      while (readyThrough + 1 < total && patches[readyThrough + 1]) readyThrough++;
      resolvePrebuffer();
      showReady();
      while (
        !interrupted &&
        clock?.started &&
        audioCtx &&
        nextFrame - clock.frameAt(audioCtx.currentTime) > cfg.maxAheadFrames
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  function draw(frame: number, patch: ImageData | null): void {
    const meta = manifest.frames[frame];
    if (!meta) return;
    drawComposite(ctx, frames[frame], faces[frame], patch, meta.box, patchCanvas);
  }

  function render(): void {
    if (!clock?.started || !audioCtx) return;
    const audioMs = clock.mediaMsAt(audioCtx.currentTime);
    const choice = chooseFrame(audioMs, readyThrough, cfg.fps, total);
    if (choice.frame >= 0) {
      if (choice.frame !== lastShown) {
        lastShown = choice.frame;
        const patch = patches[choice.frame];
        draw(choice.frame, patch);
        stats.onShown(audioMs, choice.repeated, choice.behind, patch !== null);
      }
    } else if (!closedShown) {
      draw(0, null);
      closedShown = true;
    }
    const durationMs = (pcm24.length / manifest.pcmSampleRate) * 1000;
    if (!interrupted && audioMs < durationMs - 1000 / cfg.fps) requestAnimationFrame(render);
    else if (!interrupted) finish();
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    running = false;
    startBtn.disabled = false;
    interruptBtn.disabled = true;
    copyBtn.disabled = false;
    status.textContent = JSON.stringify(stats.toJSON(), null, 2);
  }

  async function start(): Promise<void> {
    if (running) return;
    running = true;
    finished = false;
    interrupted = false;
    startBtn.disabled = true;
    interruptBtn.disabled = false;
    copyBtn.disabled = true;
    audioCtx = new AudioContext({ sampleRate: manifest.pcmSampleRate, latencyHint: 'interactive' });
    clock = new AudioClock(cfg.fps);
    const waitStart = performance.now();
    await Promise.race([
      new Promise<void>((resolve) => {
        prebufferResolve = resolve;
        resolvePrebuffer();
      }),
      new Promise<void>((resolve) => {
        prebufferTimer = setTimeout(resolve, cfg.firstLipTimeoutMs);
      }),
    ]);
    if (prebufferTimer) clearTimeout(prebufferTimer);
    stats.prebufferWaitMs = performance.now() - waitStart;

    const buffer = audioCtx.createBuffer(1, pcm24.length, manifest.pcmSampleRate);
    buffer.copyToChannel(int16ToFloat32(pcm24), 0);
    source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.onended = () => {
      if (!interrupted) finish();
    };
    draw(0, null);
    closedShown = true;
    source.start();
    clock.start(audioCtx.currentTime);
    requestAnimationFrame(render);
  }

  function interrupt(): void {
    if (!running || interrupted || !audioCtx || !clock) return;
    const started = performance.now();
    const playedMs = clock.mediaMsAt(audioCtx.currentTime);
    const frame = Math.max(0, Math.min(total - 1, clock.frameAt(audioCtx.currentTime)));
    interrupted = true;
    source?.stop();
    draw(frame, null);
    let ticks = 0;
    const closeMouth = (): void => {
      draw(frame, null);
      if (++ticks < 2) requestAnimationFrame(closeMouth);
      else {
        stats.interrupt(performance.now() - started);
        status.textContent = `interrupted at ${Math.round(playedMs)} ms\n${JSON.stringify(stats.toJSON(), null, 2)}`;
        running = false;
        startBtn.disabled = false;
        interruptBtn.disabled = true;
        copyBtn.disabled = false;
      }
    };
    requestAnimationFrame(closeMouth);
  }

  startBtn.addEventListener('click', () => {
    void start().catch((error) => {
      status.textContent = `start failed: ${String(error)}`;
      running = false;
      startBtn.disabled = false;
      interruptBtn.disabled = true;
    });
  });
  interruptBtn.addEventListener('click', interrupt);
  copyBtn.addEventListener('click', () => {
    void navigator.clipboard.writeText(JSON.stringify(stats.toJSON(), null, 2));
  });

  void fill().catch((error) => {
    status.textContent = `fill failed: ${String(error)}`;
    startBtn.disabled = true;
  });
}
```

`avatar-core/photoreal/src/main.ts` 替换为：

```ts
import { startPage } from '../../src/spike/photoreal/page.ts';

void startPage();
```

- [ ] **Step 11: 浏览器端到端手测**

```bash
npm run dev:photoreal -w avatar-core
```

打开 `http://127.0.0.1:5174/`，按顺序确认：
1. 页面显示 `provider=webgpu`、帧数约 250、`melFrames` 约 801；
2. 点「开始」后音频播放，嘴跟着动；
3. 播放结束后状态显示 JSON 指标；
4. 点「开始」重播一次仍可用（刷新页面后测更干净）；
5. `?ep=wasm` 能加载（速度可能很慢，只确认能跑）。

Expected: 第 1–4 项通过；`?ep=wasm` 至少能加载并出帧。把控制台错误、`modelLoadMs`、`melBuildMs`、`prebufferWaitMs`、`firstLipAfterAudioMs`、`inferenceAvgMs` 记进 T7 报告。

如果页面显示 `model failed` 或 `fill failed`：先确认 ONNX 存在、页面从 5174 端口打开、manifest URL 是 `/spike/photoreal/...`；不要通过改 `base` 或把大资产放进主 `public/` 来绕过。

- [ ] **Step 12: 回归与提交**

```bash
npm test -w avatar-core
npm run typecheck -w avatar-core
git add avatar-core/src/spike/photoreal/compositor.ts \
  avatar-core/src/spike/photoreal/assets.ts \
  avatar-core/src/spike/photoreal/metrics.ts \
  avatar-core/src/spike/photoreal/page.ts \
  avatar-core/photoreal/src/main.ts \
  avatar-core/test/photoreal/compositor.test.ts \
  avatar-core/test/photoreal/assets.test.ts \
  avatar-core/test/photoreal/metrics.test.ts
git commit -m "feat(photoreal): render a fixed talking-face clip in the browser"
```
