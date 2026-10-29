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
  if (cfg.melBins !== 80 || cfg.melWindow !== 16 || cfg.faceSize !== 96 || cfg.batchFrames !== 8) {
    throw new Error('photoreal: model dimensions do not match the exported ONNX');
  }
  const canvas = el<HTMLCanvasElement>('stage');
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('canvas 2d');
  // Explicit type: tsgo does not keep const narrowing inside function declarations.
  const ctx: CanvasRenderingContext2D = ctx2d;
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
        // DOM typings want ArrayBuffer-backed views; patchToRgba allocates one.
        const rgba = patchToRgba(out, i * 3 * FACE * FACE, FACE) as Uint8ClampedArray<ArrayBuffer>;
        patches[nextFrame + i] = new ImageData(rgba, FACE, FACE);
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
    // DOM typings want ArrayBuffer-backed views; int16ToFloat32 allocates one.
    const samples = int16ToFloat32(pcm24) as Float32Array<ArrayBuffer>;
    buffer.copyToChannel(samples, 0);
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
