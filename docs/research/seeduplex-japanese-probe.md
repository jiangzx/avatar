# Seeduplex 日语能力探针

日期：2026-10-19
状态：**FAIL（无日语音色 → 按决策树直接失败）**
过线标准（grilling 共享理解）：端到端日语 = 听懂日语 + 日语回复 + 日语听感 PCM；无 `ja_*`（或等价日语）音色则不硬塞 `zh_*` 试探。

## 判定依据

### 1. Seeduplex 3.0（本仓库当前适配器路径）

- 端点 / 模型：`wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`，model `1.2.6.1`（见 `gateway/src/adapters/seeduplex.ts`）。
- 官方全双工文档要求配置 `audio.output.voice`，并指向「音色列表」；文档示例音色为 `zh_female_vv_jupiter_bigtts`。
- 方言参数 `explicit_dialect` 仅列中文方言（东北/四川/陕西/粤/北京/河南/天津/上海），**未列日语**。
- 证据卡 [C-1.4]（`docs/elderly-avatar-companion/evidence/C-technical.md`）描述 Seeduplex 协议与能力，**未写语种列表**。

访问：https://docs.volcengine.com/docs/DoubaoVoice/endtoend-realtime-voice-full-duplex-version?lang=zh（2026-10-19）。

### 2. 同厂端到端 RealtimeAPI（旧协议线，非 duplex 3.0）

- 官方原文：「支持中文和英语两大语种」。
- 列出的精品音色 ID 前缀为 `zh_*` 与 `en_*`（如 `zh_male_xiaotian_jupiter_bigtts`、`en_male_tim_uranus_bigtts`）；克隆音色亦为 `ICL_zh_*` / `saturn_zh_*`。
- **未出现 `ja_*` 或「日语」音色 ID。**
- 克隆说明：「端到端模型仅对中文有较好支持，其他语种效果暂时还不能保证」。

访问：https://docs.volcengine.com/docs/DoubaoVoice/End-to-endreal-timespeechlargemodelAPIaccessdocument?lang=zh（2026-10-19）。证据卡 [C-1.3] / [C-3.8]。

### 3. 勿混淆：其它火山语音产品上的「日语」

- 传统流式 TTS 音色表可见日语条目（如 `BV520_streaming` 元气少女、`BV524_streaming` 日语男声）——属于**另一条 TTS 产品线**，不是 Seeduplex duplex `RealtimeAdapter` 会话。
- 第三方整理的 Seed-Audio / 非官方音色表曾写 Vivi 支持日文；**不能**当作本仓库 Seeduplex 端到端会话的官方承诺。

## 未执行的步骤（有意跳过）

按共享理解 Q9：音色表无日语 voice → **立刻判失败**，不使用默认 `zh_male_xiaotian_jupiter_bigtts` + 日语 `instructions` 做假阳性文本探针，也不送日语 WAV。

本机 `docs/seeduplex/` 资料目录缺失；`gateway/.env` 中 `SEEDUPLEX_*` 键存在但未用于日语试探。

## 结论

| 项 | 结果 |
|---|---|
| Seeduplex 路径端到端日语 | **不可用（当前账号/文档范围内）** |
| 原因 | 端到端音色与语种约束为中英（及中文方言），无日语 voice |
| 产品含义 | 日语**不**走 `ADAPTER=seeduplex`；若仍要日语，另开「换适配器 / 级联」讨论 |

## 下一步（未自动执行）

1. 换适配器候选：同仓库 Qwen-Omni-Realtime（证据 [C-1.1] 厂商自述识别多语种）— 需单独探针，不在本文范围。
2. 或级联：日语 ASR + 文本 LLM + 日语 TTS（传统音色）— 架构变更，需新计划。
