# 情感共鸣与主动性设计（Plan 4）

## 状态

已批准（2026-10-23；2026-10-22 起草，独立审查两轮后通过）。客户原话例子拿不到，评估集只用合成场景；实施分期按本文不变。本文只记录设计，不含实现。决策来源：2026-10-22 grilling 四轮逐项确认（下文「已确认决策」），能力边界来自同日探针（`docs/research/emotion-proactivity-probes-2026-10-22.md`，blockers #47/#48）。实施见 Plan 4（2026-10-23 完成 T0–T7；评估后修正已实施，T6 新增句已于 2026-10-24 回退（`4843882`），共情复评恢复 +0.48，但门槛仍未通过（差 0.52）；plan-a 门槛已于 2026-10-24 修订为排除开场轮（含必须的称呼问句），阈值不变，复评进行中；此前三次回退后运行按旧口径中位数 0.3721 未通过）。

本文改动高风险区（开场、四段沉默规划器、人设、记忆注入）。用户已在 grilling 中授权，前提是保留 roadmap「打断与沉默」「记忆与回忆」两节的全部坑位契约，只按第 5 节修订第 4 条。

## 背景与目标

客户试用反馈：小暖缺少情感共鸣，对话生硬；虽然不是一问一答，仍然缺少主动性。

现状（2026-10-22 核对代码）：

- 唯一的情绪模块是 `gateway/src/session/emotion.ts` 的 `EmotionTagger`：词表匹配（zh 约 40 词），四类 `neutral/happy/sad/love`，只驱动 `avatar.emotion`，不回流对话；默认 happy，6 秒回落。
- 对话共情只靠人设一句「先接住情绪，再说事情」。系统不知道用户此刻的情绪和跨轮走向。
- 若干「去机械感」规则同时压掉了共情信号：不先加应答词、不复述对方的话、三句最多一句问句、eval 门槛问句比 ≤1/3、平均回复 ≤45 字。
- 主动性只有开场与四段沉默。有称呼时开场是固定安全模板；主动接话只用非敏感事实；健康/情绪事实标 `sensitive` 后一律不进提示词，所以「上次您说腰疼，好点没」做不到。
- 被动回复由上游自动发起（Qwen `semantic_vad`；Seeduplex 全双工），网关无法在回复前插入分析。

目标（按优先级）：

1. 用户讲到情绪时，回应能接住、点出感受，而不是套话或立刻转话题。
2. 主动开口随情绪调整：低落时陪着，状态好时主动起话头；对话中话题聊干时主动换话头。
3. 跨会话关怀回访：开场能轻轻问起上次用户亲口说过、尚未了结的事。
4. 头像表情跟随用户情绪，低落时不再自动回到微笑。

不在范围：

- 语音情绪/语气控制（P2/P3 实测不可分辨，见探针）。
- ASR 情绪标签接入（P1 不可靠，#47；补人声样本后再评估）。
- App 未打开时的推送；协议与 `avatar.emotion` 枚举变更；`app/`、`avatar-core/` 改动。
- ja/en 效果调优与验收（只补齐 parity）。
- 自动重建「下一轮无响应」的上游会话（只观测）。

## 已确认决策

| # | 决策 | 选择 |
|---|---|---|
| 1 | 痛点 | 主：(a) 情绪被套话接住/转话题，(b) 主动只在沉默时且泛泛，(c) 不回访上次的事；次：表情、过短 |
| 2 | 适配器 | 设计不绑定适配器；先在 Qwen 上调优验收；Seeduplex 主动开口走「规划器定稿 + 直接 TTS」 |
| 3 | 立项 | 单独 Plan 4，优先于 M3，M3 暂停 |
| 4 | 人设放宽 | 允许情绪性开头（哎呀/哟/真的呀），仍禁「好/好的/嗯」应答词开头；允许点出感受，仍禁逐字复述；问句比门槛数值不变（2026-10-24 口径修订：plan-a 问句比排除开场轮，见验收节）；情绪浓的轮次可到 3 句约 60 字 |
| 5 | 跨会话关怀 | 方案 B：只用最近已结束会话里的用户原话，开场问一次，原话锁证据，否认/婉拒即关闭 |
| 6 | 高风险区 | 授权改动，坑位契约保留，改后全量测试 + typecheck + 真实库召回探针 |
| 7 | 验收 | 合成场景 + 文本模型评委量表（前后对比）+ 真机复试；现有 eval 门槛和记忆回归为硬门槛 |
| 8 | 情绪数据 | 日志只记计数/耗时/错误码；状态卡只在会话内存；未了之事只进记忆库、`sensitive`、可删除 |
| 9 | 信号来源 | 方案 B：文本模型分析器为主；词表保留为失败兜底和头像即时反应（P1 后由 C 退回 B） |
| 10 | 生效时机 | 不改判轮；情绪晚一轮生效，作用于下一轮指令、全部主动开口、头像 |
| 11 | 输出 | 会话内「此刻」状态卡，渲染为 ≤约 150 字指令段，「不说出情绪名称，而是表现出来」 |
| 12 | 主动范围 | (i) 开场关怀 (ii) 话题聊干换话头 (iii) 四段沉默随情绪 (iv) 时段/节气；不做推送 |
| 13 | 语音情绪 | 探针不可分辨 → 本期不做 |
| 14 | 头像 | 不改协议；驱动源换状态卡；低落时不自动回落微笑 |
| 15 | 危机 | 状态卡 `crisis` → 下一轮指令置顶安全提醒、规划器不起新话题、日志一次计数；不做固定话术接管（#16） |
| 16 | 多语言 | 只调中文，ja/en 补齐 parity |
| 17 | 分析器调用 | 共享文本模型（默认 `qwen-plus`），每条非轻回应终稿一次，超时 2.5s、不重试、最新结果优先、失败可忽略 |
| 18 | 话题聊干 | 分析器判定或连续 2 句轻回应/≤4 字短答；引导一次；冷却 4 轮；婉拒冷却 10 轮；低落不触发。实现上第 1 句短答后就提前推送条件引导，让第 2 句短答的被动回复当场生效（第 4 节，spec 审查后细化） |
| 19 | 未了之事 | 会话结束抽取写入，证据只认用户陈述原话，`sensitive`，7 天过期且来源会话已结束，问过一次即关闭，开场最多 1 条。存储上扩展现有 `followups` 表而不是新增 `open_loop`（第 5 节偏离说明） |
| 20 | 开场关怀 | 「只问候」安全模板 + 文本模型根据原话写一句关怀，沿用召回包装的校验，≤40 字、1.5s 超时，不合格退回普通安全问候 |
| 21 | #48 | 作为 Task 0：统一推送闸门，修复现有两条播报中推送路径 |
| 22 | 推送闸门 | 一切 session 变更走缝隙；合并最新一份；间隔 ≥1s、每轮最多一次；两适配器统一 |
| 23 | 无响应 | 只观测 `no_response_after_final`，不自动重建 |

## 探针结论（摘要）

完整数据见研究文档。

- P1 Qwen 转写 `emotion`：字段存在于 `input_audio_transcription.delta/.completed`，但合成样本 sad 0/5、happy 2/4，且句内翻转 → 不接入。
- P2/P3 语音风格：Qwen、Seeduplex 被动回复与 `speech_text_buffer.commit` 直接 TTS 均盲听不可分辨 → 不做。
- P4 Seeduplex 播报中 `session.update`：当前回复可继续，但下一轮不再响应（3/3，无 error）；上一轮 done 后发送安全；间隔 1s 连发无乱序。Qwen 播报中更新安全。

## 架构

```text
user final ──► Session.onUserFinal ──► Director.onUserFinal（不变）
                    │                └► EmotionTagger.onUserFinal（词表即时表情，保留）
                    └► AffectTracker.onUserFinal（非轻回应）
                           │ 共享 TextModelClient（2.5s，最新优先）
                           ▼
                     AffectCard（会话内存，zod 校验）
          ┌────────────────┼──────────────────────┬──────────────────┐
          ▼                ▼                      ▼                  ▼
  renderAffect(lang)   Director 规划输入      EmotionTagger.hold   日志：计数/耗时/错误码
  （确定性模板）       （affect/time/openLoop）  （头像不回落）
          │
          ▼
  InstructionGate ──（缝隙打开时）──► adapter.updateInstructions / updateVoice

session start ──► store.careFollowup ──► CareLine（文本模型 + grounded 校验）
                                           └► greetingCareTexts + 关怀句 → 开场
```

新增模块都在 session 层，按现有分层：server → (session, identity) → (adapter, memory, roles)。共享资源（文本模型客户端、store）注入，不加模块级可变状态。

### 0. 统一推送闸门与无响应观测（Task 0）

现有两条可能在 Seeduplex 播报中发 `session.update` 的路径（#48）：

- `session.ts` `applyLanguage` 直接 `adapter.updateVoice(...)`；Seeduplex `updateVoice` 会重发完整 payload。语言在用户终稿后判定，此时上游多半已在生成回复。
- `maybeSummarize` 成功后直接 `pushInstructions()`，没有缝隙守卫。

只有 `maybePushLanguage` 有 `slimSeamOpen()` 守卫。

设计：Session 内新增 `InstructionGate`（`gateway/src/session/pushGate.ts`，纯逻辑、可注入时钟）。

- Session 不再直接调用 `adapter.updateInstructions` / `adapter.updateVoice`，改为 `gate.request({ instructions?: true, voice?: string | undefined })`。
- 发送条件：`slimSeamOpen()`（无工具轮、用户没在说话、无活跃回复、无打断）且 `!modelGenerating`，且距上次发送 ≥ `minIntervalMs`，且本轮（两次用户终稿之间）尚未发送。
- 不满足时只记「待推送」并合并：指令总是在发送时现取 `this.instructions()`；音色取最新值。
- 缝隙打开的时机都调用 `gate.flush()`：回复正常结束、打断结束、工具轮结束、用户说话结束而未形成回复、间隔计时到期，以及主动请求发出之前（替代 `requestResponse` 里现有的 `maybePushLanguage()` 调用，`session.ts:651`）。现有 `maybePushLanguage` 并入闸门。
- 适配器重建连接成功后清空待推送：`connect` 已经带上最新的指令和音色。
- 适配器层新增可选方法 `updateSession({ instructions, voice })`：Seeduplex 合成一次完整 `session.update`；Qwen 发送一次部分 `session.update`。不提供时退回分别调用两个现有方法。`RealtimeAdapter` 只增不改，Mock 实现同步更新。
- 首次连接的 `session.create` / 首个 `session.update` 不经过闸门（尚无回复）。
- 代价（已接受）：换语言后的第一句可能仍是旧音色；状态卡可能晚两轮生效。

无响应观测：

- 非轻回应的用户终稿之后启动计时 `noResponseAfterMs`（默认 5000）。期间出现 `response.start`、用户再次开口或会话结束则取消。
- 不计时的情况：终稿到达时已有活跃回复（`responseLive` 或 `modelGenerating`），或者从本句开口（最近一次 speaking 边沿）到终稿之间已经出现过 `response.start`。Qwen 的转写终稿可能晚于 `response.created`，不加这条会误报。
- 到期记 `log('no_response_after_final', { adapter, sinceFinalMs })`，不含内容。不重建、不补话；沉默链照常兜底。

配置：`gateway/config/pacing.json` 新增 `push: { minIntervalMs: 1000, noResponseAfterMs: 5000 }`，zod 校验。

### 1. 情感分析器 `AffectTracker`

位置：`gateway/src/session/affect.ts`。每个 Session 一个实例，状态只在内存。

调用：

- 触发：`onUserFinal` 中、`dropUserFinals` 之后。轻回应（Director 的 `lightPhrases` 整句判定）不调用，只更新「话题聊干」计数（第 4 节）。
- 输入（JSON，作为引用数据，指令不可执行）：当前语言、本句用户终稿、最近 `historyEntries`（默认 6）条 ledger 记录（用户/助手分别标注）、上一张卡的枚举字段。总长 ≤ `maxInputChars`，超出时从最旧的记录开始裁剪。
- 提示词：`gateway/roles/_shared/<lang>/affect.md`。
- 模型：注入的共享 `TextModelClient`。`affect.json` 可选 `model` 字段仅作记录用途，本期复用已有客户端，不新建端点。
- 策略：`runWithPolicy('affect', policy)`，`timeoutMs 2500`、`retries 0`；错误一律归为可忽略。
- 最新优先：每次调用分配递增序号并 abort 上一个未完成的调用；返回时序号不是最新的就丢弃。`runWithPolicy` 不接受外部 signal，在 task 内用 `AbortSignal.any([own, timeoutSignal])` 合并，写法同 `silence.ts`。
- 无文本模型客户端时（Mock/未配置），整个分析器关闭，行为退回现状（只有词表表情）。

输出（`AffectCardSchema`，`.strict()`）：

| 字段 | 取值 | 用途 |
|---|---|---|
| `emotion` | `neutral` / `happy` / `sad` / `love` | 头像、渲染 |
| `intensity` | 1–3 | 低落判定、渲染 |
| `trend` | `better` / `worse` / `flat` | 渲染、规划 |
| `need` | `vent` / `share_joy` / `help` / `chat` / `topic_exhausted` | 渲染、话题聊干（`topic_exhausted` 指话题聊干，不是用户累了；affect.md 里写明区别） |
| `strategy` | `comfort` / `reflect` / `affirm` / `ask` / `disclose` / `suggest` | 渲染 |
| `mismatch` | boolean | 渲染：字面轻描淡写但上下文显示难受 |
| `crisis` | boolean | 第 7 节 |
| `openLoop` | 可选，≤60 字 | 本会话内的未了之事，只进规划器 |

校验：

- AffectTracker 自己保留本会话的用户终稿（只在内存，最多 `sessionLinesMax` 条，默认 200，超出丢最旧的），因为 ledger 摘要后 `recent` 会丢掉旧句子。
- `openLoop` 必须是这些用户原话中某一条的子串（按 `sameUtterance` 同样的规范化方式比较），还要通过 `isMemoryEvidence` 和 `scanText`，否则丢弃该字段（不是丢弃整张卡）。
- 解析失败或 schema 不符时整张卡丢弃，记 `affect { outcome: 'failed', code: 'invalid' }`。

低落判定（`isLow`）：`crisis`，或 `emotion === 'sad'` 且（`intensity >= lowIntensity`（默认 2，进配置）或 `trend === 'worse'`）。`trend` 只在 `sad` 时参与判定，避免「开心但走向变差」时头像和渲染打架。

日志：每次调用只记一种事件 `affect { outcome: ok|failed|stale|skipped, ms, code? }`；会话级另有 `affect_crisis {}`（每会话最多一次，第 7 节）和会话结束的 `affect_summary { calls, failures, byEmotion: {…计数}, crisis: 0|1, exhaustedArmed: n, exhaustedRevoked: n }`。不记逐句标签。`TextModelClient` 目前不返回 usage，本期不记 token。

### 2. 状态卡渲染与注入

渲染（`renderAffect(card, lang, flags)`）是确定性的：只把枚举映射成 `gateway/config/i18n/<lang>/affect.json` 里的固定短句，模型输出的自由文本不会进入实时模型指令。拼接顺序：

1. `crisis` 句（如有，置顶）；
2. 主句：按优先级 `crisis` > 低落（`isLow`）> `emotion` 取一档：低落 / `sad` 有点难过（不算低落的轻度难过，2026-10-23 计划审查补充）/ `happy` 开心 / `love` 温暖亲近 / `neutral` 平稳；`trend` 为 `better`/`worse` 时追加半句走向。例如「对方此刻情绪低落，比刚才更难受。」；
3. 需求句：`vent` →「对方想倾诉，先陪着听，少提问。」；
4. 策略句：`reflect` →「用一句话点出对方的感受，不要直接说出情绪名称，也不要逐字复述。」；
5. `mismatch` 句；
6. 话题聊干的条件引导句（第 4 节，`exhaustedArmed` 时出现）；
7. 固定尾句：「以上是内部参考，不要说出来，用语气和内容表现。」

注入：

- `buildInstructions` 新增可选 `affect` 部分，标题取 `PROMPT_LABELS[lang].affectHeader`（zh：「## 此刻（内部参考）」），位置在人设之后、记忆之前。
- 预算：`gateway/config/memory.json` 的 `instructions` 新增 `affectMaxChars`（默认 150）和可选的 `languageAffectMaxChars`（按语言覆盖，写法参照 `languageBudgetRatio`）。`validateBudgets` 把它带进 `InstructionBudget`。
- `historyBudget()` 必须按 `affectMaxChars` 预留 affect 段（与快照上限同样按最大值预留）。Session 构造与 `applyLanguage` 用它设置 `summarizeAfterTokens`，`validateBudgets` 用它校验 `summary + minHistory`。这样 affect 段不会在摘要触发之前挤掉未摘要的轮次。
- 启动校验：对每种语言渲染最长组合，必须 ≤ 该语言的 `affectMaxChars`；预留后的历史预算仍要满足现有的 `summaryMaxChars + minHistoryChars` 检查。超限按现有规则让启动失败。
- 预算方案（2026-10-23 用户批准 A）：只调高各语言的 `languageBudgetRatio`（zh 0.43 / ja 0.5 / en 0.8），`summaryMaxChars`、`minHistoryChars` 不变；`languageAffectMaxChars` 为 ja 210、en 250，英文文案压缩。数值与核算见 Plan 4 总览。
- `buildInstructions` 的超预算裁剪顺序：先丢最旧的 recent，再裁摘要，再裁快照，affect 段不裁（它已经被预留）。
- 推送：渲染文本与上次已推送的不同时，才调用 `gate.request({ instructions: true })`。

规划器输入：`SilenceContext` 新增

- `affect?: { emotion, intensity, trend, need, low: boolean, crisis: boolean }`；
- `openLoop?: string`（本会话内的用户原话）；
- `timeOfDay`：`morning` / `noon` / `afternoon` / `evening` / `night`；`season`：季节名；`solarTerm?`：当天前后 `solarTermWindowDays` 天内的节气名。

`silence.ts` 计算 `usedChars` 时要把新增字段（`affect`、`openLoop`、时间字段）都算进去，`maxInputChars` 的裁剪仍然只裁记忆快照。

时间取自 `gateway/config/affect.json` 的 `timeZone`（默认 `Asia/Shanghai`），节气用 i18n 配置里的近似日期表（每年误差约 ±1 天，规划器提示词里写明「约」）。协议是冻结契约，本期不从客户端取时区。

规划器提示词（zh `director.json` `silenceDecision.instruction`）新增规则，保留其余 11 条不变：

- `affect.low` 为真：context/check 不起新话题，只陪着、接住；leave 不留新话头。
- `affect.crisis` 为真：任何阶段都不起新话题，只表达在、劝联系家人。
- `need` 为 `share_joy` 或 `chat` 且不低落：可以主动起一个相关的小话题。
- `openLoop` 只在 context/check 阶段可用，用法同 userText；只能用其中已有的事实。
- 时间字段只用于寒暄措辞，不得编造天气。

现有的 checkin 内容校验、previousTexts 去重、作品名/人名禁令全部保留。

### 3. 人设放宽

改 `roles/elder-companion/zh/styles/grandchild.md` 与 `old-friend.md` 的「陪伴的方式」「说话方式」两节，ja/en 同步翻译：

- 「回应时直接说内容，不先加应答词」改为：可以用一句感叹先接住情绪（哎呀、哟、真的呀），但不要用「好」「好的」「嗯」「行」开头。人设原文里只在肯定句举感叹词的例子，否定句不列具体应答词（坑位：否定句里的词也会被照读），见 Plan 4 T6。
- 「也不先复述对方的话」改为：不逐字复述，可以用自己的话点出对方的感受。
- 新增：情绪浓的时候可以说到 3 句，约 60 字；平常仍 1 到 3 句、口语短句。
- 「三句话里最多一句是问句」保留。

不改动：安全底线、记忆与接话、反依赖条款。eval 门槛 `maxQuestionRatio` 与 `maxAvgReplyChars`（45）数值保持不变，作为防回退硬门槛。2026-10-24 口径修订：plan-a 的问句比只统计开场之后的回复；固定开场轮（含没有称呼时按产品要求问「怎么称呼」）不计入问句比的分子和分母，`maxAvgReplyChars` 仍统计全部回复。

### 4. 话题聊干

`AffectTracker` 维护：

- `shortStreak`：连续轻回应或规范化后 ≤ `shortMaxChars`（默认 4）的用户终稿数。
- `cooldown`：剩余冷却轮数，每条用户终稿减一；冷却 N 表示随后 N 条终稿都不预备。

时序问题：被动回复是上游收到用户话就自动生成的，而指令只能在缝隙推送。如果等到第 2 句短答才推引导，它最早作用于第 3 句话之后的回复。同时，用户回轻回应时 Director 走 `waitQuietly()`，沉默链不开口，这条行为属于沉默契约，本期不改。

所以采用「提前推条件引导」：

- 预备：`shortStreak` 达到 `shortStreakTrigger - 1`（默认 1），或 `card.need === 'topic_exhausted'`，且 `cooldown === 0`、`!isLow(card)` 时，置 `exhaustedArmed`。渲染带上条件引导句：「如果对方接下来还是只简短回应，就在回应里换个轻松的话头，或者说说你自己（AI 的生活）、表达一点好奇。只换一次，不要连着问。」这句随下一次缝隙推送。
- 生效：用户再回一句短答时，实时模型的被动回复已经带着这句引导，可以当场换话头，不需要多等一轮。
- 撤销：用户下一句是实质内容（非轻回应、超过 `shortMaxChars`）时，清除 `exhaustedArmed`，下次渲染去掉引导句。
- 冷却：`shortStreak` 达到 `shortStreakTrigger`（即引导已经用上）后，清除 `exhaustedArmed`，`cooldown = cooldownTurns(4)`。
- 不改 Director 的轻回应处理，也不让沉默链因此开口。

婉拒：用户终稿命中 `i18n/<lang>/affect.json` 的 `declinePhrases`（如「不想聊这个」「算了」「别问了」，按 `containsPhrase` 匹配）时，`cooldown = declineCooldownTurns(10)`，并清除 `exhaustedArmed`。

2026-10-23 评估后修正：`exhaustedArmed` 且不低落、非危机时，渲染只保留强提示句和尾注（不再带卡片的 mood/need/strategy），提示要求这一句必须说一点 AI 自己的小事，不要只应答，也不要问对方；规划器返回与 `previousTexts` 重复的句子时回退该阶段配置文案；规划器规则 13/15 收紧为 context 只接细节、check 最多一个相关问题、leave/checkin 不起新话题，时间/节气不得当话题。

### 5. 跨会话关怀回访

存储：复用现有 `followups` 表（`id, owner_id, text, due_at, done_at, source_session_id`）。这张表已被抽取写入，也已接入 forget/全删/审计链路。目前只有抽取器自己在上下文里读它（`worker.ts` 的 `renderInput`），对话、快照、规划器都不读；`text` 是模型写的概括。

> 偏离说明：grilling 时说的是「新增 `open_loop` 操作」。实现上改为扩展 `followups`：概念一致，删除/审计链路现成可用，避免两张语义重叠的表。需在批准 spec 时一并确认。

迁移（`memory/migrations.ts` 新版本）：`followups` 增加 `quote TEXT`、`sensitive INTEGER NOT NULL DEFAULT 0`、`created_at INTEGER`。旧数据这三列为空或默认值，永远不会被用于关怀（缺少原话证据）。

抽取（`roles/_shared/<lang>/extract.md` 与 `extract.ts`）：

- `followups.add` 新增可选字段 `quote`（必须逐字复制本批中的一条用户原话，内容是尚未了结的事：身体不适、要去做的事、担心的事）和 `sensitive`（健康相关必须为 true）。
- 已在本批内了结的事不加（例如先说「明天复查」，后来又说「复查完了没事」）。
- 写入前校验（`worker`/`applyExtractOps` 路径）：`quote` 规范化后必须是本批某条 `role='user'` 消息的子串，并通过 `isMemoryEvidence`、`scanText` 校验，长度 ≤ `quoteMaxChars`（80）。不通过就去掉 `quote`，记录照常写入，但不会用于关怀。`created_at` 取写入时间。
- 写入仍受记忆告知与拒绝规则约束：用户拒绝记忆时，本来就没有可抽取的消息。
- 抽取器的上下文（`renderInput`）继续只给 followups 的 `id/text/dueAt`，不给 `quote`；`followups.update` 不能修改 `quote` 和 `sensitive`（schema 不含这两个字段，带上时被剥离，整批抽取不作废）。原话只在 add 时写入一次。

选取：`store.careFollowup(ownerId, currentSessionId, now, maxAgeMs)`：`done_at IS NULL AND quote IS NOT NULL AND created_at >= now - maxAgeMs`，且来源会话已结束（关联 `sessions.ended_at IS NOT NULL`）、不是当前会话，按 `created_at DESC` 取 1 条。`maxAgeMs` 默认 7 天。

关怀句生成（`gateway/src/session/care.ts`）：

- 时机：现有流程是 `Session.start()` 在 `adapter.connect` 成功后立即调用 `director.onSessionStart()`，开场同步发出，没有任何开场计时。本设计由 Session 有界地推迟开场：`start()` 一开始就与 `adapter.connect` 并行启动关怀句生成；connect 成功后，如果关怀句还没出结果，最多再等到生成的 `timeoutMs`（1500，从启动生成时算起），然后才调用 `director.onSessionStart()`。没有可回访的 followup 时不等待，开场时序与现状完全一致。Director 不改，`safeGreeting()` 仍然是同步的，只是返回值可能是带关怀的开场。
- 前提：能拿到称呼（`safeGreeting()` 的条件）；拿不到称呼时跳过关怀（保守）。
- 输入：`{ userLine: quote, daysAgo }`，提示词 `roles/_shared/<lang>/care.md`。规则：问「怎么样了 / 好点没」这类开放式关心；只能使用原话里已有的事实；不预设结果；不说「我记得您说过」之外的引用框架；一句，≤ `careMaxChars`（40）。
- 校验：沿用召回包装的 `grounded()`（不能新增 `《》「」『』“”` 引号内的名字、必须保留原话中的内容 bigram、不能等于原话），加 `scanText` 和长度上限。为了复用，把 `recall.ts` 中的 `grounded` / `sameUtterance` / `parsePhrase` 原样移到 `gateway/src/memory/grounding.ts`，`recall.ts` 改为导入，行为不变，由现有召回测试保护。
- 开场文本：`greetingCareTexts`（`director.json`，按语言配置，例如 `"{name}，又见面啦。"`）随机取一条，渲染称呼后拼上关怀句。拼好的文本走与现有安全开场完全相同的路径：`safeGreeting()` 返回它，Director 以 `instruction = fallbackText = 文本` 发出（Seeduplex 直接 TTS；Qwen 与现有安全开场一样直接发送该文本，不套 `speakInstruction`）。生成失败或超时就用原来的 `greetingNameTexts`，行为与现状一致。
- 生成结果带上生成时的语言；如果开场时会话语言（例如 `setInitialLanguage` 之后）与它不一致，丢弃关怀句，退回普通安全问候，followup 不关闭。
- 等待窗口内用户先开口时，沿用现有行为：`requestGreeting` 被 `blocked()` 挡住，用户说完后由 `armOpening` 重试。不会重复开场，也不会丢掉开场。
- 拼好的开场文本在本会话内缓存。开场被噪声打断后，`armOpening` 800ms 后的重试会重说同一句（关怀句不重新生成，也不退回普通问候）。
- 关闭：带关怀的开场第一次 `response.start` 时，把该条 followup 标为 `done_at = now`，同时把 `quote` 置空（数据最小化），写审计（审计 diff 不写原话）。之后不管用户怎么回应都不再提起；用户否认时按人设规则认下，不争辩。

契约修订（实施时同步到 roadmap「记忆与回忆：已踩过的坑」第 4 条）：

> 开场关怀是唯一例外：可以使用一条最近 7 天内、来自已结束会话、通过证据校验的用户原话（可以是敏感内容）。原话本身只作为关怀句生成器的输入，不进入实时模型指令、快照或规划器。由它生成并通过校验的关怀句是助手自己的话：它作为开场发给实时模型（Qwen 的 item 模式下会成为一条消息），播出后作为助手文本进入 ledger，并随最近对话进入后续指令。这是允许的。

### 6. 头像表情

`EmotionTagger` 新增 `onAffect(card)`：

- 有卡时以卡的 `emotion` 为准（`crisis` 时用 `neutral`）。`onAffect` 绕过 1500ms 去抖：卡比词表晚到 1–2 秒，又更可靠，不能因为词表刚切过表情就被吞掉。
- 低落（`isLow`）时进入 `hold`：取消回落计时，并且忽略词表给出的 `happy`（`sad`/`love` 仍可生效），直到新卡不再低落才恢复正常回落。
- 词表在用户终稿和回复首句上的即时反应保留，分析器失败时就是现状行为。

协议、`avatar-core`、`app` 都不改。

### 7. 危机信号

`card.crisis === true` 时：

- 下一轮渲染把 `crisis` 句放在最前（i18n 配置，例如「对方可能有危险念头或身体急症：先认真接住，按安全底线劝联系家人、身边的人或拨打急救电话，不要转移话题。」）；
- 规划器收到 `affect.crisis`，不起新话题；话题聊干引导被抑制；
- 头像保持 `neutral`；
- 每个会话第一次出现时记 `affect_crisis {}`，计入 `affect_summary.crisis`。

人设里的安全底线仍是主防线；分析器可能漏判。本期不做固定话术接管（热线号码 #16 未核实）。

### 8. 隐私与日志

- 状态卡、`shortStreak`、`openLoop` 只在 Session 内存，会话结束即丢弃。
- 日志只记第 1 节列出的计数、耗时、错误码，不记逐句标签和任何文本。
- 关怀用的原话存在 `followups.quote`，标 `sensitive`。删除链路要扩展：`deleteFollowupsInstr` 改为 `instr(text, ?) > 0 OR instr(COALESCE(quote, ''), ?) > 0`，让用户说「忘掉腰疼的事」时，即使概括里没有这个词也能删掉。审计 diff 从不写原话，所以 `blankDiffs` 不需要覆盖 quote。全删（`deleteAllFollowups`）本来就会删除。问过之后 quote 立即置空（第 5 节）。从没被问过、已超过 `care.maxAgeDays` 的 quote 由每日保留任务置空（followup 本身保留；2026-10-23 计划审查补充）。
- 分析器和关怀句发给文本模型的内容，与现有召回包装、规划器同属一个供应商通道，不新增第三方。

### 9. 多语言

新增内容都按语言提供：

- `roles/_shared/{zh,ja,en}/affect.md`、`care.md`；
- `config/i18n/{zh,ja,en}/affect.json`（渲染短句、`declinePhrases`、节气表）；
- `director.json` 的 `greetingCareTexts` 和规划器新规则；
- `PROMPT_LABELS.affectHeader`。

启动时的 parity 校验扩展到这些文件。ja/en 只做翻译、能过校验，不做效果验收。

## 配置

新文件 `gateway/config/affect.json`（zod `.strict()`，与其他配置交叉校验）：

```json
{
  "enabled": true,
  "historyEntries": 6,
  "sessionLinesMax": 200,
  "maxInputChars": 1500,
  "maxTokens": 160,
  "temperature": 0,
  "policy": { "timeoutMs": 2500, "retries": 0, "backoffMs": 0, "maxBackoffMs": 0 },
  "lowIntensity": 2,
  "exhausted": { "shortMaxChars": 4, "shortStreakTrigger": 2, "cooldownTurns": 4, "declineCooldownTurns": 10 },
  "care": { "maxAgeDays": 7, "timeoutMs": 1500, "maxChars": 40, "quoteMaxChars": 80 },
  "timeZone": "Asia/Shanghai",
  "solarTermWindowDays": 3
}
```

`pacing.json` 新增 `push`（第 0 节）；`memory.json` 的 `instructions` 新增 `affectMaxChars` / `languageAffectMaxChars`（第 2 节）。所有数值都只在配置里出现。

## 失败处理与降级

| 情况 | 行为 |
|---|---|
| 无文本模型客户端 / `enabled=false` | 分析器、关怀句关闭；行为同现状 |
| 分析器超时、出错、JSON 不合法 | 沿用上一张卡；头像退回词表；记 `affect { outcome: 'failed', code }` |
| 分析结果过期（已有更新的终稿） | 丢弃，记 `stale` |
| 缝隙一直不开 | 待推送保留并合并；下次缝隙发送 |
| 关怀句失败/超时/校验不过 | 普通安全问候；followup 不关闭，下次会话可再试（仍受 7 天过期约束） |
| `openLoop` 不是用户原话子串 | 丢弃该字段 |
| 终稿后 5s 无回复 | 记 `no_response_after_final`；沉默链兜底 |
| 迁移失败 | 按现有迁移规则让启动失败，不带病运行 |

## 测试与验收

单元测试（每个任务先写失败测试）：

- `pushGate`：缝隙关闭时不发；合并；最小间隔；每轮一次；`flush` 时机；`applyLanguage` 与摘要不再直接调用适配器（Seeduplex fake 断言播报中零 `session.update`）。
- `no_response_after_final`：计时、取消、轻回应不计时。
- `AffectTracker`：轻回应跳过；最新优先 / abort；schema 拒绝；`openLoop` 子串校验；失败沿用旧卡；无客户端时关闭。
- `renderAffect`：各语言最长组合 ≤ `affectMaxChars`；不包含模型自由文本；`crisis` 置顶。
- `buildInstructions`：`affect` 位置与预算裁剪顺序。
- 话题聊干：第 1 句短答后预备并推送条件引导、实质内容撤销、第 2 句短答后冷却、婉拒、低落抑制；Director 的轻回应处理不变。
- 无响应观测：终稿时已有活跃回复、或本句开口后已出现 `response.start`，都不计时。
- 闸门：主动请求前 flush；重建连接后清空待推送。
- 规划器：输入新增字段，`low`/`crisis` 规则存在于提示词；现有 checkin 校验不回退。
- 迁移与抽取：新列；`quote` 校验（非原话、提问句、质疑句、超长都去掉 quote）；`careFollowup` 选取（过期、当前会话、无 quote、已关闭都不选）。
- `care`：`grounded` 拒绝新作品名和丢失关键词；超时回退；开场拼接；没有 followup 时开场不等待；有 followup 时最多等 1500ms；等待期间用户开口时不重复开场也不丢开场；语言不一致时丢弃关怀句；打断后重试重说同一句；第一次 `response.start` 后关闭并置空 quote。
- 删除：`forget` 的关键词只出现在 quote 中时也能删掉该条 followup；审计 diff 不含原话；`followups.update` 带 quote/sensitive 时被 schema 剥离（不改库，整批不作废）；选取只取来源会话已结束的记录。
- `grounding.ts` 移动后，现有召回测试全部通过且不改断言。
- `EmotionTagger.onAffect`：hold 期间不回落、忽略词表 happy、`crisis` 用 neutral。
- 配置：`affect.json`、i18n、parity、预算的启动校验。

回归门槛：`npm test -w gateway`、`npm run typecheck -w gateway`、`git diff --check`；真实记忆库召回探针（「上次聊到哪儿了 / 上次聊过电影吗 / 我说过喜欢喝茶吗」前两条命中、第三条找不到，无新作品名）；Mock smoke；现有 eval 门槛（问句比、平均字数）。

真实模型探针（合成输入，只输出不含内容的数据）：

- `docs/testing/plan4-affect-probe.mjs`：用十来条合成语句跑分析器，输出各字段枚举、耗时、失败数，人工核对枚举是否合理。共情评估跑完后，从 `affect_summary` 统计 `exhaustedArmed` / `exhaustedRevoked` 和推送次数（只记计数），用来评估条件引导带来的指令变动频率。
- `docs/testing/plan4-care-probe.mjs`：用真实文本模型对合成原话生成关怀句，验证校验通过率；只输出布尔值和计数。选取、回退、关闭由 T5 单元测试用临时库覆盖（2026-10-23 计划审查调整）。

共情评估：

- 场景：`docs/testing/plan4-empathy-eval/scenarios.json`，12 个合成场景，覆盖悲伤、喜事、抱怨、孤单、身体不适、嘴上说没事、话题聊干、长沉默、危机，加 2 个回归场景（召回、否认）。开场关怀由 care 探针覆盖。
- harness：在现有 `gateway/src/eval` 上扩展。场景可以带 `silenceAfterMs`，用来驱动沉默阶段；新增 `judge.ts`，用共享文本模型按 `docs/testing/plan4-empathy-eval/rubric.md` 对每个场景打 1–5 分，六个维度：接住情绪、点出感受、主动得体、不谄媚不说教、不编造、不打扰。结果写入 `docs/testing/plan4-empathy-eval/results-*.json`（合成数据，允许入库）。
- 基线：在 T0 与 T1 合入之后、T3/T5/T6 任何对话行为改动合入之前，用 Qwen 跑一次，记录提交 hash。T0 只改推送时机，不改对话内容。
- 合并条件：前三维平均提高 ≥1 分；后三维不下降；「不编造」全部满分；现有门槛与记忆回归全部通过。
- 现有 eval 门槛（问句比 ≤1/3、平均回复 ≤45 字）继续只按现有的 `docs/testing/plan-a-eval/scenarios.json` 统计。2026-10-24 口径修订：问句比排除开场轮（固定开场含必须的称呼问句），平均字数仍统计全部回复；阈值不变。新的共情场景集不统计平均字数（情绪轮允许到约 60 字），只统计问句比，作为参考值，不设门槛。

真机：用户或客户在 Qwen 上复试，主观反馈记进 roadmap（不记对话正文）。

## 实施分期（供 writing-plans 细化）

| Task | 内容 | 依赖 |
|---|---|---|
| T0 | 推送闸门 + `updateSession` + 两条现有路径迁移 + 无响应观测 | — |
| T1 | eval 扩展（`silenceAfterMs`、judge、rubric、12 场景）+ 跑基线（T0+T1 合入后） | T0 |
| T2 | `affect.json`/i18n 配置与 schema + `AffectTracker` + 日志 | T0 |
| T3 | `renderAffect` + `buildInstructions` 注入 + 预算校验 + 头像 `onAffect` + 危机 | T2 |
| T4 | 规划器输入（affect/openLoop/时间节气）+ 提示词规则 + 话题聊干 | T3 |
| T5 | `grounding.ts` 抽取 + 迁移 + 抽取 quote 校验 + `careFollowup` + 关怀开场 | T0 |
| T6 | 人设放宽（zh）+ ja/en parity 翻译 | T3 |
| T7 | 真实探针、评估对比、召回回归、roadmap/契约更新 | T1–T6 |

T1 的基线必须在 T3、T5、T6 任何一个合入之前跑完，否则对比无效。T5 与 T2–T4 在功能上互不依赖，但实施计划审查（2026-10-23）发现它们改同一批 `session.ts`/`affect.ts` 锚点，所以计划改为严格串行（T4 → T5），见 Plan 4 总览。

## 风险与开放项

- 状态卡最多晚两轮生效，本轮被动回复的共情仍靠实时模型和人设。如果复试显示「第一句接得不好」是主要问题，需要另立决策（例如手动判轮），本期不做。
- 每条非轻回应终稿多一次 `qwen-plus` 调用。成本由 T7 探针实测，不在此估算。
- 人设放宽可能带来谄媚和话变多：评委的「不谄媚」维度和 eval 平均字数门槛兜底。
- 关怀回访误伤：用户可能已经好了，或不想被提起。只问一次、开放式问法、问过即关闭、7 天过期。
- 节气为近似日期；时区写死在配置里，不随用户变化。
- 分析器漏判危机：安全底线仍在人设最前面，不依赖分析器。
- #47（ASR 情绪 ground truth）、语音情绪不可控、#46（Seeduplex 日语）保持开放。

## 参考

- 探针：`docs/research/emotion-proactivity-probes-2026-10-22.md`；blockers #47、#48。
- 记忆设计：`docs/superpowers/specs/2026-10-17-companionship-memory-design.md`。
- 多语言设计：`docs/superpowers/specs/2026-10-21-multilingual-conversation-design.md`。
- 业界做法：ESConv 策略（ACL 2021）、Inner Thoughts（CHI'25）、Hume EVI 提示词指南、EQ-Bench 3、OpenAI 谄媚复盘（2025-04）。
