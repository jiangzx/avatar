# Seeduplex 协议核对与最小连通性验证

日期：2026-10-14
状态：协议资料已核对；最小连通性验证被鉴权阻塞，未启用真实适配器。

## 已核对事实

资料来源：仓库内 `docs/seeduplex/端到端实时语音.md`、`docs/seeduplex/实时语音_android.md`，以及火山引擎官方公开 Python demo（下载到临时目录后核对；未提交 demo）。

- WebSocket：`wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`。
- 鉴权：请求头 `X-Api-Key`；官方旧鉴权示例还提到 Bearer 方式，但需按账号配置验证。
- 模型：`1.2.6.1`。
- 会话：上行 `session.create` / `session.update` / `session.close`；成功事件为 `session.created` / `session.updated` / `session.closed`。
- 输入音频：JSON 文本帧中的 `input_audio_buffer.append`，Base64 PCM，16 kHz；官方建议 20 ms、640 字节（PCM16 单声道）分片。结束一段输入可发 `input_audio_buffer.commit`。
- 输出音频：`response.output_audio.delta`，Base64；配置 `pcm_s16le`、24 kHz。网关仍需把收到的数据统一校验/转换为现有协议要求的 PCM16、24 kHz、单声道。
- 用户转写：`conversation.item.input_audio_transcription.started/delta/completed/failed`。
- AI 文本与音频：`response.output_text.delta/done`、`response.output_audio.started/delta/done`；一轮结束 `response.done`。
- 取消：上行 `response.cancel`，确认事件 `response.canceled`。资料没有按客户端播放进度截断的专用 API。
- Function Calling：会话工具定义使用标准 JSON Schema；下行 `response.function_call_arguments.done`，工具结果用 `conversation.item.create`，条目 `role=tool`、相同 `call_id`、`content` 类型 `input_text`。
- 错误/关闭：下行 `error`，关闭确认 `session.closed`；官方 demo 在关闭时等待关闭事件后再关闭 socket。
- 上下文：`instructions` 与模型内部提示及上下文合计上限 12K tokens；`conversation.item.create` 初始化上下文一次最多 20 轮（40 条）完整 QA。
- VAD/自动打断：资料描述全双工服务端判停与 `response.cancel`，但未提供可验证的 `turn_detection` 开关、独立 `userSpeechStarted` 事件或播放进度截断字段。网关不能假设这些能力存在；本项目的本地 VAD、迟到事件丢弃和 context note 仍需在适配器层实现。

## 最小探针

探针脚本未写入仓库，位置为临时文件 `/tmp/seeduplex_probe.mjs`。它从 `docs/seeduplex/developer_keys` 在进程内读取 Key，不打印 Key；输出仅包括连接状态、HTTP 状态码、事件类型、字节数、错误码和计时。

命令：

```sh
node /tmp/seeduplex_probe.mjs
```

探针计划在建立连接后才会发送以下脱敏测试事件：`session.create`、一个 640 字节静音 PCM 片段、`input_audio_buffer.commit`、文本合成触发、`response.cancel`、工具结果回传、`session.close`。由于握手失败，以上事件均未发送。

实际结果：

- `X-Api-Key`：WebSocket 握手 HTTP 403（Node ws 报 `Unexpected server response: 403`）。
- `Authorization: Bearer`：WebSocket 握手 HTTP 401（Node ws 报 `Unexpected server response: 401`）。
- 两次均未收到 WebSocket 事件、音频字节为 0、未产生模型错误码；连接以本地 `1006` 结束。
- 未记录 Key、音频内容、ASR 文本或模型回复文本。

## 未决问题与阻塞

1. 本地 Key 当前无法通过官方端点鉴权；需要更新/确认有效的 Seeduplex API Key 或账号授权范围后重跑同一探针。
2. 连接成功后仍需验证真实的输出音频字节数、`response.canceled` 行为、工具调用下行字段和工具结果后的续答事件。
3. 需要用最小实验确认音色 `zh_male_xiaotian_jupiter_bigtts` 在当前账号可用，并确认服务端是否要求额外请求头或 UID。
4. VAD、自动打断、迟到事件与上下文限制的适配策略必须在上述实验成功后定稿。

在鉴权成功前，`ADAPTER` 继续只能为 `mock`，不创建真实适配器实施计划。

## 2026-10-14 权限开通后复测

用户反馈权限已开通后，使用同一脱敏探针重试。Key 文件仍为 55 字节；未输出 Key 内容。

- WebSocket + `X-Api-Key`：握手 HTTP 403，未建立连接。
- HTTPS 预检（`X-Api-Key`、Bearer、两者同时）：均返回 HTTP 401；响应体仅记录长度和哈希，未保存内容。
- 事件数 0，音频字节数 0；未发送 `session.create`、PCM、取消或工具结果事件。

因此当前本地 Key/账号授权仍未被官方端点接受，真实适配器和实施计划继续阻塞。
