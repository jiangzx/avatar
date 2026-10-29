# 关系连续的主动互动设计

## 状态

已批准（2026-10-28，用户）。

- 决策来源：2026-10-28 grilling 会话 Q1–Q26。用户逐轮确认；Q8 按用户修订（保留适配器框架），Q22 按用户修订（控制台计划全部完成后才开工）。
- 调研：代码现状与竞品/学术调研各一份，结论写在「现状事实」和附录 A。
- **开工条件**：后台管理控制台的计划 3、计划 4 全部完成。**已满足**（2026-10-28 两份计划验收，`bf49c4f`）。同日按控制台落地后的代码复核了「现状事实」，并据此修订「配置」「隐私、数据与删除」「测试与验收」「实施分期」（修订记录见文末）。本文只记录设计，不含实现，也不含计划。
- 本文会改写 roadmap「记忆与回忆：已踩过的坑」第 4、5、7、8、12 条（见「坑位契约修订」）。改写在对应计划开工时与代码一起提交，不在本文提交时改。

## 背景与目标

用户反馈：主动建议、跟进对话、适时问候这几块关系连续性很弱；固定句型太多，有明显的 AI 感，达不到商品化要求。希望自研一套算法，并借鉴 Character.AI、Replika 等产品。

目标（按优先级）：

1. **关系连续**：下次见面能自然接上上次的事（事件前提一句、事件后回访、持续的牵挂隔几天问一次），而不是每次都像初次见面。
2. **主动得自然**：什么时候说、说什么由决策层按情绪、事项、作息、接受率打分决定；没有合适的就保持安静。具体措辞交给模型，固定句只在出错时兜底。
3. **理解当下与近来的情绪**：在逐轮情绪卡之外，加入跨会话的情绪轨迹，按「先了解、再安慰、后建议」切换应对。
4. **可商品化**：符合《人工智能拟人化互动服务管理暂行办法》，不做情感操纵，用户能调主动程度，数据可查可删。

不在范围：

- 会话外主动联系（App 推送、定时来电），只留接口（Q2）。
- 训练或微调模型（Q3）。
- 语音语调情绪识别；头像表情的词表打标器不改（Q12）。
- 三段式链路（ASR → 大模型 → TTS）本身的实现，另立计划；本文只保证意图契约可以直接用（Q14）。
- `app/` 改动，包括主动程度的设置界面（Q18）。
- ja/en 调优，只保证配置能加载、能兜底（Q21）。
- 首次见面的开场（`greetingsFirstMeet` 自我介绍、问称呼、AI 身份提示）保持现状。

## 已确认决策

| # | 决策 | 选择 |
|---|---|---|
| Q1 | 目标用户 | 算法不绑人群，主动频率、亲近程度、禁区话题都在角色配置；先在老人陪伴场景打磨验证 |
| Q2 | 主动范围 | 本期做会话内（L1）和跨会话连续（L2）；会话外（L3）不做，留接口 |
| Q3 | 自研什么 | 决策与关系编排层（规则 + 打分 + 状态），模型负责措辞；不训练模型 |
| Q4 | 固定句型 | 模型生成为主；模板只在出错时兜底，每个时机多条，最近用过的不重复 |
| Q5 | 验收方式 | 先合成剧本 + 模型评委，里程碑做小范围真人盲测；线上指标以后再看 |
| Q6 | 伦理硬约束 | 不用愧疚感挽留；引导联系家人朋友；用户可调低或关闭主动；高风险情绪转安全流程 |
| Q7 | 谁说出来 | 方案 C：决策层给「意图 + 锁定事实 + 语气」，实时模型在自己这一轮里说；事实只能用锁定原话；说完事后核对，只记录、不拦截；关键路径上不调文本模型规划 |
| Q8 | Seeduplex | 删除实现与分支；保留 `RealtimeAdapter` 接口和能力标记，给三段式链路用 |
| Q9 | 关系建模 | 后台关系画像，用户不可见，不做游戏化等级；推出三档熟悉度（初识 / 熟悉 / 老朋友），只调称呼亲近度、玩笑、回访深浅 |
| Q10 | 未了之事 | 事项线取代 care：事件 / 牵挂 / 计划三类，各有生命周期；每会话主动提 1–2 件；必须有用户原话依据 |
| Q11 | 反思层 | 只给决策层用，绝不当作事实说出口；说出口的内容必须附用户原话 |
| Q12 | 情绪 | 保留逐轮情绪卡（只看文本）；新增跨会话情绪轨迹；低落时按 ESConv 先了解、再安慰、后建议；不做语音语调 |
| Q13 | 决策算法 | 时机 → 候选意图 → 打分 → 最高分且过阈值才开口；「保持安静」是正式候选；接受/拒绝计次；权重阈值在角色配置 |
| Q14 | 意图契约 | 与模型无关的 `ProactiveIntent`；Qwen 渲染成指令，三段式链路以后做成 `CascadeAdapter` |
| Q15 | 已知称呼的开场 | 放开给模型说，材料只限决策层交给它的已核实原话、事项线、情绪摘要、作息；无材料就简单问候；模板只兜底 |
| Q16 | 四段沉默 | 变成决策层的四个开口时机；保留各段时长、`quietPhrases`、rest 不提问；checkin 要求改为意图约束 + 事后核对；删逐句词表硬校验 |
| Q17 | 延迟预算 | 决策 ≤50ms 本地计算；会话中不同步调文本模型（情绪卡维持异步）；抽取、反思、情绪摘要在会话结束或沉默 180s 时异步做；开场材料在连接期间预取 |
| Q18 | 用户控制 | 安静 / 适中 / 活跃三档，默认档在角色配置；语音可调，偏好跨会话保存；不改 App |
| Q19 | 多角色隔离 | 关系画像、事项线、反思、情绪轨迹、主动偏好、接受率都按 `agent_id`；只有称呼与基本资料共享 |
| Q20 | 验收门槛 | 编造 0 次一票否决；连续性、自然度各比基线 +0.5（5 分制）以上；不打扰、共情不退步；之后真人盲测 |
| Q21 | 语言 | 只调中文 |
| Q22 | 排期 | 控制台计划 3、4 完成后才开工；新参数放 `gateway/config/proactivity.json`，zod 校验，接入控制台配置描述符 |
| Q23 | 计划拆分 | P0 下架 Seeduplex → P1 评测基线 → P2 数据层 → P3 决策层 → P4 开场 → P5 验收；每份单独审批、按序执行 |
| Q24 | 数据合规 | 告知后且未拒绝才写；可删；删原话连带删除依据它的事项与反思；设置页可见；原地迁移，未关闭的 `followups` 转事项线 |
| Q25 | 接受率 | 非轻回应 = 接受；安静类/婉拒/无回应 = 拒绝；按角色 × 意图计次；平滑后换算成 0.5–1.5 系数；每次决策一条内容无关日志 |
| Q26 | 文档 | 本文 + 附录调研；坑位在 roadmap 改写；计划等开工时再写 |

## 现状事实（2026-10-28 控制台落地后复核，`bf49c4f`）

**对话行为**

- **开场**（`session.ts` `start()`，`director.ts:605-612` `requestGreeting`）：首次见面用角色卡（`characters/*.json`）的 `greetingsFirstMeet`；已知称呼时优先用 care 关怀句（模板开头 + 模型一句），没有就从 `greetingNameTexts` 3 条随机取（`session.ts:1716-1730`）；不知道称呼才由规划器生成。坑位第 5 条禁止已知称呼时走规划器。
- **四段沉默**（`director.ts` `onAiTurnEnded`/`fire`，`silence.ts`）：context/check/leave/checkin/rest 为 6/8/10/10/180s（`director.json:42-46`）。每段先调文本模型规划器（2s、不重试、≤60 字），失败、与已说过的话重复或不过校验就说配置文案。checkin 必须同时含「在听」类和「随时」类词且 ≤30 字，rest 不能提问（`silence.ts:17-22`，词表 `config/i18n/zh/silence.json`）。
- **固定口语**（zh `director.json`）：18 句 `*Text` + 3 句 `greetingNameTexts` + 3 句 `greetingCareTexts`，共 24 句；指令模板 19 段（17 个顶层 `*Instruction` + `silenceDecision.instruction` + `speakInstruction`）。`topics.json` 10 张卡只在 `fileCatalog.ts:271` 加载校验，session 任何地方都不用（含 `topicInstruction`）。
- **跨会话跟进**：只有 care。会话结束抽取 `followups.quote`（逐字原话）；开场选 1 条（未完成、有原话、来源会话已结束且非本会话、7 天内，`store.ts:408-413`），模型写一句关怀，播出即关闭并清空原话；每日任务清理过期原话（`clearStaleCareQuotes`）。
- **情绪**：`EmotionTagger` 词表只驱动头像；`AffectTracker` 每条非轻回应终稿调一次文本模型（2.5s、不重试），情绪卡字段 emotion/intensity/trend/need/strategy/mismatch/crisis/openLoop（`affect.ts:24-32`），由 `renderAffect` 用固定短句拼成指令（zh ≤150 字，`memory.json` `affectMaxChars`），经 `PushGate` 推送。卡只在会话内存。
- **适配器**：Qwen 是 item 模式，指令作为 user 消息插入再 `response.create`，模型会改写措辞。坑位「打断与沉默」第 3 条：指令里不能放可照读的例句。Seeduplex 只能直接 TTS 网关定稿的整句（P0 下架）。
- **合规现状**：已有 AI 身份提示、每 60 分钟休息提醒（满足《办法》2 小时提醒）。
- **前车之鉴**：Plan 5 共情补句在关键路径上调规划器，`planner_timeout 30/31`，代码已回退（roadmap Plan 4 节记录，未重跑）。

**记忆与数据**

- **表**：owners、devices、agents、sessions、messages + `messages_fts`、profile_facts（共享）、agent_facts、pinned_memories、relationship_notes、episodes、followups、memory_changes、meta、usage_events、price_entries、log_events、config_versions、secrets、admin_audit。`user_version=7`（`migrations.ts`，`BASELINE_VERSION=6` + 两步），新表只能在末尾追加迁移步骤（v8）。
- episode 与关系备注不进提示词（`snapshot.ts:108` 传 `notes: []`，不传 episode）。`episodes.mood` 只被 `memoryForExtract`（`store.ts:655-657`）读回作抽取模型的输入，没有任何决策或提示词路径读它。
- **关系阶段**：没有，只有 `firstMeet` 布尔值。**情绪历史**：没有跨会话存储。**会话外联系**：没有。
- **删除**：
  - 删 owner：后台 `admin/routes/owners.ts:36-59` 在事务里 `deleteOwner`，靠 `owner_id ... ON DELETE CASCADE` 级联，另清 `log_events`。
  - 清空某角色记忆：`clearAgentMemory` 逐表 DELETE（agent 行保留，`agent_id` 的 FK 级联不触发），新表必须手动加入列表。
  - 删单条：`memoryService.deleteItem`（`identity/memoryService.ts:102-118`）方向是「条目 → 来源原话」；反方向「删原话 → 删依据它的条目」目前不存在。
  - 语音「忘掉」：`forgetMatches` 按文本匹配删 facts/pins/profile/notes/episodes/followups 并清空匹配的 messages 内容，新表须加入。
  - 后台只显示记忆条数，不显示内容（admin spec「安全复核卡」）。

**配置（控制台计划 3 落地后）**

- 会话启动时 `makeSessionFactory`（`snapshotDeps.ts:89-102`）读一次配置快照，转成 `SessionDeps`，整个会话用这一份（不经 `SessionContext`）。快照由 `buildConfigSnapshot`（`configSnapshot.ts:43-98`）把仓库基线 `config/`、`roles/`、`characters/` 物化到临时目录、写入覆盖值、再用原 loader 加载校验；交叉校验集中在 `configSnapshot.ts:71-80` 与 `fileCatalog.ts:308`，报错文案在 `CODE_MESSAGES`。
- 覆盖键白名单（`keys.ts:22-80`）：`pacing`/`memory`/`affect`/`emotion` 文件、`i18n:`、`role:<role>/<lang|*>/persona` 与 `director.<path>`、`character:`、`model:qwen.*`。**只能替换基线已有的路径，不能新增键；值只能是 number / boolean / string / string[]**。角色目录只开放 `persona.md` 与 `director.json`。
- 后台描述符在 `gateway/config/admin/descriptors/*.json`；没有描述符的键后台不能改。场景集合硬编码在 `SCENE_IDS`（`descriptors.ts:6`）、`AdminConfigSceneId`（`protocol/src/adminApi.ts:37`）、`NAV_GROUPS`、admin 路由四处。`config-descriptors.test.ts:79-81` 禁止 `director.*Instruction` 与 `silenceDecision` 进入白名单（指令模板不给后台改）。`config-snapshot.test.ts` 会自动对每个描述符取最小/最大/上限值构建快照。

**Seeduplex 的分布（P0 范围）**

- 实现与接线：`adapters/seeduplex.ts`、`index.ts`（构造与音色选择）、`config.ts`（`ADAPTER` 取值与 `SEEDUPLEX_*` 环境变量）、`characters/card.ts`（`voices.seeduplex`，strict schema）与 `registry.ts`（`VoiceAdapter`）、三份角色卡与测试 fixture、`.env.example`。
- 注释提及：`adapters/types.ts`、`session/pushGate.ts`、`session/tools/recall.ts`、`session.ts:101`。
- 后台：`admin/src/pages/OverviewPage.tsx:40`（当前适配器为 Seeduplex 的提示）、`admin/src/labels.ts`、`protocol/src/adminApi.ts:11` 注释。
- 测试与脚本：`seeduplex.test.ts`、`seeduplex.integration.test.ts`、`snapshot-deps`/`secrets`/`config`/`characters`/`director-silence`/`pin-session`/`push-seam` 中的用例，`scripts/probe-*seeduplex*` 等 5 个探针脚本。
- 项目规则：`AGENTS.md` 高风险区一行提到「Seeduplex 工具轮」。
- **适配器框架**：`RealtimeAdapter` 的三个能力标记 `supportsPlaybackTruncate`、`verbatimFallback`、`supportsUserText`；会话层只在 `session.ts:578`（`!supportsUserText`）与 `:941`（`verbatimFallback`）按标记分支，不按适配器名判断。
- 后台描述符里没有 Seeduplex 音色或模型的可写键，现有覆盖层不会因删除 `voices.seeduplex` 而失效（P0 开工时仍对真实库的活动覆盖层做一次只读核对）。

**评测框架**

- `docs/testing/plan4-empathy-eval/`：`scenarios.json`（手写多轮，`harness.ts:46-53` schema：1–10 轮、可选 `silenceAfterMs`）、`rubric.md`（6 维）、`compare.mjs`（前三维 +1、后三维不降、noFabrication 全 5）。驱动是 `scripts/eval.ts --adapter mock|qwen`：每个场景一个 `firstMeet` 的新 `Session`，没有记忆库、worker、care；规划器和情绪分析只在 Qwen + 文本模型时生效；评委用 `memory.extractModel`。
- 没有模拟时钟、没有多会话。`Session` 有可选 `deps.now`，Director 用裸 `setTimeout`；`eval.ts` 自己拼 deps，不走配置快照。跨会话真实库探针只有 `plan3-qwen-memory-probe.mjs`（临时库 + `DeviceRegistry`）。

**日志**

- `Logger.info/warn/error/debug(event, fields)` 与 `child({sid,oid,char,seq,job})`。字段名含 text/transcript/content/reply/utterance/prompt/message/instruction/quote/summary 的一律拒绝（测试与开发环境 throw，`fieldGuard.ts`）。

## 架构

### 分层

沿用 `server → (session, identity) → (adapter, memory, roles)`，不反向依赖。新增模块（目录名在计划中定）：

| 模块 | 层 | 职责 |
|---|---|---|
| 决策引擎 `ProactiveEngine` | session | 时机 → 候选 → 打分 → 选择；纯函数为主，输入是一个只读的「决策上下文」 |
| 意图渲染 `IntentRenderer` | session | 把 `ProactiveIntent` 渲染成适配器能用的形式（Qwen：指令） |
| 关系存储 | memory | 关系画像、事项线、情绪轨迹、反思结论、主动偏好、接受率计数 |
| 会话后处理 | memory | 会话结束 / 沉默 180s 时异步：事项抽取、情绪摘要、反思、画像更新 |
| 配置 | roles / config | 意图类型、权重、阈值、三档参数、生命周期、兜底句 |

没有模块级可变状态；数据库连接注入。配置从会话启动时的配置快照经 `SessionDeps` 传入（与现有 `makeSessionFactory` 一致）；本会话的决策上下文、本会话主动次数等运行态放在会话对象里；跨会话的数据（今日主动次数、接受率、最近用过的兜底句）在记忆库按 `(owner, agent)` 存取。

### 数据流

```
连接建立 ──预取──▶ 决策上下文（画像 + 事项线 + 上次情绪摘要 + 偏好 + 接受率 + 作息/时段）
                         │
开口时机（开场 / 沉默各段 / 话题聊干）
                         ▼
               ProactiveEngine（≤50ms，无模型调用）
                         │ ProactiveIntent 或 quiet
                         ▼
               IntentRenderer ──▶ PushGate ──▶ RealtimeAdapter（Qwen 自己说）
                         │                              │
                  失败/超时 → 兜底模板             助手转写稿 → 事后核对（只记日志）
                                                        │
               用户下一句 → 判定接受/拒绝 → 计次
会话结束 / 沉默 180s ──异步──▶ 事项抽取、情绪摘要、反思、画像更新
```

### 意图契约 `ProactiveIntent`（Q14）

与模型无关，由决策引擎产出，zod 定义（放在 gateway 内部，不进 protocol）：

| 字段 | 说明 |
|---|---|
| `moment` | `session_start` / `silence_context` / `silence_check` / `silence_leave` / `silence_checkin` / `silence_rest` / `topic_exhausted` |
| `kind` | 意图类型，见下表 |
| `material` | 锁定材料：用户原话（带来源 message id）、事项线条目、话题卡、作息/时段/节气/天气；可为空 |
| `tone` | 熟悉度档位、情绪应对阶段（了解/安慰/建议）、是否允许玩笑 |
| `constraints` | 长度上限、是否允许问句、必须表达的意思（如 checkin 的「我在听、随时可以聊」） |
| `language` | 会话当前语言 |
| `fallbackKey` | 出错时用哪组兜底句 |

意图类型（初版，权重与开关在配置）：

| `kind` | 含义 | 可用时机 |
|---|---|---|
| `thread_followup` | 回访事项线（事件前提醒 / 事件后问结果 / 牵挂关心） | 开场、context、check、话题聊干 |
| `mood_check` | 上次或刚才情绪低落，轻轻关心 | 开场、context |
| `routine` | 作息问候（早上问睡眠、饭点问吃饭、晚上道晚安） | 开场、context |
| `interest_topic` | 用户感兴趣的话题（非敏感事实或话题卡） | context、check、话题聊干 |
| `continue_thread` | 延续刚才没聊完的话（会话内 openLoop） | context、check |
| `human_connection` | 引导联系家人朋友（必须有用户提过的家人朋友原话） | context、话题聊干，有周上限 |
| `self_share` | AI 说自己的一件小事（不编造用户事实） | check、话题聊干 |
| `presence_check` | 确认还在不在、表达随时可聊 | 仅 checkin |
| `rest_quiet` | 安静陪伴，不提问 | 仅 rest |
| `greeting_plain` | 无材料时的简单问候 | 仅开场 |
| `quiet` | 不开口 | 除 checkin、rest、开场外的所有时机 |

### 决策引擎（Q13、Q16、Q18、Q25）

**时机**：开场、四段沉默的每一段、话题聊干（沿用现有判定）。被动回复仍由上游自动发起，不经过决策引擎。

**打分**：每个可用候选

```
score = (w_rel·情绪相关 + w_urg·紧迫度 + w_imp·重要性 + w_nov·新鲜度) × 接受率系数 × 疲劳系数
```

- 各分项归一到 [0,1]，计算规则在配置中按 `kind` 定义：例如 `thread_followup` 的紧迫度取决于离事件日期多近；`mood_check` 的情绪相关在上次结束时低落时最高；新鲜度按距上次提这个话题多久衰减。
- 接受率系数（Q25）：`0.5 + (接受 + α) / (接受 + 拒绝 + α + β)`，α=β 为先验（初值 2），结果落在 0.5–1.5。按 `(owner, agent, kind)` 计。
- 疲劳系数：按本次会话和今天已主动的次数递减，各档上限在配置。
- `quiet` 的分数恒等于当前档位的阈值：其他候选都过不了阈值就安静。
- 平分时按配置中的 `kind` 优先级决定，保证确定性、可测试。

**硬规则（打分之前先过滤）**：

- 情绪卡 `crisis`：只允许 `presence_check` / `rest_quiet` / `quiet`，下一轮指令置顶安全提醒（沿用 Plan 4）。不起新话题。
- 用户说了 `quietPhrases`：本会话停止沉默链（沿用）。
- 用户在告别：不主动挽留，只走正常结束（Q6）。
- 同一事项每次会话最多提一次；每次会话主动提事项最多 1–2 件（配置）。
- checkin 只能是 `presence_check`；rest 只能是 `rest_quiet`（Q16）。
- 低落时按情绪应对阶段限制：「了解」阶段不给建议，「安慰」阶段不换话题（ESConv）。

**三档主动程度**（Q18）：

| 档位 | 阈值 | 会话内主动上限 | 说明 |
|---|---|---|---|
| 安静 | 高 | 低 | 开场只做 `greeting_plain` / 到期事件的 `thread_followup`；沉默只保留 checkin 与 rest |
| 适中 | 中 | 中 | 默认 |
| 活跃 | 低 | 高 | 允许 `self_share`、`interest_topic` 更频繁 |

具体数值在 `proactivity.json`。语音调节：命中配置的短语（如「少说点」「别老问我」/「多跟我聊聊」，放在 `config/i18n/<lang>/silence.json` 的新键，匹配沿用 `i18n/text.ts` 的短语规则）把档位降一档或升一档，存入主动偏好，跨会话生效；调节后说一句确认（兜底句组）。

**接受判定**（Q25）：主动开口后 `acceptWindowMs` 内用户有非轻回应 = 接受；说了安静类短语或明确婉拒 = 拒绝；窗口内无回应 = 拒绝；轻回应不计。

### 意图渲染与生成（Q4、Q7、Q14）

- **Qwen**：`IntentRenderer` 用角色 `director.json` 中按 `kind` 的指令模板（`intentInstructions.<kind>`，与现有 `*Instruction` 一样只在仓库维护、不进后台白名单），把材料、语气、约束拼成指令，经 `PushGate` 送出，再 `response.create`。
  - 材料用明确的标记括起来，写明「只能使用括号里的事实，不得补充人名、作品名、地名、数字」。
  - 遵守「打断与沉默」第 3 条：指令里不放可照读的例句；否定句里不出现具体作品名。
  - 不调用文本模型规划器（Q7、Q17）。现有 `planProactiveLine` 在 P3 中移除。
- **三段式链路（以后）**：`CascadeAdapter` 实现 `RealtimeAdapter`，把同一份指令放进大模型提示词，把 `tone` 映射成 TTS 参数。本期只要求契约与渲染器不含 Qwen 专属字段。
- **兜底**：适配器报错或在 `fallbackAfterMs` 内没有开始出声时，从 `fallbackKey` 对应的句组里选一句，按适配器原有的「照读」方式说出（`verbatimFallback` 为真的适配器直接 TTS，否则用 `speakInstruction`）。句组放在角色 `director.json` 的 `fallbacks.<key>`（string[]，可由后台覆盖），每组至少 5 句，按 `(owner, agent)` 记住最近用过的 N 句，不重复。兜底句是配置文案，不写进任何指令（坑位第 9 条）。现有 18 句 `*Text` 在 P3/P4 中并入或改写为这些句组，不再作为固定话术使用。
- **事后核对**：拿到助手本轮转写稿后，按与召回包装相同的规则检查：是否出现材料里没有的 `《》/「」` 作品名、人名、地名、数字；checkin 是否表达了要求的意思。只写一条内容无关的违规日志（违规类型计数），不拦截、不重说。评测把它当作编造证据之一。

### 关系画像（Q9、Q19）

按 `(owner, agent)` 从 `sessions` 表即时推导（不另建表，避免与会话记录不同步；清空角色记忆时随会话记录一起归零）：

- 首次见面时间、会话数、累计分钟数、活跃天数、上次会话时间。
- 作息直方图：24 个小时桶的会话开始次数（用来推断「常在几点来」）。
- 熟悉度档位：由会话数和活跃天数按配置阈值推出（初识 / 熟悉 / 老朋友）。只影响 `tone`：称呼亲近度、是否允许玩笑、回访说多深。

画像不含对话内容，只有计数和时间。

### 事项线（Q10、Q24）

取代 `followups` 和 care（Plan 4 决策 19、20 由本节取代）。

| 字段 | 说明 |
|---|---|
| `kind` | `event`（有日期的事件）/ `concern`（持续牵挂）/ `plan`（计划） |
| `quote`、`source_message_id` | 逐字用户原话及来源；校验沿用 `followups` 的证据规则（坑位第 1、10 条） |
| `due_at` | 仅 `event`：抽取时按会话日期解析「明天」「下周三」等；解析不出就当 `concern` |
| `status`、`close_reason` | `open` / `closed`；关闭原因：用户说已解决、婉拒、过期、被删除 |
| `mention_count`、`last_mentioned_at` | 用于新鲜度与上限 |
| `sensitive` | 健康类必须为 1（坑位第 10 条） |
| `owner_id`、`agent_id` | 隔离（坑位第 13 条） |

生命周期（初值，在配置中调）：

| 类型 | 可提起的窗口 | 上限 | 过期 |
|---|---|---|---|
| `event` | 事件前 1 天内提一次；事件后 0–7 天问一次结果 | 2 次 | 事件后 7 天 |
| `concern` | 距上次提起 ≥3 天 | 3 次 | 14 天无新提及 |
| `plan` | 创建后 3–7 天问一次 | 1 次 | 30 天 |

关闭：用户回应里表示已解决（「好了」「去过了」）或婉拒（「别问了」）由情绪卡的 `need` 或配置短语判定；被回访后用户继续提到同一件事，可以续期（重新抽取时合并）。

### 情绪轨迹（Q12）

- 会话结束时，把会话内的情绪卡序列**确定性聚合**（不调模型）成一条摘要：主导情绪、最高强度、结束时情绪、走向。写入 `episodes.mood` 或新表（计划中定），按 `agent_id` 隔离。
- 决策上下文读最近 N 条，得到「上次结束时是否低落」「近 7 天走向」，供 `mood_check` 打分和 `tone` 的应对阶段使用。
- 会话内的应对阶段：低落时从「了解」开始，用户愿意说下去转「安慰」，情绪回升或用户求助才进入「建议」。阶段推进规则在配置，输入只用情绪卡。

### 反思（Q11）

- 会话结束后异步调用一次共享文本模型（不在关键路径，失败可忽略），从本次会话的**用户陈述**中提炼高层判断，例如「最近常一个人吃午饭」「周三女儿常来」。每条必须带依据的 `message id`，没有依据就丢弃。
- 用途只有一个：决策引擎的打分特征（例如提高 `human_connection`、`routine` 在某些时段的相关性，或选择哪条原话、哪张话题卡）。
- **绝不**进入任何实时模型指令、快照或规划器。真正说出口的，仍然只能是它所依据的那条用户原话（作为 `material`）。
- 依据的原话被删除时，反思结论一起删除。

### 开场（Q15）

已知称呼时：决策引擎在 `session_start` 时机选 `thread_followup` / `mood_check` / `routine` / `greeting_plain` 之一，交给 Qwen 说，材料只有称呼加上被选中的那一项。连接期间预取决策上下文（沿用现有约 1.5s 的窗口，但不再需要等文本模型）；超时或出错时用兜底句组。首次见面和不知道称呼的开场保持现状。

### 四段沉默与话题聊干（Q16）

- 各段时长、`quietPhrases`、`lightPhrases` 的步骤规则、rest 不提问：保留。
- 每段调用决策引擎；context/check/leave 可以选 `quiet`，此时直接进入下一段计时。
- checkin 固定为 `presence_check`，必须表达「我在听、随时可以聊」写在 `constraints`，由事后核对检查；删掉 `silence.ts` 的逐句词表硬校验。
- 话题聊干沿用现有判定和冷却，触发后作为一个时机交给决策引擎。

## 安全与伦理（Q6）

- 不用愧疚感、怕错过、付费等话术挽留；告别时不主动开口。写进人设和指令模板的硬规则，并在评测里单列一个违规检查。
- `human_connection` 定期引导联系家人朋友，必须基于用户提过的原话，不编人名。
- 用户可以用语音把主动程度调到「安静」；`quietPhrases` 立即停止本会话的沉默链。
- `crisis` 时只陪伴、不起新话题，沿用 Plan 4 的安全提醒；会话外紧急联系人仍是 blocker（#59–#65）中的合规项，不在本期。
- 不改变现有 AI 身份提示与 60 分钟休息提醒。

## 隐私、数据与删除（Q24）

- 新增的事项线、情绪摘要、反思结论、关系画像、主动偏好、接受率，只在用户看过记忆告知且未拒绝后写入；用户拒绝记忆时一律不写。
- 删除（按现有四条删除路径逐一接入）：
  - 删 owner：新表都带 `owner_id REFERENCES owners ON DELETE CASCADE`，随现有事务级联。
  - 清空某角色记忆：新表全部加入 `clearAgentMemory` 的逐表列表，并补隔离测试。
  - 删单条与语音「忘掉」：新增「删原话 → 删依据」方向。凡是删除或清空 messages 的路径（`deleteItem` 删来源原话、`forgetMatches` 清空匹配原话、care 原话过期清理），都要同时删除 `source_message_id` 或依据 id 指向这些原话的事项与反思；`forgetMatches` 另按文本匹配事项原话。
  - 删除事项本身时，按现有「条目 → 来源原话」方向一并处理。
- 设置页的「查看和删除记忆」能看到事项、反思结论、情绪摘要（App 侧展示属于以后的计划；本期保证网关已有的查询/删除接口能返回它们，若需要改 protocol，在 P2 开工时停下报告）。后台只增加这些表的条数统计，不显示内容。
- 不存音频；日志不含对话内容。
- 迁移：在 `migrations.ts` 末尾追加 v8；把未关闭的 `followups` 转为 `concern` 类事项，保留原话与 `sensitive`。真实库迁移前按控制台计划 3 的做法用 WAL 安全备份。

## 日志与指标

内容无关，经注入式 Logger（字段名避开 `fieldGuard` 禁用词，例如不用 `quote_*`、`text_*`）。这些事件会自动出现在后台排查时间线里：

- `proactive_decision`：moment、kind、score（两位小数）、candidates、tier、fallback、decide_ms。
- `proactive_outcome`：kind、outcome（accepted / rejected / ignored）。
- `proactive_grounding_violation`：violation_kind、count。
- `proactive_tier_changed`：from、to。
- `post_session_job`：job（extract / mood / reflect / profile）、duration_ms、result_code。

每条回复的首音延迟、生成时间、token、错误码沿用现有指标。

## 配置

**`gateway/config/proactivity.json`**：意图开关与优先级、打分权重、三档阈值与上限、接受率先验与窗口、事项生命周期、熟悉度阈值、`fallbackAfterMs`、兜底去重 N。

- 结构按覆盖层的限制设计：所有可调值都是标量或 string[]，按固定键组织（如 `weights.thread_followup.urgency`、`tiers.moderate.threshold`、`threads.event.followupDays`），不用对象数组，基线里列全所有键（覆盖层不能新增键）。
- 接入步骤：zod schema 与 loader → `ConfigSnapshot` 新字段 → `buildConfigSnapshot` 加载与交叉校验（与 `director.json` 沉默时长、`affect.json` 冷却、`pacing.json` 比较，例如 `fallbackAfterMs` 小于最短沉默段、`acceptWindowMs` 不超过下一个时机），报错文案补 `CODE_MESSAGES` → `sessionDepsFromSnapshot` 映射 → `keys.ts` 增加 `proactivity` 域与 `CONFIG_FILES` 映射。
- 后台：新增「主动互动」场景（`SCENE_IDS`、`AdminConfigSceneId`、`NAV_GROUPS`、路由四处，用通用 `ConfigScenePage`），描述符写成大白话说明卡；三档阈值、上限、生命周期天数、权重等开放调节，接受率先验等内部参数不开放。`config-snapshot.test.ts` 的最小/最大/上限构建测试自动覆盖新描述符。

**角色目录 `gateway/roles/<role>/<lang>/director.json`**：按 `kind` 的指令模板 `intentInstructions.*`（不进后台）、兜底句组 `fallbacks.*`（可进后台，沿用文案场景）、默认档位、禁区话题。

**`config/i18n/<lang>/silence.json`**：档位调节短语。

**弃用**：`silence.ts` 的 checkin 词表硬校验在 P3 删除；后台描述符里复用它的 `rule:'checkin'` 校验（`validate.ts:99`）同步改为只校验长度，或随对应文案键一起移除，P3 开工时按当时描述符确定。

## 失败处理与降级

| 情况 | 处理 |
|---|---|
| 决策上下文预取失败 | 按空上下文决策（只剩 `greeting_plain` / 沉默基本意图），记错误码 |
| 适配器出错或 `fallbackAfterMs` 内未出声 | 兜底句组，不重复 |
| 情绪卡晚到或失败 | 用上一张卡；没有卡时按中性 |
| 会话后任务失败 | 记错误码，下次会话结束重试本次未处理的范围；不影响下次开场（用已有数据） |
| 事后核对发现违规 | 只记日志 |

所有超时与重试走共享策略 helper；错误按 ignorable / retryable / fatal 分类。不能让用户陷入沉默（兜底句保证）。

## 测试与验收

**单元测试（TDD）**：打分与平分规则、硬规则过滤、三档阈值、接受率系数边界（0.5 / 1.5）、事项生命周期与关闭、日期解析、情绪聚合、熟悉度推导、兜底去重、按 `agent_id` 隔离（沿用 `iso_*`）、删除连带、迁移。

**多天合成剧本评测（P1 建基线，P5 复测）**：

- 在 `docs/testing/` 写约 7 天、模拟时钟推进的多会话合成剧本（全部手写，不含真实用户内容）。覆盖：事件前后回访、持续牵挂、低落后的次日开场、长时间沉默、话题聊干、婉拒与要求安静、告别、危机、多角色隔离。
- 复用 `plan4-empathy-eval` 的评委框架与 `eval.json` 的判官参数，新增维度：连续性、自然度、不重复、共情恰当、不打扰、编造次数，另单列挽留话术违规。
- 现有 `scripts/eval.ts` 只跑单会话、无记忆，P1 需要补一个多会话 runner：
  1. 剧本 schema：天、会话、角色、各会话的轮次与沉默、婉拒/要求安静、告别、「当前时间」。
  2. 临时 SQLite + `DeviceRegistry.resolve`，让会话带记忆；按「会话结束 → 抽取 worker 完成 → 下一会话」串行推进。
  3. **只注入墙钟时间，不加速计时器**：引入可注入的 `now()`，贯穿 session、worker、记忆库的时间读写（care 的 7 天窗口、`created_at`、事项到期都依赖它）；沉默计时仍用真实 `setTimeout` 加现有倍速播放，不改 Director 的计时方式，避免触碰沉默链。
  4. deps 用 `sessionDepsFromSnapshot` 从配置快照构造，保证评测和线上同一份配置。
  5. 评委输入包含此前各会话的摘要材料，按会话打分；比较脚本对多次运行取中位数。
- 基线（P1）跑的是改造前的代码：已有 care 跨会话回访、四段沉默规划器，没有事项线和决策层。
- 门槛（Q20）：编造 0 次；连续性、自然度各比基线 +0.5 以上；不打扰、共情不低于基线；plan-a 门槛与现有共情评估不退步。

**回归**（坑位第 11 条）：`npm test -w gateway`、`npm run typecheck -w gateway`，真实记忆库三句召回探针（「上次聊到哪儿了 / 上次聊过电影吗 / 我说过喜欢喝茶吗」= true/true/false，`newTitleFlag` 全 false），跨角色隔离探针。

**里程碑**：真机验收后，小范围真人盲测打分（P5）。

## 坑位契约修订（在对应计划开工时写入 roadmap）

| 条目 | 修订 | 来源 | 计划 |
|---|---|---|---|
| 第 4 条 | 补充：反思结论只给决策层，绝不进入指令、快照、规划器。被决策引擎选中的那一条事项原话（含敏感内容）作为锁定材料进入当次 Qwen 指令（开放项 1 已定）；熟悉度语气说明（固定短语）进入会话指令（开放项 2 已定） | Q7、Q11 | P3 |
| 第 5 条 | 改写：已知称呼的开场由决策引擎选意图、Qwen 说，事实锁定，模板只兜底 | Q15 | P4 |
| 第 7 条 | 删除（Seeduplex 下架） | Q8 | P0 |
| 第 8 条 | 改写：四段沉默由决策引擎运行；checkin 要求改为意图约束 + 事后核对；保留时长、`quietPhrases`、rest 不提问、禁止补充材料外的具体名词 | Q16 | P3 |
| 第 12 条 | 去掉 Seeduplex 相关描述，`PushGate` 规则不变 | Q8 | P0 |

第 1、2、3、6、9、10、11、13、14 条不变。「打断与沉默」各条不变。

## 实施分期（供 writing-plans 细化）

开工前提：控制台计划 3、4 完成（已满足）；「现状事实」已于 2026-10-28 复核。

| 计划 | 内容 | 依赖 | 验收要点 |
|---|---|---|---|
| P0 | 下架 Seeduplex（范围见「现状事实 › Seeduplex 的分布」）：删除实现、`ADAPTER=seeduplex` 与 `SEEDUPLEX_*`、角色卡 `voices.seeduplex`、探针脚本与专属测试、后台当前适配器提示；改写依赖它的测试；更新 `AGENTS.md` 高风险区一行与坑位第 7、12 条。**保留**：`RealtimeAdapter` 与三个能力标记、`session.ts` 中按标记的两处分支（改用 Mock 构造的「无 user text / 照读兜底」假适配器继续覆盖测试，留给 `CascadeAdapter`）、后台 `labels.ts` 的 `seeduplex` 标签（历史通话记录仍可能是该值） | — | 全量测试（protocol / gateway / admin）、三个 typecheck、admin build、Mock smoke、真实 Qwen smoke、真实库活动覆盖层只读核对 |
| P1 | 多会话剧本 runner（可注入墙钟、临时库、快照 deps）+ 剧本 + 评委量表 + 现状基线 | P0 | 基线结果入库，可重复运行，多次运行取中位数 |
| P2 | 数据层：事项线、关系画像、情绪轨迹、反思、主动偏好、接受率与今日计数；v8 迁移；四条删除路径接入（含「删原话 → 删依据」）；会话后异步任务 | P1 | 单元测试、迁移测试、隔离与删除测试、召回探针 |
| P3 | 决策层：`ProactiveIntent`、`ProactiveEngine`、`IntentRenderer`、兜底与事后核对；`proactivity.json` 接入配置快照与后台「主动互动」场景；接入四段沉默和话题聊干；移除沉默规划器与 checkin 词表硬校验 | P2 | 单元测试、评测不退步、坑位第 4、8 条修订 |
| P4 | 开场改造：已知称呼开场走决策引擎；事项线取代 care | P3 | 评测、真机开场、坑位第 5 条修订 |
| P5 | 验收：评测达门槛、真机验收、真人盲测 | P4 | Q20 门槛 |

每份计划单独审批，按顺序执行，每个任务 TDD 后提交。

## 风险与开放项

1. **敏感原话进入实时模型指令**——**已定（2026-10-28，用户）**：健康类等敏感事项原话必须直接作为锁定材料进入 Qwen 指令，不走预取窗口里的文本模型改写。理由：用户语音本来就送往同一家 Qwen 服务。约束不变：只有被决策引擎选中的那一条进入当次指令，不进会话常驻指令、快照或规划器；日志不含原话。（2026-10-29 补充：开放项 3 的渲染方案落地后，健康类事项暂不进实时模型指令，改说兜底句组；本条授权保留，待单独重测健康场景编造为 0 后再放开。）
2. **被动回复是否读取熟悉度语气**——**已定（2026-10-28，用户）**：熟悉度同时影响被动回复。会话开始时由固定短语（按熟悉度档位，放 i18n 配置）拼成一句语气说明，随会话指令下发；会话中熟悉度不变，不需要额外推送。
3. **Qwen 按意图说话的服从度未验证（UNVERIFIED）**：指令中「只能使用括号里的事实」是否足以避免编造，需要在 P3 第一步用最小探针验证；不足时把对应意图降级为兜底句或回到预取窗口内的文本模型生成。结论（2026-10-29）：两种指令写法都未通过（80 次调用，failures 0；写法 A mentionRate 0.96、人工复核编造 4；写法 B mentionRate 0.88、编造 6、超长 1）。数字规则对「两天」「一天」有误报；真编造是材料外的具体细节（按时吃药/服药、医院流程都熟、家里一切都好）。**渲染方案已定（2026-10-29，用户）：按意图分流。** 逐条看结果，写法 A 的 4 条编造全部出在健康场景（health-sensitive 4/5，均为补出「按时吃药/服药」），其余 7 类 35/35 没有编造；写法 B 在非健康场景也有编造（event-before 1、human-connection 1）。因此：(a) 非敏感意图用写法 A 的指令交给 Qwen 说；(b) `sensitive=1` 的事项（健康类）不进实时模型指令，直接说兜底句组 `fallbacks.threadSensitive`（配置文案，不含原话，不含用药、就医建议）；(c) 事后核对增加「材料外健康词」计数（沿用 `config/i18n/<lang>/memory.json` 的 `healthWords`），只记日志、不拦截；(d) 不采用「预取窗口里用文本模型先写好句子」：它与开放项 1、Q7、Q17 冲突，且只覆盖开场。以后要放开健康类，须先加「不得给任何健康或用药建议」的约束，单独重跑健康场景（≥10 次）且编造为 0。样本每类 5 次，35/35 只说明其余 7 类编造率大概率低于约 8%，最终以 P5 的「编造 0 次一票否决」把关。
4. **日期解析**：「下周三」「过两天」的解析可能出错；解析不出就按 `concern` 处理，宁可少提不提错。
5. **接受率冷启动**：先验 α=β=2 让新用户系数接近 1.0；数据少时不应大幅偏移。
6. **作息推断**：会话次数少时直方图无意义；不足阈值时只按时段（早/午/晚）问候。
7. **剧本评测的噪声**：Plan 4 的经验是单场景波动大；门槛按多次运行的中位数判定，次数在 P1 定。

## 安全复核卡

- 威胁面：新增数据（事项、反思、情绪摘要、画像）都在 SQLite 记忆库内，按 `owner_id`/`agent_id` 隔离，作用域键只来自服务端 `SessionContext`。
- 输入校验：模型输出（反思、事项抽取、情绪卡）用 zod 校验并要求原话依据；配置启动时 zod 校验。
- 敏感数据：健康类事项 `sensitive=1`；日志不含任何对话内容；不存音频（L4/L5 数据不落日志）。
- 授权：不新增对外 API；后台查看沿用控制台的 127.0.0.1 + 登录 + 审计。
- 删除与保留：随原话、角色、owner 连带删除；事项有过期；反思随依据删除。
- 操纵防护：挽留话术禁止并纳入评测；用户可降档或静音；危机时不起新话题。
- 依赖：不新增第三方依赖。
- 测试：单元、迁移、隔离、删除、评测、召回探针、真机、真人盲测。

## 参考

- 前置设计：[情感与主动性](2026-10-22-emotion-proactivity-design.md)、[共情补句](2026-10-24-empathy-followup-design.md)、[陪伴记忆](2026-10-17-companionship-memory-design.md)、[多角色](2026-10-26-multi-character-design.md)、[后台管理](2026-10-27-admin-console-design.md)。
- 坑位：`docs/project/roadmap.md`「记忆与回忆：已踩过的坑」「打断与沉默：已踩过的坑」。

## 附录 A：竞品与学术调研摘要（2026-10-28）

标注：**V** = 官方、论文、监管或可信媒体；**U** = 第三方、社区或推断。ElliQ 数据多为厂商或合作方提供。

**主动触发与频率**

- ElliQ：感知到人在附近后，按行为、情绪、偏好、时段决定是否主动；挂在作息上（早上问睡眠、午饭问吃饭）；频率由约 200 名用户的 beta 校准（V，[JARLife 2024](https://www.jarlife.net/4982-elliq-an-ai-driven-social-robot-to-alleviate-loneliness-progress-and-lessons-learned.html)、[ASA Generations](https://generations.asaging.org/staving-loneliness-social-robot/)）。
- Nomi：每角色 4 档间隔；不回复则间隔翻倍；22:00–08:00 静默；聊天中不主动（V，[Nomi](https://nomi.ai/nomi-knowledge/proactive-messaging-when-your-nomi-messages-you-first/)）。
- Character.AI「Away Messages」2024-01 宣布（V，[博客](https://blog.character.ai/ama-recap-and-january-2024-faq/)）；实测多为无内容召回（U）。Replika 只有开关，有凌晨消息（U）。星野、猫箱有开关或好感度触发（U）。
- 小冰：全双工语音、主动来电；沉默时递归向服务端要新内容（V）。
- 学术：Lu et al. ICLR 2025 把「该不该主动」建模为预测问题，最好 F1 66.47%，误报是主要问题（V，[arXiv 2410.12361](https://arxiv.org/abs/2410.12361)）。

**主动内容**

- 小冰话题管理器：无合适回复、重复无新信息、用户敷衍时换话题；按相关、新鲜、个人兴趣、流行度、历史接受率选话题（V，[论文](https://ar5iv.labs.arxiv.org/html/1812.08989)）。
- Pi：上次请它帮忙筹划聚会，下次会问办得怎么样（V，[Forbes 2023](https://www.forbes.com/sites/alexkonrad/2023/05/02/inflection-ai-ex-deepmind-launches-pi-chatbot/)）。
- 主动消息引用真实历史的比例：Nomi 9/11、Kindroid 7/8、Replika 3/14、Character.AI 0/3（U，单人 12 天实测）。

**关系连续**

- Replika：可查看、编辑、删除的记忆页；点赞强化（V，[帮助中心](https://help.replika.com/hc/en-us/articles/37208679176077-How-does-Replika-s-memory-work)）；日记、XP（U）。
- Kindroid：持久 / 级联 / 可检索三层记忆（V，[文档](https://kindroid.ai/docs/article/memory/)）。Nomi：分层记忆 + Identity Core + Mind Map（V）。
- Generative Agents：记忆流按近因 + 重要性 + 相关性检索，定期反思写回，再做计划（V，[arXiv 2304.03442](https://ar5iv.labs.arxiv.org/html/2304.03442)）。MemGPT：核心记忆 + 对话库 + 归档，模型自管理（V）。MSC：带检索或摘要的多会话模型明显更好（V，[ACL 2022](https://aclanthology.org/2022.acl-long.356/)）。
- 未了事项没有公开的专门机制；Pi 是最接近的已证实案例（推断）。

**情绪**

- 小冰共情计算：话题、意图、情绪、观点、画像合成用户共情向量，规则推出回复共情向量；A/B 中日活 50 万 → 510 万（V，[CL 2020](https://aclanthology.org/2020.cl-1.2.pdf)）。
- ESConv：探索 → 安慰 → 行动三阶段、8 种策略（V，[Liu 2021](https://www.alphaxiv.org/abs/2106.01144)）。
- Hume EVI：韵律分数按句以文本交给模型，明确不代表真实情绪（V，[FAQ](https://dev.hume.ai/voice/docs/speech-to-speech-evi/faq)）。

**失败模式与监管**

- 老人对 ElliQ：有人嫌「一直在说话」「强势、侵入」（V，[PMC8297987](https://pmc.ncbi.nlm.nih.gov/articles/PMC8297987/)）；更适合独居、社交少的老人（V）。
- 825 名老人中 69.3% 不接受被误导以为 AI 是人（V，[Frontiers 2023](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2023.1106633/full)）。
- 告别挽留：主流陪伴 App 约 37–43% 在用户告别时用内疚、怕错过等话术（V，工作论文，[HBS](https://www.library.hbs.edu/working-knowledge/how-ai-chatbots-try-to-keep-you-from-walking-away)）。
- Replika：2023 年删除情色角色扮演后用户反映「人格突变」（V，[OECD.AI](https://oecd.ai/en/incidents/2023-03-18-32ef)）；2025-01 FTC 投诉（情绪高点弹付费、情感轰炸）（V，[TIME](https://time.com/7209824/replika-ftc-complaint/)）；2025 年意大利罚款 500 万欧元（V）。
- FTC 2025-09 对 7 家陪伴类公司发调查令（V，[FTC](https://www.ftc.gov/news-events/news/press-releases/2025/09/ftc-launches-inquiry-ai-chatbots-acting-companions)）。
- 《人工智能拟人化互动服务管理暂行办法》2026-07-15 施行：禁止诱导情感依赖与情感操纵、每超 2 小时提醒、提示 AI 身份、面向老年人加强指导与风险提示（V，[网信办解读](https://www.cac.gov.cn/2026-04/17/c_1778166820056328.htm)）；征求意见稿中的紧急联系人等条款是否保留未核实（U）。

**量化**

- ElliQ：beta 每天 6.3 次互动，其中 3.6 次主动；商用约每天 20 次 / 20 分钟；纽约州试点第三年每天 41 次；主动越多，用户自发互动也越多（V-厂商，[NYSOFA](https://aging.ny.gov/system/files/documents/2026/02/nysofa-elliq-project-update-2026.pdf)）。
- 小冰 CPS 23（人类约 9）（V）。

**本设计采纳的原则**：作息优先（ElliQ）→ `routine`；退避与克制（Nomi）→ 疲劳系数、`quiet` 候选、三档；有理由才开口并引用真实记忆（Pi、实测对比）→ 锁定材料；未了事项单独建模 → 事项线；换话题有依据（小冰）→ 话题聊干时机与接受率；分层记忆 + 反思（Generative Agents）→ 反思只给决策层；按阶段共情（ESConv）→ 应对阶段；不挽留、引导真实关系（HBS、FTC、《办法》）→ 安全与伦理硬规则；人格与策略变更要平滑（Replika 2023）→ 分期上线、评测门槛。

## 修订记录

- 2026-10-28 初稿（grilling Q1–Q26）。
- 2026-10-28 控制台计划 3、4 落地后复核（`bf49c4f`），决策不变，修订落地细节：
  - 现状事实：指令模板 19 段（原写 18）；`topics.json` 整个 session 都不用；`episodes.mood` 只被抽取模型读回；补充配置快照、覆盖层、描述符、删除路径、评测框架、日志禁用词、Seeduplex 分布等事实。
  - 架构：配置经快照 → `SessionDeps` 进入会话，跨会话计数存记忆库（原写放在 `SessionContext`）。
  - 配置：`proactivity.json` 按覆盖层限制设计（标量键、基线列全）；接入快照、交叉校验与后台新「主动互动」场景；指令模板不进后台、兜底句组可进后台；档位短语放 i18n `silence.json`。
  - 删除：明确四条删除路径的接入方式，新增「删原话 → 删依据」方向；迁移为 v8。
  - 评测：P1 需新建多会话 runner；只注入墙钟、不加速计时器，不改 Director 计时。
  - P0：列出完整下架范围与保留项（能力标记分支、历史标签）。
- 2026-10-28 用户决定开放项 1、2（见「风险与开放项」）；关系画像改为从 `sessions` 表推导，不另建表（P2 计划编写时定）。
- 2026-10-29 P2 计划落地细节：事项线沿用 followups 表加列（有 quote 且未关闭即事项线）；引用删除用消息表触发器；反思计入 memory_extract 用量类型；设置页数据经 protocol 可选字段返回，App 展示另立计划；清空角色记忆时保留主动档位。
- 2026-10-29 P3-T0 探针结论：Qwen 按意图说话的两种写法人工复核后编造均不为 0，开放项 3 未通过，渲染方案待用户决定（见「风险与开放项」第 3 条）。
- 2026-10-29 用户决定开放项 3 的渲染方案：非敏感意图用写法 A 交给 Qwen，健康类（`sensitive=1`）事项直接说兜底句组；事后核对增加材料外健康词计数（见「风险与开放项」第 3 条）。
- 2026-10-29 P3 后半落地：总览「编写计划时定的取舍」十一条（开场与规划器暂留、ja/en 保持现状、话题聊干只给 selfShare、continueThread 材料与健康类延伸、调档不另说确认句、接受窗口、写库按告知把关、超时兜底、行为变化风险、humanConnection 周上限未做、旧配置文案暂不并入），用户已确认。旅程评测未过 P3 不退步门槛，没有为此改代码或调参。
