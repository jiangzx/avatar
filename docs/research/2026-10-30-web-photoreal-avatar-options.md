# Web 端达成 Android 同等「真人形象」效果 — 方案调研

日期：2026-10-30  
范围：桌面浏览器 / `avatar-core` Web 调试 / 未来若有独立 Web 客户端；对照现有 Android Duix-Mobile 路径。  
非目标：本文件不选型拍板、不写实现计划；仅列可选方案与证据。

## 1. 「同等效果」锚定（来自现有 Android）

依据：`docs/superpowers/specs/2026-10-25-duix-avatar-engine-design.md`、Duix 计划 overview。

| 维度 | Android 现状 |
|---|---|
| 画面 | 公开模特帧序列（Lily 等）的 2D 真人脸+上身，非 3D GLB |
| 驱动 | 我方网关 PCM → 端侧推理口型（NCNN / `DuixNcnn`），非字幕嘴型 |
| 音频主控 | 我方播放时钟；打断要立刻停，并回报准确 `playedMs` |
| 会话栈 | 网关 + 现有协议不动；Duix 只当「喂音频、出画面」的渲染器 |
| 隐私/外发 | 端侧 POC 要求渲染路径零外发（构建去上报 + 抓包验收） |
| 离线 | 模型下完后可本机推理 |
| 延迟体感 | 真机口型跟声；短回复与打断是验收项 |

Web 要对齐，实质是同时满足：**真人感画面 + 音频驱动口型 + 我方会话/打断语义**；若还要对齐「零外发/离线」，可选空间会急剧变窄。

## 2. 重要前提：厂商有两套「Duix」

| 产品 | 形态 | 与本仓库关系 |
|---|---|---|
| **Duix-Mobile**（GitHub `duixcom/Duix-Mobile`） | Android 端侧 NCNN + OpenGL TextureView；PCM push | 当前 App 真人形象所用 |
| **硅基 / Duix H5 SDK**（`docs.duix.com/sdks/h5`，npm `duix-guiji-light` 等） | 浏览器里 WebRTC/远端音视频流；要 `sign`、`conversationId`、平台会话 | **不是** Mobile SDK 的 WASM 版 |

设计 spec §2.1 已写明：docs.duix.com 上的 Android/云端产品与 GitHub 端侧 SDK 不是同一条交付线。  
开源桌面版 Duix.Avatar 官方回复（[issue #338](https://github.com/duixcom/Duix-Avatar/issues/338)，2025-04）：**目前不支持把现有客户端直接做成浏览器应用**；可用其 API 自行包一层 Web。

结论：**没有「把现有 Lily 模型包 + NCNN 直接搬进 Chrome」的官方路径。**

## 3. 方案选项

### A. 接入厂商 Duix H5 / 云端数字人 SDK

- **做法：** 浏览器装 H5 SDK，会话与画面走对方云端（WebRTC 等）；或用其 OpenAPI 包一层。
- **接近同等效果的点：** 真人感、口型跟声（对方云端渲染）。
- **差距 / 风险：**
  - 会话、ASR、播放控制与现有网关**双栈冲突**；打断与 `playedMs` 要对齐对方事件模型。
  - 音视频上云，与 Android D2「渲染零外发」产品立场冲突。
  - 按分钟/会话计费；HTTPS + 用户手势才能播（H5 FAQ）。
  - **不能复用** 当前 APK 内的 Duix 模型 zip / 去上报 AAR。
- **证据：** [H5 Quick start](https://docs.duix.com/sdks/h5/quickstart)、[H5 FAQ](https://docs.duix.com/sdks/h5/questions)、中文文档 [duix.guiji.ai/document/h5](https://duix.guiji.ai/document/h5/)。

### B. 自建 GPU 渲染服务 + 浏览器 WebRTC/MSE 拉流

- **做法：** 网关仍出 PCM/文本；旁路「Avatar Render」服务（LiveTalking / MuseTalk / Wav2Lip / 自研）吃音频出视频，经 WebRTC（如 LiveKit）进浏览器 `<video>`。
- **接近同等效果的点：** 画质可做到真人级；打断可在服务端切轨；会话仍可归我方网关。
- **差距 / 风险：**
  - 需要常驻 GPU（公开数据：MuseTalk + TensorRT 在 RTX 4090 约 1.2× 实时、约 330 ms 量级块延迟，见 [mayflower/voipavatar](https://github.com/mayflower/voipavatar/)；LiveTalking 文档见 [livetalking-doc](https://livetalking-doc.readthedocs.io/en/latest/usage.html)）。
  - 运维、扩缩容、每路会话成本；端到端延迟通常高于端侧 Duix。
  - 模特资产与 Lily 帧包**一般不兼容**，需另训/另备形象。
  - 音频与画面仍上云（或上自建机房），隐私模型与端侧不同。
- **适合：** 「桌面 Web 也要真人脸」，可接受云渲染与成本。

### C. 浏览器端本地推理（开源重做「路 2」）

**范围说明（2026-10-30 收窄）：** 本节只谈 **路 2**——用开源口型/说话头管线在浏览器本地重做「产品效果逼近」，**不**谈把 Duix-Mobile / `libgjduix.so` / Lily 加密包 1:1 搬进 Chrome。后者无官方 Web 路径，且依赖预编译原生库与资产格式，不作为候选展开。

- **做法：** 选定轻量开源说话头（优先 Wav2Lip 级 / Ultralight-Digital-Human 一类；完整 MuseTalk / LivePortrait 仅作对照上限），导出或使用已有 ONNX，经 **ONNX Runtime Web + WebGPU**（无 GPU 时 WASM 回退）推理；WebAudio 播放我方 PCM，按播放头驱动嘴型；Canvas/WebGL 出帧。会话仍走现有网关；打断与 `playedMs` 对齐现有 `NativeAudioIO` / Duix 契约（见 design spec §4.1），**不必逆向 Duix**。
- **接近同等效果的点：** 理论上可离线、可零外发；画质可「像真人照片说话」，但模特资产与 Lily **不通用**，需另备形象。
- **现实约束：**
  - MuseTalk 类即使在 **RTX 4090 原生**也多在 15–20 fps 量级才谈实时；浏览器 WebGPU 通常更慢，不宜作为路 2 的默认模型。
  - 完整 LivePortrait WebGPU 移植曾测约 **25–60 秒/帧**（512²），远非实时（[liveportrait-web-port](https://github.com/MartinDelophy/ai-video-editor/blob/main/docs/liveportrait-web-port.md)）。
  - 路 2 的成败由 **性能 spike** 决定，不是由「能不能写出胶水」决定。
- **适合：** 验证「零外发 Web 真人」是否物理上可行；通过后再谈接入 `avatar-core`。不适合在未过 spike 前承诺与 Android Duix 同等体感。

#### C.1 Effort（路 2，1 名熟手全职粗估）

| 交付物 | 量级 |
|---|---|
| 固定 PCM + 一张脸，浏览器里嘴能动的 **spike** | **2–4 周**（见 C.3） |
| 接到网关音频、打断、`playedMs`、可日常桌面联调 | **3–5 人月** |
| 高端桌面 Chrome 口型延迟/画质 **接近** 现 Android Duix | **6–12 人月**，且仍可能达不到 |
| 手机浏览器也「同等」 | 不作为路 2 目标（Android Duix 自身已要求高配机） |

#### C.2 效果逼近把握（主观，相对 Android Duix）

| 目标 | 把握 |
|---|---|
| 脸「像真人照片」说话（换模特） | **中** |
| 桌面 Chrome **实时**跟嘴（体感 ≥~20–25 fps） | **中低**（轻量模型）；完整 MuseTalk 级 **低** |
| 打断 / `playedMs` 语义对齐 | 编排 **高**；推理卡顿会拖垮体感 |
| 用户觉得和手机 Duix「差不多」 | 高端桌面约 **30–40%**；跨设备一致 **&lt;15%** |

一句话：**「能做出会说话的脸」把握不低；「逼近当前 Android 同等实时体验」把握低。**

#### C.3 建议的 2–4 周性能 spike（过关才继续）

**目的：** 用最小代价证明「本机浏览器实时口型」在目标机器上是否成立；失败则停路 2，改回 E/F 或云方案 B。

**做法（抛出代码，不入库也可）：**

1. 选 **一个** 轻量开源管线（推荐先 Wav2Lip / Ultralight 级，不上完整 MuseTalk）。
2. 固定一段 16 kHz 或 24 kHz PCM（可用仓库 mock 语音或合成音），固定一张肖像 / 短视频资产。
3. Chrome（开 WebGPU）+ 一台写明的目标机（例如 M 系列 Mac 或带独显的 Windows）。
4. 播放 PCM 的同时出帧；记录稳态 fps、首口型延迟、打断后静音/停帧时间。

**硬验收（建议全部满足才算过）：**

| # | 条 | 建议阈值 |
|---|---|---|
| S1 | 稳态出帧 | ≥ **20 fps**（持续 ≥10 s 说话段） |
| S2 | 音频起播 → 嘴明显动 | ≤ **300 ms**（另记一档 ≤500 ms 为「勉强」） |
| S3 | 模拟打断（停 PCM） | ≤ **100 ms** 内停声；画面在 **2 帧内**回到静默/闭合嘴 |
| S4 | 无云推理 | 断网可跑（模型已缓存） |
| S5 | 机型写明 | 报告 CPU/GPU/浏览器版本；未测机型不算过关 |

**明确不算过关：** 仅能离线导出短视频；仅 CPU WASM 个位数 fps；只有静音循环脸没有音频驱动。

**spike 之后：** 过 → 再开「接入网关 / `playedMs`」的小计划；不过 → 文档记结论，Web 真人改走 B（GPU 拉流）或接受 E（Web 仍 3D）。

### D. 其他商业云数字人（D-ID、HeyGen、Azure Talking Avatar、国内云厂商等）

- **做法：** 与 A/B 类似，浏览器播对方视频流或流式口型视频。
- **利弊：** 集成快、形象管线成熟；会话/计费/隐私/打断语义均需适配；与 Duix 资产无关。
- **适合：** 不绑定硅基品牌、愿换供应商时的对照标的。

### E. Web 降级视觉，Android 独享真人（产品分层）

- **做法：** Web / `avatar-core` 继续 TalkingHead 3D（或轻量 2D 精灵/MediaPipe 嘴型）；真人仅 Android Duix。
- **接近同等效果的点：** 无。
- **利弊：** 零增量研发与 GPU 成本；与现状一致；需产品接受「Web ≠ 手机脸」。
- **适合：** POC/内测阶段、桌面只做联调。

### F. 混合：Web 调试用云流，量产手机仍端侧

- **做法：** `avatar-core` 增加可选「远端真人预览」开关 → B 或 A；正式 APK 路径不变。
- **利弊：** 工程两套渲染器；但联调可看真人感，不强迫浏览器端侧推理。

## 4. 对照表（相对 Android Duix）

| 方案 | 真人感 | 实时口型 | 复用 Lily/端侧包 | 我方网关/打断 | 零外发渲染 | 工程量 | 运行成本 |
|---|---|---|---|---|---|---|---|
| A 厂商 H5 | 高 | 高（云） | 否 | 难（双栈） | 否 | 中 | 按量 |
| B 自建 GPU 流 | 高 | 高（有 GPU） | 否* | 可得 | 否（自建机除外） | 高 | GPU 常驻 |
| C 浏览器本地（路 2 开源重做） | 中 | **待 spike**（轻量或可；重模型否） | 否（须换资产） | 可得 | 可得 | 高（先 2–4 周闸门） | 客户端算力 |
| D 其他商业云 | 高 | 高 | 否 | 难–中 | 否 | 中 | 按量 |
| E Web 保持 3D | 低（3D） | 字幕/骨骼级 | 否 | 已有 | 是 | 零 | 零 |
| F 混合 | Web 高 / App 高 | 各靠各的 | App 是 | 分支实现 | App 是 | 中高 | Web 有成本 |

\*除非自建管线专门吃同一套帧资产并重写推理，等价于自研引擎。

## 5. 建议（调研结论，非正式决策）

1. **不要期待「Duix-Mobile 同款进浏览器」。** 厂商 Web 产品是云 H5；开源桌面客户端也未提供浏览器端。
2. 若 Web **必须**真人感且可接受上云：**优先评 B（自建 GPU + WebRTC）** 与 **A/D（托管云）** 做 1–2 周 spike：同一段网关 PCM、打断延迟、`playedMs` 是否可映射、月成本、形象是否可自带。
3. 若 **零外发 / 离线** 与 Android 同级硬约束：Web 侧先做 **§3.C 路 2 的 2–4 周 spike**；不过关则短期只有 **E**，不承诺同等实时。不必逆向 Duix。
4. 与现架构最省事的产品表述：**手机 = 端侧真人；桌面 Web = 3D 或云预览（F）**，避免假装同一引擎。

## 6. 若继续，建议的下一问（拍板用）

1. Web 场景是「开发者桌面联调」还是「终端用户浏览器产品」？
2. 渲染音频/画面是否允许离开用户设备？
3. 能否接受与 Lily **不同**的模特资产？（路 2 **必须**接受）
4. 可接受的端到端口型延迟上限（例如 ≤300 ms / ≤500 ms）？
5. 预算：能否养 GPU 实例，或只接受按分钟 SaaS？
6. 若走路 2：spike 目标机是哪一台？未过 S1–S5 是否同意直接停？

## 7. 来源

- 仓库：`docs/superpowers/specs/2026-10-25-duix-avatar-engine-design.md`；`scripts/build-web.sh`（仅打包 TalkingHead，与 Duix 无关）。
- [Duix.Avatar #338](https://github.com/duixcom/Duix-Avatar/issues/338)
- [Duix H5 Quick start](https://docs.duix.com/sdks/h5/quickstart)、[H5 questions](https://docs.duix.com/sdks/h5/questions)
- [硅基 H5 文档](https://duix.guiji.ai/document/h5/)
- [mayflower/voipavatar](https://github.com/mayflower/voipavatar/)（MuseTalk + LiveKit 实时比）
- [LiveTalking usage](https://livetalking-doc.readthedocs.io/en/latest/usage.html)
- [LivePortrait Web 移植笔记](https://github.com/MartinDelophy/ai-video-editor/blob/main/docs/liveportrait-web-port.md)
- MuseTalk 实时讨论（原生 GPU，非浏览器）：[TMElyralab/MuseTalk#396](https://github.com/TMElyralab/MuseTalk/issues/396)
- ONNX Runtime WebGPU：[Execution Provider 文档](https://onnxruntime.ai/docs/execution-providers/WebGPU-ExecutionProvider.html)
