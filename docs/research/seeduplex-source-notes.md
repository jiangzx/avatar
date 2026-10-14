# Seeduplex 官方协议资料核对摘要

> 资料来源：项目内 `docs/seeduplex/端到端实时语音.md`、`docs/seeduplex/实时语音_android.md`（访问日期 2026-10-14）；火山引擎随文档公开的 Python demo（`python3_duplex_demo.zip`，下载地址见下）。本笔记不包含 API Key、音频、ASR 文本或模型回复文本；示例中的内容字段均以字段名/类型描述。

## 已由资料明确的接口事实

- WebSocket：`wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`。
- 鉴权：请求头 `X-Api-Key: <key>`；文档同时提到旧版 `Authorization: Bearer ...`，应以新控制台 API Key 路径为准。响应头提供 `X-Tt-Logid`，仅用于故障定位。
- 会话创建/更新：上行 `session.create` / `session.update`，均可带 `event_id`、`session`、`extension`；模型固定值为 `1.2.6.1`。成功事件分别为 `session.created` / `session.updated`，并返回 `session.id`（可用于接续历史对话）。结束使用 `session.close`，确认事件 `session.closed`。
- 会话配置：`audio.input.format.type` 支持 `pcm`、`speech_opus`，输入采样率仅 16 kHz；`audio.output.format.type` 支持 `pcm`（32-bit little-endian）、`pcm_s16le`（16-bit little-endian）、`ogg_opus`，输出采样率仅 24 kHz；需配置 `voice`。官方提示 PCM 输入建议 20 ms/包（16 kHz int16 为 640 bytes），并按实时节奏发送。
- 上行音频：`input_audio_buffer.append`，音频必须 Base64 放在 JSON 的 `audio` 字段；一次输入结束用 `input_audio_buffer.commit`。静音保活使用 `input_audio_mute.commit`，恢复使用 `input_audio_unmute.commit`（资料明确指出停止发帧会导致超时；Android SDK 的暂停录音指令会持续发送静音，最长 10 分钟）。
- 下行 ASR：`conversation.item.input_audio_transcription.started`、`.delta`、`.completed`、`.failed`。资料及官方 Python demo将 `item_id`、`delta`、终稿字段作为事件元数据处理；网关日志不得打印这些内容。
- 下行文本/音频：`response.output_text.delta`、`.done`；`response.output_audio.started`、`.delta`（Base64）、`.done`。Python demo在事件中读取 `response_id`，音频格式按配置解码；网关应只记录 response id、事件类型和字节数，不记录 `delta`。
- 取消：上行 `response.cancel`；下行确认 `response.canceled`（注意美式拼写 canceled）。确认事件示例读取 `event_id`，并非文档保证的 response id；因此适配器必须用本地 response 关联表处理迟到音频/文本。
- Function Calling：创建会话时 `tools` 使用标准 JSON Schema。下行 `response.function_call_arguments.done`，每个 `items` 元素含 `call_id`、函数名 `name`、JSON 字符串 `arguments`。执行后上行 `conversation.item.create`，`items` 中 `role: tool`、相同 `call_id`、`content: [{type: input_text, text: ...}]`；服务端随后继续生成回复。工具参数/结果属于对话内容，必须脱敏处理。
- 上下文：上行 `conversation.item.create/update/retrieve/delete`；创建最多 20 轮（40 条）完整 QA；删除按对话轮成对删除。系统提示词与模型内部上下文合计上限 12K tokens。`dialog.dialog_context` 是另一种初始化 QA 入口，需严格 user/assistant 成对。
- 关闭及错误：服务端有 `session.closed` 和 `error` 事件；Android SDK另有引擎 start/stop/error 回调。官方资料没有给出可直接映射到本项目的稳定错误码全集，必须保留原始错误 code/status（仅记录 code，不记录 message 内容）。

## 从公开 Python demo 核对到的实现细节

下载地址：`https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_148ee77d3245e465d244b912d1e83c91.zip`。demo 的 `realtime_client.py` 使用 `websockets.connect(..., extra_headers={"X-Api-Key": ...}, ping_interval=None)`；发送和接收均为 JSON 文本帧，音频 delta 为 Base64。demo 会等待 `session.created` 后继续，关闭时发送 `session.close` 并等待 `session.closed`（3 秒超时）。这些等待策略可作为网关超时的起点，但不是服务端 SLA。

demo 的配置把输入设为 `pcm`（16 kHz）时，输出可选 `pcm_s16le`（24 kHz）或 `pcm`；因此网关统一输出 PCM16/24 kHz/单声道时，优先请求 `pcm_s16le`，仍需对实际下行块做长度/采样格式校验。demo 对 `.delta` 事件仅做 Base64 解码并累积字节，不提供音频重采样逻辑。

## 映射风险与未决点

- **VAD / 自动打断**：资料列出全双工能力及 ASR started 事件，但没有在协议字段中给出可依赖的 VAD 阈值、`turn_detection` 开关或独立 `userSpeechStarted` 事件。Android SDK提供暂停/恢复录音与硬件/内置 AEC选项，不等价于模型端 VAD。需用最小实验观察服务端是否在用户插话时自动取消，以及网关是否仍需发送 `response.cancel`；不能猜测字段。
- **response 关联**：文本/音频事件出现 `response_id`（demo读取），取消确认明确示例使用 `event_id`。协议资料未定义统一 response 生命周期字段的完整 schema；适配器需按事件中存在的 response id 建立门控，并把无 id/迟到包按当前取消集合丢弃。
- **主动响应**：官方协议没有“greeting/主动 response”专用事件。可用 `speech_text_buffer.commit`（或 replacement 系列）提交由网关生成的文本，触发 TTS；这条路径与模型自主回复的 response 事件需分别标记，不能假设 commit 会带来同样的上下文语义。
- **debug 文本**：官方 demo 会打印完整 JSON、ASR/文本 delta；这违反本项目日志规则。生产 adapter 必须只输出事件名、id、字节数、计时和错误码，禁止复用 demo 日志代码。
- **context note / 已播放截断**：协议提供 conversation item CRUD 和初始化 `dialog_context`，但没有“按音频播放进度截断”或专门 context-note API。若需记录被打断回复，只能通过 `conversation.item.update/create` 写入脱敏后的摘要；12K 上限与每次最多 20 轮创建限制需在网关 ledger 层控制。
- **输出格式**：文档确认支持 `pcm_s16le`，但未承诺每个 delta 的帧边界、端序异常或空块行为；实现应按字节数统计并在解码器中校验偶数字节数，必要时缓冲半个采样。
- **重连**：`session.id`可接续历史对话，但公开资料未定义本项目所需一次性 connect/resume token、宽限期或网络重连语义；这些仍由网关自有协议实现，不能直接当作 Seeduplex 功能。

## 对 Plan 2 adapter 的直接建议

1. 首次连接先发送 `session.create`，等待 `session.created`；模型、音频格式和工具定义集中配置，Key 仅由网关环境变量注入。
2. 输入严格以 16 kHz/单声道/PCM16、20 ms 节奏发送；静音时发送协议 mute commit 保活。输出请求 `pcm_s16le`/24 kHz，网关内部统一校验并转为现有 PCM16 协议。
3. 事件映射按上表建立白名单；未知事件进入脱敏计数器。取消后将 response id 加入 tombstone 集合，丢弃迟到的 audio/text/tool 事件，直到 response.done/canceled 或 TTL 到期。
4. FC 只转发函数名、call_id 和经过 schema 校验的参数；结果通过 `conversation.item.create` 回传，call_id 必须原样匹配。
5. 不在单元测试中连接真实服务；使用脱敏事件 fixture 覆盖 session、音频、ASR、cancel、FC、error 和乱序/迟到事件。MockAdapter 保持默认后端。

## 参考链接

- [接入必读 / 完整协议](https://www.volcengine.com/docs/6561/2549732?AuditDocumentID=397063&lang=zh)
- [S2S 全双工版本 API 文档](https://www.volcengine.com/docs/6561/2549778?lang=zh)
- [Android SDK 接入说明](https://www.volcengine.com/docs/6561/2549732?AuditDocumentID=397063&lang=zh)
- [官方 Python demo ZIP](https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_148ee77d3245e465d244b912d1e83c91.zip)
