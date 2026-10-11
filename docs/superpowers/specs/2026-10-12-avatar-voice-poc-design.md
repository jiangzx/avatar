# AI 虚拟人实时语音对话 POC 设计（Android 手机首版）

- 日期：2026-10-12；状态：设计已获用户同意（v0.2 + 多轮上下文），待评审
- 背景：[可行性报告](../../elderly-avatar-companion/01-feasibility-report.md)。本 POC 只验证"流畅、主动、可打断、有动作的虚拟人对话"这一体验，不做可行性报告 §5 中的风控、长期记忆、联系家人等产品功能。
- 标注：**【已核实】** = 调研时打开过官方文档/包源；**【未核实】** = 搜索摘要或推断；**【预估】** = 未经实测的目标值。

## 1. 目标与范围

### 1.1 目标
7 天内交付一个可在**小米 Android 手机（Android 12+）**上安装演示的 APK：打开即由 3D 半写实虚拟人主动问候，用普通话进行流畅多轮语音对话，可随时打断，能按语音指令做 5 个动作。

决策优先级：交流流畅度与自然主动性 > 可靠打断与动作 > 虚拟人逼真度。

### 1.2 范围内
- 主动迎宾、静默追问（可控频率）、多轮上下文接话。
- 流式语音回复、随时打断、旧语音与旧字幕零残留。
- 虚拟人：idle / listening / thinking / speaking 状态、口型、表情、动作 wave / nod / smile / turn / heart。
- 竖屏字幕、"AI"常驻标识、静音与结束按钮、调试指标面板。

### 1.3 范围外（明确不做）
Web 端、平板适配（后期）、方言、跨会话长期记忆、危机/诈骗风控、联系家人、账号体系、上架。

### 1.4 已确定约束
- 只用境内模型；暂不考虑 API 成本，但控制工程复杂度。
- 模型 API Key 暂未提供：拿到 Key 之前，所有模块（含摘要）必须能用 Mock 跑通。
- 本机：Flutter 3.47.6 / Dart 3.13.5、Node 24、Python 3.12；需安装 Android SDK 与 adb。

## 2. 总体架构

```
┌──────────────── Android App（Flutter） ────────────────┐
│ Flutter 层：权限、常亮、全屏竖屏 UI（字幕 / AI 标识 /     │
│   静音 / 结束 / 指标面板）、网络状态、Bridge             │
│        ▲  JavaScriptChannel / runJavaScript（Bridge）     │
│        ▼                                                 │
│ WebView（webview_flutter）加载本地打包的 avatar-core     │
│   ├─ AudioIO（方案 A）：getUserMedia 采集 → 本地 VAD     │
│   │    → PCM16 16k 上行；AudioWorklet 播放下行 PCM       │
│   ├─ GatewayClient：WSS 连接网关                          │
│   ├─ Avatar：three.js + TalkingHead，GLB 人物            │
│   └─ 状态机 / 口型 / 表情 / 动作层                        │
└──────────────────────────── WSS ───────────────────────┘
                              │
┌──────────── gateway（Node 24 + TypeScript） ────────────┐
│ SessionManager → RealtimeAdapter（Seeduplex | Qwen | Mock）│
│ ConversationLedger + Summarizer（多轮上下文）             │
│ Director（迎宾 / 追问 / 主动性限流）                       │
│ InterruptCoordinator（取消 / 迟到包丢弃 / 上下文对齐）     │
│ ActionRouter（工具调用 + 关键词快速通道 + 去重）           │
│ Metrics（只记时延与事件类型）                              │
└─────────────────────────────────────────────────────────┘
```

### 2.1 为什么是这个形态
- **WebView 渲染 3D**：Flutter 侧没有成熟的实时 3D 方案（flutter_scene 还没到 1.0；flutter_3d_controller 不能控制 blendshape）【已核实】。
- **音频默认放在 WebView（方案 A）**：口型分析只能读取同一 JS 上下文里播放的音频【已核实】。另外，avatar-core 可以在电脑 Chrome 里快速调试（只当调试环境，不交付）。
- **本地页面加载**：avatar-core 构建产物放在 Flutter assets 中，由 App 内启动的 **127.0.0.1 本地 HTTP 服务**（`dart:io` HttpServer，随机端口，只绑定回环地址，路径带随机 token，`.wasm` 返回 `application/wasm`）提供，WebView 加载 `http://127.0.0.1:<port>/<token>/index.html`。localhost 属于安全上下文，ES module、AudioWorklet、onnx/wasm、GLB 都能正常 fetch，同时不需要开启 WebView 的文件访问。这一项是 Day 1 ① 的显式验证项。
- **方案 B（Flutter 原生音频）作为 Day 1 对照**：`record`（VOICE_COMMUNICATION 音源 + echoCancel）采集，`flutter_pcm_sound` 播放，原生侧计算音量和频带后通过 Bridge 驱动口型。两个方案都实现 `AudioIO` 接口，网关协议完全相同。选定标准见 §9 Day 1。
- **自建网关，不引入 LiveKit**：LiveKit 官方实时模型插件里没有 Qwen 和豆包【已核实】；使用实时模型自带的服务端 VAD 时，LiveKit 的大部分打断参数会被忽略【已核实】；自部署还要 TURN、TLS、UDP 端口段。另外两家模型的 WS 接口都要求请求头鉴权，本来就需要服务端代理【已核实】。
- **Plan B 传输**：如果方案 A、B 都压不住外放回声（判定阈值见 §10），改用 `flutter_webrtc`。优先直连 Qwen 原生 WebRTC（官方称自带回声消除和降噪【已核实】），其次自部署 LiveKit。这个切换只影响 Transport/AudioIO 层。

### 2.2 方案 A / B 职责归属

| 职责 | 方案 A（默认，完整实现） | 方案 B（Day 1 只做 spike 对照） |
|---|---|---|
| 采集 + AEC | WebView getUserMedia | Dart `record`（VOICE_COMMUNICATION + echoCancel） |
| 本地 VAD | avatar-core（vad-web / Silero） | spike 阶段只用能量阈值，不做 Silero |
| 播放、淡出、清空、`responseSeq` 门控、进度上报 | avatar-core AudioWorklet | Dart `flutter_pcm_sound` |
| WSS GatewayClient | avatar-core（TS） | Dart |
| 口型输入 | JS 内直接读取 PCM | Dart 计算音量后通过 Bridge 发送 `audio.level` |

方案 B 在 Day 1 只验证一件事：真机外放下回放 Mock 长音频，原生采集里的残余回声会不会触发自打断（按能量阈值计数），并和方案 A 对比。如果 B 明显胜出，就把上表 B 列的职责迁到 Dart，并在 ADR-001 里重排 Day 2–4 的任务，预计多花约 1 天；这个代价计入风险。

## 3. 语音模型

| | 豆包实时语音 3.0 Seeduplex（主候选） | Qwen-Omni-Realtime `qwen3.8-omni-flash-realtime`（备选） |
|---|---|---|
| 接入 | `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`，JSON 帧，音频 Base64，16 kHz 输入，20 ms 一包、按实时节奏发送【已核实】 | WebSocket（Bearer 请求头）或 WebRTC【已核实】 |
| 判停 | 全双工 | `semantic_vad`，`silence_duration_ms` 可调（200–6000）【已核实】 |
| 打断 | `response.cancel` / `response.canceled`【已核实】 | `response.cancel`、`input_audio_buffer.speech_started`；文档未提 `truncate`【已核实】 |
| 工具调用 | `session.update` 里声明 tools，下行 `response.function_call_arguments.done`，结果用 `conversation.item.create(role=tool)` 回传【已核实】 | 支持 Function Calling【已核实】 |
| 上下文 | instructions + 系统提示 + 上下文合计 ≤12K tokens【已核实】 | 单次会话最长 120 分钟【已核实】 |
| 延迟 | 无官方毫秒数据【未核实】 | 无官方毫秒数据【未核实】 |

- **主次在 Day 1 实测后决定**，依据：首响应延迟、主观自然度、工具调用是否打断语流、打断后的行为。
- 两家的输出音频格式（采样率、编码）以 Day 1 实测为准。网关统一转成 **PCM16 / 24 kHz / 单声道**再下发【未核实，Day 1 确认】。
- `RealtimeAdapter` 接口（网关内部）：
  - `connect(sessionConfig)`、`sendAudio(pcm16k)`、`updateInstructions(text)`、`createResponse(instructions?)`、`cancelResponse()`、`sendToolResult(callId, result)`、`injectContextNote(text)`、`close()`。
  - 事件：`userSpeechStarted`、`userTranscript(delta|final)`、`responseStarted(id)`、`audioDelta(id, pcm)`、`textDelta(id, text)`、`toolCall(id, name, args)`、`responseDone(id)`、`responseCancelled(id)`、`error`。
- **MockAdapter**：不需要 Key。所有集成测试和无 Key 开发都依赖它。
  - 按用户音频能量判断开口和说完，发出 `userSpeechStarted`。
  - 按脚本（`gateway/mock/script.json`，第 N 句话对应一条记录）发出 `userTranscript(delta, final)`。真机上也可以在调试面板里直接输入文本，代替语音识别结果。
  - 回放预录的 PCM（或合成的正弦波语音包络）和对应文本，并按脚本发出 toolCall。
- **Summarizer 接口**：`LlmSummarizer`（拿到 Key 后使用）/ `MockSummarizer`（按条目拼接后截断到 800 字）。

## 4. 客户端 ↔ 网关协议（WSS）

- 鉴权：App 启动时向网关 `POST /session` 换取一次性 session token（有效期 5 分钟），然后带着 token 连接 WSS。模型 Key 只存在网关的环境变量中。
- 二进制帧：`[1 字节类型][4 字节 responseSeq（uint32 BE），上行为 0][PCM16 数据]`。类型：`0x01` 上行麦克风音频，`0x02` 下行 AI 音频。
  - 上行：16 kHz、20 ms 一帧。
  - 下行：24 kHz。
- JSON 帧：

| 方向 | type | 字段 | 用途 |
|---|---|---|---|
| C→G | `session.start` | `clientInfo` | 开始会话，网关随后触发迎宾 |
| C→G | `vad` | `state: speaking\|silent`, `t` | 本地 VAD 状态，供 Director 和打断使用 |
| C→G | `playback.progress` | `responseSeq`, `playedMs` | 每 200 ms 上报一次已播放进度 |
| C→G | `playback.stopped` | `responseSeq`, `playedMs`, `reason: interrupted\|ended` | 打断或播放结束 |
| C→G | `client.mute` | `muted: bool` | 关闭/打开麦克风：静音期间停止上行音频，Director 暂停主动发言 |
| C→G | `session.end` | — | 结束会话 |
| G→C | `response.start` | `responseSeq`, `kind: reply\|greeting\|followup` | 新回复开始；客户端把它设为当前激活回复 |
| G→C | `response.end` / `response.cancelled` | `responseSeq` | 回复结束 / 已取消 |
| G→C | `transcript.user` | `text`, `final` | 用户字幕 |
| G→C | `transcript.assistant` | `responseSeq`, `text`（增量） | AI 字幕 |
| G→C | `avatar.action` | `action`, `source: tool\|keyword` | 执行动作 |
| G→C | `avatar.emotion` | `emotion: neutral\|happy\|...` | 可选，表情提示 |
| G→C | `metric` | `name`, `ms` | 时延回显，供指标面板显示 |
| G→C | `error` | `code`, `retryable` | 错误 |

- `POST /session` 要求请求头携带静态 App 密钥（网关环境变量配置，不进仓库，只在 debug/内测 APK 中注入）；公网部署时再加 IP 白名单（Day 7）。
- Bridge（WebView ↔ Flutter）：在 JS 和 Flutter 之间转发字幕、状态、指标、错误事件，以及 Flutter 发出的静音和结束指令。方案 B 下还要承载 `audio.level`（约每 30 ms 一条）。

## 5. 打断与零残留

1. **本地抢先停播**：本地 VAD（Silero，vad-web）检测到用户开口超过 150 ms【预估，待调参】时，AudioWorklet 立即把当前回复淡出 30 ms 并清空缓冲，然后上报 `playback.stopped(interrupted, playedMs)`。在模型侧检测到用户说话（`userSpeechStarted`）之前就已经停了。
2. **网关取消（AI 播放期间需要本地确认）**：
   - 收到客户端 `playback.stopped(interrupted)`：立即调用 `cancelResponse()`。
   - 只收到模型侧 `userSpeechStarted`、本地 VAD 没有触发：等 300 ms，期间本地 VAD 确认说话才取消，否则忽略（多半是回声）。不在 AI 播放期间时，直接以模型侧事件为准。
   - 模型自带的自动打断：能关就关（例如 Qwen 的 turn_detection 打断开关，如果有的话），统一交给网关判断；关不掉的，网关接受模型侧取消，计入"误打断"指标，并按第 5 条处理。各模型是否可关，Day 1 拿到 Key 后核实。
   - 取消后，把该 `responseSeq` 记入已取消集合；之后这个回复迟到的音频、文本、工具调用全部丢弃。
3. **客户端门控**：只播放和显示 `responseSeq` 等于当前激活回复的数据；`response.cancelled` 到达后，把该回复的字幕截断到已播放的位置。
4. **上下文对齐**：Ledger 把这条助手回复截断到已播放部分。截断点 = 已收到文本长度 × `playedMs` ÷ 截至取消时已收到的音频时长（取近似值），并标注"（被用户打断）"。模型不支持按播放进度截断时，网关调用 `injectContextNote("助手上一句只说到：『…』，被用户打断")`。
5. **误打断**：如果 VAD 触发后 600 ms【待调参，Day 1 实测 `userTranscript(delta)` 首字延迟后确定】内模型侧没有识别到任何用户文字，就视为噪声或回声。这时**不恢复**旧回复（宁可少说，也不重复），由 Director 判断是否补一句"你刚刚是想说什么吗？"【待调参】。
6. **外放期间的保护**：AI 播放期间，本地 VAD 的触发阈值提高一档【预估，待调参】，降低回声自打断。

## 6. 多轮上下文记忆（会话内）

模型自带的上下文有限（Seeduplex 合计 ≤12K tokens），会话也可能因断网或时长上限而重建。所以由网关维护一份与具体模型无关的对话记录，作为唯一可信的上下文来源。

- **ConversationLedger**（只存在内存里，随会话结束销毁，不落盘、不写日志）：
  - 有序记录：`{role, text, ts, interrupted?}`。
  - 用户条目取 ASR 终稿；助手条目取**实际已播放**的文本（见 §5.4）。
- **滚动摘要**：Ledger 估算超过 6K tokens，或累计超过 16 轮时【预估】，在后台调用一次文本 LLM（与主模型同一家的轻量模型，如 qwen-flash 或 doubao-seed mini 系列，Day 1 确定）。
  - 把较早的轮次压缩成「对话摘要」，内容包括：
    - 用户的称呼和自述信息；
    - 提到过的人和事；
    - 用户表达过的情绪和偏好；
    - 未聊完的话题清单（open topics）。
  - 保留最近 8 轮原文。
  - 摘要通过 `updateInstructions` 注入，格式：「人设 + 对话摘要 + 最近 8 轮」。
  - 摘要在后台异步执行，不阻塞对话。
- **会话重建**：模型连接断开、或达到时长上限时，用「人设 + 摘要 + 最近 8 轮」新建模型会话，客户端连接不断开。重建期间虚拟人保持 listening 状态，并显示"网络有点慢，稍等我一下"。
- **模型侧上下文瘦身**：`updateInstructions` 不会清掉模型会话里已经积累的历史。所以模型侧上下文估算接近上限（Seeduplex 按 12K tokens 的 80% 算【预估】），或者已经累计 30 轮时，网关在下一次用户说完、AI 回复开始之前，主动做一次"会话重建"（见下条）来瘦身。模型自己会不会截断上下文，Day 1 拿到 Key 后核实。
- **接话**：人设提示词要求"优先接住用户上一句里的具体内容，再自然延伸"。Director 发起追问时，优先从 open topics 里挑话题。
- **验收**（见 §10）：第 2 轮说出的事实，第 10 轮能正确引用；被打断后问"你刚才说到哪了"，回答与已播放内容一致；断线重连后能接上之前的话题。

### 6.1 客户端重连与会话保留
- `POST /session` 返回 `sessionId` + 一次性 `connectToken`（5 分钟）+ `resumeToken`（只在本会话内有效，每次重连成功后轮换）。
- WSS 断开**不等于** `session.end`。网关为断开的会话保留 Ledger、摘要和模型连接 60 秒【预估】的宽限期；期间丢弃模型下发的音频，并取消进行中的回复。
- 客户端重连：带 `sessionId` + `resumeToken` 调用 `POST /session/resume`，换取新的 `connectToken` 并重新连接 WSS，发送 `session.resume`。网关回复 `session.resumed {lastResponseSeq}`；客户端清空播放缓冲，丢弃所有 `responseSeq ≤ lastResponseSeq` 的数据，只接受更大的序号。之后由 Director 决定是否说一句"刚才网络断了一下，我们接着聊～"，再接上之前的话题。
- 宽限期过了还没重连，或者收到 `session.end`：销毁 Ledger 并关闭模型连接。客户端之后再连就是新会话，重新迎宾。
- 协议新增：C→G `session.resume`；G→C `session.resumed {lastResponseSeq}`。

## 7. 主动性：Director

- **迎宾**：`session.start` 后立即 `createResponse(greeting)`，内容是简短问候加一个轻松的开放式问题。Android 上关闭"媒体播放需用户手势"限制，打开 App 就能出声。
- **静默追问**：AI 回复播放结束后，用户 8 秒没有说话（本地 VAD 和模型侧都没检测到语音），追问 1 次；之后再沉默 25 秒，只说一句"我在这儿呢，想聊随时叫我"，然后进入安静的 idle 状态，不再主动开口，直到用户说话。【所有数值为预估，可配置】
- **限流**：
  - 用户或模型侧检测到有人在说话时，绝不主动开口。
  - 连续主动发言最多 2 次。
  - 每 5 分钟最多 3 次主动发言。
  - 用户说"别说了 / 安静一会儿"后，本次会话不再追问。
- **人设提示词要点**：
  - 像朋友一样说口语，每次 1–3 句；不必每轮都提问（目标是不超过一半的轮次）；
  - 先回应，再延伸；
  - 不用"宝宝"之类的叠词称呼，不声称自己有感情；
  - 被问到是不是真人时，如实说明是 AI；
  - 收到动作请求时，用一句话自然回应（如"好呀～"），不要描述动作过程。
- 配置文件：`gateway/config/director.json`、`gateway/prompts/persona.md`，可热加载，方便 Day 5 调参。

## 8. 虚拟人与动作

### 8.1 渲染与素材
- three.js + TalkingHead（MIT 许可；流式音频接口、手势、情绪、视线）【已核实】。
- 人物：GLB 格式，要求 52 个 ARKit blendshape + Mixamo 兼容骨骼。
  - 来源优先 Avaturn（导出时勾选 ARKit blendshape），其次购买现成 GLB。Ready Player Me 已关停【未核实，多源一致】。
  - **Day 1 定稿**：东亚面孔、半写实、授权允许用于内部演示。
- 预算：约 3 万面、贴图 ≤2K、不开实时阴影；说话和动作时 60 fps 上限，idle 时降到 30 fps。
- 构图：竖屏半身（头部到腰部）；挥手、比心、转身的动作幅度都要在画面内，转身时镜头随之调整。

### 8.2 状态机
| 状态 | 进入条件 | 表现 |
|---|---|---|
| idle | 会话空闲 | 呼吸、随机眨眼、偶尔小幅移动视线 |
| listening | 本地 VAD 检测到用户说话 | 目光注视用户，偶尔轻点头附和 |
| thinking | 用户说完，第一帧音频还没到 | 视线略微偏移、眨眼；超过 1.5 秒加一个轻微"嗯"的表情 |
| speaking | 当前回复正在播放 | 口型 + 情绪表情 + 小幅说话手势 |

打断时任何状态都直接切到 listening。动作在独立的动作层执行，不改变当前状态。

### 8.3 口型
从播放中的 PCM 实时计算 RMS 和三个频带的能量（每帧约 16 ms），映射为 `jawOpen` 加 aa / oh / ee 的混合权重，并做平滑处理（attack 30 ms、release 80 ms【预估】）。音频停止，口型立即归零。这只是"大体同步"的近似方案；中文拼音韵母的精确映射留到后期。

### 8.4 动作
- 固定集合：`wave` 挥手、`nod` 点头、`smile` 微笑（表情层，持续 2 秒）、`turn` 转身一圈、`heart` 比心。
- **主路径**：模型调用工具 `perform_action({action})`，`action` 只能取上面 5 个值之一。网关立即回传 `{ok:true}`（不等待动画完成），然后下发 `avatar.action(source=tool)`。
- **快速通道**：网关拿到用户语音的 ASR 终稿后，用关键词规则匹配：挥手/招手/打招呼、点头、笑一下/笑一个、转身/转一圈/转过去、比心/比个心。命中就立即下发 `avatar.action(source=keyword)`。
- **去重**：同一个动作 3 秒内只执行一次（先到先执行）。
- **执行**：上半身动作用 Mixamo 片段重定向，通过骨骼遮罩叠加在 idle 或 speaking 上，所以能边说边做；动作执行中又来新动作时，在 200 ms 内交叉淡入切换；被打断时动作淡出。
- **比心**：Mixamo 没有现成动作，需要手调手指姿势。如果 Day 4 结束时效果不过关，就改成双臂举过头顶的"大比心"。

## 9. 七天计划

| Day | 任务 | 产出 | 验收 | 风险 |
|---|---|---|---|---|
| 1 | ① 安装 Android SDK 和 adb，Flutter 应用加 WebView（本地 127.0.0.1 服务加载页面）在小米真机上跑通：麦克风权限、免手势播放、AudioWorklet、wasm、WebGL<br>② 网关骨架 + MockAdapter，真机上走通"说话→Mock 回放"<br>③ 音频方案 A 和 B 在真机外放下对比（用 Mock 播放长音频，测自打断次数和本地停播延迟）<br>④ TalkingHead 加载候选 GLB，测真机帧率<br>⑤ 拿到 Key 后：Seeduplex 和 Qwen 连通，测首响应延迟和工具调用 | `app/`、`avatar-core/`、`gateway/` 骨架；`spikes/`；`docs/adr/ADR-001-选型.md` | 真机上 Mock 链路能语音往返；A/B 方案选定（选外放 10 分钟自打断更少的；持平时选 A）；GLB 帧率 ≥30 fps | 没有 Key 时，⑤顺延，主模型选择推迟到拿到 Key 的当天；国产 ROM 的 WebView 版本；当天任务量大，人物定稿可以顺延到 Day 2，先用临时 GLB 测帧率 |
| 2 | 真实模型适配器；迎宾；字幕；Ledger | 适配器、Director 迎宾、字幕 UI | 打开 App ≤2 秒开始迎宾；连续 5 轮对话 | 模型协议细节 |
| 3 | 打断全链路（§5）；会话重建；断线重连 | InterruptCoordinator 及其测试 | 50 次打断残留 0 次；停播延迟达标 | 模型不支持按播放进度截断上下文 |
| 4 | 状态机、口型、表情、5 个动作（工具调用 + 快速通道） | `avatar-core` 动作层与状态机 | 5 个动作 × 10 种说法全部执行正确 | 比心动作、发热 |
| 5 | Director 调参、滚动摘要、人设提示词；主备模型 A/B | 配置文件、提示词、摘要模块 | 抢话率 ≤10%；第 10 轮能回忆第 2 轮的事实 | 主动性过强或过弱 |
| 6 | 真机测试：30 分钟连续运行、发热、断网、切后台、来电打断；指标表填入实测值 | 测试报告 | 指标逐项给出实测值，与目标值分开列 | 小米后台限制 |
| 7 | 回归测试、修 bug；网关部署到境内云服务器（WSS + TLS + App 密钥 + IP 白名单）；打 release APK；交付文档 | APK、README、演示脚本 | §10 的 7 个场景全部走通 | 云服务器与域名/证书的准备 |

## 10. 验收场景与指标

### 10.1 场景
1. 打开 App 后，虚拟人主动、自然地打招呼。
2. 连续多轮中文对话，能理解上下文并自然追问。
3. 虚拟人说话时用户插话，旧语音迅速停止，没有旧回复残留。
4. "挥挥手""对我笑一下""点点头""转个身""比个心"都能正确执行，并配一句自然的口头回应。
5. 用户停顿、改主意、连续补充时，虚拟人不频繁抢话。
6. 口型、表情、倾听和说话状态与实际交互基本一致。
7. 小米手机上 30 分钟稳定运行。

### 10.2 指标（全部是【预估目标值】，Day 6 报告中实测值与目标值分开列）
| 指标 | 定义 | 目标 |
|---|---|---|
| 首响应延迟 | 本地 VAD 判定用户说完 → 第一帧 AI 音频开始播放 | P50 ≤1.5 秒，P90 ≤2.5 秒 |
| 迎宾延迟 | App 冷启动完成 → 问候音频开始播放 | ≤2 秒 |
| 打断停止延迟 | 本地 VAD 检测到用户开口 → AI 播放静音 | P50 ≤300 毫秒，P90 ≤500 毫秒 |
| 旧语音残留 | 打断后又出现旧回复的音频或字幕 | 50 次中 0 次 |
| 误打断 | 正常外放音量下，AI 被自己的声音打断 | ≤1 次/10 分钟 |
| 抢话率 | 停顿、补充、改主意脚本 20 条中，用户没说完 AI 就接话 | ≤10% |
| 上下文回忆 | 10 轮对话中，第 2 轮说出的 3 个事实在第 10 轮被正确引用 | ≥2/3 |
| 动作准确率 / 时延 | 50 条动作语音指令；从 ASR 终稿到动作开始 | ≥90%；≤1 秒 |
| 对话成功率 | 20 次会话 × 10 轮，无卡死、无报错 | ≥90% |
| 稳定性 | 30 分钟连续会话 | 0 次崩溃；帧率 ≥30 fps；无明显降频卡顿 |

测量方式：客户端和网关在关键事件上打单调时钟时间戳，网关汇总后显示在指标面板，Day 6 导出为 CSV。只记录事件类型和时延。

## 11. 测试策略
- **gateway 单元测试（vitest）**：
  - Director 定时器和限流（用假时钟）；
  - InterruptCoordinator：取消集合、迟到包丢弃；
  - Ledger 截断和摘要触发；
  - 关键词匹配和动作去重；
  - 协议编解码。
- **gateway 集成测试**：基于 MockAdapter，脚本化"迎宾→对话→打断→工具调用→重建"，断言下行事件序列。
- **avatar-core 单元测试（vitest）**：播放器门控和清空（用离线 AudioContext 或纯函数）、口型映射函数、状态机迁移。
- **Flutter**：Bridge 消息解析的单元测试；一个能启动应用的 widget 冒烟测试。
- **真机手工测试**：按 §10 的场景脚本执行；停顿和抢话测试用固定的录音或固定台本。

## 12. 安全与隐私
- 模型 Key 只放在网关环境变量中，不进 APK、不进仓库（`.env` 加入 `.gitignore`）；客户端只持有短期 session token。
- 全链路 HTTPS/WSS。Android `networkSecurityConfig`：
  - **release 和 debug** 都用 `domain-config` 放行明文访问 `127.0.0.1`（只放这一个地址，给 WebView 加载本地页面用）；
  - 开发用的局域网网关 `ws://` 只在 debug 构建中放行；
  - 其他地址一律只允许 HTTPS/WSS。
- **日志不记录任何对话内容**（音频、ASR 文本、回复文本都属于 L4 用户内容）；只记录事件类型、时延、错误码。Ledger 只在内存里，会话结束即释放。
- 网关校验客户端消息：JSON schema 校验、单帧大小上限、上行音频速率上限，每个 token 只允许一个连接。
- WebView 只加载 App 内打包的本地页面；不开文件访问。麦克风：先申请 App 级别的 `RECORD_AUDIO` 运行时权限，再在 `setOnPlatformPermissionRequest` 里只授予 `RESOURCE_AUDIO_CAPTURE`（Day 1 ① 的验证项）。
- 界面常驻"AI"标识；人设中如实承认 AI 身份（拟人化办法第 18 条）。POC 仅限内部演示。

## 13. 仓库结构
```
anyidea/
  app/            Flutter Android 应用（壳 + UI + Bridge + 方案 B AudioIO）
  avatar-core/    TypeScript + Vite：虚拟人、方案 A AudioIO、GatewayClient；构建产物拷入 app/assets/web/
  gateway/        Node 24 + TypeScript：会话、适配器、Director、Ledger
  spikes/         Day 1 验证脚本（不进入交付）
  docs/           调研、规格、ADR、测试报告
```

## 14. 主要风险
1. 外放回声：方案 A/B 对比（如果 B 胜出，需要迁移职责，多花约 1 天）；播放期间提高 VAD 阈值；以 WebRTC 传输作为 Plan B。
2. 国内模型的实际延迟和自然度没有公开数据：用 Mock 先开发，拿到 Key 后立即双模型实测。
3. API Key 暂未提供：所有模块都先基于 MockAdapter 开发；拿到 Key 后真实模型的接入和调参会挤压后续进度，尤其是 Day 2 和 Day 5。
4. 人物素材与比心动作：Day 1 定稿人物，比心准备了退路方案。
5. 小米 WebView 版本、后台限制、发热：Day 1 真机检查，Day 6 做压力测试。
6. 中文口型只是近似：POC 接受"大体同步"。
