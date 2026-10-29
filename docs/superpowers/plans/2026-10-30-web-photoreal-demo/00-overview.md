# Web 端真人说话头 Demo（路线 C）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在桌面 Chrome 里用浏览器本地推理，把一段固定 24 kHz PCM 驱动成一张会说话的真人人脸，并测出 S1–S5；过关后才进入接网关的交互阶段。

**Architecture:** 独立 Vite root `avatar-core/photoreal/` 承载页面与大资产，纯 TypeScript 模块放在 `avatar-core/src/spike/photoreal/`；ONNX Runtime Web（WebGPU，WASM 回退）跑 Wav2Lip；WebAudio 播放 PCM 作为主时钟；Canvas 合成源帧与 96×96 嘴部块。独立 root 保证模型/视频不会进入 `scripts/build-web.sh` 的 APK 产物。

**Tech Stack:** TypeScript 7 / Vite 8 / vitest 5 / onnxruntime-web 1.30.0；桌面 Chrome/Edge WebGPU；Python 3 仅用于离线导出模型、预处理样本和生成 mel 基准；Wav2Lip `bac9a81e63ecc153202353372e5724b83d9e6322`（研究用，非商用）；macOS 26 / Apple M3 Max。

**Spec:** `docs/research/2026-10-30-web-photoreal-avatar-options.md`（调研与方案）；`docs/superpowers/specs/2026-10-25-duix-avatar-engine-design.md`（Android Duix 的效果锚点）。本 overview 的「已确认决策」是 grilling 后用户确认的约束，与这两份文档冲突时以本 overview 为准。

## 已确认决策

| # | 决策 |
|---|---|
| P1 | 本次只做研究/可行性 demo，不考虑商业授权；Wav2Lip 等非商用模型可用于本 demo。 |
| P2 | 先做固定音频 + 一张脸；S1–S5 过关后才做接网关的交互阶段。 |
| P3 | 渲染路线优先浏览器本地推理（C）；不过关才评估 B（自建 GPU 拉流）。 |
| P4 | 目标机是本机 MacBook Pro M3 Max / 36 GB / macOS 26.3.1；浏览器用 Chrome 或 Edge（当前只装了 Safari）。 |
| P5 | 先用公开研究样本；确认性能后再换自备真人视频。 |
| P6 | 验收用 S1–S5 + 与 Android Duix 并排盲测；20 fps 是最低线，24 fps 是目标。 |
| P7 | 阶段 a 不接网关；阶段 b 复用现有网关、协议、记忆、打断语义。 |
| P8 | 不改 `gateway/`、`protocol/`、`app/`、`scripts/build-web.sh`；只在 `avatar-core/`、`scripts/photoreal/`、`docs/` 内工作。 |
| P9 | 不提交模型、视频和大资产；资产由脚本下载/生成，哈希固定在 `scripts/photoreal-assets.lock.json`。 |
| P10 | 不新增 npm workspace；复用 `avatar-core` 已有的 `onnxruntime-web`、Vite、vitest。 |

## Global Constraints

- 回复用简体中文；代码注释用英文，短。
- 只用公开研究样本或合成语音；不接触用户对话内容。日志只记事件、计数、耗时、错误码。
- 不提交密钥；`.env*` 继续忽略。本计划不需要任何 API Key。
- 模型/视频/帧序列/PCM 都落在 `avatar-core/photoreal/public/spike/photoreal/`，该目录与 `dist-photoreal/` 一起 gitignore。只提交脚本、锁文件、小体积的 mel filterbank/基准和小体积报告。
- Wav2Lip 只用于研究 demo；产品化时许可会重新成为门槛，本计划不处理。
- 目标浏览器只考虑桌面 Chrome/Edge；Safari、Firefox、手机浏览器不在范围。
- 关键逻辑用 TDD：先写失败测试，确认失败，再实现，确认通过，然后提交。每任务结束跑 `npm test -w avatar-core` 和 `npm run typecheck -w avatar-core`；报告真实命令与结果。
- 不新增 npm 依赖。Python 依赖只存在于 `scripts/photoreal/requirements.txt`，不进产品依赖。
- 大模型/视频下载失败、ONNX 导出失败或 WebGPU 不可用时，按各任务的停止规则停下报告，不静默换方案。
- 提交信息按执行时会话的系统要求署名；本计划示例只写标题。

## 任务与依赖

| 文件 | Task | 内容 | 依赖 |
|---|---|---|---|
| `01-t1-scaffold-assets.md` | T1 | 独立 Vite root、配置/manifest 解析、资产脚本、模型导出、样本预处理 | — |
| `02-t2-timing-core.md` | T2 | `AudioClock`、`chooseFrame` 与单元测试 | T1 |
| `03-t3-mel.md` | T3 | mel 前端、filterbank、Python 基准与对齐测试 | T1 |
| `04-t4-wav2lip-runner.md` | T4 | `packFace`、`packBatch`、`Wav2LipRunner`（ORT Web） | T1, T3 |
| `05-t5-compositor-e2e.md` | T5 | Canvas 合成、页面接线、固定片段端到端 | T2, T4 |
| `06-t6-interrupt-offline.md` | T6 | 打断、闭嘴帧、离线、指标 JSON | T5 |
| `07-t7-benchmark.md` | T7 | 3 轮基准、WASM 对照、S1–S5 判定、模型/参数决策 | T6 |
| `08-t8-blind-test-report.md` | T8 | Android Duix 并排盲测、报告、研究文档回写、下一步 | T7 |

顺序执行。T2 与 T3 技术上可并行，但本计划按一个执行者串行，避免共享文件冲突。T7 若判定失败，T8 只写失败报告，不做盲测。

## 命令

```bash
# 页面（dev）
npm run dev:photoreal -w avatar-core          # http://127.0.0.1:5174/
# 测试与类型检查
npm test -w avatar-core
npm run typecheck -w avatar-core
# 生产构建必须不含 photoreal
npm run build -w avatar-core
test ! -e avatar-core/dist/photoreal/index.html
# 资产（先手动下载 checkpoint 到 build/photoreal/wav2lip_gan.pth）
./scripts/photoreal/build-assets.sh
# 独立构建（可选，产物在 avatar-core/dist-photoreal/）
npm run build:photoreal -w avatar-core
```

## 共享接口（冻结）

`avatar-core/src/spike/photoreal/types.ts`：

```ts
export interface FaceBox { x1: number; y1: number; x2: number; y2: number }

export interface FrameMeta {
  index: number;
  frameUrl: string; // full frame, "/spike/photoreal/frames/frame-000.webp"
  faceUrl: string;  // 96x96 face crop, "/spike/photoreal/faces/face-000.webp"
  box: FaceBox;
}

export interface SampleManifest {
  name: string;
  fps: number;                 // 25
  width: number;
  height: number;
  pcmUrl: string;              // "/spike/photoreal/speech-24k.pcm"
  pcmSampleRate: number;       // 24000
  frames: FrameMeta[];
}

export interface PhotorealConfig {
  fps: number;                 // 25
  melSampleRate: number;       // 16000
  melBins: number;             // 80
  melWindow: number;           // 16
  faceSize: number;            // 96
  batchFrames: number;         // 8
  prebufferFrames: number;     // 6
  firstLipTimeoutMs: number;   // 300
  maxAheadFrames: number;      // 25
}
```

模块 API：

- `config.ts`：`DEFAULT_PHOTOREAL_CONFIG`、`parsePhotorealConfig(raw: unknown): PhotorealConfig`。
- `manifest.ts`：`parseSampleManifest(raw: unknown): SampleManifest`。
- `audioClock.ts`：`class AudioClock { constructor(fps: number); start(ctxTime: number): void; reset(): void; get started(): boolean; mediaMsAt(ctxTime: number): number; frameAt(ctxTime: number): number }`。
- `frameScheduler.ts`：`chooseFrame(audioMs: number, readyThrough: number, fps: number, totalFrames: number): { frame: number; repeated: boolean; behind: number }`。
- `mel.ts`：`interface MelFilterbank { bins: number; fftBins: number; data: number[][] }`、`class MelSpectrogram { constructor(filterbank: MelFilterbank); process(pcm16k: Float32Array): Float32Array; get frames(): number }`、`melWindow(mel: Float32Array, frames: number, bins: number, frameIndex: number, fps: number, step?: number): Float32Array`。
- `face.ts`：`packFace(rgba: Uint8ClampedArray, size?: number): Float32Array`、`patchToRgba(patch: Float32Array, offset: number, size?: number): Uint8ClampedArray`。
- `wav2lipRunner.ts`：`packBatch(melWindows: Float32Array[], faces: Float32Array[], count: number, batchFrames: number, melWindow: number, faceSize: number): { mel: Float32Array; img: Float32Array }`、`class Wav2LipRunner { static create(modelUrl: string, opts: { webgpu: boolean }): Promise<Wav2LipRunner>; infer(packed: { mel: Float32Array; img: Float32Array }, batchFrames: number): Promise<Float32Array>; readonly provider: string }`。
- `compositor.ts`：`clampBox(box: FaceBox, width: number, height: number): FaceBox`、`drawComposite(ctx: CanvasRenderingContext2D, frame: CanvasImageSource, face: CanvasImageSource, patch: ImageData | null, box: FaceBox, patchCanvas: HTMLCanvasElement): void`。
- `assets.ts`：`pcmBytesToInt16(buffer: ArrayBuffer): Int16Array`、`fetchManifest(url: string): Promise<SampleManifest>`、`fetchImage(url: string): Promise<ImageBitmap>`、`fetchPcm(url: string): Promise<Int16Array>`。
- `interrupt.ts`：`interruptedAt(clock: AudioClock, ctxTime: number, totalFrames: number): { frame: number; playedMs: number }`。
- `metrics.ts`：`class Metrics { provider: string; offline: boolean; firstLipAfterAudioMs: number | null; ...; recordInference(ms: number): void; onShown(audioMs: number, repeated: boolean, behind: number, hasPatch: boolean): void; interrupt(ms: number): void; markOffline(): void; toJSON(): Record<string, unknown> }`。

资产目录（gitignored）：

```text
avatar-core/photoreal/public/spike/photoreal/
  manifest.json
  speech-24k.pcm
  wav2lip.onnx
  frames/frame-000.webp ...
  faces/face-000.webp ...
```

提交的小资产：

```text
avatar-core/src/spike/photoreal/mel-filterbank.json   # 80x401, generated by scripts/photoreal/make_mel_fixture.py
avatar-core/test/fixtures/photoreal/mel-fixture.json   # pcm16 + expected mel
scripts/photoreal-assets.lock.json                     # urls + sha256 + bytes
```

## 验收门槛

| # | 条 | 过 | 勉强 | 不过 |
|---|---|---|---|---|
| S1 | 稳态出帧（持续 ≥10 s） | ≥24 fps | 20–23.9 fps | <20 fps |
| S2 | 冷启动：预缓冲等待 + 音频起播→第一次嘴动 | 合计 ≤300 ms | 合计 301–500 ms | 合计 >500 ms |
| S3 | 打断 → 停声且闭嘴 | ≤100 ms 停声，2 帧内闭嘴 | — | 超过 |
| S4 | 断网 | 模型/帧加载完后断网可推理 | — | 需要网络 |
| S5 | 机型写明 | CPU/GPU/macOS/浏览器版本齐全 | — | 缺 |

**明确不算过关**：只能离线导出短视频；只有 CPU WASM 个位数 fps；只有静音循环脸、没有音频驱动。

**盲测**：同一段文本、相近构图（脸可以不同），Android Duix 与 Web demo 各录一段；不看标签，评价「真人感 / 口型跟声 / 打断」，不觉得 Web 明显更差。不同脸/不同录音设备是已知限制，报告里必须写明。

**停止规则**：T7 结束若 S1 <20 fps 或 S2 >500 ms，停 C，不进入 T8 的正式盲测；写报告并给出 B 的一周 spike 建议。若只有 S1 在 20–23.9 fps，记录为「勉强」，由用户决定是否继续 T8。

## 风险

- Wav2Lip 的 96×96 嘴部块可能偏软，真人感可能不如 Duix。T7 先用不同源视频/checkpoint/batch/fp16 对比；仍不够则停 C。Ultralight/FeatherTalk 需要按人训练、不同输入前端和授权核实，另立计划评估，本计划不临时移植。
- ORT WebGPU 仍是 experimental；算子缺口或性能不达标时回退 WASM，WASM 很可能低于 20 fps，按停止规则处理。
- mel 的 JS 直接 DFT 可能偏慢；T3 先测，超过预算再做混合基 FFT 或 ONNX STFT，不在 T3 提前优化。
- 模型约数百 MB；页面加载和 WebGPU 初始化可能数秒。报告记录 `modelLoadMs`，不把加载时间算进口型延迟。
- M3 Max 不能代表 Windows 独显或普通用户机器；S5 写明，结论只对目标机成立。
- 公开样本的版权/肖像只用于研究 demo；不要把它放进产品路径。

## 过关后的阶段 b（本计划不做）

- 在 `avatar-core/src/app.ts` 增加 `PhotorealView` 开关；从 `PlaybackController` 的 PCM 路径 tap 数据，用 `playedMsFor(seq)` 作为口型时钟；不改 gateway/protocol。
- 交互阶段预计 3–5 人月，另立计划；先跑 `npm test -w avatar-core`、`npm run typecheck -w avatar-core`，再做桌面浏览器验收。

## 不过关的 B 保底（本计划不做）

- MuseTalk/LiveTalking + WebRTC（LiveKit）或 MSE；一台 GPU；1 周 spike；对比画质、延迟、成本；隐私模型变化（音频/画面上云）必须单独记录并征得用户同意。

## 文档回写

- T8 结束把「Wav2Lip 非商用、没有浏览器 ≥20 fps 公开证据、ORT WebGPU experimental」补进 `docs/research/2026-10-30-web-photoreal-avatar-options.md` 的 C 节，并写本次结论。
- T8 更新 `docs/project/roadmap.md` 的状态、下一步与真实测试结果。
- 报告写 `docs/testing/2026-10-30-web-photoreal-spike.md`；截图/录屏留在本机，不提交。
