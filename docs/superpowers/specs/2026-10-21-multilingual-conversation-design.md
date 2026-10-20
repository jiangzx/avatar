# 多语言对话设计：Qwen 中/日/英，Seeduplex 中/英

## 状态

已批准（2026-10-21，五节设计逐节确认）。本文只记录设计，不含实现；实现前必须先完成第 8 节的能力探针。预计拆成 2–3 个计划执行，避免单个计划过大。

决策来源：2026-10-21 brainstorming 的逐项确认。当前日期 2026-10-21。

## 背景与目标

当前产品链路是按中文设计的：角色人设、Director 主动话术、四段沉默、记忆告知、召回包装、安全/情绪词表、UI 都是中文；协议和客户端没有语言字段。

已有日语证据：

- Qwen `qwen3.8-omni-flash-realtime` + 音色 `Tina` 做过最小端到端日语探针，PASS（`docs/research/qwen38-japanese-probe-and-2h-cost.md`）。
- Seeduplex 端到端音色只有中/英及中文方言，无日语 voice，判 FAIL（`docs/research/seeduplex-japanese-probe.md`、`docs/blockers.md` 2026-10-19 条目）。
- 代码里唯一的 `ja` 是周期重建摘要语言选项和日语过渡句（`gateway/src/session/qwenSummarizer.ts`、`gateway/config/pacing.json`），不影响对话语言。

目标：

- **Qwen** 支持中文、日语、英语三种语言对话。
- **Seeduplex** 支持中文、英语两种语言对话。
- 用户说什么语言，就用什么语言回复；每轮跟随，中途换语言立即切换。
- “支持”覆盖完整口语链路：对话、人设、主动接话、四段沉默、记忆告知、召回包装、安全兜底。
- 记忆保留用户原语言，跨语言仍可召回。
- 开场（用户还没开口）用设备语言；设备语言不是 zh/ja/en 时回退中文。
- 每种语言使用匹配的音色；Seeduplex 换语言必要时重建会话。

不在范围：

- App UI 多语言/本地化。App 界面本轮仍是中文。
- 中文、日语、英语之外的语种。
- 按用户或按语言路由双适配器；适配器仍是部署级 `ADAPTER`。
- 口音、方言、老人语音专项调优。
- 长会话质量评测、声音克隆、纯文本聊天模式。
- 重写已验收的中文行为；中文现有提示词只做迁移，不做内容改写。

## 已确认决策

| # | 决策 | 选择 |
|---|---|---|
| D1 | 语言跟随规则 | 每轮跟随；用户换语言立即切换 |
| D2 | 多语范围 | 完整口语链路；App UI 不在本轮 |
| D3 | Seeduplex 日语 | 明确告知不支持；前提是能检测到日语 |
| D4 | 记忆语言 | 保留用户原语言；抽取/摘要也用原语言 |
| D5 | 开场语言 | 设备语言（zh/ja/en），其他回退中文 |
| D6 | 跨语音色 | 按语言配置音色；接受 Seeduplex 换语言时声音变化 |
| D7 | 系统话术语言判定 | 网关轻量脚本启发式，不额外调用模型 |
| D8 | 人设/话术产出 | 本地化改写，保留同一小暖人设，不逐字翻译 |
| D9 | Seeduplex 中途换语言 | 先探针热换 voice；不支持则安全缝重建 |
| D10 | 架构 | 语言包 + 会话语言状态（方案 A） |

## 架构

### 1. 语言状态与判定

新增类型：

```ts
type Language = 'zh' | 'ja' | 'en';
```

- `protocol` 的 `session.start.clientInfo` 增加可选 `language`，zod 校验为 `zh|ja|en`；缺省 `zh`。
- App 从 `PlatformDispatcher.instance.locale.languageCode` 取值，非 zh/ja/en 一律传 `zh`。
- `SessionContext` 保存初始语言；`Session` 保存可变的 `currentLanguage`。
- `manager.begin` 在 `session.start` 时把 `clientInfo.language` 传给 `Session.setInitialLanguage()`，在适配器 `connect()` 之前生效；`session.resume` 不带语言。
- 首轮开场、记忆告知使用初始语言；用户第一次终稿后按检测结果切换。
- `session.resume` 不接收新的设备语言；恢复会话保留原语言，避免重连时改变正在进行的对话。

判定算法（纯函数，单元测试覆盖）：

1. 含平假名或片假名 → `ja`。
2. 无假名、含拉丁字母且不含汉字 → `en`。
3. 只有汉字或汉字为主 → 上一轮是 `ja` 且本句没有假名时保留 `ja`；否则 `zh`。纯汉字无法可靠区分中文/日语，保留上一轮是更稳的选择。
4. 汉字和拉丁字母混合 → 比较两类字符数；拉丁更多判 `en`，否则保留上一轮；并列保留上一轮。
5. 短应答（“嗯/好/OK/はい/yes”）、纯数字、纯标点、空文本 → 保留上一轮。
6. 显式换语短语（“说英语/用日语/日本語で/English please/中文”）优先于以上规则；短语表放语言配置，可扩展。

设计约束：

- 判定只驱动**系统话术和提示词语言**，不试图纠正实时模型回复。模型回复里引用其他语言、翻译、专有名词不反过来改状态。
- 首轮无法判定时用设备语言；设备语言不支持则 `zh`。
- 语言变化时立即更新 `currentLanguage`；提示词在下一次模型请求前推送。当前回复正在生成时不打断，等回复结束后再做音色切换/重建。
- 当前回复仍由模型按用户语言生成；系统话术从下一次请求开始使用新语言。

### 2. 语言包与配置结构

目录按语言对称：

```text
gateway/roles/
  _shared/
    zh/{safety.md, actions.md, extract.md, recall.md}
    ja/{safety.md, actions.md, extract.md, recall.md}
    en/{safety.md, actions.md, extract.md, recall.md}
  elder-companion/
    role.json
    zh/{styles/*.md, director.json, topics.json, activities/*.md}
    ja/{styles/*.md, director.json, topics.json, activities/*.md}
    en/{styles/*.md, director.json, topics.json, activities/*.md}
gateway/config/
  memory.json / pacing.json / ...     # 共享数值与行为
  i18n/
    zh/{memory.json, safety.json, emotion.json, silence.json}
    ja/{memory.json, safety.json, emotion.json, silence.json}
    en/{memory.json, safety.json, emotion.json, silence.json}
```

`role.json` 保留语言中立字段：

- `id`
- `defaultStyle`
- `defaultLanguage`
- `supportedLanguages`
- 风格 id 列表
- 可选的按语言音色覆盖

每种语言的 `styles/<styleId>.md`、`director.json`、`topics.json`、`activities/*.md` 必须齐全，style id、activity id、topic id 集合一致。

`RoleCatalog` 增加语言维度：

```ts
supportedLanguages(roleId): readonly Language[]
buildPersona(roleId, styleId, language): string
director(roleId, language): DirectorConfig
activityText(roleId, language, activityId): string | undefined
voiceFor(roleId, styleId, language): string | undefined
```

`Session` 与 `Director` 不能像现在这样在构造时固定 persona/Director 配置（`gateway/src/session/session.ts:225-233`）：

- `Session.instructions()` 每次按 `currentLanguage` 取 persona、摘要、最近对话和预算。
- `Director` 每次生成请求时按当前语言取话术；语言切换只换包，不清空 Director 的定时器、阶梯状态和记忆快照。
- 工具注册表按当前语言取工具描述和召回文案。

启动校验：

- 每个 `supportedLanguages` 必须有完整语言包；缺任何文件直接启动失败，不静默回退中文。
- `elder-companion` 必须支持 zh/ja/en。未来角色若只支持部分语言，Session 遇到不支持的语言时回退到该角色 `defaultLanguage`，并记 `language_unsupported`，不静默。
- 指令预算按语言分别计算：`validateBudgets` 对每种语言的人设各算一次，`Session` 使用当前语言的预算。英语字符数更长，不能复用中文预算。
- `slim.bridge` 按语言映射；删除 `slim.summaryLanguage`，摘要语言改用 `Session.currentLanguage`。

音色：

- 适配器配置改为按语言映射：`QWEN_VOICE_ZH/JA/EN`、`SEEDUPLEX_VOICE_ZH/EN`。
- 角色/风格的 `voice` 仍是可选覆盖；`null` 表示使用适配器当前语言的默认音色。
- 默认值：Qwen 三语优先用 `Tina`（已验证日语；中文/英语待探针），Seeduplex 中文 `zh_male_xiaotian_jupiter_bigtts`、英语 `en_male_tim_uranus_bigtts`。

文本模型链路：

- `Summarizer.summarize(previous, entries, language)`。
- `MemoryExtractor.extractOwner(ownerId, reason, language?)`。
- 召回包装提示词、召回工具描述、`recallFoundPrefix`/`recallEmptyText` 按当前语言取。
- `QwenSummarizer` 不再在构造时固定语言；`SummaryLanguage` 扩展为 `zh|ja|en`。
- `MemoryWorker` 的 `systemPrompt` 改为按语言取包；`startup` 抽取没有会话语言时，按待抽取用户消息的主导语言选包，找不到则 `zh`。

结构标签：

- `instructions.ts` 的“用户/助手/记忆参考/对话摘要/最近对话/（暂无）”按语言提供。
- `snapshot.ts` 的“称呼/事实/关系/上次话题/用户/助手”按语言提供；`addressingText` 的中文“我叫/用户叫”正则改为按语言匹配，避免日语/英语称呼事实无法归一。
- `tokens` 估算仍用 `text.length`；英语可能高估 token（更保守，可接受），但预算验证要按语言实测。

### 3. 适配器、音色与能力探针

**Qwen**

- 三语共用 `Tina`（或同等多语音色）。
- 语言变化只调用 `updateInstructions`，不重建；语音不换。
- 需验证 Tina 的中文、英语输出与日语一样可用。

**Seeduplex**

- 中文用 `zh_*`，英语用 `en_*`；按语言映射音色。
- 换语言先尝试 `session.update` 热换 voice；不支持就在安全缝重建。
- 新增内部重建 reason `language`：走与 slim 相同的 `presence: refreshing` 静默流程；重连慢时用新语言说一句过渡句；**不发** `model_reconnecting`（那是“网络断开”话术）。
- 切换时机：用户终稿后更新语言状态；若当前回复还在生成，不打断，等回复结束后切音色/重建。当前这句仍由模型按用户语言生成。

**适配器语言能力**

- gateway 配置增加适配器能力表：`ADAPTER_LANGUAGES: Record<'qwen' | 'seeduplex', readonly Language[]>`，Qwen 为 `zh/ja/en`，Seeduplex 为 `zh/en`。
- `Session` 用该表决定日语提示分支；不支持的语种不进入正常回复链路，也不硬塞给适配器。
- 未来新增适配器时只扩展能力表，不在 Session 里写 if-else。

**Seeduplex 日语提示**

- 确认日语后，用上一个可用语言（zh/en）说“我目前只会中文和英文”。
- 首句就是日语、没有上一个语言时：设备语言是 zh/en 就用设备语言；否则用英语。
- 提示走正常回复链路，不新增协议消息。
- 前提：Seeduplex 的 ASR 能把日语输入转写成可识别的日语文本（至少含假名）。如果转写成中文/英文乱码，网关无法判定“用户说了日语”，明确告知就不可实现。

**能力探针矩阵**（只记事件、脚本标志、字节数、耗时；不记录对话正文）

| 探针 | 通过标准 |
|---|---|
| Qwen + Tina：zh/ja/en 文本与音频 | 三种语言都能听懂、回复脚本匹配、输出 PCM 非空、`response.done` |
| Qwen 中途 `updateInstructions` 换语言 | 下一轮按新语言回复，连接不丢 |
| Seeduplex + `zh_*` 中文音频 | ASR 中文、中文回复、PCM 非空 |
| Seeduplex + `en_*` 英语音频 | ASR 英文、英文回复、PCM 非空 |
| Seeduplex `session.update` 热换 voice | 音色确实改变且会话不断；失败则走重建 |
| Seeduplex 日语音频（zh/en voice） | ASR 是否产出可识别的日语文本（含假名） |

最后一项是 gate：失败时停下，在以下三者中重新决策，不能假装能检测：

1. 增加轻量语言识别（例如把短音频样本送 Qwen ASR）。
2. 放弃明确提示，Seeduplex 日语仅尽力而为。
3. Seeduplex 部署不接受日语输入。

### 4. 记忆、安全与情绪

**记忆保存与召回**

- 记忆保留用户原语言；抽取提示词增加硬规则：“每条 text/summary 用用户原话的语言写，不要翻译”。混合语言会话按各自原句语言保存。
- 召回包装、空结果话术、`recallFoundPrefix`、召回工具描述按当前语言取。
- 召回只使用已存事实；跨语言时允许自然转述，但不新增细节。
- **分词缺口**：`gateway/src/memory/bigram.ts` 的 `bigrams()` 只索引汉字和拉丁字符，假名被跳过。日语记忆目前只能靠汉字词召回，纯假名内容检索不到。需要增加平假名/片假名 bigram；英文仍按整词 run。已有日语行做一次有界回填；中文/英文 token 不受影响。
- `isMemoryEvidence` 的中文问句后缀（吗/呢/么/嘛/来着）、`sameUtterance` 的标点归一、`grounded` 的 token 校验都要按语言扩展。否则日语问句会被当成陈述，英文/日语召回包装会被误判不 grounded。
- `recallRecentQueries`、`lightAcks`、`skipPatterns` 按语言配置；中文现有词表原样保留，日语/英语新增。

**记忆告知与确认**

- `memoryNoticeText`、`memoryNoticeKeywords`、忘掉/拒绝确认文案、`recallEmptyText`、`recallFoundPrefix` 全部进语言包。
- 告知校验用“播报时的当前语言”关键词；如果模型没有按当前语言播报，按现有逻辑判未送达，不标记已告知。
- 记忆告知在用户开口后、语言已确定时再请求；若首轮就切换语言，以当前语言为准。首轮尚未开口时用设备语言。

**安全、情绪、沉默校验**

- `safety.json`：共享 `invisibleCodePoints`/数字规则；`rejectPhrases`/`degradePhrases`/`markPhrases` 按语言补充。扫描已存文本和召回结果时使用所有语言词表的并集，避免跨语言漏检。
- `emotion.json`：每种语言一套 lexicon；运行时用并集，兼容中英混说、日英混说。
- `silence.ts` 的 `LISTENING`/`ANYTIME` 中文正则改为语言包配置。示例：日语“聞こえますか/いますか/いつでも”，英语“are you there/can you hear/anytime”。`checkin` 内容校验按当前语言执行。

**抽取与摘要**

- 抽取提示词按批次主导语言选包，但输出语言仍跟随每条用户原话。
- 会话摘要用当前语言写；中途换语言不重写已有摘要，模型可读混合语言摘要，下一次压缩再用新语言。
- 摘要和抽取失败时，回退到当前语言的配置文案，不静默留空。

### 5. 协议与客户端

- `protocol` 新增 `Language` 类型；`session.start.clientInfo.language?`。
- App 在 `session.start` 里发送设备语言；不新增服务端消息，客户端不需要知道当前语言。
- App UI 仍是中文，作为已知限制记录；本轮不做本地化。
- 诊断只记事件名、语言代码、耗时、错误码；不记音频、ASR 文本、回复文本。语言代码本身不是对话内容，可进日志。
- 指标：每语言首音延迟、语言切换次数与耗时、`model_rebuild` 的 `reason=language` 与耗时、错误码。
- 适配器仍由部署级 `ADAPTER` 决定：`qwen` 支持三语；`seeduplex` 支持中/英。不做按用户路由双适配器。

## 失败处理与降级

- **语言包缺失**：启动失败，错误码指明 role/language/缺失文件。不静默回退中文。
- **未知语言**：设备语言不是 zh/ja/en → 初始 `zh`；用户说话后按检测结果切换。
- **检测不确定**：保留上一轮；首轮用设备语言。
- **Seeduplex 日语 ASR 探针失败**：停止，不在实现里假装检测；按第 3 节三者重新决策。
- **Seeduplex voice 热换失败**：安全缝重建；使用 `presence: refreshing`，不说“网络断开”；重建失败按现有 `model_unavailable` 重试策略。
- **语言切换时正在生成回复**：不打断；当前回复结束后再切音色/重建。提示词可在下一次请求前更新。
- **记忆告知语言不匹配**：按现有 `noticeVerified` 逻辑判未送达并重试；不标记已告知。
- **文本模型失败**：抽取/摘要/召回包装回退到当前语言的配置文案或逐字原话。

## 测试与验收

**单元测试**

- `detectLanguage`：中/日/英/混合/短应答/纯汉字/显式换语。
- 语言包 parity：每语言 style/activity/topic/director 字段齐全；缺包启动失败。
- 按语言预算：中/日/英 persona 长度、`historyBudget`、摘要触发阈值。
- 记忆：假名分词、问句证据过滤、`sameUtterance`、`grounded`、召回包装。
- 记忆告知：每语言关键词校验、未匹配不标记。
- 沉默：每语言 `checkin` 校验；中文现有行为不变。
- 情绪/安全：每语言词表；并集扫描。
- 抽取/摘要：输出语言跟随原话；`language` 参数贯通。

**合成评测**

- `zh/ja/en` 各一组场景：开场、正常回复、主动接话、四段沉默、记忆告知、召回、换语言。
- 只使用手写合成输入；不记录真实对话正文。
- Seeduplex 中/英各一组；日语提示单独探针。

**能力探针**

- 按第 3 节矩阵人工执行；结果写 `docs/research/`，只记事件/脚本标志/字节数/耗时。
- 探针未通过前不进入实现；探针通过后把实际音色、模型、日期写回本规格或研究文档。

**真机验收**

- Qwen：中/日/英分别完成开场、正常回复、主动接话、四段沉默、记忆告知、召回；中途换语言后下一轮跟随；跨语言记忆可召回；无中文话术泄漏（专有名词除外）。
- Seeduplex：中/英同样通过；日语按已确认策略明确告知；换语言音色正确或重建后正确；中文现有行为无回归。
- 回归：gateway 全量测试、typecheck、真实记忆库召回探针、现有中文手机验收。
- 性能：Qwen 换语言不增加首音延迟；Seeduplex 热换失败时记录重建耗时，用户不听到“网络断开”。

## 实施分期

1. **能力探针（gate）**
   - Qwen zh/ja/en + Tina；Qwen 中途换指令。
   - Seeduplex zh/en；voice 热换；日语音频 ASR。
   - 产出研究记录和实际音色/模型结论。

2. **语言状态基础**
   - `Language` 类型、协议字段、设备语言。
   - `detectLanguage` 纯函数、显式换语短语。
   - `Session.currentLanguage`、初始语言传递、`session.resume` 行为。
   - 先不改提示词内容；用一个测试语言包验证动态取包。

3. **语言包基础设施 + 中文迁移**
   - 目录结构、role manifest、`RoleCatalog` 语言维度。
   - 中文现有文件迁入 `zh/`；启动 parity 校验。
   - 按语言预算、按语言音色映射。
   - 用最小 `en`/`ja` 测试包验证加载和切换，不要求完整内容。

4. **日语/英语内容包**
   - `ja/`、`en/` 的 persona、styles、director、topics、activities、_shared 提示词。
   - 本地化改写：保留同一人设和边界，按语言调整称呼、敬语、语气、例子。
   - 记忆告知/确认/召回/沉默固定话术。

5. **记忆与安全本地化**
   - 假名分词、证据判定、召回包装、工具描述。
   - safety/emotion/silence 词表。
   - 抽取/摘要语言贯通；`MemoryWorker` 按语言取提示词。
   - 真实记忆库召回探针（中/日/英）。

6. **适配器行为**
   - Qwen 三语音色与 `updateInstructions`。
   - Seeduplex 按语言音色、热换/重建、日语提示。
   - `model_rebuild(reason=language)`、`presence` 流程、指标。

7. **评测与真机**
   - 三语合成场景、跨语言记忆、回归、手机复验。

计划拆分建议：

- **M1**：分期 1–3（探针、语言状态、语言包基础设施 + 中文迁移）。
- **M2**：分期 4–5（日语/英语内容、记忆/安全本地化）。
- **M3**：分期 6–7（适配器行为、评测与真机）。

每个计划执行前按项目规则走 writing-plans、TDD、verification-before-completion；记忆召回和四段沉默改动前先读 `docs/project/roadmap.md` 的「记忆与回忆：已踩过的坑」并向用户确认。

## 风险与开放项

| 风险 | 影响 | 处理 |
|---|---|---|
| Seeduplex 日语 ASR 无法产出日语文本 | “明确告知不支持”缺少输入信号 | 探针 gate；失败则三者重新决策 |
| Seeduplex voice 热换不生效 | 换语言需要重建，增加 1–2 秒思考态 | 探针验证；失败走 `language` 重建 |
| 日语假名分词/证据判定缺失 | 日语记忆召回大量漏检 | 第 5 期专项实现 + 真实记忆库探针 |
| Qwen Tina 中文/英语未验证 | 三语可能不是同一音色都可用 | 探针确认；必要时按语言换音色 |
| 英语字符数更长 | 指令预算/摘要阈值偏差 | 按语言预算和测试调整 |
| 日语敬语/英语老人语气失真 | 陪伴体验下降 | 本地化改写 + 母语审校；不逐字翻译 |
| 记忆告知语言错配 | 告知被判未送达、重复请求 | 按当前语言请求；未匹配不标记 |
| 模型回复语言漂移 | 系统话术与回复不一致 | 提示词明确“跟随用户语言”；系统话术按检测语言；不改模型回复 |
| 旧日语消息缺假名 token | 旧数据召回不到 | 有界回填含假名的行；不影响中/英 |
| 假名 bigram 增大 FTS 索引 | 检索延迟/库体积上升 | 用合成数据测召回延迟与索引体积，必要时限制 token 数 |
| App UI 仍中文 | 日语/英语用户体验割裂 | 已知限制，后续独立 UI 本地化计划 |

必须在实现前确认的假设：

- Seeduplex 英语 ASR/TTS 可用，且 `en_*` 音色在当前账号可用。官方文档列了 `en_*`，但未实测。
- Seeduplex `session.update` 可以中途换 voice；未实测。
- Qwen `Tina` 的中文和英语输出可用；日语已实测，其他未实测。
- Seeduplex 日语输入能转写出含假名的文本；未实测。
- 英语/日语 ASR 对老人语音的识别质量；未测。

## 参考

- `docs/research/qwen38-japanese-probe-and-2h-cost.md`
- `docs/research/seeduplex-japanese-probe.md`
- `docs/research/cascade-vs-qwen-cost-2026-10-19.md`
- `docs/project/roadmap.md`（「记忆与回忆：已踩过的坑」）
- `docs/superpowers/specs/2026-10-17-companionship-memory-design.md`
- `gateway/src/session/session.ts`
- `gateway/src/session/director.ts`
- `gateway/src/session/silence.ts`
- `gateway/src/session/instructions.ts`
- `gateway/src/memory/bigram.ts`
- `gateway/src/memory/evidence.ts`
- `gateway/src/memory/snapshot.ts`
- `gateway/src/session/tools/registry.ts`
- `gateway/src/session/tools/recall.ts`
- `gateway/src/session/qwenSummarizer.ts`
- `gateway/src/memory/worker.ts`
- `gateway/src/adapters/qwen.ts`
- `gateway/src/adapters/seeduplex.ts`
- `protocol/src/index.ts`
- `app/lib/native_gateway/protocol.dart`
