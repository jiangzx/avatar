# 后台用量探针（P1-T1）

- 日期：2026-10-27
- 命令（cwd `gateway/`）：`node --env-file-if-exists=.env --import tsx scripts/probe-admin-usage.ts --wav /tmp/probe-16k.wav`（stdout 存 `/tmp/admin-usage-probe.jsonl`，7 行 JSON）
- 模型：realtime `qwen3.8-omni-flash-realtime`；文本 `qwen-plus`、`qwen-flash`（`QWEN_SUMMARIZER_MODEL` 未设置，用代码默认值）
- 输入：合成句子与合成音频（时长 3.79 秒，16 kHz 单声道 16 位 PCM），不含真实用户数据。
- 输出核对：`grep -c '天气\|打个招呼\|测试助手' /tmp/admin-usage-probe.jsonl` = `0`；stderr 为空。

## A1 实时转写是否单独计费 / 计入 usage

| 项 | 结果 |
|---|---|
| 携带 usage 的事件类型 | `response.done`（`usageCarriers` 只有这一条，路径 `response.usage`） |
| response.done usage 键路径 | `total_tokens`、`input_tokens`、`output_tokens`、`input_tokens_details.text_tokens`、`input_tokens_details.audio_tokens`、`output_tokens_details.text_tokens`、`output_tokens_details.audio_tokens` |
| 输入音频 token：期望 / 实报 | `28` / `35`（+25%，在 ±30% 内） |
| 结论 | **成立**：只有 `response.done` 携带 usage；转写相关事件（`conversation.item.input_audio_transcription.delta`、`conversation.item.input_audio_transcription.completed`）都不带 usage；实报输入音频 token 35 在期望 28 的 ±30% 内。P1-T7 无需新增转写用量类型。 |
| 账单核对（次日，用户在阿里云费用中心查看 `qwen3-asr-flash-realtime` 是否单列） | 未核对 |

## A4 上游请求 id

| 来源 | 结果 |
|---|---|
| WS 握手响应头 | `x-request-id` |
| realtime error 事件 id 路径 | `event_id` |
| 文本接口响应头 | `x-request-id` |
| 文本接口错误体 id 路径 | `error.id`（成功响应体另有 `id`） |

结论：**成立**，至少四处来源可拿到 id。

## A5 文本模型 usage

| 模型 | usage 键路径与数值 |
|---|---|
| `qwen-plus` | `prompt_tokens`=34、`completion_tokens`=2、`total_tokens`=36、`prompt_tokens_details.cached_tokens`=0 |
| `qwen-flash` | `prompt_tokens`=34、`completion_tokens`=6、`total_tokens`=40、`prompt_tokens_details.cached_tokens`=0 |

结论：**成立**，两个模型都含 `prompt_tokens` 和 `completion_tokens` 两个数字。

## realtime details 字段核对

- 完整字段名与预期一致：`input_tokens_details.text_tokens`、`input_tokens_details.audio_tokens`、`output_tokens_details.text_tokens`、`output_tokens_details.audio_tokens`。
- 注意：详情字段按存在的模态出现。纯文本轮次（`realtime_text`）只有 `input_tokens_details.text_tokens`，没有 `input_tokens_details.audio_tokens`；音频轮次（`realtime_audio`）四个字段齐全。解析必须把四个 detail 字段都当作可选字段。

## 对后续任务的结论

- P1-T6 上游请求 id 取值路径：
  - realtime：错误事件顶层 `event_id`；WS 握手响应头 `x-request-id`（可选补充）。
  - 文本：错误体 `error.id` 与响应头 `x-request-id`；成功响应体 `id` 与响应头 `x-request-id`。
- P1-T7 realtime details 字段名：`input_tokens_details.text_tokens`、`input_tokens_details.audio_tokens`、`output_tokens_details.text_tokens`、`output_tokens_details.audio_tokens`（均为可选；缺音频模态时对应 `audio_tokens` 不出现）。
- P1-T7 文本 usage 字段名：`prompt_tokens`、`completion_tokens`、`total_tokens`、`prompt_tokens_details.cached_tokens`。
