# 情感共鸣与主动性：上游能力探针（2026-10-22）

状态：P1–P4 探针完成。未改 `gateway/src`、`app`、`avatar-core`、`protocol`；未启动/重启 8787；未操作手机。本文只记录事件类型、字段路径、枚举值、布尔判定、计数、时长、字节数、RMS/峰值/F0，不含任何转写正文或回复正文。

## 0. 结论摘要

标注：【实测】= 本次直接观测；【推断】= 基于观测的设计判断。

| 探针 | 结论 | 判定 |
|---|---|---|
| P1 Qwen 转写情绪 | 【实测】`emotion` 字段真实存在，随 ASR delta 实时下发，终稿事件自带最终值；取值见 `neutral/happy/sad/surprised/angry`。但最终标签在本次样本上不稳定（sad 0/5），且句内会翻转；没有可验证情绪的人声 ground truth | 【推断】**退回 B（不可靠）**；字段保留为候选，待人声样本复测 |
| P2 Qwen 语音风格 | 【实测】session 级 A/B 的时长差 -0.4%、RMS +1.0%、F0 -0.9%；单次 `response.create` 指令的 B 反而更快（-2.1%）更响（+6.7%）。盲听 2/5（3 对作答，对 2） | 【推断】**不做** |
| P3 Seeduplex 语音风格 | 【实测】被动回复：时长 -3.9%、每字 +1.2%、RMS +0.8%、F0 -3.1%，盲听 0/5（3 对作答，对 0）；直接 TTS：时长 +1.5%、RMS -0.9%、F0 -4.8%，盲听 2/5（4 对作答，对 2）。方向不一致且都在可感知边缘 | 【推断】**不做**（被动回复和直接 TTS 都不做） |
| P4 Seeduplex 中途 update | 【实测】播报中发送：当前回复可继续并正常结束，确认 46–61 ms，但**下一轮不再响应**（3/3 干净样本）；更晚发送时会出现无 `done` 的停滞。空闲（上一轮 `done` 后）发送：下一轮生效（2/2，45 ms）。连续两次间隔 1 s：两次都确认，后一次生效，无乱序/丢弃 | 【推断】**只在安全缝隙推送**；禁止播报中推送；间隔 ≥1 s、每轮最多一次、合并连发 |
| P4 Qwen 对照 | 【实测】播报中 update：确认 59–66 ms，当前回复正常结束，下一轮带标记（2/2）；空闲 update 同样生效（1/1） | 【推断】Qwen 可播报中推送；为统一仍建议安全缝隙 |

## 1. 环境与方法

- 工作树：`/Users/jed/SourceCode/avatar`，基线 `master` 4eb747c；探针分支 `probe/emotion-2026-10-22`。
- Qwen：`QWEN_MODEL=qwen3.8-omni-flash-realtime`，`QWEN_VOICE=longanlingxin`，`semantic_vad silence_duration_ms=800`，`input_audio_transcription.model=qwen3-asr-flash-realtime`；与 `gateway/src/adapters/qwen.ts` 的会话配置一致。
- Seeduplex：`SEEDUPLEX_MODEL=1.2.6.1`，`SEEDUPLEX_VOICE=zh_male_xiaotian_jupiter_bigtts`。
- 密钥只从 `gateway/.env` 读取，未打印、未提交。未重启 8787，未触碰手机。
- 音频统一为 16 kHz 单声道 PCM16 WAV。合成音频两类：
  1. `qwen3-tts-flash`（DashScope 北京公共端点）指令式 TTS，文本与 `instructions` 见各节；输出 24 kHz WAV，用 `ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le` 转为 16 kHz。
  2. macOS `say -v Tingting`，只作中性/用户输入，语调**没有**情绪。
- **重要限制：** `qwen3-tts-flash` 的 `instructions` 是否真的改变了情绪，本次无法用人耳之外的 ground truth 验证；客观音高/时长分布在 happy/sad/calm 之间明显重叠（见 §2.4）。CosyVoice v2 的 `instruction` 在当前账号所有可用中文音色上返回 `[cosyvoice:] Engine return error code: 428`；`emotion` 参数被接受但输出字节数完全相同，未产生差异。因此 P1 的“一致率”只能理解为“最终标签 vs TTS 指令标签”，不是标签准确率。
- 所有音频在盲听结束后已从 `/tmp` 删除；`/tmp/avatar-emotion-probe/*.jsonl` 仅保留指标/事件日志，不含正文。

### 新增脚本

| 脚本 | 用途 |
|---|---|
| `gateway/scripts/probe-emotion-p1-asr-tags.ts` | P1：逐条送入 WAV，打印脱敏事件结构、`emotion` 路径/取值/相对终稿时间 |
| `gateway/scripts/probe-emotion-p2-qwen-style.ts` | P2：Qwen session 级与单次 response 指令 A/B，输出时长/字数/ms per char/RMS/峰值，写 WAV 供盲听 |
| `gateway/scripts/probe-emotion-p3-seeduplex-style.ts` | P3：Seeduplex 被动回复与直接 TTS A/B，同上 |
| `gateway/scripts/probe-emotion-p4-session-update.ts` | P4：Seeduplex 播报中/空闲/连续两次 `session.update` |
| `gateway/scripts/probe-emotion-p4-qwen-session-update.ts` | P4 可选对照：Qwen 播报中/空闲 `session.update` |

## 2. P1：Qwen 转写里有没有情绪标签

### 2.1 方法

每条音频独立开一个 Qwen 会话，流式送入 16 kHz PCM（20 ms 块），随后补 2 s 静音；等待 `conversation.item.input_audio_transcription.completed`，再等 4 s 捕获迟到事件。所有打印值经过脱敏：`transcript/text/delta/audio/arguments/output` 以及任何含 CJK 或超过 48 字符的字符串都替换为 `<redacted:len>`。

### 2.2 事件结构（实测，正文已删除）

`conversation.item.input_audio_transcription.delta`：

```json
{
  "event_id": "event_...",
  "type": "conversation.item.input_audio_transcription.delta",
  "item_id": "item_...",
  "content_index": 0,
  "text": "<redacted:0>",
  "stash": "<redacted:2>",
  "language": "zh",
  "emotion": "neutral",
  "obfuscation": "..."
}
```

`conversation.item.input_audio_transcription.completed`：

```json
{
  "event_id": "event_...",
  "type": "conversation.item.input_audio_transcription.completed",
  "item_id": "item_...",
  "content_index": 0,
  "transcript": "<redacted:13>",
  "language": "zh",
  "emotion": "neutral"
}
```

- 字段路径就是顶层 `emotion`（字符串）。没有发现 `emo_tag`、`annotations`、`prosody`、`sentiment`、`style` 等变体。
- `emotion` 只出现在上述两个转写事件里；`speech_started`、`speech_stopped`、`committed`、`conversation.item.created`、`response.*` 都没有该字段。
- 终稿事件没有单独的“标签事件”：最终标签随 `completed` 一起到达；delta 期间每个分片都带当时的标签。

### 2.3 逐条结果

音频来源：`tts` = `qwen3-tts-flash` 指令式（未人耳验证）；`say` = macOS `say`（无情绪）。`seq` 是该句内出现过的标签集合；`final` 是 `completed.emotion`；`firstΔ` 是首个带标签的 delta 相对终稿的时间（负值=早于终稿）。

| # | 用例 | 期望 | 来源 | final | seq | firstΔ (ms) | ASR 终稿 |
|---|---|---|---|---|---|---|---|
| 1 | happy-1 | happy | tts | neutral | neutral | -2245 | ✓ |
| 2 | sad-1 | sad | tts | neutral | neutral | -2317 | ✓ |
| 3 | neutral-1 | neutral | say | neutral | neutral | -2480 | ✓ |
| 4 | happy-strong | happy | tts | **happy** | happy | -1366 | ✓ |
| 5 | sad-strong | sad | tts | surprised | neutral, sad, happy, surprised | -3434 | ✓ |
| 6 | angry-strong | angry | tts | **angry** | happy, surprised, angry | -1884 | ✓ |
| 7 | calm-strong | neutral | tts | **neutral** | neutral | -2346 | ✓ |
| 8 | sad-imfine-short | sad | tts（合成代用） | neutral | neutral | -1173 | ✓ |
| 9 | happy-2 | happy | tts | **happy** | neutral, happy | -3600 | ✓ |
| 10 | happy-3 | happy | tts | neutral | neutral | -2280 | ✓ |
| 11 | sad-2 | sad | tts | surprised | neutral, sad, surprised | -3189 | ✓ |
| 12 | sad-3 | sad | tts | neutral | neutral | -2179 | ✓ |
| 13 | neutral-2 | neutral | tts | surprised | neutral, surprised | -1514 | ✓ |
| 14 | surprised-1 | surprised | tts | **surprised** | surprised | -2899 | ✓ |
| 15 | angry-2 | angry | tts | neutral | neutral, surprised | -3122 | ✓ |

所有 15 条都收到 ASR 终稿，无 error。

### 2.4 一致率与稳定性

- 最终标签命中：happy **2/4**；sad **0/5**；neutral **2/3**；angry **1/2**；surprised **1/1**；合计 **6/15**。
- 句内会翻转：`sad-strong` 为 `neutral → sad → happy → surprised`；`angry-strong` 为 `happy → surprised → angry`；`neutral-2` 为 `neutral → surprised`。因此“取最后一条”与“取出现过的最强标签”会得到不同结论。
- 首个标签在终稿前 **1.2–3.6 s** 到达；最终标签在 `completed` 上同步到达（Δ=0）。如果未来要用 C，情绪信号不需要额外等待终稿，但必须决定用哪个时刻的标签。
- **Caveat：** 本次 TTS 的“情绪”没有被独立验证。对 happy/sad/calm 三组 16 kHz 样本做 F0/时长/RMS 分析，分布重叠（例如 calm 的 F0 中位数 258 Hz，happy 200–258 Hz，sad 182–267 Hz），不能证明 TTS 真的按指令改变了语气。因此 6/15 既可能是标签不准，也可能是输入不够情绪化；本次不能把 C 判为可靠。

### 2.5 判定

**【推断】退回 B（不可用/不可靠）。** 理由：字段存在且实时，但最终标签在本次样本上 sad 0/5、happy 2/4，且句内多次翻转；没有可验证情绪的人声 ground truth，无法证明它在真实老人语音上可靠。建议保留该字段作为候选，待操作者录 2 条开心、2 条难过、2 条中性的人声表演句后复测；若复测一致率达到约定门槛，再升级到 C。

用例 (d)“嘴上没事、语气难过”：**未测（无人声表演条件）**。合成代用品（`我没事` + 难过指令）最终标签为 `neutral`；这不是人声表演结果，不能替代 (d)。

## 3. P2：Qwen 能不能用 instructions 控制语音情绪

### 3.1 方法

固定句子：`您别着急，我在这儿陪着您，慢慢说就好。`；音色 `longanlingxin`。每个会话只在一处不同：

- A：`你是一位温柔、自然的陪伴助手。请用简短、自然的口语回应用户。`
- B：A + `\n对方现在很难过，请用轻柔、放慢、音量低一点的语气说话。`

session 级各 5 次；单次 `response.create` 指令各 3 次（会话仍为 A，把 B 的整段指令放进 `response.create.response.instructions`）。每次新开会话，送同一句用户文本，要求逐字重复。记录音频时长、字数、ms/char、RMS、峰值、F0 中位数。音频乱序配对后交操作者盲听，听完删除。

### 3.2 客观结果（5 次平均）

| 条件 | 时长 ms | 字数 | ms/char | RMS | 峰值 | F0 Hz |
|---|---:|---:|---:|---:|---:|---:|
| A（session） | 3892 | 19 | 204.9 | 2480 | 11287 | 224 |
| B（session） | 3876 | 19 | 204.0 | 2504 | 11946 | 222 |
| **B−A** | **-0.4%** | 0 | **-0.4%** | **+1.0%** | +5.8% | -0.9% |
| A（单次 response） | 3860 | 19 | 203.2 | 2479 | 11294 | 231 |
| B（单次 response） | 3780 | 19 | 198.9 | 2644 | 11956 | 231 |
| **B−A** | **-2.1%** | 0 | **-2.1%** | **+6.7%** | +5.9% | 0% |

B 的指令要求“放慢、音量低”，但 session 级几乎不变，单次 response 反而更快、更响；方向与指令相反。15/15 次都逐字说出了固定句。

### 3.3 盲听

- 5 对乱序；操作者作答 3 对，**对 2 对**（按 5 对计为 2/5），2 对表示听不出。
- 结合客观指标：没有可感知的“轻柔/放慢/音量低”效果。

### 3.4 判定

**【推断】不做。** session 级 instructions 不能可靠控制 Qwen 的语气；单次 `response.create` 指令也没有产生期望方向的变化。若 Plan 4 需要语音情绪，Qwen 这条路不能作为实现基础。

## 4. P3：Seeduplex 能不能用 instructions 控制语音情绪

### 4.1 方法

同一套 A/B 指令，音色 `zh_male_xiaotian_jupiter_bigtts`，两条路径各 5 次：

- (i) 被动回复：送入合成的“我今天有点累。”16 kHz WAV，等待 Seeduplex 回复音频；记录回复时长、回复字数、ms/char、RMS、峰值、F0。
- (ii) 直接 TTS：`speech_text_buffer.commit` 提交固定句 `您别着急，我在这儿陪着您，慢慢说就好。`（与主动开口同一条路径）；记录时长、RMS、峰值、F0。

### 4.2 客观结果（5 次平均）

| 路径 | 条件 | 时长 ms | 字数 | ms/char | RMS | 峰值 | F0 Hz |
|---|---|---:|---:|---:|---:|---:|---:|
| 被动 | A | 6147 | 36 | 170.8 | 2801 | 17413 | 104 |
| 被动 | B | 5907 | 34 | 173.7 | 2822 | 17445 | 101 |
| **被动 B−A** | | **-3.9%** | | **+1.2%** | **+0.8%** | +0.2% | -3.1% |
| 直接 | A | 3306 | 19 | 174.0 | 2961 | 17512 | 124 |
| 直接 | B | 3357 | 19 | 176.7 | 2934 | 17169 | 118 |
| **直接 B−A** | | **+1.5%** | | **+1.5%** | **-0.9%** | -2.0% | -4.8% |

- 直接 TTS 的方向（略慢、略轻、F0 略低）与指令一致，但幅度很小；逐对看，B 的 F0 在 4/5 对更低，时长在 4/5 对更长，RMS 只在 3/5 对更低。
- 被动回复方向不一致：总时长更短、每字更慢、RMS 略高。
- 所有 10 次都正常收到 `response.output_audio.done`；无 error。

### 4.3 盲听

- 被动回复：5 对乱序；操作者作答 3 对，**对 0 对**（按 5 对计为 0/5），2 对听不出。
- 直接 TTS：5 对乱序；操作者作答 4 对，**对 2 对**（按 5 对计为 2/5），1 对听不出。
- 两项都没有超过随机水平；直接 TTS 的客观小差异没有被盲听支持为可感知。

### 4.4 判定

**【推断】不做（被动回复和直接 TTS 都不做）。** 最关键的是 P3(ii)：`speech_text_buffer.commit` 的直接 TTS 没有表现出可靠的 instructions 语气变化，因此 Seeduplex 的主动开口无法靠 instructions 做语气变化。若 Plan 4 仍需要主动开口的情绪，只能考虑更换 TTS 能力或接受固定语气，不能假设现有指令会生效。

## 5. P4：Seeduplex 中途 session.update 的时序

### 5.1 方法

按 `gateway/src/adapters/seeduplex.ts` 的 `pushSession` 发送完整 session payload，新指令加入可检测标记“每句话结尾都必须加上‘呀嘿’两个字”（对照标记“喵喵”）。所有发送都记录相对会话起点的时刻；`session.updated` 作为确认事件。

- (a) 播报中：在第一个 `response.output_audio.delta` 到达后立即发送；记录当前回复是否继续、是否报错、`session.updated` 耗时、剩余回复是否出现标记；当前回复完成后，再送一轮用户音频，观察下一轮是否响应。
- (b) 空闲：等上一轮 `response.output_audio.done` 后发送，再送一轮，观察下一轮是否带标记。
- (c) 连续两次：先完成一轮作为预热，再间隔 1 s 发送“喵喵”与“呀嘿”，观察确认数量/顺序和下一轮标记。
- Qwen 对照：同一结构，用 `session.update {instructions}`；播报中按 `response.audio.delta` 触发。

### 5.2 结果（a）：播报中更新

干净的“首个 delta 后立即发送”样本 3 次（a9/a10/a11）：

| 指标 | a9 | a10 | a11 |
|---|---:|---:|---:|
| 首个 delta 时刻 ms | 4739 | 5020 | 4720 |
| 发送时刻 ms | 4952 | 5020 | 4851 |
| `session.updated` 耗时 ms | 46 | 58 | 61 |
| 当前回复是否继续 | 是 | 是 | 是 |
| 当前回复是否正常 done | 是（9541 ms） | 是（9339 ms） | 是（9574 ms） |
| 剩余部分带标记 | 否 | 否 | 否 |
| error | 无 | 无 | 无 |
| **下一轮是否响应** | **否** | **否** | **否** |

更晚发送的样本（a1/a2，约 28 s 时发送）出现另一种表现：`session.updated` 在 51–59 ms 确认，但当前回复之后 **0 个音频 delta、无 done、无 error**，20 s 内一直停滞；a3（8.3 s 发送）继续了 7.0 s 音频后也没有 done，且后续用户轮不响应。a5 在约 47 s 触发 `55000000 Internal Server Error` + `45000000 Bad Request` 并被 `session.closed`，与本轮探针的长时间无输入有关（见 §6）。

**结论（a）：** 播报中 `session.update` 不是“截断当前音频”那么简单：当前回复在早期发送时能继续播完，但**下一轮不再响应**；晚发送时当前回复会无 `done` 停滞。两种情况都没有 error，网关侧很难靠错误码发现。**禁止在播报中推送。**

### 5.3 结果（b）：空闲更新

| 样本 | 上一轮 done | 发送时刻 ms | 确认耗时 ms | 下一轮 done | 下一轮带标记 | error |
|---|---|---:|---:|---|---|---|
| b3（呀嘿） | 是 | 4317 | 45 | 是 | **是** | 无 |
| b-miao（喵喵） | 是 | 4861 | 45 | 是 | **是** | 无 |

**结论（b）：** 在上一轮 `response.output_audio.done` 之后、下一轮用户音频之前发送，更新会生效到下一轮被动回复，确认约 45 ms，不破坏会话。

### 5.4 结果（c）：连续两次更新

预热轮完成后，间隔 1.000–1.004 s 发送两次完整 payload：

| 指标 | c4 |
|---|---|
| 第一次/第二次发送 ms | 4574 / 5578 |
| 两次 `session.updated` ms | 4617 / 5620 |
| 两次确认间隔 ms | 1003 |
| 下一轮 done | 是 |
| 第一标记（喵喵） | 否 |
| 第二标记（呀嘿） | **是** |
| error | 无 |

**结论（c）：** 1 s 间隔的两次更新都会确认，顺序正确，没有丢弃；**后一次生效**。本次没有测 1 s 以下间隔；建议把 1 s 作为最小间隔，并在网关侧合并同一轮的多次更新。

补充：在“首轮用户音频之前”发送更新（c/c1）时，确认正常，但下一轮两条标记都未出现；c1 的回合还在 30 s 内没有结束。这个“预热前更新”场景不可靠，不能作为生产路径。

### 5.5 Qwen 对照（选做）

| 场景 | 样本 | 确认耗时 | 当前回复 | 下一轮带标记 | error |
|---|---|---:|---|---|---|
| 播报中 update | a1 | 66 ms | 正常 done | **是** | 无 |
| 播报中 update | a2 | 59 ms | 正常 done | **是** | 无 |
| 空闲 update | b | 61 ms | — | **是** | 无 |

Qwen 在播报中 `session.update` 没有出现 Seeduplex 的“下一轮不响应”问题。为保持两种适配器行为一致，仍建议在安全缝隙推送；但 Qwen 不是必须。

### 5.6 判定

- **【推断】Seeduplex：只在安全缝隙推送。** 安全缝隙 = 当前回复 `response.output_audio.done`（或等价终态）之后、下一轮用户音频之前。播报中禁止推送。
- **最小间隔/节流：** 本次只验证 1 s；建议间隔 ≥1 s、每轮最多一次、同一轮的多次状态变化先合并，再在一次 `session.update` 里发送。
- **Qwen：** 播报中推送未复现破坏；可作为对照上的“可做”，但统一实现建议同样走安全缝隙。
- **对 Plan 4 的影响：** “每句终稿后推状态卡”在 Seeduplex 上不能直接做。若状态卡依赖逐句终稿，必须把推送延后到回复结束；或者只更新网关内部状态，不向上游发 `session.update`。

## 6. 意外发现

1. **Seeduplex 长时间无输入会触发上游错误。** 探针在约 47–48 s 无输入后收到 `55000000 Internal Server Error`，随后 `45000000 Bad Request` 和 `session.closed`；加入 20 ms 静音 keepalive 后，干净样本不再出现。判断为探针未持续送音频导致的空闲超时，**不是**生产客户端的行为（客户端持续采集/静音帧）。但它会干扰长探针，后续 Seeduplex 探针应默认带 keepalive。
2. **Seeduplex 的 `response.output_audio.delta` 没有 `response_id`。** `response.output_audio.started` 有 `response_id`；delta 只有 `event_id/type/delta`。适配器 `responseIdFrom` 依赖“当前 responseId”回退，正常路径可用；做多响应并发分析时不能只靠 delta 的 `response_id`。
3. **播报中 update 后没有 error、没有 `response.output_audio.done`、下一轮不响应。** 这是本次最危险的发现：网关现有的“等 error 再重建”策略发现不了；如果未来在播报中推送，需要额外的“更新后 N 秒无 done/无下一轮响应”守卫。
4. **`emotion` 标签会句内翻转。** 同一句从 `neutral` 变到 `sad`、`happy`、`surprised`；如果 Plan 4 用 C，必须定义聚合策略（首个/最后一个/多数/最高置信），并接受它可能不稳定。

## 7. Blocker

新增两条，已写入 `docs/blockers.md`：

- **#47 P1 情绪音频 ground truth 缺失。** 本次没有可验证情绪的人声表演；`qwen3-tts-flash` 的指令情绪未被独立验证，CosyVoice v2 的 `instruction` 在当前账号返回 428。影响：P1 只能判“不可靠”，不能判“字段无效”。解除条件：操作者录 2 条开心、2 条难过、2 条中性的人声表演句（16 kHz 单声道），复跑 P1；或找到可验证情绪的 TTS。
- **#48 Seeduplex 播报中 `session.update` 后下一轮不响应。** 3/3 干净样本复现；无 error。影响：不能按“每句终稿后推状态卡”实现。解除条件：上游修复，或确认可用的规避方式（本次已验证安全缝隙推送可用）。

## 8. 复现命令

```bash
cd gateway

# P1（每条音频独立会话；--case 可重复）
node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p1-asr-tags.ts \
  --case happy=/tmp/avatar-emotion-probe/happy-16k.wav \
  --case sad=/tmp/avatar-emotion-probe/sad-16k.wav \
  --case neutral=/tmp/avatar-emotion-probe/neutral-16k.wav

# P2（5 次 session 级 + 3 次单次 response 指令）
node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p2-qwen-style.ts --runs 5 --per-response-runs 3

# P3（被动回复需要 16k 用户 WAV；直接 TTS 不需要）
node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p3-seeduplex-style.ts passive \
  --wav /tmp/avatar-emotion-probe/user-tired-16k.wav --runs 5
node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p3-seeduplex-style.ts direct --runs 5

# P4 Seeduplex（a/b/c 分开跑；a 用较长故事请求，b/c 用短句）
node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p4-session-update.ts seeduplex-a \
  --wav /tmp/avatar-emotion-probe/user-story-16k.wav
node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p4-session-update.ts seeduplex-b \
  --wav /tmp/avatar-emotion-probe/user-tired-16k.wav --marker 呀嘿
node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p4-session-update.ts seeduplex-c \
  --wav /tmp/avatar-emotion-probe/user-tired-16k.wav

# P4 Qwen 对照
node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p4-qwen-session-update.ts both
```

TTS fixture 的生成方式（本次实际使用）：`qwen3-tts-flash` 北京公共端点 `POST /api/v1/services/aigc/multimodal-generation/generation`，`input.text` + `parameters.{voice:'Cherry', instructions, speed}`；返回 24 kHz WAV URL；用 `ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le` 转 16 kHz。`say -v Tingting` 只用于中性/用户输入。

## 9. 对 Plan 4 的建议

1. **情绪信号先按 B 设计**：不要把 Qwen `emotion` 作为唯一/主信号；可以把它作为候选特征，但必须有文本/声学兜底，并用真实人声样本验证后再升级。
2. **语音情绪不作为 Plan 4 第一版的能力**：P2/P3 都没有表现出可靠、可感知的 instructions 控制；Seeduplex 的主动开口直接 TTS 也不受 instructions 影响。第一版应把“情感共鸣”放在话术、节奏、回应内容上，而不是音色情绪。
3. **状态卡/指令推送只在安全缝隙**：Seeduplex 在 `done` 后推送，Qwen 也建议同样；间隔 ≥1 s，合并连发。
4. **如果未来仍要 C**：先补人声表演 ground truth，再决定聚合策略；同时把“标签句内翻转”和“最终标签与首个标签不一致”纳入规格。
