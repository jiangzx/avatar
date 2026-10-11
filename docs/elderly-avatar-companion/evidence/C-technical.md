# 证据包 C：技术可行性与成本

- 采集日期 / 访问日期：2026-10-09（以下所有 URL 的访问日期如无特别说明均为 2026-10-09）
- 方法：先用 WebSearch 找候选来源，再用 WebFetch 或 curl（调用火山引擎文档 JSON 接口、解析阿里云价格页 HTML、用 pypdf 抽取论文 PDF 正文）逐条核实。卡片中只记录实际打开核实过的内容；搜索摘要里出现但没有打开核实的内容，要么标为"未核实"，要么不收录。
- 卡片格式：`[C-编号] 结论 | 数值/原文摘录 | 来源标题 | 发布方 | 发布日期/版本 | URL | 访问日期 | GRADE | 适用范围与偏差`
- GRADE：A = 官方文档/论文；B = 知名技术博客/开源仓库；C = 教程；D = 社区
- 厂商给出的延迟、准确率一律标为"厂商自述"。价格均为官方页面上的刊例价，不含限时优惠。

---

## C1 可打断语音链路

### C1.1 端到端实时语音模型（中国大陆厂商）

[C-1.1] 阿里云百炼 Qwen-Omni-Realtime 提供 WebSocket/WebRTC 实时音视频接口，服务端 VAD 有 server_vad 与 semantic_vad 两种 | "VAD 类型可选 server_vad 或 semantic_vad；使用 qwen3.5-omni-realtime 系列模型时推荐设为 semantic_vad"；silence_duration_ms "取值范围 200-6000，默认 800"；支持的模型：qwen3.8-omni-flash-realtime（推荐）、qwen3.5-omni-plus-realtime、qwen3.5-omni-flash-realtime、qwen3-omni-flash-realtime；"单次会话最长可持续 120 分钟"；语音识别"支持 113 种语种和方言"，语音生成 36 种 | Qwen-Omni 实时模型 | 阿里云 | 页面未标日期（2026-10 访问时的版本） | https://help.aliyun.com/zh/model-studio/realtime | 2026-10-09 | A | 官方能力描述；"113 种语种和方言"为厂商自述，没有给出分方言准确率。

[C-1.2] Qwen-Omni-Realtime 的打断：用户一开口就打断模型，但官方建议用耳机避免回声误触发 | Python SDK 文档原文："推荐使用耳机播放音频，避免回声触发语音打断"；开启 turn detection 后，用户在模型回复期间开口，服务端会打断并立即停止回复，回到输入状态；WebRTC 示例注释："支持语音打断：用户开始说话时清空缓存，停止播放模型的旧回复" | Python SDK 调用 Qwen-Omni 实时模型 | 阿里云 | 未标日期 | https://help.aliyun.com/zh/model-studio/omni-realtime-python-sdk | 2026-10-09 | A | **关键信号**：平板外放场景下，回声会误触发打断，客户端必须做 AEC（见 C-1.12），否则就只能戴耳机，而老人场景一般不戴耳机。

[C-1.3] 火山引擎豆包端到端实时语音大模型（RealtimeAPI）原生支持打断事件、可调判停窗口、可按播报进度截断上下文 | "ASRInfo（450）：模型识别出音频流中的首字返回的事件，用于打断客户端的播报"；end_smooth_window_ms "默认1500ms，取值范围[500ms, 50s]"；ConversationTruncate（513）"仅保留对应item_id的audio_end_ms已播报毫秒时长对应的上下文内容"（仅 2.0 模型）；修订记录 26.02.26："支持基于客户端实际播报进度进行上下文对齐，仅向模型暴露已播放内容"；ClientInterrupt（515）用于 push_to_talk 模式；"目前只支持server_vad模式"；"支持中文和英语两大语种"；dialog_id 加载历史"目前服务端仅支持最近20轮QA对"；TTS explicit_dialect 支持 dongbei/sichuan/shaanxi/yue/beijing/henan/tianjin/shanghai（"只在4个精品音色生效"） | 端到端实时语音大模型API接入文档 | 火山引擎（豆包语音） | 文档更新于 2026-09-28；模型版本 1.2.1.1（O2.0）/2.2.0.0（SC2.0） | https://docs.volcengine.com/docs/6561/1594356 | 2026-10-09 | A | 这是"停止播报 + 上下文续接"做得最完整的一份官方文档；输入只支持中文和英语，方言输入能力没有说明。

[C-1.4] 豆包实时语音模型 3.0（Seeduplex）为全双工端到端版本，协议与原版不同，并支持客户端 response.cancel 打断 | "豆包实时语音模型 3.0（Seeduplex）是一款全双工端到端语音大模型，提供低时延、高拟人的实时语音对话能力"；请求路径 wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue；model 固定值 1.2.6.1；instructions 与内部 SP 及上下文"合计长度上限为 12K tokens"；音频"仅支持16000"Hz，"音频分片建议以20 ms为单位…严格按照实时音频流的节奏发送"；response.cancel"用于取消进行中的响应，即客户端主动打断服务端播报" | 端到端实时语音（S2S 全双工） | 火山引擎 | 文档更新于 2026-09-28 | https://docs.volcengine.com/docs/6561/2549778 | 2026-10-09 | A | "低时延"为厂商自述，没有给出数值。

[C-1.5] 智谱 GLM-Realtime 支持服务端/客户端 VAD 与自动打断，但通话记忆只有约 2 分钟 | "人也可以实时打断AI"；turn_detection.interrupt_response 控制 VAD 检测到说话时是否自动中断回复；Server VAD 与 Client VAD 两种模式；"通话记忆时长长达 2 分钟"；音频通话上下文 8K（约 20 轮）；价格：GLM-Realtime-Flash 音频 0.18 元/分钟、Air 0.3 元/分钟 | GLM-Realtime | 智谱 AI 开放平台 | 未标日期 | https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-realtime | 2026-10-09 | A | 记忆窗口短，不适合依赖长对话上下文的陪伴场景，需外挂记忆（C8）；文档没有给出延迟数值。

[C-1.6] MiniMax 于 2024-10-24 发布 Realtime API（HTTP + WebSocket，文本/语音输入输出） | "The realtime API released this time include HTTP and WebSocket interfaces"；延迟描述只有"End-to-end latency has been significantly optimized"（厂商自述，无数值）；公告里没有提到打断 | Launch realtime API | MiniMax | 2024-10-24 | https://www.minimax.io/news/realtime-api | 2026-10-09 | A（官方公告） | 官方文档页 https://platform.minimaxi.com/document/Realtime 由 JS 渲染，**未能打开**，打断事件和 VAD 参数未核实。

[C-1.7] 百度千帆的"实时语音对话能力"是 ASR→Agent→TTS 串联示例，没有实现打断 | 原文："通过循环不断处理用户的语音，将语音转文本，然后进行对话，最后将对话结果通过TTS进行播报"；VAD 用 webrtcvad（Vad(1)，16kHz，30ms 帧）；示例中播报结束后才重新录音 | 实时语音对话能力 | 百度智能云千帆 | 2025-04-18 | https://cloud.baidu.com/doc/qianfan-docs/s/jm98dle5w | 2026-10-09 | A | 只说明千帆没有提供官方端到端实时接口（就此页而言）；不代表百度其他产品线没有。

[C-1.8] 讯飞：有"超拟人交互"产品，但官方 Web API 文档本次**未能打开核实** | 搜索得到的文档索引显示存在"超拟人数字人交互SDK文档"（https://www.xfyun.cn/doc/spark/Virtual_interaction.html）和"超拟人语音合成API文档"；打断机制、价格（媒体报道称"每分钟低至0.1元"）均**未核实** | — | 讯飞开放平台 | — | https://www.xfyun.cn/doc/spark/Virtual_interaction.html | 2026-10-09 | D（仅线索） | 列为 [coverage_gap]。

### C1.2 级联链路组件与开源框架

[C-1.9] Pipecat：本地 Silero VAD + Smart Turn 语义判停，默认允许打断 | "the bot immediately stops speaking, in-flight work is cancelled"；VADParams start_secs / stop_secs 默认 0.2；默认判停策略为 TurnAnalyzerUserTurnStopStrategy + LocalSmartTurnAnalyzerV3；本地 VAD "150-200ms faster than remote VAD services"（项目自述） | Speech input / turn detection | Pipecat（Daily） | 2026-10 访问时的版本 | https://docs.pipecat.ai/guides/learn/speech-input | 2026-10-09 | B | 开源框架文档；延迟数据为项目自述。

[C-1.10] Smart Turn v3 支持 23 种语言（含中文），8MB 量化模型，CPU 推理可低至约 10ms | "23 languages"（列表含 Chinese）；CPU 版 "8MB quantized"；"as little as 10ms on some CPUs, and under 100ms on most cloud instances"；BSD-2-Clause | smart-turn | pipecat-ai | 仓库当前版本 | https://github.com/pipecat-ai/smart-turn | 2026-10-09 | B | 没有公布中文判停准确率；对老人语速慢、停顿多的效果未知。

[C-1.11] LiveKit Agents：默认 turn detector 模型 + VAD，支持误打断恢复；旧版多语言文本 turn detector 列出了中文准确率 | 判停模式包括 turn detector 模型、realtime 模型、VAD only、STT endpointing、manual；`false_interruption_timeout` / `resume_false_interruption`：检测到打断但用户随后沉默时默认恢复播报；多语言文本 turn detector（已标记 deprecated）"supports … Chinese"，基于 Qwen2.5-0.5B-Instruct，396MB，需 <500MB RAM，CPU 每轮约 50–160ms；中文 true negative rate 86.60%，各语言 true positive rate 约 99.3% | Turns overview / Turn detector | LiveKit | 2026-10 访问时的版本 | https://docs.livekit.io/agents/build/turns/ ；https://docs.livekit.io/agents/build/turns/turn-detector/ | 2026-10-09 | B | 中文 TNR 86.6% 意味着约 13% 的"用户还没说完"会被误判为说完，即抢话（项目自测集）；老人停顿多，实际可能更差（推断）。

[C-1.12] TEN Framework：开源实时对话框架，附带 TEN VAD 与 TEN Turn Detection（支持中英） | TEN 是"an open-source framework for real-time multimodal conversational AI"；TEN Turn Detection"enables full-duplex dialogue communication"，基于 Qwen2.5-7B，输出 finished / unfinished / wait 三类；中文自测：finished 98.90%、unfinished 92.74%、wait 92% | ten-framework；ten-turn-detection | TEN-framework（声网/Agora 社区） | 仓库当前版本 | https://github.com/TEN-framework/ten-framework ；https://github.com/TEN-framework/ten-turn-detection | 2026-10-09 | B | 7B 模型做判停，需要服务端 GPU，不能端侧运行；准确率来自项目自有测试集；主框架许可为"Apache 2.0 with additional restrictions"，商用前需审阅。

[C-1.13] Silero VAD：约 2MB，单线程 CPU 每 30ms+ 音频块 <1ms，MIT | "less than 1ms to be processed on a single CPU thread"；"JIT model is around two megabytes"；支持 8000/16000 Hz；"trained on huge corpora that include over 6000 languages" | silero-vad | snakers4 | 仓库当前版本 | https://github.com/snakers4/silero-vad | 2026-10-09 | B | 适合端侧做首道 VAD（打断检测）；仓库徽章的许可证文字有矛盾（alt 文本写 CC BY-NC），商用前应核对 LICENSE 文件。

[C-1.14] Android 平台 AEC：AcousticEchoCanceler 依赖设备实现，必须先用 isAvailable() 检查 | "Acoustic Echo Canceler (AEC) is an audio pre-processor which removes the contribution of the signal received from the remote party from the captured audio signal"；isAvailable()："Checks if the device implements acoustic echo cancellation"；"On some devices, an AEC can be inserted by default in the capture path by the platform according to the MediaRecorder.AudioSource used" | AcousticEchoCanceler（API level 16） | Android Developers / Google | 当前版本 | https://developer.android.com/reference/android/media/audiofx/AcousticEchoCanceler | 2026-10-09 | A | 官方文档只说明"可能有"，不保证效果；家用平板（尤其低端机、智能屏）的 AEC 质量差异大，需要实测（[coverage_gap]：没有找到分机型的 AEC 效果数据）。对策是 WebRTC APM 软件 AEC，或走厂商 WebRTC 链路（阿里 WebRTC 接入文档称其"自带回声消除和降噪"，此句来自搜索摘要，原文未单独核实）。

[C-1.15] FunASR：中文流式 ASR（paraformer-zh-streaming，220M）+ FSMN-VAD（0.4M）+ 标点（ct-punc） | paraformer-zh-streaming "zh/en streaming ASR model with 220M parameters"；"Use the streaming checkpoint and per-session cache"；fsmn-vad 0.4M 参数；Fun-ASR-Nano（800M）"covers zh/en/ja and Chinese dialects/accents"；工具代码 MIT，权重按各模型卡许可 | FunASR | 阿里达摩院 / modelscope | 仓库当前版本 | https://github.com/modelscope/FunASR | 2026-10-09 | B | 仓库明确说"Offline throughput is not streaming latency"，没有给出流式延迟数值。

[C-1.16] SenseVoice：非自回归低延迟识别，支持普通话、粤语、英、日、韩，但**官方不是流式** | 支持 "Mandarin, Cantonese, English, Japanese, and Korean"；"runs more than 5 times faster than Whisper-Small and 15 times faster than Whisper-Large"（项目自述）；流式只能靠第三方 streaming-sensevoice 分块伪流式 | SenseVoice | FunAudioLLM（阿里通义） | 仓库当前版本 | https://github.com/FunAudioLLM/SenseVoice | 2026-10-09 | B | 适合端侧或断网时整句识别，不适合做"边说边出字"。

[C-1.17] CosyVoice：流式 TTS，项目自述延迟最低 150ms，支持 18+ 种中文方言/口音 | "achieves latency as low as 150ms while maintaining high-quality audio output"；"18+ Chinese dialects/accents"（含广东、闽南、四川、东北等）；版本 1.0 / 2.0 / Fun-CosyVoice 3.0；Apache-2.0 | CosyVoice | FunAudioLLM | 仓库当前版本 | https://github.com/FunAudioLLM/CosyVoice | 2026-10-09 | B | 150ms 为项目自述且没有说明测试硬件；自部署需要 GPU。

[C-1.18] 老年人访谈研究：支持打断与附和（backchannel）的语音代理，被老人评为更自然、更有掌控感 | 论文：Liu et al., "Toward Enabling Natural Conversation with Older Adults via the Design of LLM-Powered Voice Agents that Support Interruptions and Backchannels", CHI 2025；摘要要点（来自 HKUST 门户和搜索摘要）：组内对比中，Barge-in agent 比 No barge-in agent 更自然、投入、流畅；backchannel 让等待感觉更短 | CHI 2025 论文 | ACM / HKUST | 2025-04-25 | https://doi.org/10.1145/3706598.3714228 | 2026-10-09 | A（论文）/ 本次核实程度：**仅摘要级**（ACM 页面返回 403，全文未能打开） | 样本量小、探索性研究、非中国大陆样本；但直接支持"可打断"是老人体验的核心价值。

---

## C2 延迟基准

[C-2.1] 人类对话轮次间隔：10 种语言平均响应偏移 +208ms，众数 0ms | "The mean response offset for the full dataset is +208 ms"；"Japanese has the fastest (+7 ms)"；"Danish has the slowest response time on average (+469 ms)"；"an overall mode of 0 ms"，各语言众数在 0 到 +200ms 之间 | Universals and cultural variation in turn-taking in conversation（Stivers et al., PNAS 106(26):10587–10592） | PNAS / Max Planck Institute for Psycholinguistics | 2009-06-30 | https://pmc.ncbi.nlm.nih.gov/articles/PMC2705608/ | 2026-10-09 | A | 样本是问答对（是/否问题），不含中文普通话；只能作为"人类自然节奏"的理想上限，不是产品可接受阈值。

[C-2.2] 语音界面可接受延迟：约 2s 内通常可接受，约 4s 体验评分明显下降，≥8s 持续很低 | "latencies of under 2 seconds are generally considered acceptable"；"around 4 seconds, UX ratings drop substantially"；"at 8 seconds or more, UX ratings are consistently rated at a very low level"（综述引用 Sogemeier et al. 2024、Peng et al. 2020、Funk et al. 2020a） | Beyond Words: Measuring User Experience through Speech Analysis in Voice User Interfaces（Ma et al.） | arXiv:2603.19904 | 2026-03-20（v1，预印本） | https://arxiv.org/html/2603.19904v1 | 2026-10-09 | A（预印本，二手综述） | 一般人群，非老人专属；没有逐条核对被引原文。

[C-2.3] 老年人系统响应延迟实验：0.5–5.5s 延迟对回忆成绩没有显著直接影响，影响由个体特质调节 | Scientific Reports 2019：62 名老人（均龄 69.03），延迟 0.5–5.5s，以 0.5s 递增随机分配；"Delay had no significant direct effect on recall performance"；较短延迟与更高的系统质量评价相关；作者称"longer system response times can have performance benefits for elderly user groups" | Effects of system response delays on elderly humans' cognitive performance in a virtual training scenario | Scientific Reports（Nature 出版集团） | 2019 | https://pmc.ncbi.nlm.nih.gov/articles/PMC6549173/ | 2026-10-09 | A | 德国样本、训练任务、Wizard-of-Oz；不能直接推到陪伴闲聊。提示老人对延迟的容忍度可能高于年轻人，但主观偏好仍然是越快越好。

[C-2.4] Qwen3-Omni 技术报告：冷启动理论端到端首包延迟 234ms | "In cold-start settings, Qwen3-Omni achieves a theoretical end-to-end first-packet latency of 234 ms"；语音理解 19 种语言、语音生成 10 种语言 | Qwen3-Omni Technical Report | 阿里通义 Qwen 团队（arXiv:2509.17765） | 2025-09-22 | https://arxiv.org/abs/2509.17765 | 2026-10-09 | A（厂商论文，厂商自述） | "理论值"，不含公网 RTT、客户端缓冲和 VAD 判停等待（silence_duration_ms 默认 800ms）。

[C-2.5] Moshi（Kyutai）全双工：理论 160ms，实际 200ms | "theoretical latency of 160ms, 200ms in practice"；"the first real-time full-duplex spoken large language model" | Moshi: a speech-text foundation model for real-time dialogue | Kyutai（arXiv:2410.00037） | 2024-09-17（v1） | https://arxiv.org/abs/2410.00037 | 2026-10-09 | A | 主要支持英文，不能在中国大陆合规商用的场景下直接采用；只作为全双工技术上限的参照。

[C-2.6] 端到端 API 的实际"感知延迟"主要由判停等待决定（推断，基于官方参数） | Qwen-Omni silence_duration_ms 默认 800ms（C-1.1）；豆包 end_smooth_window_ms 默认 1500ms（C-1.3）；GLM-Realtime silence_duration_ms 默认 500ms（C-1.5）；腾讯 ASR vad_silence_time 默认 1000ms、范围 500–2000（C-3.7） | 见各卡片 | — | — | — | 2026-10-09 | 推断 | 感知延迟 ≈ 判停等待 + 首包延迟 + 网络 RTT + 播放缓冲。老人停顿多，判停窗口过短会抢话，过长又显迟钝，这是需要实测的核心参数。

---

## C3 老年语音与口音/方言

[C-3.1] 老年人语音的 ASR 错误率显著高于成年人 | "Word Error Rates (WERs) for elderly voices are significantly higher than those of adult voices"；数据来自美国最高法院庭审录音的纵向研究 | Longitudinal study of ASR performance on ageing voices（Vipperla, Renals, Frankel） | Interspeech 2008（ISCA） | 2008 | https://www.isca-archive.org/interspeech_2008/vipperla08_interspeech.html | 2026-10-09 | A | 英语、旧一代 ASR；摘要没有给出具体 WER 数值。

[C-3.2] 中国 75 岁以上老人对话语料 SeniorTalk：Whisper 零样本 CER 很高，Paraformer 表现最好，口音越重错误越高 | 55.53 小时，202 人，"individuals aged 75 and above"，覆盖 16 省；零样本 CER：Paraformer-large 14.91%，Whisper-large-v3 57.74%，Whisper-small 55.83%；微调后 Paraformer 14.41%；从头训练的 Conformer 按口音分：无口音 21.23%、轻 34.21%、中 37.62%、重 59.52%；省份 CER（微调 Paraformer）：广西 4.88%，辽宁 27.08%，河南 20.93% | SeniorTalk: A Chinese Conversation Dataset with Rich Annotations for Super-Aged Seniors | arXiv:2503.16578 | 2025-03-20（v1）/2025-11-12（v2） | https://arxiv.org/html/2503.16578 | 2026-10-09 | A（预印本） | 自然对话、多人场景，比一对一对设备说话更难；没有与标准集做同模型对比；商业云 ASR 未评测。

[C-3.3] 野外中文老人语音 WildElder：CER 随年龄上升，85 岁以上明显恶化；男性高于女性 | 33.7 小时；预训练模型零样本/微调 CER：Conformer-WenetSpeech 16.43%/13.54%，Whisper-Medium 23.41%/16.14%；按年龄（微调 Conformer-WenetSpeech）：70–75 岁 12.85%，85–90 岁 20.06%，90–95 岁 24.41%；女 10.44%，男 16.89% | WildElder: A Chinese Elderly Speech Dataset from the Wild with Fine-Grained Manual Annotations | arXiv:2510.09344（Interspeech 2026 接收） | 2025-10-10（v1）/2026-07-18（v2） | https://arxiv.org/html/2510.09344 | 2026-10-09 | A | 素材来自网络视频，噪声与录音条件不同于家用平板；没有评测商业云 ASR、SenseVoice 和端到端模型。

[C-3.4] KeSpeech（NeurIPS 2021）：同一模型在普通话子方言上的 CER 约为普通话的 1.6–2.6 倍 | 1,542 小时、27,237 名说话人、34 城、8 种子方言；ESPnet 基线（全量训练集）CER：普通话 6.1%，北京 11.5%，西南 11.9%，中原 9.6%，东北 10.2%，兰银 11.7%，江淮 15.9%，冀鲁 11.5%，胶辽 11.7%；AISHELL-1 test 5.3% | KeSpeech: An Open Source Speech Dataset of Mandarin and Its Eight Subdialects（Tang et al.） | NeurIPS 2021 Datasets & Benchmarks | 2021 | https://datasets-benchmarks-proceedings.neurips.cc/paper/2021/file/0336dcbab05b9d5ad24f4333c7658a0e-Paper-round2.pdf | 2026-10-09 | A | 2021 年的基线模型，现代大模型 ASR 的绝对值会更低，但"子方言比普通话差"的相对结论有参考价值；只覆盖官话子方言，不含粤、吴、闽等。

[C-3.5] 讯飞实时语音转写大模型：中英 + 202 种方言免切换识别 | "autodialect：支持中英 + 202 种方言免切识别"；"autominor：支持 37 个语种免切识别（该功能权限需单独提交工单申请）"；音频 16k/16bit/单声道，"建议音频流每 40ms 发送 1280 字节" | 实时语音转写大模型 | 讯飞开放平台 | 页面未标更新时间 | https://www.xfyun.cn/doc/spark/asr_llm/rtasr_llm.html | 2026-10-09 | A | 方言数量为厂商自述；文档没有给出准确率或延迟。

[C-3.6] 阿里云 Fun-ASR-Realtime：支持中英文自由切换与"多地区方言覆盖"；北京地域 0.00033 元/秒 | 模型页原文："中英文自由切换""多地区方言覆盖"；快照：fun-asr-realtime-2026-02-28 / 2025-11-07 / 2025-09-15；价格页：fun-asr-realtime 0.00033元/秒，免费 36,000 秒（10 小时，90 天）；paraformer-realtime-v2 0.00024元/秒，免费 36,000 秒，每月 1 日发放 | fun-asr-realtime 模型信息；模型调用价格 | 阿里云百炼 | 价格页 2026-10 版本 | https://help.aliyun.com/zh/model-studio/fun-asr-realtime ；https://help.aliyun.com/zh/model-studio/model-pricing | 2026-10-09 | A | 模型页**没有列出具体方言名单**；搜索摘要里"16 种方言、平均字准确率 88.62%"来自媒体报道，**未在官方页核实**，不采用。

[C-3.7] 腾讯云实时语音识别：Hy-ASR-3.0-preview"中英+20种方言"，16k_zh_en（大模型 1.0）称 31 种方言；8k_zh_large 方言名单含粤语、闽南语、客家话等 27 种 | engine_model_type 原文："Hy-ASR-3.0-preview：中英+20种方言大模型引擎"；16k_zh_en 页面称"31种方言"（名单不在本页）；vad_silence_time 取值 500–2000ms，默认 1000，"此参数建议不要随意调整" | 实时语音识别（WebSocket） | 腾讯云 | 2026-09-20 16:54:08 | https://cloud.tencent.com/document/product/1093/48982 | 2026-10-09 | A | 方言数量为厂商自述；没有准确率数据；本页不存在旧的 16k_zh_dialect 引擎。

[C-3.8] 火山端到端实时语音大模型的输入语种为"中文和英语"；方言只在输出 TTS 侧有 8 种方言参数（限 4 个精品音色） | 见 C-1.3 | — | 火山引擎 | 2026-09-28 | https://docs.volcengine.com/docs/6561/1594356 | 2026-10-09 | A | 文档没有说明方言口音输入的识别效果，需要实测。

[C-3.9] 开源模型方言能力：SenseVoice 支持普通话和粤语（C-1.16）；Fun-ASR-Nano 称覆盖"Chinese dialects/accents"（C-1.15）；CosyVoice 合成侧 18+ 方言/口音（C-1.17）；Qwen3-Omni 论文称语音理解 19 种语言（C-2.4） | — | — | — | — | 2026-10-09 | B | 各开源模型都没有在老人语料上公开评测（SeniorTalk/WildElder 只评测了 Paraformer、Whisper、Conformer）。

---

## C4 唤醒词

[C-4.1] 讯飞语音唤醒（Android SDK）：可自定义唤醒词，规则为 4–6 个汉字，门限可调 | "每个为4-6个汉字或不超过2个英文单词"；最多 8 个，中英文不可同时配置；IVW_THRESHOLD 范围 0–3000，默认 1450，"门限值越高，则要求匹配度越高，才能唤醒"；SDK 免费试用 10 个装机量、90 天 | 语音唤醒 Android SDK 文档 | 讯飞开放平台 | 未标日期 | https://www.xfyun.cn/doc/asr/awaken/Android-SDK.html | 2026-10-09 | A | 官方**没有公开唤醒率/误唤醒率数值**；正式授权按装机量收费，单价未公开（[coverage_gap]）。

[C-4.2] Picovoice Porcupine：控制台输入短语即可"within seconds"训练定制唤醒词，端侧运行；模型与平台绑定 | "will train a model for that specific phrase within seconds"；"a model trained for Raspberry Pi cannot run on Android"；语言列表含 "Chinese"，但 Android 快速入门列出的 8 种语言不含中文 | Porcupine docs | Picovoice | 2026-10 访问时的版本 | https://picovoice.ai/docs/porcupine/ | 2026-10-09 | A（厂商文档） | Android 上中文支持需要确认；境外服务，控制台训练和授权在中国大陆的可用性与合规性未核实。

[C-4.3] Porcupine 官方基准方法：误报率固定为每 10 小时 1 次、10dB SNR 噪声（DEMAND）、LibriSpeech 背景语音 | "We compare accuracies of engines under test at a fixed false alarm rate of 1 per 10 hours"；"the data is mixed with noise (at 10 dB SNR)" | Wake Word Benchmark | Picovoice | 未标日期 | https://picovoice.ai/docs/benchmark/wake-word/ | 2026-10-09 | A（厂商自测，数据与代码以 Apache 2.0 开源） | 具体漏检率数值只出现在图中，没能从文本提取；测试词为英文。可作为"误唤醒 ≤1 次/10 小时"的评测框架参考。

[C-4.4] Snowboy 已于 2020 年底停止官方服务 | "we plan to shut down all KITT.AI products (Snowboy, NLU and Chatflow) by Dec. 31st, 2020"；"only community support will be available" | snowboy README | KITT.AI | 2020-03-18 公告 | https://github.com/Kitt-AI/snowboy | 2026-10-09 | B | 不建议新项目采用。

[C-4.5] sherpa-onnx 开放词表关键词检测：无需重新训练即可自定义关键词，有中文模型和 Android APK | 可以 "without re-training the model" 指定关键词；中文模型 "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"；每个关键词可设 boosting score 与触发阈值 | Keyword spotting | k2-fsa（新一代 Kaldi） | 当前版本 | https://k2-fsa.github.io/sherpa/onnx/kws/index.html | 2026-10-09 | B | 没有公布误唤醒/漏唤醒指标，需在老人语音上自测。

[C-4.6] 产品含义（推断）：简报设定"唤醒词或大按钮开始、默认不持续监听"。唤醒词本身就要求端侧持续监听麦克风（只在本地检测），这与"默认不持续监听"在隐私表述上存在张力；"大按钮"方案在技术和隐私上都最简单 | — | — | — | — | 2026-10-09 | 推断 | 需与证据包 D（隐私合规）交叉确认怎么表述"端侧唤醒检测、不上传"。

---

## C5 虚拟形象

[C-5.1] Live2D Cubism SDK：个人与小规模企业（最近年销售额 <1,000 万日元）免除发布许可费；超过该门槛需签发布许可协议 | "Small-Scale Enterprises: enterprises with the Latest Sales of less than 10 million yen"；中等规模 1,000 万–1 亿日元，大规模 ≥1 亿日元；SDK 许可页："Individuals and Small-Scale Enterprises are exempted from the license and payment (except Expandable Application)"；具体费用页面未公开 | SDK Release License；How is the scale of a business… determined? | Live2D Inc. | 当前版本 | https://www.live2d.com/en/sdk/license/ ；https://help.live2d.com/en/sdk/sdk_007/ | 2026-10-09 | A | 早期验证阶段可零许可费使用；规模化后费用未知（[coverage_gap]）。

[C-5.2] Live2D 口型同步：可在运行时读取音量（音频电平）实时驱动嘴型参数，Android 2.3+ 支持实时播放音量 | "By obtaining the audio level in some way and scaling it to the target parameters, real-time lip-sync is achieved"；另有基于动作（元音关键帧）的方式与 MotionSync 插件 | Lip-sync | Live2D Cubism SDK Manual | 当前版本 | https://docs.live2d.com/en/cubism-sdk-manual/lipsync/ | 2026-10-09 | A | 音量驱动方案算力极低，与流式 TTS 天然兼容；打断时只要停止音频，嘴型就同步停止。

[C-5.3] 腾讯云智能数智人：云渲染交互按"路"包月/包年；端渲染 2D 按设备 5,000 元/年 | 云渲染：2D 精品/小样本/照片 3,500 元/月/路或 27,000 元/年/路；3D 写实 6,750 元/月/路；端渲染：2D SDK 授权"按设备"5,000 元/年、"按应用"800,000 元/年；3D H5 授权 200,000 元/年，另需会话驱动次数包 10,000 元/年（100 万次） | 价格指南 | 腾讯云 | 2026-07-17 14:04:25 | https://cloud.tencent.com/document/product/1240/101944 | 2026-10-09 | A | 形象、播报、交互需要组合购买；云渲染按并发计价，用户越多、峰值越集中，单位成本越高。

[C-5.4] 阿里云数字人 2D 云渲染全链路实时对话：3,000 元/路/月，含 ASR、TTS、驱动，LLM 另计 | "3000元/路/月（目录价）"；"链路中已整合ASR、TTS、LLM、数字人驱动能力"，官方 TTS/ASR"暂不收取额外费用"，LLM 按模型计费 | 数字人实时交互-2D | 阿里云虚拟数字人 | 页面未显示日期 | https://help.aliyun.com/zh/avatar/avatar-application/product-overview/price-videochat-2d | 2026-10-09 | A | "暂不收取"属于阶段性政策。

[C-5.5] 阿里云 3D 交互数字人：端渲染（H5）1,000 元/月/路，云渲染（UE）4,800 元/月/路 | 端渲染："画面清晰、推流成本很低"；云渲染：表情控制、仿真和渲染效果更好 | 3D 实时交互计费 | 阿里云虚拟数字人 | 页面未显示日期 | https://help.aliyun.com/zh/avatar/avatar-application/product-overview/price-videochat-3d | 2026-10-09 | A | 端渲染也按"路"收费，不是买断。

[C-5.6] 端侧全离线 3D 数字人可行但要旗舰算力：MNN-TaoAvatar 要求骁龙 8 Gen 3 / 天玑 9200 级、≥8GB RAM、≥5GB 存储 | 硬件要求原文：骁龙 8 Gen 3、天玑 9200 或更高，至少 8GB RAM、ARM64、5GB 存储；模型：Qwen2.5-1.5B（LLM）、Sherpa 中英流式 ASR、bert-vits2-MNN（TTS）、UniTalker-MNN（音频到表情系数）、TaoAvatar-NNR-MNN（渲染）；"100%离线运行"；低配设备可能"卡顿、声音断续或功能受限" | MNN-TaoAvatar Android README_CN；TaoAvatar（CVPR 2025，arXiv:2503.17032） | 阿里巴巴（MNN） | 仓库当前版本 | https://github.com/alibaba/MNN/blob/master/apps/Android/MnnTaoAvatar/README_CN.md | 2026-10-09 | B | 老人家中"现成平板"多为中低端机，不满足要求（推断）；论文中的 90FPS 是在 Apple Vision Pro 上测得，不是普通手机。

[C-5.7] 阿里云百炼的"数字人"类模型（万相 s2v、EMO、LivePortrait 等）属于离线视频生成，按生成秒数计费，不适合实时对话 | wan2.2-s2v：480P 0.5 元/秒、720P 0.9 元/秒；emo-v1：1:1 画幅 0.08 元/秒；animate-anyone-gen2 0.08 元/秒 | 模型调用价格 | 阿里云百炼 | 2026-10 版本 | https://help.aliyun.com/zh/model-studio/model-pricing | 2026-10-09 | A | 可用于离线生成固定片段（如问候、节日视频），不能用于实时对话。

---

## C6 价格（人民币，刊例价，查看日期 2026-10-09）

见第 3 节价格表与单位成本计算。各价格卡片如下：

[C-6.1] 火山引擎豆包语音后付费价格 | 豆包流式语音识别模型 2.0：1 元/小时；豆包语音合成模型 2.0：3 元/万字符（"1个汉字算1个字符"）；豆包声音复刻 2.0：3 元/万字符；豆包实时语音大模型：输入文本 10、输入音频 80、输入文本/音频 cached 5、输出文本 80、输出音频 300（元/百万 token）；token 折算："输入每1秒的音频大致对应6.25个Token，输出音频每1秒大致对应25个token"；限制"QPM限制为60，TPM限制为100000"；资源包：流式 ASR 2.0 低至 0.8 元/小时（30 万小时包），TTS 2.0 低至 2.1 元/万字符 | 计费说明 | 火山引擎（豆包语音） | 文档更新于 2026-09-29 | https://docs.volcengine.com/docs/6561/1359370 | 2026-10-09 | A | **页内不一致**：费用示例三中"输出-文本"按 30 元/百万 token 计算，与价格表的 80 不符，本文按价格表计。默认 TPM 10 万对多并发是硬限制，需扩容。

[C-6.2] 阿里云百炼实时多模态价格（华北2 北京，元/百万 token） | qwen3.8-omni-flash-realtime：输入文本/图片/视频 1.5、输入音频 6、输出文本 4.5、输出音频 12；qwen3.5-omni-flash-realtime：3.3 / 27 / 20（仅文本输出）/ 107（文本+音频输出，仅对音频计费）；qwen3.5-omni-plus-realtime：10 / 80 / 60 / 300；qwen3-omni-flash-realtime：音频输入 18.9、文本+音频输出 75.1；免费额度 100 万 token（90 天）；token 折算："Qwen3.8-Omni-Flash-Realtime、Qwen3.5-Omni-Realtime 系列…输入音频为每秒 7 Token，输出音频为每秒 12.5 Token"；多轮："实际输入计费 = 上下文窗口内历史内容的 Token 数 + 本轮新增输入的 Token 数" | 模型调用价格；Qwen-Omni 实时模型（计费与限流） | 阿里云百炼 | 2026-10 版本 | https://help.aliyun.com/zh/model-studio/model-pricing ；https://help.aliyun.com/zh/model-studio/realtime | 2026-10-09 | A | 价格页声明"仅展示模型调用原价"；qwen3.8 的音频与对应文本分别计费。

[C-6.3] 阿里云百炼 ASR/TTS/LLM 价格（华北2 北京） | ASR：paraformer-realtime-v2 0.00024 元/秒（≈0.864 元/小时），fun-asr-realtime 0.00033 元/秒（≈1.188 元/小时），qwen-audio-3.0-asr-flash-streaming 0.00033 元/秒；TTS（"一个汉字…计为 2 个字符"）：cosyvoice-v3-flash 1 元/万字符，cosyvoice-v3.5-flash 0.8 元/万字符，cosyvoice-v3-plus 2 元，qwen3-tts-flash-realtime 1 元/万字符，qwen3-tts-flash 0.8 元/万字符；LLM（元/百万 token，输入/输出）：qwen-flash 0.15/1.5（≤128K），qwen3.5-flash 0.2/2（≤128K），qwen3.6-flash 1.2/7.2，qwen3.5-plus 0.8/4.8（≤128K），qwen3.6-plus 2/12（≤256K）；实时语音对话 qwen-audio-3.0-realtime-flash：输入文本 1.5、输入音频 6、输出文本 4.5、输出音频 12 | 模型调用价格 | 阿里云百炼 | 2026-10 版本 | https://help.aliyun.com/zh/model-studio/model-pricing | 2026-10-09 | A | 阿里 TTS 的汉字按 2 字符计，与火山（1 汉字 = 1 字符）口径不同，比价时要换算。

[C-6.4] 腾讯云实时语音识别价格 | 后付费（日阶梯）：标准版 0–299 小时/日 3.20 元/小时；大模型 1.0 4.80 元/小时；大模型 2.0 1.0 元/小时（不分阶梯）；预付费：大模型 2.0 低至 0.85 元/小时（30 万小时包）；每月免费 5 小时 | 计费概述（在线版） | 腾讯云 | 2026-09-08 09:17:56 | https://cloud.tencent.com/document/product/1093/35686 | 2026-10-09 | A | — |

[C-6.5] 腾讯云 TRTC AI 实时对话：AI 对话服务（语音）0.01 元/分钟；AI 智能语音中，大模型实时 ASR 0.017 元/分钟、基础 TTS 3.00 元/万字符；LLM 需自行采购 | "0.01 元/分钟"；"大模型调用(LLM)需自行从第三方采购"；AI 智能语音页（旧版，2026-09-11）：实时语音识别 0.017 元/分钟，基础语音合成 3.00 元/万字符 | AI 实时对话计费；AI 智能语音 | 腾讯云 | 2026-07-13；2026-09-11 | https://cloud.tencent.com/document/product/647/115755 ；https://cloud.tencent.com/document/product/647/111976 | 2026-10-09 | A | 后者页面自述为旧版，"2026 年 9 月 1 日起已接入新版模型的用户"应看另一份文档（未打开）；音视频通话时长费另计（未核实单价）。

[C-6.6] 火山方舟大模型价格（元/百万 token，在线推理，最短输入档） | doubao-seed-2.0-mini：输入 0.2 / 输出 2.0；doubao-seed-2.0-lite：0.6 / 3.6（输入音频 9.0）；doubao-seed-2.1-lite：0.80 / 2.70（输入音频 12.00）；doubao-seed-character：0.80 / 2.00 | 模型价格 | 火山引擎（火山方舟） | 文档更新于 2026-10-08 | https://www.volcengine.com/docs/82379/1544106 | 2026-10-09 | A | 表中另有高峰/空闲分时价（如 deepseek 系列），本文只取标准在线价。

[C-6.7] 火山 RTC "AI 音视频互动方案"已改为 Tokens 计费：12 元/百万 tokens；自行开通的方舟/豆包语音模型独立计费 | "单价：12元 / 百万tokens"；首次开通赠送免费 Tokens 资源包（1 个月） | AI 音视频互动方案计费 | 火山引擎（实时音视频） | 2026-09-23 | https://docs.volcengine.com/docs/6348/2123214 | 2026-10-09 | A | 页面没有给出 RTC 时长到 token 的折算比例，无法换算成元/分钟（[coverage_gap]）。搜索摘要中的"9 元/千分钟"属于旧版计费，不再采用。

[C-6.8] 讯飞开放平台价格：**未能打开**官方价格页（JS 渲染，WebFetch 只拿到导航） | — | — | 讯飞 | — | https://www.xfyun.cn/services/rtasr | 2026-10-09 | — | [coverage_gap]

---

## C7 断网降级与长时运行

[C-7.1] sherpa-onnx：完全本地运行的流式/非流式 ASR、TTS、VAD、KWS，支持 Android/HarmonyOS | "During speech recognition, it does not need to access the Internet. Everything is processed locally on your device"；支持 Silero VAD 与 TEN-VAD、TTS、关键词检测、说话人识别；平台含 Android、iOS、HarmonyOS、ARM 嵌入式；模型含 SenseVoice、Paraformer、Qwen3-ASR、FireRedAsr 等 | sherpa-onnx 文档首页 | k2-fsa | 当前版本 | https://k2-fsa.github.io/sherpa/onnx/index.html | 2026-10-09 | B | 文档没有给出中低端平板上的实时率，需实测。

[C-7.2] MNN：阿里开源端侧推理引擎，提供可离线运行的多模态 LLM Android App（支持 Qwen3、Qwen2.5-Omni 3B/7B） | 2025-01-23："released our full multimodal LLM Android App"；2025 年 4–5 月加入 Qwen3 与 Qwen2.5 Omni（3B、7B）支持；TaoAvatar 在本地运行 LLM、ASR、TTS（见 C-5.6） | MNN | 阿里巴巴 | 仓库当前版本 | https://github.com/alibaba/MNN | 2026-10-09 | B | 仓库没有给出手机上的 tokens/s 数值；端侧 1.5B 级模型只够做"降级兜底"（推断）。

[C-7.3] Android Lock Task（Kiosk）模式：需设备策略控制器（DPC，通常为 Device Owner）把应用加入白名单；Android 9+ 可定制系统 UI | "Only apps that have been allowlisted by a device policy controller (DPC) can run when the system is in lock task mode"；"In Android 9.0 or later a DPC can start any app's activity into lock task mode"；`setLockTaskFeatures` 未调用时只启用 GLOBAL_ACTIONS；"Don't start lock task mode when the device is locked because the user might not be able to unlock the device" | Lock task mode | Android Developers / Google | 当前版本 | https://developer.android.com/work/dpc/dedicated-devices/lock-task-mode | 2026-10-09 | A | 要真正锁定，一般需要把设备恢复出厂后设为 Device Owner，这与"老人家中现成平板（已有账号和数据）"冲突（推断）；不设 Device Owner 时只能用屏幕固定（用户可退出）。国产 ROM 的后台保活与省电策略差异未核实（[coverage_gap]）。

[C-7.4] 断网降级的可行组合（推断） | 端侧：Silero VAD / sherpa-onnx KWS（唤醒）+ sherpa-onnx 流式 ASR（Paraformer/Zipformer）+ 端侧 TTS + 预置话术或 0.5–1.5B 小模型；云端：主链路 | — | — | — | — | 2026-10-09 | 推断 | 中低端平板上跑小 LLM 的实时性未验证；建议断网时只做"安抚话术 + 联系家人入口 + 提示网络断开"，不承诺完整对话。

---

## C8 记忆架构（简要）

[C-8.1] LangGraph 区分短期（线程内）与长期（跨会话）记忆；长期记忆可以是"profile"（单个持续更新的文档）或"collection"（多条小记忆） | profile："single, continuously updated 'profile' of well-scoped and specific information"，但会随规模增长而易错；collection 更不容易丢信息，但更新和检索更难；写入方式：hot path（交互中写入，用户可见，但增加延迟）vs background（后台写入，无延迟）；记忆以 JSON 文档存于 namespace（通常含 user id） | Memory overview | LangChain（LangGraph） | 当前版本 | https://docs.langchain.com/oss/python/langgraph/memory | 2026-10-09 | B | 框架概念文档。

[C-8.2] Mem0：抽取-合并-检索式长期记忆，在 LOCOMO 上 token 与延迟大幅低于全上下文，但准确率略低 | 摘要："Mem0 attains a 91% lower p95 latency and saves more than 90% token cost"（相对 full-context）；"26% relative improvements in the LLM-as-a-Judge metric over OpenAI"；（正文表 2 的数值来自搜索摘要，未逐条核对：full-context J 72.90% vs Mem0 66.88%） | Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory | arXiv:2504.19413（Mem0 团队） | 2025-04-28 | https://arxiv.org/abs/2504.19413 | 2026-10-09 | A（厂商论文） | 厂商自评；英文基准。

[C-8.3] 设计含义（推断） | 老人陪伴建议采用"结构化 profile（姓名称呼、家人、健康禁忌、偏好，可由子女/老人查看和删除）+ 情节记忆 collection（向量检索，带时间戳与来源轮次，可逐条删除）"；端到端 API 自带的上下文很短（GLM-Realtime 2 分钟、豆包 dialog_id 20 轮、Qwen3.8 实时保留 600 秒音频），长期记忆必须外挂，并以文本注入 instructions/system prompt | — | — | — | — | 2026-10-09 | 推断 | 删除和可见性要求见证据包 D（个人信息删除权）。注意：豆包 3.0 的上下文删除以"对话轮"为单位（C-1.4 文档：传入 user 侧 items_id 会同时删除成对的 assistant 回复）。

---

## 2. 技术方案对比表

| 维度 | 级联（端侧 VAD/唤醒 + 云 ASR + LLM + 流式 TTS） | 端到端实时语音模型（Qwen-Omni-Realtime / 豆包 Realtime / GLM-Realtime） | 混合（端到端为主 + 外挂记忆/安全层 + 端侧兜底） |
|---|---|---|---|
| 打断 | 需自行实现：端侧 VAD 检测到用户说话后立即停止 TTS、取消 LLM 请求、记录已播放位置（Pipecat/LiveKit 已内置，C-1.9、C-1.11） | 服务端原生（C-1.1、C-1.3、C-1.5）；豆包 2.0 支持按已播报毫秒截断上下文（C-1.3） | 同端到端；端侧 VAD 作为第二道保险 |
| 回声风险 | 同样依赖 AEC；可在端侧控制"播报期间提高打断阈值" | 官方建议戴耳机（C-1.2），外放场景必须做 AEC | 同左 |
| 判停/轮次 | 可接入语义判停模型（Smart Turn、TEN Turn Detection、LiveKit） | 厂商内置（semantic_vad、end_smooth_window_ms），可调但不透明 | 端到端内置 + 参数按老人调优 |
| 延迟 | 多跳串联，首包取决于 ASR 尾点 + LLM 首 token + TTS 首包（CosyVoice 自述 150ms，C-1.17） | 厂商论文理论首包 234ms（Qwen3-Omni，C-2.4）；实际体感受判停窗口支配（C-2.6） | 同端到端 |
| 方言/老人语音 | 可选方言能力强的 ASR（讯飞 202 方言、腾讯/阿里方言引擎，C-3.5–3.7），可加热词 | 豆包输入仅中英（C-1.3）；Qwen-Omni 自述 113 种语种和方言（C-1.1），没有老人评测 | 可在方言重的用户上切换回级联 ASR |
| 可控性/安全 | 每一步都有文本，便于审核、过滤、记忆抽取 | 文本转写可得，但生成过程不透明；豆包有 strict_audit 开关（C-1.3） | 在文本层做安全/记忆 |
| 长期记忆 | 完全自控 | 原生上下文短（2 分钟–20 轮），需外挂（C-8.3） | 外挂 profile + 检索，注入 instructions |
| 单位成本（20 分钟/天，见第 3 节） | 约 0.7–1.0 元/天 | 0.10–0.36 元/天（qwen3.8-omni-flash）到约 4–4.5 元/天（豆包 Realtime） | 端到端费用 + 少量 LLM 记忆抽取费用 |
| 厂商锁定 | 低（组件可替换） | 高（协议各异：阿里类 OpenAI 事件、豆包二进制协议、Seeduplex 新协议） | 中 |
| 断网 | 可降级到端侧 ASR/TTS（C-7.1） | 不可用 | 端侧兜底 |

---

## 3. 价格表与单位成本计算

### 3.1 价格汇总（刊例价，查看日期 2026-10-09）

| 类别 | 产品 | 单价 | 来源卡片 |
|---|---|---|---|
| 流式 ASR | 火山 豆包流式语音识别 2.0 | 1 元/小时（后付费）；资源包低至 0.8 元/小时 | C-6.1 |
| 流式 ASR | 阿里 paraformer-realtime-v2 | 0.00024 元/秒 = 0.864 元/小时 | C-6.3 |
| 流式 ASR | 阿里 fun-asr-realtime | 0.00033 元/秒 = 1.188 元/小时 | C-6.3 |
| 流式 ASR | 腾讯 实时 ASR 大模型 2.0 | 1.0 元/小时（后付费） | C-6.4 |
| 流式 ASR | 腾讯 实时 ASR 大模型 1.0 | 4.80 元/小时（0–299 小时/日） | C-6.4 |
| 流式 ASR | 讯飞 实时转写大模型 | 未能核实 | C-6.8 |
| TTS | 火山 豆包语音合成 2.0 | 3 元/万字符（1 汉字 = 1 字符） | C-6.1 |
| TTS | 阿里 cosyvoice-v3-flash / qwen3-tts-flash-realtime | 1 元/万字符（1 汉字 = 2 字符） | C-6.3 |
| TTS | 阿里 cosyvoice-v3.5-flash | 0.8 元/万字符（1 汉字 = 2 字符） | C-6.3 |
| TTS | 腾讯 TRTC 基础 TTS | 3.00 元/万字符 | C-6.5 |
| LLM | 阿里 qwen3.5-flash | 输入 0.2 / 输出 2 元/百万 token（≤128K） | C-6.3 |
| LLM | 阿里 qwen3.5-plus | 0.8 / 4.8 | C-6.3 |
| LLM | 火山 doubao-seed-2.0-lite | 0.6 / 3.6（≤32K） | C-6.6 |
| LLM | 火山 doubao-seed-2.0-mini | 0.2 / 2.0（≤32K） | C-6.6 |
| 实时语音大模型 | 阿里 qwen3.8-omni-flash-realtime | 入音频 6 / 入文本 1.5 / 出音频 12 / 出文本 4.5 元/百万 token；入 7 token/秒，出 12.5 token/秒 | C-6.2 |
| 实时语音大模型 | 阿里 qwen3.5-omni-flash-realtime | 入音频 27 / 入文本 3.3 / 出音频 107（文本不计） | C-6.2 |
| 实时语音大模型 | 火山 豆包实时语音大模型 | 入音频 80 / 入文本 10 / cached 5 / 出音频 300 / 出文本 80；入 6.25 token/秒，出 25 token/秒 | C-6.1 |
| 实时语音大模型 | 智谱 GLM-Realtime-Flash / Air | 音频 0.18 / 0.3 元/分钟 | C-1.5 |
| 实时对话编排 | 腾讯 TRTC AI 对话服务 | 0.01 元/分钟（另计 ASR、TTS、LLM、通话） | C-6.5 |
| 数字人（云渲染） | 阿里 2D 全链路实时对话 | 3,000 元/路/月（含 ASR、TTS，LLM 另计） | C-5.4 |
| 数字人（云渲染） | 腾讯 2D 精品/照片 | 3,500 元/月/路；27,000 元/年/路 | C-5.3 |
| 数字人（3D） | 阿里 3D 端渲染 / 云渲染 | 1,000 / 4,800 元/月/路 | C-5.5 |
| 数字人（端渲染授权） | 腾讯 2D 端渲染 SDK 按设备 | 5,000 元/年/设备 | C-5.3 |
| 虚拟形象（端侧） | Live2D Cubism SDK | 小规模企业（年销售额 <1,000 万日元）免发布许可费；超出后费用未公开 | C-5.1 |

### 3.2 单位成本计算方法（透明公式）

**假设（均为假设，需用真实埋点替换）**

- N = 每活跃用户每天的会话时长 = 20 分钟（1,200 秒，含静默）
- U = 用户说话时长 = 6 分钟（360 秒）；A = AI 说话时长 = 8 分钟（480 秒）；其余为停顿/静默
- T = 每天轮次数 = 30
- R = AI 播报语速 = 4 汉字/秒（假设值，未引用来源），即 AI 文本 = 480 × 4 = 1,920 汉字，按约 1 token/汉字估算为 1,920 token；用户转写文本 = 360 × 4 = 1,440 字
- LLM 每轮输入 ≈ 系统提示 + 记忆 2,000 token + 平均历史（T/2 × 每轮 112 token ≈ 1,680）≈ 3,700 token；每天 30 轮 ≈ 111,000 输入 token；输出 1,920 token
- 月 = 30 天；全部用后付费刊例价，不含免费额度、资源包折扣、服务器、带宽、内容安全审核、存储与人工运营

**公式**

- 级联：`C_day = ASR单价/秒 × 计费音频秒数 + TTS单价/万字符 × (AI汉字数 × 字符系数)/10,000 + LLM入单价 × 入token/1e6 + LLM出单价 × 出token/1e6`
  - 计费音频秒数：流式 ASR 全程推流时 = N×60；端侧 VAD 只送有声段时 ≈ U×60
  - 字符系数：阿里 = 2，火山/腾讯 = 1
- 端到端：`C_day = P_in_audio × (r_in × S_in)/1e6 + P_out_audio × (r_out × A×60)/1e6 + P_out_text × 出文本token/1e6 + [上下文累积项]`
  - S_in = 计费输入音频秒数（U×60 到 N×60 之间，取决于厂商对静默段是否计费，**官方页面未明确**）
  - 上下文累积项 ≈ 每轮新增 token × T(T−1)/2 × 对应输入单价（阿里文档明确历史内容每轮重复计费，C-6.2；豆包命中缓存按 cached 价）
- 数字人（按路计费）：`C_user_month = 单路月价 × 峰值并发率`，其中峰值并发率 = 峰值同时在线用户数 / 月活跃用户数

**示例计算（N=20 分钟/天）**

| 方案 | 计算过程 | 元/天 | 元/月（×30） |
|---|---|---|---|
| 级联·阿里 | ASR paraformer-realtime-v2：1,200 s × 0.00024 = 0.288；TTS cosyvoice-v3-flash：1,920 汉字 × 2 = 3,840 字符 → 0.384；LLM qwen3.5-flash：111,000 × 0.2/1e6 = 0.022 + 1,920 × 2/1e6 = 0.004 | ≈ 0.70 | ≈ 21 |
| 级联·阿里（ASR 只送有声段） | ASR 360 s × 0.00024 = 0.086；其余同上 | ≈ 0.50 | ≈ 15 |
| 级联·火山 | ASR 豆包流式 2.0：1/3 小时 × 1 = 0.333；TTS 豆包 2.0：1,920 字符 × 3/10,000 = 0.576；LLM doubao-seed-2.0-lite：111,000 × 0.6/1e6 = 0.067 + 1,920 × 3.6/1e6 = 0.007 | ≈ 0.98 | ≈ 29 |
| 端到端·qwen3.8-omni-flash-realtime | 入音频 2,520–8,400 token × 6/1e6 = 0.015–0.050；出音频 480 × 12.5 = 6,000 × 12/1e6 = 0.072；出文本 1,920 × 4.5/1e6 = 0.009；上下文：用户音频每轮 84 token × 435 = 36,540 × 6/1e6 = 0.219，文本历史 64 × 435 = 27,840 × 1.5/1e6 = 0.042 | 0.10–0.13（不含上下文）；≈ 0.36（含） | 3–11 |
| 端到端·qwen3.5-omni-flash-realtime | 入音频 2,520–8,400 × 27/1e6 = 0.068–0.227；出音频 6,000 × 107/1e6 = 0.642；上下文：36,540 × 27/1e6 = 0.987 + 27,840 × 3.3/1e6 = 0.092 | 0.71–0.87（不含）；≈ 1.9（含） | 21–57 |
| 端到端·豆包实时语音大模型 | 入音频 360 × 6.25 = 2,250 × 80/1e6 = 0.18；出音频 480 × 25 = 12,000 × 300/1e6 = 3.60；出文本（AI 1,920 + 用户转写 1,440）= 3,360 × 80/1e6 = 0.27；上下文按 cached 5 元：约 (32,625 + 48,720) × 5/1e6 = 0.41 | ≈ 4.05（不含）；≈ 4.5（含） | 122–135 |
| 端到端·GLM-Realtime-Flash | 若按会话时长计 20 × 0.18 = 3.6；若只按有效音频计，会更低（官方未说明计量口径） | ≤ 3.6 | ≤ 108 |
| 数字人·阿里 2D 云渲染 | 3,000 元/路/月 × 峰值并发率 5%（假设：晚间集中使用） | — | ≈ 150（另加 LLM） |
| 数字人·腾讯 2D 端渲染按设备 | 5,000 元/年 ÷ 12 | — | ≈ 417/设备 |
| 虚拟形象·Live2D 端侧 | 小规模企业免许可费；边际成本 ≈ 0（只占用设备算力） | 0 | 0 |

**解读（推断）**

1. 语音 AI 本身每用户每月约 3–30 元（qwen3.8-omni-flash 或级联方案），豆包 Realtime 方案约 120–135 元。差异主要来自输出音频的单价：豆包 300 元/百万 token、25 token/秒，阿里 qwen3.8 为 12 元/百万 token、12.5 token/秒。
2. 云渲染数字人按"路"收费，一旦使用就会成为成本主项（每用户每月百元级）。首版采用 Live2D 或 2D 端侧动画加音量驱动口型，成本最低。
3. 上下文累积会让端到端成本翻倍以上。单次会话应控制轮次或定期新开会话，并用外挂摘要记忆替代长上下文。
4. 以上全部未计免费额度和资源包折扣，也未计服务端编排、RTC 传输、内容安全、日志存储等，实际总成本需上浮（幅度未知）。

---

## 4. 技术瓶颈初排（均为推断）

评分：1–5 分。用户影响和可能性越高越严重；难度和验证成本越高越难。

| # | 瓶颈 | 用户影响 | 可能性 | 解决难度 | 验证成本 | 依据与验证方式 |
|---|---|---|---|---|---|---|
| 1 | 平板外放的回声导致自打断，或为防误打断调高阈值后老人打断不了 | 5 | 4 | 4 | 2 | C-1.2 官方建议耳机；C-1.14 AEC 依赖设备。验证：采购 3–5 款主流中低端平板/智能屏，测量播报时的误打断率和真打断成功率 |
| 2 | 判停窗口与老人停顿不匹配：抢话或反应迟钝 | 5 | 4 | 3 | 2 | C-1.11 中文 TNR 86.6%；C-2.6 默认 500–1500ms。验证：在老人录音上回放，扫描 silence_duration_ms / end_smooth_window_ms |
| 3 | 老人和方言口音的识别错误导致答非所问 | 4 | 4 | 3 | 3 | C-3.2–3.4：老人 CER 14–25%，口音重时更高。验证：招募目标城市 20–30 位老人做脚本外闲聊，按厂商比 CER 和语义理解成功率 |
| 4 | 家中现成平板算力、系统版本、ROM 后台限制差异大，导致长时运行不稳定 | 4 | 4 | 3 | 3 | C-7.3 Kiosk 需 Device Owner；C-5.6 端侧 3D 需旗舰。验证：72 小时常亮运行测试（发热、掉线、被杀后台） |
| 5 | 端到端 API 协议各异、版本迭代快（如豆包 O/SC 停止迭代，迁往 2.0/3.0），导致厂商锁定与维护成本 | 3 | 4 | 2 | 1 | C-1.3、C-1.4。缓解：抽象一层"实时语音会话"接口 |
| 6 | 端到端原生上下文短，长期记忆需外挂；记忆错误或隐私问题 | 4 | 3 | 3 | 2 | C-1.5、C-8.3。验证：14 天连续使用后人工评估记忆准确率和删除生效情况 |
| 7 | 唤醒词误唤醒或漏唤醒（老人发音、电视背景声） | 3 | 3 | 3 | 2 | C-4.1/4.5 厂商未公开指标。缓解：大按钮为主、唤醒词为辅 |
| 8 | 云数字人按路计费的成本失控 | 3（间接） | 3 | 2 | 1 | C-5.3–5.5。缓解：端侧 2D |
| 9 | 端到端成本随上下文与输出音频单价放大 | 3（间接） | 3 | 2 | 1 | 第 3 节。缓解：选型 + 会话截断 |
| 10 | 断网时体验断崖 | 3 | 2 | 3 | 2 | C-7.1/7.2。缓解：端侧兜底话术 |

---

## 5. 覆盖缺口 [coverage_gap]

- [coverage_gap] 讯飞"超拟人交互"实时语音 Web API 的官方文档与价格未能打开核实（C-1.8、C-6.8）；讯飞实时转写大模型价格页由 JS 渲染，未能获取。
- [coverage_gap] MiniMax Realtime 官方文档页未能打开，打断事件与 VAD 参数未核实（C-1.6）。
- [coverage_gap] 各端到端 API 对"静默段输入音频是否计费"没有官方明确说明，影响成本区间（第 3 节）。
- [coverage_gap] 没有找到 Android 平板/智能屏分机型 AEC 效果的公开测量数据（C-1.14）；WebRTC APM（AEC3）官方文档未单独核实。
- [coverage_gap] 没有找到针对老年人的可接受对话延迟阈值研究（只有一般人群综述 C-2.2，以及老人认知任务实验 C-2.3）。
- [coverage_gap] 没有找到商业云 ASR（讯飞/阿里/腾讯/火山）或端到端模型在中文老年语音上的公开 CER 评测；厂商方言准确率多为自述或媒体转述（如 Fun-ASR"88.62%"未在官方页核实）。
- [coverage_gap] 讯飞唤醒、sherpa-onnx KWS、Porcupine 在中文（尤其老人）上的误唤醒/漏唤醒指标均未公开（C-4.1–4.5）；Porcupine 在 Android 上的中文支持与境内可用性未确认。
- [coverage_gap] 火山引擎、百度曦灵、硅基智能的实时交互数字人公开价格未找到或未核实；火山 RTC Tokens 计费没有给出时长折算（C-6.7）。
- [coverage_gap] 云渲染数字人视频流对平板带宽的要求（码率）未找到官方数值。
- [coverage_gap] Live2D 中/大规模企业的发布许可费用未公开（C-5.1）。
- [coverage_gap] 中低端 Android 平板上端侧 ASR/TTS/小模型的实时率数据缺失（C-7.1、C-7.2）；国产 ROM 后台保活与常亮策略未核实。
- [coverage_gap] CHI 2025 老人打断研究（C-1.18）全文未能打开（403），只核实到摘要级。
- [coverage_gap] Mem0 正文表格数值未逐条核实（C-8.2）。
- [coverage_gap] AI 播报语速 4 汉字/秒是计算假设，没有引用来源。
