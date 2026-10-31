# 小白版：photoreal-spike 到底做了什么，模型是怎么在浏览器里跑起来的

日期：2026-10-30  
分支：`photoreal-spike`（worktree `.worktrees/photoreal-spike`）  
配套文档：

- 方案调研：[2026-10-30-web-photoreal-avatar-options.md](2026-10-30-web-photoreal-avatar-options.md)
- 计划与决策：[00-overview.md](../superpowers/plans/2026-10-30-web-photoreal-demo/00-overview.md)
- 实测报告：[2026-10-30-web-photoreal-spike.md](../testing/2026-10-30-web-photoreal-spike.md)

---

## 0. 先回答你最关心的几个问题

| 问题 | 一句话回答 |
|---|---|
| 这个 spike 做了什么？ | 在桌面 Chrome 里，用浏览器本地推理，把一段固定中文语音驱动到一张真人脸上，让嘴型跟着声音动；实测 25 fps、首口型 59 ms、打断 10–13 ms、断网可跑。 |
| 模型是怎么跑起来的？ | 离线用 Python 把 Wav2Lip 的 PyTorch 权重导出成 ONNX；浏览器用 ONNX Runtime Web 的 WebGPU 后端加载 ONNX；TypeScript 负责算 mel、批量推理、按音频时钟贴嘴、合成画面。 |
| 能随便给一段视频就跑吗？ | **网页里不能拖拽上传**。脚本支持任意视频，但要先离线跑一遍 Python 预处理（人脸检测、抽帧、裁 96×96 脸、写 manifest），而且视频要满足一些条件。详见第 7 节。 |
| 有哪些脚本？ | 4 个核心 Python/Shell 脚本 + 2 个复用脚本 + 一组浏览器 TS 模块。见第 6 节。 |
| Wav2Lip 是干啥的？ | 2020 年 ACM MM 的开源“对口型”模型：给一段视频和一段音频，它只重画 96×96 的人脸块，让嘴型对上音频。**研究/个人用途，禁止商用。** 见第 2 节。 |
| 基本原理？ | 声音 → mel 频谱图 → 模型“听”约 0.2 秒声音 → 生成这一帧的嘴 → 贴回原视频帧。不是 3D，不是换脸，不是语音合成。 |

---

## 1. 先建立直觉：它到底在干什么

### 1.1 视频就是一张张照片

一段 25 fps 的视频，每秒钟有 25 张照片（帧），每张照片停留 40 毫秒。  
“让视频里的人说话”，本质上就是：**在每一帧上，把嘴画成和当前声音匹配的形状。**

### 1.2 Wav2Lip 只重画脸，不重画整个人

Wav2Lip 的做法非常“抠门”：

```text
原始视频帧（比如 960×540）
  ┌─────────────────────────────┐
  │                             │
  │        ┌───────────┐        │   ← 人脸检测框
  │        │  96×96 脸 │        │   ← 模型重新生成这张小图
  │        │   ┌───┐   │        │
  │        │   │嘴 │   │        │   ← 只有嘴由声音驱动
  │        │   └───┘   │        │
  │        └───────────┘        │
  │                             │
  └─────────────────────────────┘
```

- 它从原帧里裁出一张 **96×96 的人脸小图**；
- 模型根据声音，重新生成这张 96×96 小图（上半脸主要复刻原样，下半脸的嘴由声音驱动）；
- 再把这张小图**贴回原帧的人脸框**；
- 身体、背景、头发、衣服、镜头运动，全部保留原视频。

所以它不需要 3D 建模，也不需要为每个人都训练一个模型。换一个人，只要换一段视频。

### 1.3 声音怎么变成“嘴型”？

模型听不懂文字，它只看声音的“频谱图”。

```text
声音波形（PCM）
   │  每 12.5 毫秒切一小段，做傅里叶变换
   ▼
mel 频谱图（80 行 × 很多列）
   │  每一列 = 某一时刻，80 个频率段的能量
   ▼
取当前帧前后的 16 列（约 0.2 秒）
   │
   ▼
模型：这 0.2 秒的声音，嘴应该张多大、圆还是扁？
   │
   ▼
输出 96×96 的嘴部/人脸小图
```

这就是“对口型”的全部核心。模型学到的不是“这句话是什么意思”，而是“这种声音波形通常对应什么嘴形”。

### 1.4 三个容易混淆的概念

| 它是什么 | 它不是什么 |
|---|---|
| 口型同步（lip sync） | 不是语音合成（TTS）：它不生成声音，声音是你给的 |
| 2D 人脸重绘 | 不是 3D 数字人：没有骨骼、没有可转动的头 |
| 换嘴/重绘嘴部 | 不是换脸（face swap）：身份还是原视频里的人 |

---

## 2. Wav2Lip 这个 GitHub 仓库是干什么的

仓库：<https://github.com/Rudrabha/Wav2Lip>

### 2.1 它是什么

- 论文：**A Lip Sync Expert Is All You Need for Speech to Lip Generation In the Wild**，ACM Multimedia 2020。
- 作者：K R Prajwal、Rudrabha Mukhopadhyay、Vinay P. Namboodiri、C.V. Jawahar（IIIT Hyderabad 等）。
- 一句话：**给一段视频 + 一段音频，生成“嘴型对上音频”的视频，而且不需要为视频里的人重新训练。**

### 2.2 仓库里有什么

| 路径 | 作用 |
|---|---|
| `models/wav2lip.py` | 模型结构：人脸编码器 + 音频编码器 + 解码器 |
| `models/conv.py` | 卷积/反卷积积木 |
| `models/syncnet.py` | SyncNet：判断“嘴和声音是否同步”的“专家网络” |
| `audio.py` / `hparams.py` | 声音 → mel 频谱图的前端，以及采样率、FFT 等参数 |
| `inference.py` | 官方推理脚本：读视频、检测人脸、逐帧生成、贴回、合音频 |
| `face_detection/` | S3FD 人脸检测器（预训练权重另外下载） |
| `wav2lip_train.py` / `train_syncnet.py` | 训练脚本（本 spike 不用） |
| `checkpoints/` | 官方权重不放仓库，要从 Google Drive 下载 |
| `README.md` | 用法、权重地址、许可证、引用 |

### 2.3 权重

官方提供两个常用权重：

- `wav2lip.pth`：基础版，口型准，但画面偏糊；
- `wav2lip_gan.pth`：加了 GAN 判别器，画面更清晰。**本 spike 用的是这个。**

权重文件约 **416 MiB**（435,801,865 字节），不在 Git 仓库里，需要手动下载到 `build/photoreal/wav2lip_gan.pth`。

### 2.4 许可证（很重要）

Wav2Lip 的 README 写得很明确：

> This repository can only be used for personal/research/non-commercial purposes.
> ... any form of commercial use is strictly prohibited.

原因之一是它训练用了 LRS2（BBC 口型数据集），商用授权不干净。

所以：

- 本 spike 是**研究/可行性 demo**；
- 不能直接拿 Wav2Lip 做商业产品；
- 视频里的人的**肖像权**也要单独获得授权；
- 产品化要换许可干净的模型（例如 Ultralight / FeatherTalk，需先核实许可），或走云端商业方案。

### 2.5 本 spike 用了仓库的哪几块

| 用了 | 怎么用 |
|---|---|
| `models/wav2lip.py` + `wav2lip_gan.pth` | 加载权重，导出 ONNX |
| `audio.py` + `hparams.py` | 离线生成 mel filterbank 和测试基准 |
| `face_detection/`（S3FD） | 离线检测视频每帧的人脸框 |
| 论文里的推理逻辑 | 用 TypeScript 在浏览器里重写，不直接跑 `inference.py` |

没有用它的训练脚本，也没有在浏览器里跑 Python。

---

## 3. 全景图：两条流水线

这个 spike 分成“离线准备”和“在线播放”两段。理解这两段，就理解了全部。

### 3.1 离线准备（Python，只跑一次）

```text
wav2lip_gan.pth ──export_wav2lip.py──▶ wav2lip.onnx（145 MB，固定 batch=8）
                                              │
sample.mp4 ──ffmpeg 裁 10s/25fps──▶ sample-10s.mp4
                                              │
                                  prepare_sample.py
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
            frames/frame-000.webp ...   faces/face-000.webp ...   manifest.json
            （250 张原帧，960×540）      （250 张 96×96 脸）        （帧号/路径/脸框）
                                              │
mock 中文语音 ──24 kHz PCM──▶ speech-24k.pcm ──make_mel_fixture.py──▶ mel-filterbank.json
                                              │                         + mel-fixture.json
                                              ▼
                         avatar-core/photoreal/public/spike/photoreal/
                         + scripts/photoreal-assets.lock.json（哈希/大小）
```

### 3.2 在线播放（TypeScript，浏览器里跑）

```text
页面加载
  │
  ├─ 读 manifest.json
  ├─ 加载 250 张原帧（ImageBitmap）
  ├─ 加载 250 张 96×96 脸（转成 RGBA）
  ├─ 加载 speech-24k.pcm
  ├─ 24k→16k 重采样，算 mel（80 行 × N 列）
  └─ 加载 wav2lip.onnx（ORT WebGPU 会话）
  │
  ▼
后台批量生成嘴部补丁（每批 8 帧）
  melWindow + packFace → [8,1,80,16] + [8,6,96,96]（补零到 8 通道）
  → ONNX → [8,3,96,96] → 存成 ImageData
  │
  ▼
点“开始”
  AudioContext 播放 24k PCM
  AudioClock 把“音频时间”映射成“第几帧”
  requestAnimationFrame 循环：
      frame = floor(audioMs × 25 / 1000)，但不能超过已生成的帧
      画原帧 + 把嘴部补丁贴到人脸框
  │
  ├─ 点“打断”：立刻停声，画回源脸，记录延迟
  └─ 播完：输出内容无关的指标 JSON
```

---

## 4. 离线阶段：每个 Python 脚本在做什么

### 4.1 `scripts/photoreal/build-assets.sh`：总调度

它把下面所有步骤串起来。两种模式：

```bash
# 完整资产（需要手动下载 wav2lip_gan.pth）
./scripts/photoreal/build-assets.sh

# 只生成 mel filterbank 和测试基准（不需要 checkpoint）
./scripts/photoreal/build-assets.sh --mel-only
```

完整模式做的事：

1. 下载 Wav2Lip 源码压缩包（固定 commit `bac9a81...`），校验 SHA-256，解压到 `build/photoreal/wav2lip/`；
2. 把 2020 年老代码里的 `np.float` / `np.int` 等别名改成 Python 内置类型（现代 numpy 已删除这些别名）；
3. 下载 S3FD 人脸检测权重；
4. 下载示例视频，用 ffmpeg 裁成 10 秒、25 fps、去掉音轨；
5. 用 macOS `say` 生成一段中文 mock 语音，转成 24 kHz、16-bit、单声道、无文件头的裸 PCM；
6. 建 Python 虚拟环境，装 `requirements.txt`；
7. 调 `export_wav2lip.py` 导出 ONNX；
8. 调 `prepare_sample.py` 生成帧、脸、manifest；
9. 调 `make_mel_fixture.py` 生成 mel filterbank 和测试基准；
10. 把 checkpoint、视频、ONNX、PCM、manifest 的 SHA-256 和字节数写进 `scripts/photoreal-assets.lock.json`。

> 为什么用 codeload 压缩包而不是 `git clone`？因为部分网络环境屏蔽了 `github.com` 的 git 协议；脚本改用官方 `codeload.github.com/.../tar.gz/<commit>`，并校验固定 SHA-256。

### 4.2 `scripts/photoreal/export_wav2lip.py`：PyTorch → ONNX

浏览器不会跑 PyTorch，所以要把“训练好的模型”转成通用格式 ONNX。

它做的事：

1. 校验 `wav2lip_gan.pth` 的 SHA-256（`ca9ab7...`），防止下错文件；
2. 用 Wav2Lip 的模型定义加载权重；
3. 用固定形状导出：
   - 输入 `mel`：`[8, 1, 80, 16]`（8 帧、1 通道、80 个 mel 频段、16 个时间列）
   - 输入 `img`：`[8, 6, 96, 96]`（8 帧、6 通道、96×96 脸；导出后会被补成 8 通道）
   - 输出 `out`：`[8, 3, 96, 96]`（8 帧、BGR 三通道、96×96 脸）
4. `external_data=False`：ONNX 不能带 `.data` 旁挂文件，因为浏览器只方便按一个 URL 取模型；
5. **6 通道 → 8 通道的补丁**（见 4.2.1）；
6. 用 ONNX Runtime CPU 跑一遍，和 PyTorch 原输出对比，误差在 `1e-4` 以内才通过。

#### 4.2.1 为什么要补成 8 通道

这是本次 spike 最有意思的坑：

- Wav2Lip 的第一层卷积输入是 **6 通道**；
- ONNX Runtime Web 1.30.0 的 **WebGPU** 后端，在卷积输入通道数恰好为 6 时算错（CPU 对照最大误差 0.7，1/2/3/4/5/8 通道都正常）；
- 规避方法：把 `img` 输入扩成 8 通道，多出的两通道全填 0；同时把第一层卷积的权重也补两通道 0。

数学上完全等价（0 乘任何权重还是 0），但绕开了 ORT 的 bug。补完后 WebGPU 与 CPU 的最大误差降到 `1.7e-6`。

浏览器运行时由 `packBatch` 负责把每帧的 6 通道数据放进 8 通道张量的前 6 层，后两层保持 0。

### 4.3 `scripts/photoreal/prepare_sample.py`：视频 → 帧 + 脸 + manifest

它把“人类看的视频”变成“浏览器好用的资产”：

1. 用 OpenCV 逐帧读视频；
2. 把帧缩到最大宽度 960（控制内存和 S3FD 显存）；
3. 用 S3FD 每 4 帧一批检测人脸框；**任何一帧检测不到脸就直接退出**；
4. 把人脸框按缩放比例映射回原分辨率；
5. 按 `--pads 0 10 0 0` 把框向下扩 10 像素（多包含一点下巴）；
6. 对框做 5 帧滑动平均，减少抖动（和 Wav2Lip 官方 `inference.py` 一致）；
7. 从**原分辨率帧**裁出人脸，缩放到 96×96，存成 WebP（质量 95）；
8. 原帧缩放后存成 WebP（质量 90）；
9. 写 `manifest.json`：帧率、宽高、PCM 地址、每帧的原图路径/脸图路径/人脸框。

产物示例：

```text
avatar-core/photoreal/public/spike/photoreal/
  manifest.json
  frames/frame-000.webp ... frame-249.webp
  faces/face-000.webp ... face-249.webp
```

### 4.4 `scripts/photoreal/make_mel_fixture.py`：让 JS 的 mel 和 Python 对齐

浏览器里要用 JavaScript 自己算 mel（不能为每一帧音频去调 Python），所以必须证明“JS 算出来的 mel 和 Wav2Lip 训练时用的 mel 一致”。

它做的事：

1. 读 24 kHz PCM，用 polyphase 重采样到 16 kHz；
2. 量化成 int16，再除以 32768（模拟浏览器拿到 int16 PCM 的处理）；
3. 直接调用 Wav2Lip 自己的 `audio.py` 算 mel；
4. 把 mel filterbank（80×401）存成 JSON，把“输入 PCM + 期望 mel”存成测试基准；
5. 强制 `librosa.stft` 用 `pad_mode='reflect'`，因为 Wav2Lip 训练时用的是老版 librosa 的默认值，新版默认改成了 `constant`。

浏览器端 `MelSpectrogram` 直接读这个 filterbank JSON；单元测试用这个基准检查，最大误差要求 `< 1e-3`。

### 4.5 `scripts/photoreal/requirements.txt`：Python 依赖

关键不是“装什么”，而是“为什么锁版本”：

- **Python 3.11**：Wav2Lip 的 `audio.py` 把 `sr`、`n_fft` 按位置传给 `librosa.filters.mel`，librosa 0.10+ 不再接受这种写法；
- `librosa==0.9.2`、`numpy==1.26.4`、`scipy==1.13.1`：与老代码兼容；
- `torch`、`onnx`、`onnxruntime`、`opencv-python`：导出和校验模型；
- `gdown`：从 Google Drive 下权重（实际是手动下载，脚本只提示）。

### 4.6 其他相关脚本

| 脚本 | 作用 |
|---|---|
| `scripts/make-mock-speech.sh` | 用 macOS `say` 生成中文 mock 语音，转 24 kHz PCM；spike 的固定音频就是它生成的 |
| `scripts/photoreal-assets.lock.json` | 记录 checkpoint / 视频 / ONNX / PCM / manifest 的 SHA-256 和字节数；只提交这个，不提交大资产 |

---

## 5. 在线阶段：浏览器里到底发生了什么

代码在 `avatar-core/src/spike/photoreal/`。按执行顺序讲。

### 5.1 页面入口

- `avatar-core/photoreal/index.html`：一个 `<canvas>` + 四个按钮（开始、打断、复制指标、下载指标）+ 状态区。
- `avatar-core/photoreal/src/main.ts`：调 `startPage()`。
- `avatar-core/vite.photoreal.config.ts`：独立的 Vite root，dev 端口 5174；产物输出到 `dist-photoreal/`，不会进 APK 的 `dist/`。

### 5.2 加载资产：`assets.ts` / `manifest.ts`

```ts
const manifest = await fetchManifest('/spike/photoreal/manifest.json');
const frames = await Promise.all(manifest.frames.map(f => fetchImage(f.frameUrl)));
const faces  = await Promise.all(manifest.frames.map(f => fetchImage(f.faceUrl)));
const pcm24  = await fetchPcm(manifest.pcmUrl);
```

`manifest.ts` 会校验：

- 路径必须是 `/spike/photoreal/...` 本地路径；
- 帧率 1–60、宽高 16–8192、采样率 8000–48000；
- 每帧 `index` 必须连续；
- 人脸框必须在画面内且 `x2 > x1`、`y2 > y1`。

### 5.3 算 mel：`mel.ts`

`MelSpectrogram` 是 Wav2Lip mel 前端的 JavaScript 版：

1. **预加重**（pre-emphasis，系数 0.97）：提升高频，补偿语音高频能量偏弱；
2. **STFT**：`n_fft=800`（50 ms）、`hop=200`（12.5 ms）、Hann 窗、**reflect 填充**；
3. **取幅度谱**：401 个频点；
4. **乘 mel filterbank**：401 个频点 → 80 个 mel 频段（55–7600 Hz，Slaney 刻度）；
5. **转 dB**：`20*log10(max(1e-5, 能量)) - 20`；
6. **对称归一化**：压到 `[-4, 4]`，和训练时一致。

10 秒音频大约有 801 个 mel 列，全部在浏览器里算，实测约 **419 ms**。这是“固定音频”才敢做的事；真正流式对话要改成增量计算。

`melWindow()` 负责为每一视频帧取 16 列：

```text
start = floor(frameIndex × 80 / fps)
```

25 fps 时，每帧前进 `80/25 = 3.2` 列，正好 40 ms。取 16 列约 200 ms 的声音上下文，和 Wav2Lip 官方 `inference.py` 的 `mel_idx_multiplier = 80/fps` 一致。

### 5.4 加载模型：`wav2lipRunner.ts`

```ts
const ort = await import('onnxruntime-web/webgpu');
const session = await ort.InferenceSession.create('/spike/photoreal/wav2lip.onnx', {
  executionProviders: ['webgpu', 'wasm'],  // 优先 GPU，失败回退 CPU
  graphOptimizationLevel: 'all',
});
```

- **WebGPU**：浏览器直接调用显卡；M3 Max 上每批 8 帧约 **47–62 ms**；
- **WASM**：CPU 回退；每批约 **2045 ms**，也就是 3.9 帧/秒，**跟不上 25 fps 播放**。

`packBatch()` 把最多 8 帧的 mel 窗口和 6 通道人脸打包成固定形状：

```text
mel: [8, 1, 80, 16]
img: [8, 8, 96, 96]   ← 前 6 层是脸，后 2 层是 0
out: [8, 3, 96, 96]
```

最后一帧不足 8 个时，用 0 补齐；只读取前 `count` 个输出，补的部分丢弃。

### 5.5 人脸打包：`face.ts`

浏览器解码图片得到的是 **RGBA**，Wav2Lip 训练用的是 OpenCV 的 **BGR**，所以要换序：

- `packFace()`：RGBA → 6 通道
  - 前 3 通道：人脸下半部分（嘴的区域）涂黑，上半部分保留 BGR；
  - 后 3 通道：完整人脸的 BGR。
- `patchToRgba()`：模型输出的 3 通道 BGR → RGBA，交给 `ImageData`。

“下半脸涂黑”是给模型的提示：**这块要你根据声音补全**。后 3 通道是参考图，帮助模型保持身份和上半脸。

### 5.6 批量生成：`page.ts` 的 `fill()`

页面一加载就开始后台生成，不等点“开始”：

```text
第 0 批：帧 0–7
第 1 批：帧 8–15
...
直到 250 帧全部生成，或被打断
```

每批：

1. 为每帧取 16 列 mel；
2. 为每帧打包 96×96 脸；
3. `runner.infer()`；
4. 把输出转成 `ImageData` 存进 `patches[]`；
5. 更新 `readyThrough`（连续已就绪到第几帧）；
6. 如果已经领先播放头超过 25 帧，就等 10 ms（背压，防止生成太靠前占内存）。

### 5.7 音频主时钟：`audioClock.ts` + `frameScheduler.ts`

这是口型能跟上的关键。

```ts
audioCtx = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
source.start();
clock.start(audioCtx.currentTime);
```

`AudioClock` 用 `AudioContext.currentTime`（音频硬件时钟）而不是 `Date.now()`：

```text
mediaMs = (currentTime - startedAt) × 1000
frame   = floor(mediaMs × fps / 1000)
```

`requestAnimationFrame` 每 16.7 ms 跑一次（60 Hz 屏幕），但视频只有 25 fps，所以同一帧会被重复画；`lastShown` 保证只在帧号变化时重绘和计数。

`chooseFrame()` 做一道保险：

```text
desired = floor(audioMs × fps / 1000)
ready   = min(readyThrough, totalFrames - 1)
frame   = min(desired, ready)     ← 绝不显示还没生成的帧
```

如果生成落后，就重复上一张已就绪的帧，并记录 `repeated` / `behind`。实测预热跑和冷启动跑都是 `repeated=0`、`maxBehind=0`。

### 5.8 合成：`compositor.ts`

```text
1. 画整张原帧（960×540）
2. 如果这一帧有生成的补丁：
     把 96×96 补丁画到人脸框的位置（缩放到框的大小）
   否则：
     画原视频的 96×96 脸（保持原样，不生成嘴）
```

补丁是整张 96×96 脸，不只是嘴；但上半脸主要由原帧信息重建，视觉上变化最大的是嘴。

### 5.9 预缓冲与首口型

点“开始”后，页面不会立刻放声音，而是：

- 等至少 **6 帧**（`prebufferFrames`）补丁就绪；
- 或者等 **300 ms**（`firstLipTimeoutMs`）超时。

这样做是为了避免“声音已经出来，嘴还没准备好”的尴尬。预热跑因为 250 帧都生成完了，等待为 0；冷启动跑等待 54 ms，音频起播后 5 ms 出现第一张带嘴的帧，合计 59 ms。

### 5.10 打断：`interrupt.ts`

点“打断”时：

1. 记录当前音频时间 `playedMs` 和帧号；
2. `source.stop()` 立刻停声；
3. 把当前帧画回**源脸**（不贴生成补丁）；
4. 连续两帧 `requestAnimationFrame` 确认嘴已回到源画面；
5. 记录 `interruptLatencyMs`。

实测 10/10/13 ms，远低于 100 ms 门槛。

### 5.11 指标：`metrics.ts`

输出的 JSON 只有事件、计数、耗时，不含音频、文本或画面内容：

```json
{
  "provider": "webgpu",
  "modelLoadMs": 252,
  "melBuildMs": 419,
  "prebufferWaitMs": 0,
  "firstLipAfterAudioMs": 0,
  "fps": 25.09,
  "framesShown": 250,
  "repeatedFrames": 0,
  "maxBehind": 0,
  "inferenceCount": 32,
  "inferenceAvgMs": 47.61,
  "inferenceMaxMs": 60.8,
  "interruptLatencyMs": 10,
  "offline": false
}
```

---

## 6. 脚本与文件清单

### 6.1 离线脚本

| 文件 | 作用 | 什么时候需要跑 |
|---|---|---|
| `scripts/photoreal/build-assets.sh` | 总调度：下载、解压、生成全部资产 | 第一次，或换视频/换模型时 |
| `scripts/photoreal/export_wav2lip.py` | PyTorch checkpoint → ONNX | 换 checkpoint、换 batch 大小时 |
| `scripts/photoreal/prepare_sample.py` | 视频 → 帧 + 96×96 脸 + manifest | **换视频时** |
| `scripts/photoreal/make_mel_fixture.py` | mel filterbank + JS/Python 对齐基准 | 换音频、或验证 mel 实现时 |
| `scripts/photoreal/requirements.txt` | Python 依赖与版本锁 | 建虚拟环境时 |
| `scripts/photoreal-assets.lock.json` | 资产哈希/大小，提交到仓库 | 自动生成 |
| `scripts/make-mock-speech.sh` | 生成中文 mock 语音 24 kHz PCM | 换音频时（或手动准备 PCM） |

### 6.2 浏览器运行时

| 文件 | 作用 |
|---|---|
| `avatar-core/photoreal/index.html` | 页面骨架（canvas + 按钮） |
| `avatar-core/photoreal/src/main.ts` | 入口 |
| `avatar-core/src/spike/photoreal/page.ts` | 总编排：加载、生成、播放、打断 |
| `avatar-core/src/spike/photoreal/assets.ts` | 拉 manifest / 图片 / PCM |
| `avatar-core/src/spike/photoreal/manifest.ts` | manifest 校验 |
| `avatar-core/src/spike/photoreal/config.ts` | 固定参数（25 fps、80 bins、16 窗、96 脸、batch 8…） |
| `avatar-core/src/spike/photoreal/audioClock.ts` | 音频时间 → 媒体时间 → 帧号 |
| `avatar-core/src/spike/photoreal/frameScheduler.ts` | 选帧，保证不显示未就绪帧 |
| `avatar-core/src/spike/photoreal/mel.ts` | mel 前端 + 16 列窗口 |
| `avatar-core/src/spike/photoreal/face.ts` | RGBA ↔ 6 通道 BGR，输出 → RGBA |
| `avatar-core/src/spike/photoreal/wav2lipRunner.ts` | 打包 batch + ORT 会话 |
| `avatar-core/src/spike/photoreal/compositor.ts` | 原帧 + 嘴部补丁合成 |
| `avatar-core/src/spike/photoreal/interrupt.ts` | 打断时的帧冻结与 `playedMs` |
| `avatar-core/src/spike/photoreal/metrics.ts` | 内容无关指标 |
| `avatar-core/src/spike/photoreal/types.ts` | 共享类型（冻结接口） |
| `avatar-core/src/spike/photoreal/mel-filterbank.json` | 80×401 mel filterbank（提交） |
| `avatar-core/test/photoreal/*.test.ts` | 11 个模块的单元测试 |

### 6.3 命令

```bash
# 启动 demo（在 photoreal-spike worktree 根目录）
npm run dev:photoreal -w avatar-core
# 浏览器打开 http://127.0.0.1:5174/

# 测试与类型检查
npm test -w avatar-core
npm run typecheck -w avatar-core

# 独立构建（产物在 avatar-core/dist-photoreal/，不会进 APK）
npm run build:photoreal -w avatar-core

# 重新生成资产（需要 Python 3.11 / ffmpeg / macOS say）
./scripts/photoreal/build-assets.sh

# 只重建 mel（不需要 checkpoint）
./scripts/photoreal/build-assets.sh --mel-only
```

---

## 7. 能随便给一段视频就跑吗？

### 7.1 短答

**脚本可以吃任意视频，但网页不是“拖进去就能跑”。**  
现在的 demo 是“先离线预处理成固定资产，再播放固定资产”。你换视频，必须重新跑一遍预处理，再刷新页面。

### 7.2 现在的硬限制

| 限制 | 说明 |
|---|---|
| 网页没有上传入口 | 页面固定读 `/spike/photoreal/manifest.json`，不会读你本地的文件 |
| 必须先抽帧 | 所有帧和 96×96 脸都是离线生成好的；不是运行时解码视频 |
| 25 fps | 页面配置 `fps: 25`，manifest 的 fps 必须等于 25；换帧率要改配置并重新预处理 |
| 固定音频 | 页面播放 `speech-24k.pcm`；视频自带音轨会被丢弃（`ffmpeg -an`） |
| 单人正脸 | S3FD 每帧检测一张脸；任何一帧检测不到就报错退出 |
| 脸要够大、够清楚 | 96×96 裁剪后再贴回；脸太小、太侧、遮挡多，效果会明显变差 |
| 10 秒左右 | `build-assets.sh` 固定裁 10 秒；PCM 也是 10 秒；视频比音频长，后面的帧不会播；音频比视频长，最后一帧会重复 |
| batch 固定 8 | ONNX 是固定形状 `[8,...]`；换 batch 要重新导出 |
| 只有 WebGPU 能实时 | WASM 回退约 3.9 帧/秒，只能证明“能跑”，不能实时 |
| 研究许可 | Wav2Lip 禁止商用；视频里的人还要有肖像权授权 |

### 7.3 换视频的最小步骤

**方式 A：复用总脚本（最省事，但会重导 ONNX，较慢）**

```bash
# 1. 把你的视频放到固定位置
cp /path/to/your-video.mp4 build/photoreal/sample.mp4

# 2. 删掉旧的 10 秒裁切，强制重新生成
rm -f build/photoreal/sample-10s.mp4

# 3. 重跑总脚本
./scripts/photoreal/build-assets.sh

# 4. 刷新 http://127.0.0.1:5174/
```

**方式 B：只重建视频资产（快，不重导 ONNX）**

```bash
# 先转成 25 fps、10 秒、无音轨
ffmpeg -y -i /path/to/your-video.mp4 -t 10 -r 25 -an \
  -c:v libx264 -pix_fmt yuv420p build/photoreal/your-10s.mp4

# 只跑视频预处理
build/photoreal/venv/bin/python scripts/photoreal/prepare_sample.py \
  --wav2lip build/photoreal/wav2lip \
  --video build/photoreal/your-10s.mp4 \
  --out avatar-core/photoreal/public/spike/photoreal \
  --fps 25
```

这会覆盖 `frames/`、`faces/`、`manifest.json`，保留 ONNX 和 PCM。刷新页面即可。

### 7.4 换成你自己的声音

1. 准备 **24 kHz、16-bit、单声道、无文件头（raw）** 的 PCM；
2. 覆盖 `avatar-core/photoreal/public/spike/photoreal/speech-24k.pcm`；
3. 刷新页面。浏览器会从新 PCM 重新算 mel；
4. 如果长度不是 10 秒：
   - 音频比视频长：视频最后一帧会重复；
   - 音频比视频短：后面的视频帧不会显示。

如果你用的是普通 WAV，可以：

```bash
ffmpeg -y -i your.wav -ar 24000 -ac 1 -f s16le speech-24k.pcm
```

> 注意：页面按 manifest 里的 `pcmSampleRate: 24000` 播放。如果你的 PCM 是 16 kHz，要么先重采样到 24 kHz，要么改 manifest 的 `pcmSampleRate`。

### 7.5 什么样的视频效果差 / 会失败

| 情况 | 结果 |
|---|---|
| 正脸、光线好、脸占画面比例大、镜头基本不动 | 最好 |
| 侧脸超过约 45° | 检测框不稳，嘴部质量明显下降 |
| 手/麦克风/头发遮住嘴 | 模型补不出被遮挡的部分，会糊/穿帮 |
| 多人脸 | S3FD 每帧只取一个主脸；人脸切换时会跳 |
| 人脸太小（比如全身远景） | 96×96 裁剪信息不足，贴回后很糊 |
| 快速转头、遮挡、出画 | 人脸框抖动，可能检测失败 |
| 视频本身嘴一直在动 | 模型会重画下半脸，原嘴被覆盖；一般没问题 |
| 视频没有音轨 | 没问题；音轨本来就会被丢弃 |
| 视频超过 10 秒 | 只处理前 10 秒（脚本 `-t 10`） |

### 7.6 一句话总结

**“任意视频”在脚本层面成立，在产品体验层面不成立。**  
现在它是一个“固定素材的性能验证 demo”，不是“用户上传视频就能玩”的产品。要变成产品，还需要：上传/转码、进度反馈、失败重试、资产存储、许可与肖像授权、以及流式音频接入。

---

## 8. 为什么能跑到 25 fps：性能账

### 8.1 只算 96×96，不算整帧

模型只处理 96×96 的人脸小图，不处理 960×540 的整帧。整帧只是最后 Canvas 贴图，几乎不花推理时间。

### 8.2 batch 8

一次推理 8 帧，GPU 利用率更高。实测：

| 后端 | 每批耗时 | 每帧耗时 | 生成能力 | 25 fps 播放需要 |
|---|---|---|---|---|
| WebGPU | 47–62 ms | 6–8 ms | 约 130–170 帧/秒 | 25 帧/秒 |
| WASM | 2045 ms | 256 ms | 约 3.9 帧/秒 | 25 帧/秒 |

WebGPU 的生成能力是播放需求的 **5–6 倍**，所以有足够余量；WASM 只有需求的 **1/6**，真流式会越播越落后。

> 注意：WASM 报告里的 `fps: 25.08` 是“等 250 帧全部生成完再播放”的播放帧率，不是生成帧率。真正要看的是 `inferenceAvgMs`。

### 8.3 预生成 + 音频时钟

因为音频是固定的 10 秒，页面可以在播放前就把 250 帧全部生成好。播放时只需要按音频时钟取帧、贴图，几乎不花推理时间。这是“预热跑 repeated=0”的原因。

### 8.4 冷启动也不慢

冷启动不等全部帧，只等 6 帧或 300 ms；实测预缓冲 54 ms，首口型 5 ms，合计 59 ms。即使边播边生成，WebGPU 的生成速度仍然够。

### 8.5 模型加载不算在首口型里

页面在模型加载完成后才启用“开始”按钮。`modelLoadMs ≈ 252 ms` 是页面加载的一部分，不计入 S2 的“音频起播→嘴动”。报告里把这一点写明了。

---

## 9. 现在的结果与边界

### 9.1 S1–S5

| # | 验收条 | 实测 | 判定 |
|---|---|---|---|
| S1 | 稳态出帧 ≥24 fps；20–23.9 勉强；<20 不过 | 25.09 fps，250 帧，repeated 0，maxBehind 0 | pass |
| S2 | 音频起播→嘴动 ≤300 ms；301–500 勉强 | 冷启动 54 + 5 = 59 ms | pass |
| S3 | 打断 ≤100 ms 停声、2 帧内闭嘴 | 10/10/13 ms，画面回源脸 | pass |
| S4 | 模型缓存后断网可推理 | `offline: true`，25.09 fps | pass |
| S5 | 机型/浏览器写明 | M3 Max / 36 GB / macOS 26.3.1 / Chrome 156.0.8078.74 / WebGPU | pass |

### 9.2 已知局限

- 只在 **M3 Max + Chrome** 上验证；Windows 独显、普通笔记本、手机都没测。
- 只用了 **一个公开样本、一个 checkpoint、一个 batch 大小**。
- 96×96 嘴部块比源脸**明显偏软**；真人感要等 T8 盲测判断。
- 没有接网关；音频是固定的 mock 语音，不是真实对话。
- 不是流式：mel 和补丁都是“整段预计算”，不是边收音频边算。
- Wav2Lip 非商用；样本视频和人物肖像只用于研究。

### 9.3 还没做的 T8

T8 是“Web demo 与 Android Duix 并排盲测”，需要：

1. 用户用 Android 真机录一段 Duix Lily 的回复；
2. Web 端录一段同样构图的 10 秒；
3. 3–5 名评审不看标签，评价“真人感 / 口型跟声 / 打断”。

目前卡在“需要用户提供录屏和人工评分”，所以 roadmap 标记为“T1–T7 完成，S1–S5 全过，待 T8 盲测”。

---

## 10. 常见问题（FAQ）

**Q1：这是不是 3D 数字人？**  
不是。它没有 3D 模型、骨骼、表情参数；就是 2D 视频帧 + 2D 嘴部补丁。

**Q2：这是不是换脸？**  
不是。脸还是原视频里的人；模型只是根据声音重画嘴部区域。

**Q3：它会不会生成声音？**  
不会。声音是你提供的 PCM；它只生成画面。

**Q4：为什么嘴看起来有点糊？**  
模型工作在 96×96，嘴部细节（牙齿、舌头、唇纹）本来就有限；贴回大脸框时会被放大。`wav2lip_gan` 比基础版好，但仍不如原视频清晰。Wav2Lip 的 HD 模型是商业版，不在开源仓库里。

**Q5：为什么一定要 WebGPU？**  
WASM（CPU）每批 2 秒，只有 3.9 帧/秒，跟不上 25 fps。WebGPU 用显卡，才够实时。Safari/Firefox 不在本次支持范围。

**Q6：为什么模型文件 145 MB？**  
权重是 fp32，模型本身有编码器/解码器/多尺度卷积。145 MB 是 ONNX 文件大小；加载一次后可以缓存。

**Q7：为什么不能直接 `git clone` Wav2Lip？**  
部分网络屏蔽了 GitHub 的 git 协议；脚本改用官方 codeload tar.gz，并锁死 commit 和 SHA-256。

**Q8：为什么老代码要改 `np.float`？**  
Wav2Lip 是 2020 年的代码，用了 numpy 后来删除的别名；现代 numpy 会直接报错。脚本用正则把它们换成 Python 内置类型。

**Q9：为什么 librosa 要锁 0.9.2？**  
Wav2Lip 的 `audio.py` 用位置参数调 `librosa.filters.mel`，librosa 0.10+ 改了签名；锁老版本最省事。

**Q10：为什么 mel 要强制 `reflect` 填充？**  
Wav2Lip 训练时用的 librosa 0.7 默认 `reflect`；新版默认 `constant`。不强制的话，边界帧的 mel 会和训练分布不一致。

**Q11：为什么浏览器里要自己写 mel，不直接调 Python？**  
浏览器不能跑 Python；而且每帧都跨进程调 Python 也不现实。所以把 mel 前端重写成 TS，并用 Python 基准做单元测试。

**Q12：为什么人脸要补成 8 通道？**  
ORT WebGPU 1.30 的 6 通道卷积 bug；补零到 8 通道是数学等价的规避。详见 4.2.1。

**Q13：能不能把这段代码直接放进 App？**  
不能。它是独立的 Vite root，产物在 `dist-photoreal/`，`scripts/build-web.sh` 不会把它打进 APK；而且 Wav2Lip 非商用。它只是可行性验证。

**Q14：能不能接网关，做成真实对话？**  
这是计划里的“阶段 b”，本 spike 没做。需要：流式 PCM、增量 mel、按需生成、打断语义、协议对接；预计 3–5 人月，另立计划。

---

## 11. 自己动手：最短路径

### 11.1 直接看 demo（资产已在本 worktree 生成）

```bash
cd .worktrees/photoreal-spike
npm run dev:photoreal -w avatar-core
# Chrome/Edge 打开 http://127.0.0.1:5174/
# 等状态显示 ready=250/250，点“开始”
```

### 11.2 从零重建资产

前置：

- Python 3.11；
- `ffmpeg`；
- macOS 的 `say` / `afconvert`（生成 mock 语音）；
- 手动下载 `wav2lip_gan.pth` 到 `build/photoreal/wav2lip_gan.pth`。

```bash
mkdir -p build/photoreal
# 手动把 wav2lip_gan.pth 放进去
./scripts/photoreal/build-assets.sh
```

脚本会自动下载 Wav2Lip 源码、S3FD、示例视频；checkpoint 因为 Google Drive 限制需要手动下。

### 11.3 只验证 mel 前端（不需要 checkpoint）

```bash
./scripts/photoreal/build-assets.sh --mel-only
npm test -w avatar-core
```

### 11.4 跑测试

```bash
npm test -w avatar-core          # 29 个测试文件，166 项通过，1 项跳过
npm run typecheck -w avatar-core # 无输出即通过
```

> 本次核对时间：2026-10-30；在 `.worktrees/photoreal-spike` 下实际执行，结果与 roadmap 记录一致。

---

## 12. 术语表

| 术语 | 小白解释 |
|---|---|
| PCM | 把声音按固定时间间隔采样得到的数字序列；本项目用 24 kHz、16-bit、单声道 |
| mel 频谱图 | 声音的“频率能量图”：横轴时间，纵轴 80 个频率段，值越大该频段能量越强 |
| STFT | 短时傅里叶变换：把声音切成小段，看每段有哪些频率 |
| hop | 相邻两段之间隔多少采样点；200 个采样点 @16 kHz = 12.5 ms |
| checkpoint / `.pth` | 训练好的模型权重文件 |
| ONNX | 跨框架的模型交换格式；PyTorch 导出后，浏览器/其他运行时都能读 |
| ONNX Runtime Web | 在浏览器里跑 ONNX 的运行时；本项目用它的 WebGPU/WASM 后端 |
| WebGPU | 浏览器调用显卡的 API；比 CPU（WASM）快一到两个数量级 |
| batch | 一次推理处理多少帧；本项目固定 8 |
| 推理（inference） | 用训练好的模型算结果，不是训练 |
| 预缓冲 | 播放前先准备若干帧，避免声音出来嘴还没好 |
| 背压 | 生成太快时主动等一等，防止内存/GPU 被占满 |
| S3FD | 一种人脸检测器；Wav2Lip 官方用它找人脸框 |
| SyncNet | 判断“嘴和声音是否同步”的网络；训练时当“口型老师” |
| GAN | 生成对抗网络；`wav2lip_gan` 用它让画面更真实 |
| 打断 | 用户中途插话，要求立刻停声、闭嘴、回报已播时长 |

---

## 13. 文件地图（从入口到细节）

```text
docs/
  research/
    2026-10-30-web-photoreal-avatar-options.md   # 方案调研（A/B/C/D/E/F）
    2026-10-30-photoreal-spike-explained.md      # 本文
  testing/
    2026-10-30-web-photoreal-spike.md            # 实测报告（S1–S5）
  superpowers/plans/2026-10-30-web-photoreal-demo/
    00-overview.md                               # 目标、决策、验收门槛
    01-t1-scaffold-assets.md ... 08-t8-...       # 逐任务实现计划

scripts/
  photoreal/
    README.md                                    # 资产脚本说明
    build-assets.sh                              # 总调度
    export_wav2lip.py                            # PyTorch → ONNX
    prepare_sample.py                            # 视频 → 帧/脸/manifest
    make_mel_fixture.py                          # mel filterbank + 基准
    requirements.txt                             # Python 依赖
  photoreal-assets.lock.json                     # 资产哈希/大小
  make-mock-speech.sh                            # 中文 mock 语音

avatar-core/
  photoreal/
    index.html                                   # 页面
    src/main.ts                                  # 入口
    public/spike/photoreal/                      # 生成资产（gitignore）
  src/spike/photoreal/
    page.ts                                      # 总编排
    assets.ts / manifest.ts / config.ts          # 加载与校验
    audioClock.ts / frameScheduler.ts            # 时钟与选帧
    mel.ts                                       # mel 前端
    face.ts                                      # 人脸打包
    wav2lipRunner.ts                             # ORT 推理
    compositor.ts                                # 合成
    interrupt.ts / metrics.ts                    # 打断与指标
    types.ts                                     # 类型
    mel-filterbank.json                          # 80×401 filterbank（提交）
  test/photoreal/                                # 单元测试
  vite.photoreal.config.ts                       # 独立 Vite root
```

---

## 14. 最后一段话

这个 spike 证明了一件很具体的事：

> **在 2026 年的桌面 Chrome + WebGPU 上，Wav2Lip 这种 96×96 的轻量口型模型，已经可以在浏览器本地跑到 25 fps，首口型 59 ms，打断 10 ms 级，而且断网可跑。**

它没有证明的是：

- 真人感能不能比 Android Duix 更好（96×96 补丁偏软）；
- 能不能接真实网关、流式音频、真实对话；
- 能不能商用（Wav2Lip 许可不允许）；
- 能不能在普通 Windows 笔记本/手机上跑。

所以下一步不是“继续堆代码”，而是：

1. 做 T8 盲测，确认真人感是否可接受；
2. 如果可接受，另立“阶段 b”计划，接网关和流式音频；
3. 如果不可接受，评估换模型（Ultralight/FeatherTalk，先核实许可）或走 GPU 拉流方案 B。
