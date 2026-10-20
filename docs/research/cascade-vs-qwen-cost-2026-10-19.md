# 日语级联语音栈 vs Qwen Omni Realtime 成本对照（2026-10-19）

- 访问日期：**2026-10-19**（下文来源均以此为准，除非页面标注其它更新日）
- 范围：中国大陆可 API 调用的**刊例价**；不含免费额度、资源包、限时活动、RTC/编排/内容安全/存储
- 对照基线：证据包 [C-technical §3](../elderly-avatar-companion/evidence/C-technical.md) 用量假设与公式；2026-10-09 快照 [C-6.*](../elderly-avatar-companion/evidence/C-technical.md) 已与当前 `help.aliyun.com/zh/model-studio/model-pricing` 逐项复核

---

## 结论（Verdict）

**在同等日活用量下，日语可用的「ASR + LLM + 流式 TTS」级联方案通常比 `qwen3.8-omni-flash-realtime` 更贵，而不是更便宜。**

- **相对 qwen3.8（含多轮上下文重复计费）**：级联约 **0.50–0.70 元/天**（≈15–21 元/月） vs 端到端约 **0.36 元/天**（≈11 元/月）；即使 qwen3.8 **不计上下文**（约 0.10–0.13 元/天），级联仍更高。
- **相对 qwen3.5-omni-flash-realtime（含上下文）**：级联**明显更便宜**（≈21 元/月 vs ≈57 元/月量级）。
- **相对火山 Seeduplex 端到端**：级联**远便宜**（Seeduplex 不在本文计价表，见 blockers）；但火山**级联**（豆包 ASR 2.0 + TTS 2.0）与阿里级联同量级（≈29 元/月）。
- **选型含义**：日语产品若成本优先且可接受 Omni 协议与上下文策略，**qwen3.8 端到端仍是最低刊例价**；级联的价值在组件可替换、文本层安全/记忆、以及**不**使用 Seeduplex 时的架构退路，而非单价。

---

## 用量假设（与 C-technical §3 相同）

| 符号 | 含义 | 取值 |
| --- | --- | --- |
| N | 每用户每日会话时长（含静默） | 20 min = 1,200 s |
| U | 用户说话 | 6 min = 360 s |
| A | AI 说话 | 8 min = 480 s |
| T | 轮次/天 | 30 |
| R | AI 语速（假设） | 4 字/秒 → AI 文本 **1,920 字**；用户转写 **1,440 字** |
| LLM | 级联文本模型 | 输入 ≈111,000 token/天，输出 1,920 token/天（同 C §3，`qwen3.5-flash` 0.2/2 元/百万 token） |

**计费音频秒数（级联 ASR）**

- 全程推流：**1,200 s/天**（与 C §3 主表一致）
- 仅送有声段：**360 s/天**（C §3 敏感项）

**日语 TTS 字符口径（重要）**

- 阿里百炼：日文汉字计 **2** 字符、假名/标点等计 **1** 字符（与中文汉字规则并列，见价格页「语音合成」章节）。
- 为与 C §3 **可比**，主表 TTS 仍采用 C 的保守口径：**1,920 字 × 2 = 3,840 计费字符**（等价于「中文场景下 1,920 汉字」）。若日语回复以假名为主、计费字符接近 **1,920**，阿里 TTS 费用约 **减半**（脚注在表中给出）。

**端到端输入音频秒数**：官方未明确静默是否计费，区间 **U×60 ~ N×60**（同 C §3）。

---

## 成本表：级联 vs qwen3.8 vs qwen3.5（华北2 北京，元/天 → 元/月）

| 方案 | 组件 / 模型 | 计算摘要 | 元/天 | 元/月 (×30) |
| --- | --- | --- | --- | --- |
| **级联·阿里（日语推荐栈）** | ASR `paraformer-realtime-v2` 0.00024 元/s；TTS `qwen3-tts-flash-realtime` 1 元/万字符；LLM `qwen3.5-flash` | ASR 1,200×0.00024=0.288；TTS 3,840 字符=0.384；LLM 111k×0.2/1e6+1,920×2/1e6≈0.026 | **≈0.70** | **≈21** |
| 同上（ASR 仅有声段） | 同上 | ASR 360×0.00024=0.086；其余同上 | **≈0.50** | **≈15** |
| 同上（TTS 假名为主） | 同上 | TTS 按 1,920 字符≈0.192；合计≈0.50（有声段 ASR）~0.61（全程 ASR） | **≈0.50–0.61** | **≈15–18** |
| **级联·阿里（备选 ASR）** | `qwen-audio-3.1-asr-flash-streaming` 入 6 / 出 4.5 元/百万 token + 同上 TTS/LLM | **音频→token 折算官方未在模型页给出** → 日成本 **未知**（见「未知项」） | — | — |
| **级联·火山** | ASR 豆包流式识别 2.0 **1 元/小时**；TTS 豆包合成 2.0 **3 元/万字符**（BV520 等，`seed-tts-2.0`）；LLM `doubao-seed-2.0-lite` | ASR 1/3 h=0.333；TTS 1,920 字符=0.576；LLM ≈0.074 | **≈0.98** | **≈29** |
| **端到端·qwen3.8-omni-flash-realtime** | 入音频 6 / 入文本 1.5 / 出音频 12 / 出文本 4.5 元/百万 token；**7 token/s 入音频，12.5 token/s 出音频** | 不含上下文 0.10–0.13；含上下文重复计费 **≈0.36**（同 C §3 推导） | **0.10–0.36** | **3–11** |
| **端到端·qwen3.5-omni-flash-realtime** | 入 3.3/27，出音频 107（文本输出不计）元/百万 token | 不含上下文 0.71–0.87；含上下文 **≈1.9** | **0.71–1.9** | **21–57** |

> **2026-10-19 价格复核**：上表涉及的阿里 C-6.2/C-6.3 单价与 2026-10-09 快照**一致**；火山 C-6.1 与 [计费说明](https://docs.volcengine.com/docs/6561/1359370)（页内更新 **2026-09-29**）**一致**。

---

## 级联侧的 Token / 用量节省杠杆

1. **ASR 只上传有声段（端侧 VAD）**：ASR 费从 1,200 s 降到 360 s，阿里栈约 **−0.20 元/天**（见上表）。
2. **缩短 LLM 上下文**：级联 LLM 输入 token 与「记忆注入 + 保留轮次」线性相关；摘要记忆、限制 `keepRecentTurns` 直接降 ASR 之后最贵的一环（多轮时 LLM 输入仍可达 10 万 token/天量级）。
3. **TTS 选型**：`qwen3-tts-flash` **0.8** 元/万字符（HTTP）较 realtime **1** 元/万字符低 20%，需接受非 WebSocket 路径；`cosyvoice-v3.5-flash` **0.8** 元/万字符，日语依赖**系统/复刻音色**（见下节），非任意音色。
4. **避免错误 ASR 模型**：`fun-asr-realtime` 与 `paraformer-realtime-v2` **同档秒价不同**，但 fun-asr 官方描述为**中英文**场景；日语应用 `paraformer-realtime-v2` 或 Qwen-Audio streaming，避免误选。
5. **端到端（qwen3.8）侧**：控制轮次、定期新会话、外挂摘要替代长窗口，对**上下文重复计费**最敏感（C §3 解读）；级联不受 Omni 音频上下文重复约束，但自建多轮文本历史仍费 LLM。

---

## 日语能力（官方）与推荐组合

### 阿里云百炼

| 环节 | 模型 | 日语 ASR/TTS | 刊例价（北京） |
| --- | --- | --- | --- |
| 流式 ASR | `fun-asr-realtime` | **不支持**（官方：中英文自由切换、多方言；[模型页](https://help.aliyun.com/zh/model-studio/fun-asr-realtime)） | 0.00033 元/s |
| 流式 ASR | `paraformer-realtime-v2` | **支持**（中/英/日/韩等；[模型页](https://help.aliyun.com/zh/model-studio/paraformer-realtime-v2)） | 0.00024 元/s |
| 流式 ASR | `qwen-audio-3.1-asr-flash-streaming` | **支持**（[语音识别概述](https://help.aliyun.com/zh/model-studio/asr-model) 语言表含日语） | 入 6 / 出 4.5 元/百万 token |
| 流式 ASR | `qwen-audio-3.0-asr-flash-streaming` | **支持**（同上） | 0.00033 元/s，输出不计费 |
| 流式 TTS | `qwen3-tts-flash-realtime` | **支持**（[语音合成概述](https://help.aliyun.com/zh/model-studio/tts-model) Qwen3-TTS 语言表含日语；音色表含日语，如 Ono Anna） | 1 元/万字符 |
| 流式 TTS | `cosyvoice-v3-flash` / v3.5 | **部分支持**（v3-flash 系统音色含日语；v3.5-plus/flash **无系统音色**，日语主要在复刻/设计音色路径，[语音合成概述](https://help.aliyun.com/zh/model-studio/tts-model)） | 1 / 0.8 元/万字符 |
| 端到端 | `qwen3.8-omni-flash-realtime` | **厂商自述** 113 种识别、36 种生成（[Realtime 文档](https://help.aliyun.com/zh/model-studio/realtime)）；无分语种准确率 | 见上表 |

### 火山引擎（豆包语音）

| 环节 | 产品 | 日语 | 刊例价（后付费） |
| --- | --- | --- | --- |
| 流式 ASR | **豆包流式语音识别模型 2.0** | **支持**：`audio.language=ja-JP`（[大模型流式 ASR API](https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI) / [6561/1354868](https://docs.volcengine.com/docs/6561/1354868)） | **1 元/小时** |
| 流式 ASR | **大模型流式语音识别**（旧线） | API 文档同样列出 `ja-JP` | **4.5 元/小时**（同计费页） |
| 流式 ASR | **流式语音识别**（经典） | 计费页按小时阶梯；**语种需以接入文档为准**（本文未找到与 2.0 等价的日语声明，标为未核实） | 3.5 元/小时起（阶梯） |
| 流式 TTS | **豆包语音合成模型 2.0** | **支持**：音色表 `BV520_streaming`（元气少女）等（[音色列表](https://docs.volcengine.com/docs/DoubaoVoice/Tonelist)）；`X-Api-Resource-Id: seed-tts-2.0`（[接入文档](https://docs.volcengine.com/docs/6561/1598757)） | **3 元/万字符** |
| 端到端 | Seeduplex / 豆包实时语音大模型 | **非日语产品路径**（仅中英等；见 [seeduplex-japanese-probe.md](./seeduplex-japanese-probe.md)） | 入音频 80 / 出音频 300 元/百万 token 等 |

### BV520 等「经典日语 TTS」与中文是否同价？

- **豆包语音合成模型 2.0**（`seed-tts-2.0`，含 BV520）：计费说明写「**1 个汉字算 1 个字符**」，英文字母、标点、空格等亦各算 1 字符；**未按语种分档** → 日语与中文在同一 **3 元/万字符** 后付费价（[6561/1359370](https://docs.volcengine.com/docs/6561/1359370)）。
- **另一条产品线「语音合成」**：按 **调用次数** 阶梯（如 5.5 元/千次），与字符版不同商品；BV520 在音色文档中归属**流式/大模型音色表**，接入指向 **seed-tts-2.0**，应以 **字符版** 为准，而非按次计费。
- **付费精品音库**：**1000 元/音色/月**（与语种无关的附加项；[同页「语音合成 · 付费精品音库」](https://docs.volcengine.com/docs/6561/1359370)）。BV520 在「免费音色」说明中未单独列为精品，**是否收费以控制台为准**。

---

## 与 C-6 快照的差异说明（2026-10-19 复核）

| 卡片 | 2026-10-09 记录 | 2026-10-19 状态 |
| --- | --- | --- |
| C-6.2 qwen3.8 / qwen3.5 Omni realtime 单价 | 1.5/6/4.5/12；3.3/27/20/107 | **无变化** |
| C-6.3 paraformer / fun-asr / cosyvoice / qwen3-tts | 0.00024；0.00033；TTS 0.8–1 元/万字符 | **无变化** |
| C-6.1 火山 ASR2.0 / TTS2.0 | 1 元/h；3 元/万字符 | **无变化**（页内更新 2026-09-29） |
| （未收录） | — | **`qwen-audio-3.1-asr-flash-streaming`** 改为 **token 计费**（6 / 4.5 元/百万 token），与 3.0 的「按秒」不同 |

---

## 未知项 / 未核实

| 项 | 原因 |
| --- | --- |
| `qwen-audio-3.1-asr-flash-streaming` 级联日成本 | 官方模型页有单价，**未给出音频秒→token 折算**；无法在不实测账单的情况下代入 C §3 |
| 端到端静默段是否计音频 token | 阿里 Omni 文档有 VAD，**未明确静默输入是否计费**（C §3 已标注） |
| 火山「流式语音识别」经典线日语 | 仅有计费；**未核对**与 2.0 相同的 `ja-JP` 声明 |
| 讯飞 / 腾讯日语流式组合 | 非本次 primary 深查范围；C-6.8 讯飞价仍 **未能打开** |

---

## 来源（Primary）

| # | 标题 | URL | 页面更新/访问 |
| --- | --- | --- | --- |
| 1 | 模型调用价格（百炼） | https://help.aliyun.com/zh/model-studio/model-pricing | 访问 2026-10-19 |
| 2 | Qwen-Omni-Realtime | https://help.aliyun.com/zh/model-studio/realtime | 访问 2026-10-19 |
| 3 | fun-asr-realtime 模型信息 | https://help.aliyun.com/zh/model-studio/fun-asr-realtime | 访问 2026-10-19 |
| 4 | paraformer-realtime-v2 模型信息 | https://help.aliyun.com/zh/model-studio/paraformer-realtime-v2 | 访问 2026-10-19 |
| 5 | qwen-audio-3.1-asr-flash-streaming 模型信息 | https://help.aliyun.com/zh/model-studio/qwen-audio-3-1-asr-flash-streaming | 访问 2026-10-19 |
| 6 | 语音识别概述 | https://help.aliyun.com/zh/model-studio/asr-model | 访问 2026-10-19 |
| 7 | 语音合成概述 | https://help.aliyun.com/zh/model-studio/tts-model | 访问 2026-10-19 |
| 8 | qwen3-tts-flash-realtime 模型信息 | https://help.aliyun.com/zh/model-studio/qwen3-tts-flash-realtime | 访问 2026-10-19 |
| 9 | Qwen-TTS 音色列表 | https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list | 访问 2026-10-19 |
| 10 | 豆包语音计费说明 | https://docs.volcengine.com/docs/6561/1359370 | 更新 2026-09-29；访问 2026-10-19 |
| 11 | 大模型流式语音识别 API | https://docs.volcengine.com/docs/DoubaoVoice/LargemodelstreamingautomaticspeechrecognitionAPI | 访问 2026-10-19 |
| 12 | 双向流式 ASR（6561/1354868） | https://docs.volcengine.com/docs/6561/1354868 | 访问 2026-10-19 |
| 13 | 音色列表（BV520 等） | https://docs.volcengine.com/docs/DoubaoVoice/Tonelist | 更新 2026-05-19；访问 2026-10-19 |
| 14 | 豆包语音合成 2.0 接入（Resource-Id） | https://docs.volcengine.com/docs/6561/1598757 | 访问 2026-10-19 |
| 15 | 证据包 C §3 / C-6（2026-10-09 快照） | [C-technical.md](../elderly-avatar-companion/evidence/C-technical.md) | 对照用 |
