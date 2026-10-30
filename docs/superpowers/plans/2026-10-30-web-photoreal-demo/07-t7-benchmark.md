# Task 7: 基准、S1–S5 判定与模型/参数决策

**Files:**
- Create: `docs/testing/2026-10-30-web-photoreal-spike.md`
- Modify: `docs/research/2026-10-30-web-photoreal-avatar-options.md`（追加 2026-10-30 spike 结果，不改原结论）
- Modify: `docs/blockers.md`（只在卡住时）

**Interfaces:**
- Consumes: T5/T6 的页面与 `photoreal-metrics.json`。
- Produces: 一份可复核的 S1–S5 结果；一个明确的继续/停止决定。

背景：这一关决定路线 C 是否继续。不要用单次最好成绩；每个配置至少 3 次，取中位数。`fps` 是「不同帧数 / 播放秒数」，不是 rAF 次数；页面已按帧号变化计数。

- [x] **Step 1: 记录环境**

```bash
system_profiler SPHardwareDataType | grep -E "Model Name|Chip|Memory"
sw_vers
```

在 Chrome 打开 `chrome://version` 记录版本；打开 `chrome://gpu` 确认 `WebGPU: Hardware accelerated`。接通电源，关闭其他大应用，显示器用默认缩放。

- [x] **Step 2: 预热跑 3 次（WebGPU）**

每次：刷新 `http://127.0.0.1:5174/` → 等状态 `ready=总帧数/总帧数` → 点「开始」→ 播完 → 点「下载指标」，把文件依次另存为 `run-warm-1.json`、`run-warm-2.json`、`run-warm-3.json`（放 `/tmp/photoreal/`，不提交）。

```bash
mkdir -p /tmp/photoreal
```

记录每次的：`fps`、`firstLipAfterAudioMs`、`prebufferWaitMs`、`inferenceAvgMs`、`inferenceMaxMs`、`repeatedFrames`、`maxBehind`、`modelLoadMs`、`melBuildMs`。

- [x] **Step 3: 冷启动跑 1 次（WebGPU）**

刷新后立刻点「开始」（不等 `ready`），记录 `prebufferWaitMs` 与 `firstLipAfterAudioMs`。这一次回答「用户点开始到嘴动要等多久」，S2 的体感以此为准。

- [x] **Step 4: WASM 对照 1 次**

打开 `http://127.0.0.1:5174/?ep=wasm`，等 `ready`，开始、播完、下载。记录 `fps` 与 `inferenceAvgMs`。WASM 只作为回退证据，不要求过 S1。

- [x] **Step 5: 打断 3 次**

每次：开始，约 2 秒后点「打断」。记录 `interruptLatencyMs`、`playedMs`，并确认：声音立刻停；画面在 2 个 rAF 内回到源脸闭嘴；没有继续出嘴型。

- [x] **Step 6: 离线 1 次**

刷新，等 `ready`；DevTools → Network → Offline；点「开始」；播完下载。确认 JSON 的 `offline: true`，且控制台没有新的网络请求失败。

- [x] **Step 7: 填报告**

`docs/testing/2026-10-30-web-photoreal-spike.md` 用下面的结构（把 `...` 换成真实值；没有跑的写 `NOT RUN`，不要写「通过」）：

```markdown
# 2026-10-30 Web photoreal spike

## Environment

- Machine: MacBook Pro M3 Max / 36 GB / macOS 26.3.1
- Browser: Chrome <version>, WebGPU: Hardware accelerated
- Sample: sync-example, 10 s, 25 fps, 250 frames
- Model: wav2lip_gan ONNX, batch 8, fp32
- Command: `npm run dev:photoreal -w avatar-core` → http://127.0.0.1:5174/

## Warm runs (WebGPU)

| run | fps | firstLip ms | prebuffer ms | inference avg/max ms | repeated | maxBehind | modelLoad ms | melBuild ms |
|---|---|---|---|---|---|---|---|---|
| 1 | ... | ... | ... | ... | ... | ... | ... | ... |
| 2 | ... | ... | ... | ... | ... | ... | ... | ... |
| 3 | ... | ... | ... | ... | ... | ... | ... | ... |
| median | ... | ... | ... | ... | ... | ... | ... | ... |

## Cold run

- prebufferWaitMs: ...
- firstLipAfterAudioMs: ...

## WASM comparison

- fps: ...
- inferenceAvgMs: ...

## Interrupt

| run | interruptLatencyMs | playedMs | mouth closed |
|---|---|---|---|
| 1 | ... | ... | yes/no |
| 2 | ... | ... | yes/no |
| 3 | ... | ... | yes/no |

## Offline

- offline: true/false
- note: ...

## S1–S5

| # | 条 | 实测 | 判定 |
|---|---|---|---|
| S1 | 稳态 ≥24 fps；20–23.9 勉强；<20 不过 | ... | pass/marginal/fail |
| S2 | 音频起播→嘴动 ≤300 ms；301–500 勉强 | ... | pass/marginal/fail |
| S3 | 打断 ≤100 ms 停声、2 帧内闭嘴 | ... | pass/fail |
| S4 | 模型缓存后断网可推理 | ... | pass/fail |
| S5 | 机型/浏览器写明 | 见上 | pass |

## Decision

- C: continue / stop
- Reason: ...
- If stop: recommended next step (B one-week spike / Ultralight or FeatherTalk follow-up / E)

## Limitations

- M3 Max is not representative of Windows dGPUs.
- The sample face and the Android Duix Lily face are different.
- ...
```

- [x] **Step 8: 判定与决策**

按中位数判定：

- **S1**：≥24 fps 通过；20–23.9 勉强；<20 不过。
- **S2**：冷启动的 `prebufferWaitMs + firstLipAfterAudioMs` 若 ≤300 ms 通过；301–500 勉强；>500 不过。同时记录 `firstLipAfterAudioMs` 本身，区分「推理慢」与「预缓冲等待」。
- **S3**：3 次都 ≤100 ms 且闭嘴通过；否则记录最大一次。
- **S4**：断网跑通且 `offline: true`。
- **S5**：环境齐全。

判定后的动作：

| 结果 | 动作 |
|---|---|
| S1 ≥20 且 S2 ≤500，S3/S4 通过 | 进入 T8 盲测；S1/S2 的「勉强」在报告里明确写 |
| S1 <20 或 S2 >500 | 停 C，写失败报告，不进入 T8 |
| 性能过、真人感明显不够 | 停 C 或转入「换模型」新计划；不要在本计划里临时移植 Ultralight |

- [ ] **Step 9: 允许的调参（最多 2 个工作日）**

未触发：S1 与 S2 均通过，不做调参。

只在 S1/S2 失败时做，按顺序，每次只改一个变量：

1. **batch 大小**：把 `export_wav2lip.py --batch` 改成 4 或 16，重新导出到 `wav2lip-b4.onnx`/`wav2lip-b16.onnx`，页面通过 `?model=b4` 选择。`page.ts` 把创建 runner 的两行换成：

```ts
const modelName = new URLSearchParams(location.search).get('model') ?? '';
const modelFile = modelName ? `/spike/photoreal/wav2lip-${modelName}.onnx` : '/spike/photoreal/wav2lip.onnx';
const BATCH = modelName === 'b4' ? 4 : modelName === 'b16' ? 16 : cfg.batchFrames;
const runner = await Wav2LipRunner.create(modelFile, { webgpu });
```

   注意：`BATCH` 目前在模块顶部；把它移到 `startPage` 里，或改成 `let batchFrames` 再传给 `packBatch`/`infer`。`Wav2LipRunner.infer` 的 `[B,...]` 维度必须和 `BATCH` 一致。记录 fps 与 `inferenceAvgMs`。
2. **fp16**：用 `onnxconverter_common.float16` 把 `wav2lip.onnx` 转成 `wav2lip-fp16.onnx`，页面 `?model=fp16`；如果 ORT WebGPU 报不支持算子，记录并回退 fp32。
3. **非 GAN checkpoint**：下载官方 `wav2lip.pth`，重新导出 `wav2lip-plain.onnx`，页面 `?model=plain`；只用于画质/口型对比，不改变性能结论。

每次实验都要刷新页面、等 `ready`、跑 3 次。2 天后仍不过 S1/S2，停，不再扩展。

- [x] **Step 10: 更新研究文档**

在 `docs/research/2026-10-30-web-photoreal-avatar-options.md` 末尾追加（不改原文的选项表）：

```markdown
## 2026-10-30 spike 结果（路线 C）

- Wav2Lip 官方 README 明确禁止商用；本 spike 只用于研究 demo。产品化必须换许可干净的模型。
- 公开检索没有找到 Wav2Lip / Ultralight / MuseTalk / LivePortrait / SadTalker 在浏览器 WebGPU 上 ≥20 fps 的 demo 或 benchmark。
- ORT WebGPU 仍是 experimental；桌面 Chrome/Edge 可用，Safari/Firefox 不在支持范围。
- 实测（M3 Max / Chrome <version> / 10 s / 25 fps / batch 8 / fp32）：
  - 中位 fps：...
  - 音频起播→嘴动：... ms（冷启动预缓冲 ... ms）
  - 打断：... ms
  - 断网：pass/fail
- 结论：...（C 继续 / 停止并评估 B / 换模型另立计划）
```

- [x] **Step 11: 提交**

```bash
npm test -w avatar-core
npm run typecheck -w avatar-core
git add docs/testing/2026-10-30-web-photoreal-spike.md \
  docs/research/2026-10-30-web-photoreal-avatar-options.md
git commit -m "docs(photoreal): record the browser spike results"
```

如果 Step 9 改了代码，把改动的文件按明确路径一起提交，并在提交信息里写 `exp(photoreal): ...`。
