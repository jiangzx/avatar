# 多语言能力探针（2026-10-21）

只记录事件、脚本标志、字节数，不记录 ASR/回复正文。探针脚本：
`gateway/scripts/probe-qwen-languages.ts`、`gateway/scripts/probe-seeduplex-languages.ts`。

## 环境与输入

- 运行目录 `gateway/`；密钥来自 `gateway/.env`（`--env-file`，不打印、不入库）。
- Qwen：`QWEN_VOICE=Tina` 进程环境覆盖（未改 `.env`）；模型同 `gateway/.env` 的 `QWEN_MODEL`（`qwen3.8-omni-flash-realtime`）。
- Seeduplex：`SEEDUPLEX_MODEL=1.2.6.1`，中文音色 `zh_male_xiaotian_jupiter_bigtts`，英语音色 `en_male_tim_uranus_bigtts`。
- 合成音频：macOS `say` + `afconvert -f WAVE -d LEI16@16000 -c 1`，三语各一句；音色 `Tingting`（zh）、`Kyoko`（ja）、`Samantha`（en），三者在 `say -v '?'` 中均存在，无需替代。
- 文件（`/tmp/multilingual-probe-2026-10-21/`）：`zh-16k.wav` 2.42 s、`en-16k.wav` 2.04 s、`ja-16k.wav` 2.77 s。
- Qwen 音频 `ja` 最终使用 2026-10-19 已生成的合成日语样本 `/tmp/qwen-ja-probe/user-16k.wav`（同 Kyoko、16 kHz mono PCM16，3.73 s）；本次新合成的 ja 样本未触发 VAD，见“异常与限制”。

## Qwen

| 探针 | 结果 | 关键指标 |
|---|---|---|
| text zh / ja / en | **PASS** | 三语均 `status=completed`、`error=null`；zh 回复 67 字符（han）、ja 96 字符（hiragana+han）、en 96 字符（latin）；audioBytes 610560 / 817920 / 291840 |
| audio zh | **PASS** | ASR 11 字符（han）；回复 73 字符（han+latin）；audioBytes 641280；errors 0；`done=true` |
| audio ja | **PASS**（用 2026-10-19 样本） | ASR 22 字符（hiragana+han）；回复 86 字符（hiragana+katakana+han）；audioBytes 752640；errors 0；`done=true` |
| audio en | **PASS** | ASR 32 字符（latin）；回复 115 字符（latin）；audioBytes 353280；errors 0；`done=true` |
| switch zh→en→ja | **PASS** | `update_en.updated=true`、`update_ja.updated=true`；三语 `status=completed`、`error=null`；回复脚本 zh 47（han）、en 121（latin）、ja 69（hiragana+han） |

回复字符数与 audioBytes 每次运行会波动（例如 ja 复跑曾为回复 30 字符、audioBytes 288000），脚本标志与语言方向稳定。

**Gate 说明**：本次 gate 使用 2026-10-19 旧合成样本；本次新合成样本无 VAD 事件（`done=false`，ASR/回复/音频均为空），已记 blocker #45；controller 已批准以旧样本作为能力证据。

结论：Tina 音色下 Qwen 文本三语可用；音频中文、英语直接可用；日语音频在已知可触发 VAD 的合成样本上可用（ASR 含假名、回复含假名/片假名）。

## Seeduplex

说明：Seeduplex 的 ASR 终稿放在事件字段 `text`（网关适配器 `gateway/src/adapters/seeduplex.ts` 同样回退读取 `text`）。Review 后探针已改为读取 `transcript ?? text`，下表的 ASR 标志直接来自脚本输出，可从提交的脚本复现。

| 探针 | 结果 | 关键指标 |
|---|---|---|
| zh voice + zh audio | **PASS** | ASR 11 字符（han=true、latin=false）；回复 42 字符（han）；audioBytes 316538；errors 0；`timedOut=false` |
| en voice + en audio | **PASS**（内容齐全；终稿事件缺失） | ASR 32 字符（latin=true）；回复 133 字符（latin）；audioBytes 446464；errors 0；`timedOut=true`（3/3 次修复后运行收到完整 ASR/回复/音频，但 30 s 内未收到 `response.output_audio.done`；修复前一次运行收到该事件） |
| session.update 换 voice（zh→en voice） | **PASS** | `session.updated` 1 次、`updated=true`、`timedOut=false`、errors 0、`targetVoice=en_male_tim_uranus_bigtts`；两轮 ASR completed 2 次、ASR 43 字符（han+latin）、回复 181 字符（han+latin）、`response.output_audio.delta` 37 次；audioBytes 755310 |
| ja audio + zh voice | **FAIL**（软失败，不阻塞 M1） | 无 completed、无回复、audioBytes 0、`timedOut=true`；一次运行仅出现 transcription.started + 2 个 delta，未终稿；其余运行只有 session.created + committed |

## 异常与限制

1. **本次新合成的日语 WAV 未触发 Qwen VAD**：用 `say -v Kyoko`（默认/`-r 160`/`-r 280`/`-r 300`）、`say -v Grandma` 新合成的日语样本，以及 ffmpeg 重新转码、前置静音、重复拼接等变体，在 Qwen `semantic_vad` 会话上均未产生任何 `input_audio_buffer.*` / 转写 / `response.*` 事件（等待 25 s，errors 0）。相同探针、相同音色在 2026-10-19 生成的 `/tmp/qwen-ja-probe/user-16k.wav` 上连续两次通过（见上表）。原因未定位，已记入 `docs/blockers.md` #45；能力本身已验证，但“每次新合成样本都能复现”未验证。
2. **Seeduplex 日语 ASR 不产出终稿**：用新样本与 2026-10-19 已知可用样本各试多次，均无 completed、无回复；仅一次出现 2 个 partial delta 后中止。无法获得含假名的日语文本 → M3 不得实现“明确告知日语不支持”。
3. **Seeduplex 英语终稿事件不稳定**：修复后的 3 次 en 运行均收到 ASR completed、回复文本和非空音频，但 30 s 内未收到 `response.output_audio.done`，`timedOut=true`；另用 45 s 诊断仍未收到该事件。修复前（同日早些时候）一次 en 运行收到该事件并正常结束。当前按“内容齐全”判 PASS，但依赖 `response.output_audio.done` 的会话结束信号存在缺失风险（网关适配器用它发出 `responseDone`）。
4. Seeduplex `session.update` 被接受且未报错；本轮 switch 运行 `session.updated=1`、`timedOut=false`，两轮 `response.output_audio.done` 均出现，`response.done` 1 次；按 `updated=true` + 两轮音频/文本事件判定热换可用。
5. 探针已增加 `done`（Qwen，是否等到终止事件）与 `timedOut`（Seeduplex）字段，缺失终稿事件不再被静默掩盖；两个脚本在流式发送前校验 WAV 必须为 16 kHz mono PCM16，44.1 kHz 输入会以 `wav_not_16k_mono_pcm16` 拒绝。

## 结论与 gate

- Qwen 三语：**PASS**（文本与音频均验证；日语音频使用 2026-10-19 合成样本并经 controller 批准，新合成样本的 VAD 异常见上）。
- Seeduplex 中/英：**PASS**（ASR 与回复脚本匹配，音频非空；英语终稿事件缺失见异常 3，不改变语言能力判定）。
- Seeduplex 日语 ASR：**FAIL**（未产出含假名的终稿 → “明确告知”不可实现；M1 基础不依赖它，可继续；M3 不得实现该功能）。
- Seeduplex voice 热换：**PASS**（`session.updated` 被接受；M3 可走热换，重建仍保留为失败回退）。

## 复现命令（gateway/）

```sh
# Qwen（Tina 覆盖，不改 .env）
QWEN_VOICE=Tina node --env-file-if-exists=.env --import tsx scripts/probe-qwen-languages.ts text
QWEN_VOICE=Tina node --env-file-if-exists=.env --import tsx scripts/probe-qwen-languages.ts audio \
  --wav-zh /tmp/multilingual-probe-2026-10-21/zh-16k.wav \
  --wav-ja /tmp/qwen-ja-probe/user-16k.wav \
  --wav-en /tmp/multilingual-probe-2026-10-21/en-16k.wav
QWEN_VOICE=Tina node --env-file-if-exists=.env --import tsx scripts/probe-qwen-languages.ts switch

# Seeduplex
node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-languages.ts zh --wav /tmp/multilingual-probe-2026-10-21/zh-16k.wav
node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-languages.ts en --wav /tmp/multilingual-probe-2026-10-21/en-16k.wav
node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-languages.ts ja --wav /tmp/multilingual-probe-2026-10-21/ja-16k.wav
node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-languages.ts switch \
  --wav /tmp/multilingual-probe-2026-10-21/zh-16k.wav \
  --wav2 /tmp/multilingual-probe-2026-10-21/en-16k.wav
```

本工作树无 `gateway/.env`，实际执行时用 `--env-file=/Users/jed/SourceCode/avatar/gateway/.env`（只读取，未复制、未打印密钥）。
