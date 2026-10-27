# 多角色与分层记忆设计

## 状态

草案，待用户审阅（2026-10-26）。
- 决策来源：grilling 会话 Q1–Q32、写 spec 时补充的 Q33–Q36。用户已确认全部复述。
- 调研：陪伴类产品的角色分离做法、记忆框架的作用域模型、Character.AI 设计深挖，见文末「参考」。
- 实施计划尚未编写。用户审完本 spec 后写到 `docs/superpowers/plans/2026-10-26-multi-character/`，实现交给另一台电脑执行。

## 背景与目标

App 现在有三个形象：Lily（Duix）、Kai（Duix，年轻男声）、小柔（3D）。网关不知道当前是哪个形象，所有提示词里助手都叫「小暖」，记忆按整台手机（owner）存放。切换形象，说话的还是同一个「小暖」，记得的也是同一套事。

目标：
1. **不同形象就是不同的人。** 每个角色有自己的名字、声音、性格和私有记忆。用户切换角色，对他来说是在跟另一个人聊天。
2. **记忆分两层**（参考 Character.AI 的 Persona + Facts、Kindroid 的全局档案）：少量用户基本资料由所有角色共享，其余记忆归各角色私有。
3. **便于扩展**：加一个角色只需要加一张角色卡和 App 端形象资源，不改流程代码。
4. **参考 Character.AI**：用户可以钉住记忆、查看和删除记忆；对话中提示用户正在和 AI 交流；长时间使用会提醒休息。

现有三个角色改名：Kai → **小凯**，Lily → **小暖**，小柔 → **小欣**。

## 决策记录

| # | 决策 |
|---|---|
| Q1 | 记忆分两层：共享层只放称呼和稳定的基本资料，其余按角色私有 |
| Q2 / Q19 | 网关新增角色卡注册表 `gateway/characters/<id>.json`。提示词里的名字统一改成占位符。`elder-companion` 角色包继续共用 |
| Q3 | 角色之间的差异只在名字、性别、关系定位和一两句个性描述。不适合男性角色的措辞要清理 |
| Q4 / Q5 / Q16 | 不迁移、不兼容旧数据。旧 id、旧存储、旧数据库全部丢弃；数据库 migration 合并成新基线 |
| Q6 | 音色按「角色 × 适配器 × 语言」配置。小欣的音色先和小暖共用，另做探针选定 |
| Q7 | 小凯 Xiaokai / 小凯（シャオカイ）；小暖 Xiaonuan / 小暖（シャオヌアン）；小欣 Xiaoxin / 小欣（シャオシン） |
| Q8 / Q15 / Q21 / Q28 | 本次实现设置页的「我的资料」、各角色「记得的事」，以及三种清除操作 |
| Q9 / Q17 | 本次只交付 spec 和 plan；实现交给另一台电脑 |
| Q10 | 共享层只有 `addressing` 和新增的 `profile` 两类；健康信息永远不进共享层 |
| Q11 | 共享资料只当作「已知的基本情况」，不能说成「上次您跟我说过」。是否初次见面按角色判断 |
| Q12 | 同意和告知按整台手机，只告知一次。`memory_epoch` 分角色级和整机级两层 |
| Q13 | 语音「忘掉」先查当前角色的私有记忆，再查共享层，绝不碰其他角色 |
| Q14 | 角色之间互不知道对方存在 |
| Q18 | 角色只由我们配置，用户不能新建角色、不能修改角色、不能换声音 |
| Q20 | 去掉说话风格（孙辈 / 老朋友），关系定位写进角色卡。首次启动改为选择角色 |
| Q22 | 每个角色与用户是一段连续的关系，不做多段对话 |
| Q23 / Q25–Q27 | 本次实现「钉住」（`pin_memory`）和「你都记得我什么」（`list_memory`） |
| Q24 / Q29 / Q30 | 和 Character.AI 保持一致：聊天页常驻 AI 提示；连续使用每满 60 分钟提醒休息 |
| Q31 | 角色卡和新增文案由本 spec 附录起草，用户审定 |
| Q32 | 手机跑不了 Duix 时不悄悄换人：小凯、小暖置灰并说明原因 |
| Q33 | 用户钉住的健康类记忆可以进完整快照，但不进开场快照和主动接话快照（修订「已踩过的坑」第 4 条） |
| Q34 | 钉住上限为每个角色 10 条，每条 zh 最多 40 字，ja/en 按语言折算。钉住内容完整进提示词，不截断 |
| Q35 / Q36 | 设置页逐条删除时连带删除相关原话。方法：抽取时由模型标注每条事实的来源消息 id，网关校验后保存；删除时按 id 精确删原话；没有来源或校验失败时，退回语音「忘掉」的匹配。私有条目只作用于本角色的原话，共享条目作用于这台手机所有角色的原话 |

## 现状事实（2026-10-26 读代码确认）

**App**
- 角色定义在 `app/lib/identity/characters.dart:4-64`：`lily` / `kai` / `default`。`characterNameForEngine` 按渲染引擎写死角标：Duix 显示 `'Lily'`，否则显示 `'小柔'`（:64）。
- 本地存储有三个 key：`device_token`、`style_id`、`avatar_id`（`device_identity.dart:29-32`）。角色只存在本地，换角色不发网络请求（:97-101）。
- 首次启动：没有 `style_id` 时显示 `StylePickerPage`，选完调用 `register(style:)`（`app_shell.dart:115-131,183-192`）。
- 设置页 `companion_settings_page.dart` 有「聊天风格」和「形象」两块（:78-102）。
- 页面 key 带 style、角色和 epoch（`app_shell.dart:211`），任一变化都会重建会话。
- 垫话音频按风格存放：`assets/filler/{grandchild,old-friend}/`（`thinking_config.dart:67`）。`fillersEnabled=false`（`thinking.json:2`）。
- 引擎回退：
  - 防崩溃保护触发、设备不支持、资源缺失三种情况都会把角色改成 3D（`engine_switch_controller.dart:88-117`）。
  - `saveEngine(webview)` 会把 `avatar_id` 改写成 `default`（`device_identity.dart:114-127`）。
  - `_home` 在引擎和角色不一致时强制显示小柔（`app_shell.dart:203-205`）。
- `GatewayTransport` 只有 `post`、`patch`、`openWebSocket`（`transports.dart:20-35`）。`CredentialStore` 只有 read/write（`credential_store.dart:2-5`）。
- `SelectionCard` 在不可点时没有灰显样式（`companion_picker.dart:9-83`）。
- 聊天页没有常驻提示文字，也没有 toast（`avatar_page.dart`、`overlay.dart`）。
- Duix 模型资源 id 是 `lily` / `kai`（`assets/config/duix.json:13-29`），和角色 id 分开存放。
- 模型包打在 APK 里，由 `DuixInstaller` 拷到手机上（`duix_installer.dart:39`）。`DuixAvailability` 的 `needsDownload` / `downloading` 表示「还没拷」/「正在拷」，由 `choose(duix)` → `installer.start()` 触发（`engine_switch_controller.dart:10,56-60,121-125`）。`hidden` 表示配置关闭或仅限 debug。
- 老年人界面惯例：文字 ≥18sp，触控区 ≥60dp；主按钮高 64、字号 22；标题 26。

**协议与网关入口**
- `session.start` 的 `clientInfo` 带 `voiceProfile?: 'young-male'`（`protocol/src/index.ts:23`，`schemas.ts:8`）。
- `POST /session` 的 body 是空 `{}`（`gateway_client.dart:151`）。网关在这一步解析 bearer、agent 和记忆快照（`server.ts:169-198` → `registry.resolve`），**WS 的 `session.start` 来得比这更晚**。
- `ResponseKind` 有三种：`reply` / `greeting` / `followup`（`protocol/src/index.ts:13`）。
- HTTP 路由（`server.ts:106-166`）：`/healthz`、`POST /session`、`POST /session/resume`、`POST /device/register`、`PATCH /agent/style`、`DELETE /dev/owner/:id`。限流按 IP 分三个桶。
- `register` 使用默认 role 和 style；`resolve` 总是 `ensureAgent(owner, defaultRole)`，所以每个 owner 实际只有一个 agent（`registry.ts:73-128`）。

**角色包与提示词**
- 只有一个角色包 `elder-companion`，两种风格 `grandchild` / `old-friend`，所有音色都是 null（`role.json`）。
- `buildPersona` 的拼接顺序：`safety + style.md + actions + activityDirectory`（`fileCatalog.ts:120-126`）。
- 名字「小暖 / Xiaonuan」出现在以下位置：
  - `{zh,ja,en}/director.json`：开场文案和沉默规划器提示
  - `styles/*.md`
  - `_shared/{zh,ja}/safety.md:12`
  - `_shared/{zh,ja,en}/{care,recall,affect}.md:1`
  - `mock/script.json:2`
  - `scripts/qwen-probe.ts`
- 生产路径已经按语言传入 `roles.recallPrompt(language)`（`session.ts:778`）。`tools/registry.ts:68` 只是不传参数时的 zh 默认值，直接读原始文件。

**音色**
- Qwen 中文默认 `longanlingxin`，日语、英语默认 `Tina`；年轻男声中文 `Ryan`，其他语言 `Evan`（`config.ts:110-136`）。
- Seeduplex 中文默认音色是男声 `zh_male_xiaotian_jupiter_bigtts`，英文是 `en_male_tim_uranus_bigtts`，不支持日语（`config.ts:116-120`、`index.ts:155-159`）。
- 选择顺序：`youngMale` → `roles.voiceFor` → `deps.voiceFor` → `ctx.voice`（`session.ts:759-767`）。切换语言时经 `PushGate` 推送新音色（`:620-636`）。

**记忆库**（`gateway/src/memory/migrations.ts`，共 5 步）
- 结构：`owners`（consent、notified_at、memory_epoch、未使用的 onboarding_stage）→ `agents`（`UNIQUE(owner_id, role_id)`，带 style_id）→ `sessions`。
- 只按 owner、没有 agent 维度的表：`messages`、FTS 外部内容表 `messages_fts`、`user_facts`、`episodes`、`followups`、`memory_changes`。只有 `relationship_notes` 带 `agent_id`，而且没有外键。
- store 方法的作用域：
  - `recentUserMessages`、`searchMessages`、`careFollowup`、`forgetMatches`、`memoryForExtract`、`listFacts` 都只按 owner 查。
  - `listNotes`、`latestEpisode` 没有调用方。
  - `searchMessages` 靠 JOIN `messages` 后的 WHERE 限定 owner，FTS 表本身没有 owner 列。
- 抽取 worker 按 owner 串行排队（`worker.ts:38-69`）。`category` 只做 `string(1..32)` 校验，没有白名单（`extract.ts:19`）。提示词约定了五类：`addressing` / `preference` / `person` / `health` / `other`。`health` 强制设为敏感。writer 降级时还会写入 `safety` 类。
- 快照（`snapshot.ts:71-92`）：
  - 完整快照 = 称呼 + 非敏感事实 + 最近已结束会话里的用户陈述
  - 开场快照 = 不含陈述
  - 主动接话快照 = 不含称呼
  - 预算 `snapshotMaxChars=600`；不缓存，每次重读 store。
- 工具：`perform_action`、`recall_memory`、`forget_memory`、`set_memory_consent`、`get_weather`。owner 和 agent 都取自会话上下文，不取自工具参数（`session.ts:1190-1201`）。
- 工具结果的播报：
  - Seeduplex：用 `speech_text_buffer.commit` 直接念 `fallbackText`。
  - Qwen：发 `response.create`，同时给出「请直接说下面这句话，不要改写」指令（`session.ts:1240-1274`）。
- `wipeOwnerMemory` 会顺带把 consent 改成 `declined`（`store.ts:559-569`）。
- 消息写入的安全链（`memory/writer.ts:52-80`）：
  - 告知/同意闸：`notifiedAt==null` 或 `declined` 时不写。
  - `scanText`：拒绝不可见字符和 reject 短语。
  - `redact`：遮蔽长数字串。
- `TranscriptWriter.append` 和 `insertMessage` 目前没有 `agentId`。
- 称呼按「称呼：<称呼>」存储（`extract.md:35`），渲染时靠 `addressingPatterns` 加标签。`greetingName()` 只认以「称呼：」开头的快照行（`session.ts:1555-1562`）。
- 孤儿清理：每天删除「创建超过 `ORPHAN_OWNER_DAYS`（默认 7 天）且 agents JOIN sessions 一条都没有」的 owner（`store.ts:224-226`）。
- 指令预算（`pacing.ts:111-113`、`instructions.ts:56-82`）：
  - `totalChars = rebuild.contextChars(12000) × triggerRatio(0.8) × languageBudgetRatio`：zh 0.43 → 4128，ja 0.5 → 4800，en 0.8 → 7680。zod 把 `languageBudgetRatio` 上限定在 0.8（`pacing.ts:50`），en 已经到了这个上限。
  - `rebuild.contextChars` 同时是 `modelContextTokenLimit`，决定 rebuild 什么时候触发（`index.ts:168`）。
  - 快照整体用 `clipHead` 截到 `snapshotMaxChars`（`instructions.ts:62`）。
  - 启动时的 `validateBudgets` 要求历史余量 ≥ `summaryMaxChars + minHistoryChars`（1200）。当前 zh/ja/en 的余量只有 1207/1202/1204。
- `onToolCall` 在调用那一刻取一次 `turnUserText`（`session.ts:1189`）；`toolTurn` 只等原回复的播放结束，**不等本句用户 final**。Qwen 的用户转写常常比工具调用晚到。
- 告知流程：`noticePending = notifiedAt===null && consent!=='declined'`（`registry.ts:126`）。开场之后由 Director 播报，经关键词校验后写入 `notified_at`。
- 开场：有称呼时用 `greetingNameTexts` 安全模板，没有称呼时走规划器，规划器失败时用 `greetingText`（`director.ts:549-597`）。
- 主动发声只有一个出口：`requestResponse(kind, {cue, instruction, fallbackText})`（`session.ts:850-870`）。`ProactiveRequest.cue` 的枚举在 `adapters/types.ts:20`。

**必须遵守的已有契约**：`docs/project/roadmap.md` 的「记忆与回忆：已踩过的坑」1–12 条、「打断与沉默：已踩过的坑」1–11 条。本设计只按 Q33 修订第 4 条，其他条目不变。

## 范围

### 本次要做
- 角色卡注册表和三个角色；提示词模板化；音色随角色走。
- 记忆分层：共享 `profile_facts`，其余数据按 `agent_id`（owner × 角色）存放；数据库新基线。
- 「初次见面」开场；角色之间互不知情。
- 语音工具：`pin_memory`、`list_memory`；`forget_memory` 的作用范围改为当前角色加共享层。
- 记忆 HTTP 接口，以及设置页的「我的资料」「X 记得的事」和清除操作。
- 去掉说话风格；首次启动改为选择角色。
- 聊天页常驻 AI 提示；连续使用满 60 分钟的休息提醒。
- Duix 不可用时置灰角色，不悄悄换人。
- 契约：角色 id 列表放进 `protocol/`，并生成 Dart 版本。

### 本次不做
- 用户自建或修改角色、换声音、多套资料、按角色覆盖资料、多段对话、群聊。
- 小欣专用音色：探针选定前和小暖共用，记入 blockers。
- Seeduplex 的女声音色：未验证，记入 blockers。
- 拟人化办法中与多角色无关的条款：紧急联系人（第 12、13 条）、老年人健康使用指导（第 15 条）、数据复制或导出（第 16 条的「复制」部分），记入 blockers 作为上线前的合规项。
- 记忆用量可视化、家属端。

## 产品设计

### 角色

| id | 名字 | 性别 | 渲染 | 关系定位（详见附录 A） |
|---|---|---|---|---|
| `xiaonuan` | 小暖 | 女 | Duix（模型 `lily`） | 贴心懂事的孙女，说话亲近暖和，偶尔撒个小娇 |
| `xiaokai` | 小凯 | 男 | Duix（模型 `kai`） | 阳光精神的孙辈男孩，说话爽朗利落，爱听老故事 |
| `xiaoxin` | 小欣 | 女 | 3D（`default` glb） | 温和踏实的老朋友、老邻居，说话慢条斯理 |

- 默认角色是小暖，选择列表的顺序是小暖、小凯、小欣。
- 原来的两种风格分别落到角色上：孙辈风格给小暖和小凯，老朋友风格给小欣。

### 记忆分层

| 层 | 内容 | 谁能看到 |
|---|---|---|
| 共享层 `profile_facts` | `addressing`（称呼）；`profile`（用户亲口说的、关于自己的稳定基本信息：家乡和居住城市、家里有哪些人、退休前的工作） | 所有角色 |
| 角色私有层 | `preference`、`person`、`health`（敏感）、`other`、`safety`、钉住的记忆、原话及检索、episodes、关系备注、care 跟进、会话记录 | 只有该角色 |

- 健康信息永远不进共享层，哪怕用户是对某个角色说的「我有高血压」。
- 共享资料只当作「已知的基本情况」，提示词里用「基本情况：」标注，和「用户：」原话区分开。角色不能说「上次您跟我说过您住北京」；「上次聊过什么」只能来自该角色自己的会话。
- 角色之间互不知情。提示词里不出现其他角色的名字。用户提到「小暖跟我说过……」时，角色把小暖当成用户认识的另一个人来接话，不说自己听过，也不编造。

### 开场

每次开场按下表选一种：

| 情形 | 开场 |
|---|---|
| 这个角色和用户没有已结束的会话，且没有称呼 | 规划器自我介绍为该角色并问称呼（现有逻辑，名字换成占位符）；失败时用角色卡的 `greetingNoName` |
| 这个角色和用户没有已结束的会话，但共享层有称呼 | 角色卡 `greetingsFirstMeet` 里的安全模板，随机取一条，带 `{name}`。是「初次见面」的语气，不问称呼 |
| 有已结束的会话 | 现有逻辑不变：有称呼时用 `greetingNameTexts` / care 开场，否则走规划器 |

- 记忆告知仍按整台手机只播一次，由第一个开口的角色播。之后认识的新角色不再重复告知。
- 「有称呼时不走规划器」这条契约（已踩过的坑第 5 条）保持不变，初次见面模板也是安全模板。

### 语音能力

**钉住：`pin_memory`**
- 模型在用户明确说「记住……」「你要记住……」「把刚才那句记下来」时调用。参数是 `{target: 'this' | 'previous'}`，**不接收模型改写的内容**。
- 网关取用户真实的转写，前提是本句 final 已经进入 ledger（见技术设计第 6 节）：
  - `this`：取本句，去掉配置里的触发词前缀和尾部语气词后作为内容。
  - `previous`：取 ledger 里本句之前的那一句用户 final。
  - 不用助手的话，也不用问句。去掉触发词后为空的、少于 2 个字的，拒绝钉住，播「没听清要记什么」。
- 写入安全链和消息写入一致：
  1. 告知/同意闸：已拒绝时播「您之前说过不用我记，这个我就不记了」；告知还没播完时播「这个等会儿再跟我说一遍」。都不写入。
  2. `scanText`：reject 就拒绝，播「没听清要记什么」。
  3. `redact`：遮蔽长数字串。
  4. 规范成单行。
- 写入当前角色的 `pinned_memories`。健康内容的敏感判定：用配置的健康词表初筛，结果可以在设置页查看。
- 网关直接播报配置里的确认句，不复述内容。
- 钉住后，本次会话的快照经 `PushGate` 在缝隙刷新（已踩过的坑第 12 条），下一轮回复就能用上。
- 每个角色最多钉 10 条，每条 zh 最多 40 字，ja/en 按语言折算（Q34，可配置）。超过字数的内容拒绝钉住，并播报配置好的提示，不截断，避免记错。满了就播报满额提示，引导用户去设置页删除，不自动挤掉旧的。
- 钉住的记忆不会被压缩或替换；抽取器看不到，也不能修改。只能通过语音「忘掉」或设置页删除。

**查看：`list_memory`**
- 用户问「你都记得我什么」时调用。
- 内容和顺序：钉住记忆（新的在前）→ 共享层的 `profile` → 当前角色的私有事实。最多 5 条，可配置。称呼不念也不计数。不念原话和 episodes。
- 用模板拼接播报，不经过文本模型，零幻觉。
- 健康类不念出来，只附一句配置好的提示（「身体方面的事在设置里能看到」）。
- 没有记忆时播报配置好的空结果文案。

**忘掉：`forget_memory`**（改动作用范围）
- 匹配范围：当前角色的私有表和钉住记忆，加上共享层。绝不碰其他角色的私有数据。
- 删到共享层的条目时，所有角色都会忘记。确认句不点名其他角色。
- 原话只删当前角色的。这和设置页删除共享条目时删所有角色的原话（Q35）**有意不同**：语音是在某个角色面前说的，设置页是用户对整台手机的操作。实现时不要「统一」这两处。

**拒绝记忆：`set_memory_consent`**：保持按整台手机。用户确认拒绝后，清空所有角色和共享层的记忆，consent 改为 `declined`。

### 设置页

```
设置
├─ 选择陪伴角色        小暖 / 小凯 / 小欣（大卡片，带副标题；不可用的置灰并说明原因）
├─ 我的资料            称呼（可修改，1–20 字）+ 基本资料条目（逐条删除）
│                     [清除我的基本资料]
├─ 小暖记得的事        钉住的事 / 其他记忆，分两栏，逐条删除（含健康类，本人手机可见）
│                     [清除小暖的记忆]
├─ 小凯记得的事        同上
├─ 小欣记得的事        同上
└─ [清除全部记忆]      保留设备注册、角色选择和记忆同意状态
```

- 所有删除都要二次确认，大字显示，确认对话框沿用 `engine_confirm_dialog.dart` 的样式。删除立即生效。
- 正在聊天时删除：网关先结束当前会话，App 删除成功后 bump 页面 epoch 重新开始会话。新会话的快照里不会再有被删的内容。
- 逐条删除（Q35/Q36）：删除条目本身，再删除它的来源原话。
  1. 优先按条目保存的 `source_message_ids` 精确删除。钉住条目的来源就是被钉住的那句话。
  2. 没有来源 id 的条目，再用条目文本作为查询，走和语音「忘掉」同一套匹配（`forgetMatches` 的消息部分）尽力删除。
  - 私有条目和钉住条目只作用于该角色的原话；共享条目作用于这台手机所有角色的原话。
  - 有来源 id 的条目，删除后回忆检索、最近陈述、抽取都不会再用到来源原话。没有来源 id 的条目只能尽力删除，确认框统一写「相关聊天原话会一起删除」，不对用户区分这两种情况。
- 清除某个角色的记忆，范围是：该角色的私有表、钉住记忆、消息、会话记录。保留 agent 行，把 agent epoch 加一。这个角色下次见面会按「初次见面」开场。
- 清除全部记忆：所有角色都按上一条清除，再清空共享层。保留 owners、devices、agents 行和 consent。
- 修改称呼时覆盖共享层的 `addressing`，只保留一条。只存纯名字，最多 20 字，同样经过 `scanText`、`redact`、单行化。已拒绝记忆时不能修改，App 提示「您选了不让伙伴记事，所以不能保存称呼。想恢复的话，直接跟伙伴说『可以记住』就行。」

### AI 提示与休息提醒

- 聊天页顶部常驻一行小字「我是 AI 陪伴，不是真人」，不少于 18sp、半透明，不挡住形象的脸。文案写在 App 配置里。
- 休息提醒：
  - 网关按整台手机计算连续使用时间：会话之间间隔小于 10 分钟算连续，所以切换角色不清零。
  - 连续满 60 分钟提醒一次，之后每 60 分钟提醒一次。
  - 提醒在空档播报：不在回复中、用户没在说话、不在工具轮里。由当前角色念一句配置好的文案。
  - 和四段式沉默链的关系：提醒到点时如果沉默链正在等某一段，提醒就占用这一段的位置播出，播完后沉默链从 context 段重新计时，提醒算作 assistantText。提醒不触发 checkin，也不计入沉默链的 previousTexts 去重。
  - App 收到 `response.start{kind:'reminder'}` 后，用这一轮的字幕文本弹出 toast。
  - 用户接着说话就继续聊，不中断会话。
  - 三个阈值都写在配置里。

### Duix 不可用

按 `DuixAvailability` 的状态分别处理：

| 状态 | 小暖、小凯在选择页上 |
|---|---|
| `unsupported`、防崩溃保护已禁用 | 置灰，不可选，附上原因（复用 `engine_copy.dart` 的文案） |
| `needsDownload`（模型还没拷到手机） | 可选。选中后调用 `installer.start()`，卡片上显示「正在准备形象」和进度，准备好之后进入聊天 |
| `downloading` | 可选，显示进度；准备好之后进入聊天 |
| `checking` | 显示加载中，暂不可选 |
| 拷贝失败（`InstallFailed`，比如空间不足） | 可选，可以重试，显示原因：空间不足时复用 `downloadFailed('no_space')`；其他失败用新文案「形象准备没成功，请重试」。现有的「请检查网络」不适用，因为模型是从 APK 里拷贝的 |
| `hidden`（配置关闭或仅限 debug） | 不显示 |
| `ready` | 正常 |

- 首次启动默认高亮小暖；小暖不可选时高亮小欣。
- 运行中 Duix 出错，或启动时防崩溃保护触发：不自动换成小欣。显示原因并回到角色选择页，由用户自己选。
- 角标和标题都按角色显示，删除 `characterNameForEngine`。

## 技术设计

### 1. 契约

- `protocol/src/characters.ts`：`export const CHARACTER_IDS = ['xiaonuan', 'xiaokai', 'xiaoxin'] as const; export type CharacterId = ...; export const DEFAULT_CHARACTER_ID = 'xiaonuan'`。
- 新增 `scripts/generate-character-ids.mjs`，参照 `generate-avatar-catalog.mjs`，生成 `app/lib/identity/character_ids.generated.dart`，支持 `--check`。
- 交叉校验：
  - 网关启动时检查角色卡 id 集合等于 `CHARACTER_IDS`，否则退出。
  - App 测试检查 `assets/config/characters.json` 的 id 集合等于生成的列表。
- `POST /session` 的 body：`{ character: CharacterId }`。zod 用 `z.enum(CHARACTER_IDS)` 校验，非法值返回 400 `unknown_character`；缺少该字段时按 `DEFAULT_CHARACTER_ID` 处理，这是为了方便 Mock 和开发会话。
- `session.start`：删除 `voiceProfile`，其他不变。
- `ResponseKind` 新增 `'reminder'`。App 遇到未知 kind 时按 reply 处理，向后兼容。
- `POST /device/register`：body 删除 `style`。
- 删除 `PATCH /agent/style`。
- 新增记忆接口，见第 7 节。

### 2. 角色卡

文件：`gateway/characters/<id>.json`。启动时用 zod 校验，并按 `CharacterRegistry` 注册。字段参考 Character Card V2：

```jsonc
{
  "id": "xiaonuan",
  "role": "elder-companion",          // which role pack provides the rules
  "gender": "female",                 // female | male
  "names": { "zh": "小暖", "ja": "小暖", "en": "Xiaonuan" },
  "readings": { "ja": "シャオヌアン" }, // optional, spoken form for TTS
  "identity": {                       // per language, inserted into persona.md (relationship + personality)
    "zh": "……", "ja": "……", "en": "……"
  },
  "greetingNoName": { "zh": "……", "ja": "……", "en": "……" },
  "greetingsFirstMeet": { "zh": ["……{name}……"], "ja": [...], "en": [...] },
  "voices": {
    "qwen": { "zh": "longanlingxin", "ja": "Tina", "en": "Tina" },
    "seeduplex": { "zh": null, "en": null }   // null = adapter default
  },
  "extensions": {}                    // namespaced keys only, e.g. "avatar/duixModel"
}
```

校验规则：
- 必须覆盖角色包的所有 `supportedLanguages`。
- `greetingsFirstMeet` 每条都必须含 `{name}`，长度上限按语言分别是 zh 40 / ja 50 / en 100 字符。
- `identity` 不能出现其他角色的名字。
- `extensions` 的键必须带命名空间。

Seeduplex 不支持日语，因此只有 zh/en 两项。

`CharacterRegistry` 接口：`ids()`、`get(id)`、`name(id, lang)`、`spokenName(id, lang)`、`voiceFor(id, adapter, lang)`、`roleOf(id)`。

### 3. 提示词模板化，去掉风格

- 删除 `styles/` 目录。合并成 `roles/elder-companion/<lang>/persona.md`：以 old-friend 的通用规则为底，去掉「撒娇」等性别化措辞；把开头的身份段换成 `{{char}}` 和 `{{charIdentity}}`。
- `buildPersona(characterId, language)` = `safety + persona(替换后) + actions + activityDirectory`。
- 占位符：
  - `{{char}}`：该语言的名字。
  - `{{charSpoken}}`：日语用 `readings.ja`，其他语言同 `{{char}}`。
  - `{{charIdentity}}`：角色卡 `identity[lang]`。
- 使用占位符的文件：
  - `director.json`：开场、规划器、`greetingText` 系列
  - `_shared/*/safety.md`：en 补上「{{char}} 是你的名字，不要用来称呼对方」
  - `care.md`、`recall.md`、`affect.md`
  - `mock/script.json`、`scripts/qwen-probe.ts`
- 替换在 catalog 加载时按「角色 × 语言」完成，结果缓存在 catalog 里（启动时构建，进程内不可变）。替换后如果还残留 `{{`，启动就失败。
- 新增一个测试：`gateway/roles/**` 里不能出现任何角色名的字面量。
- `safety.md` 增加一条互不知情的规则：「用户提到你不认识的名字时，当作用户认识的人来接话；不说自己听过，也不编造。」
- `recallPrompt`、`carePrompt`、`affectPrompt` 的 getter 都改成接收 `(characterId, language)`，返回替换后的文本。删掉 `tools/registry.ts:68` 直接读原始文件的默认值，避免把没替换的 `{{char}}` 带进去。
- `RoleCatalog` 删除 `defaultStyle`、`hasStyle`、styles 相关的 `voiceFor`；`role.json` 删除 `styles`、`defaultStyle`、`voices`。
- 音色选择改为：`characters.voiceFor(character, adapter, lang)` → 为 null 时用现有的环境变量默认值。删除 `useYoungMaleVoice`、`youngMale*` 配置、`voiceProfile` 分支，以及 `QWEN_VOICE_YOUNG_MALE*` 环境变量。
- 小凯的卡片沿用 Ryan/Evan，roadmap 记录过「`Evan` 把 `～` 念成横杠」，所以中文必须是 Ryan。

### 4. 数据库新基线

把 5 个 migration 合并成一个基线，`user_version` 记为 6。`migrate` 现在的规则是「第 i 步把版本设为 i+1」，要改成带偏移：基线是第 6 版，后续步骤从 7 开始。读到 1–5 时直接抛错：`memory db predates multi-character schema; delete it`。读到比代码新的版本时，沿用现有的报错。之后仍然只追加新步骤。开发机需要删除 `$MEMORY_DB_PATH`。

```sql
owners(id PK, created_at, last_seen_at,
       memory_consent CHECK IN ('unknown','granted','declined') DEFAULT 'unknown',
       notified_at, memory_epoch DEFAULT 0)              -- onboarding_stage dropped (unused)
devices(id PK, owner_id FK CASCADE, token_hash UNIQUE, created_at, last_seen_at)
agents(id PK, owner_id FK CASCADE, character_id TEXT NOT NULL, created_at,
       memory_epoch INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_id, character_id))
sessions(id PK, agent_id FK CASCADE, started_at, ended_at)
messages(rowid PK, id, session_id, owner_id FK CASCADE, agent_id FK CASCADE, role, text,
         bigrams, extracted, excluded, created_at)
messages_fts (unchanged external-content FTS5 + 3 triggers)
profile_facts(id PK, owner_id FK CASCADE,
              category CHECK IN ('addressing','profile'), text, confidence,
              source_session_id, source_message_ids TEXT NOT NULL DEFAULT '[]', updated_at)
agent_facts(id PK, owner_id FK CASCADE, agent_id FK CASCADE,
            category CHECK IN ('preference','person','health','other','safety'),
            text, sensitive, confidence, source_session_id, source_message_ids TEXT NOT NULL DEFAULT '[]', updated_at)
pinned_memories(id PK, owner_id FK CASCADE, agent_id FK CASCADE, text, sensitive,
                source_session_id, source_message_id, created_at)
relationship_notes(..., agent_id FK CASCADE)
episodes(..., agent_id FK CASCADE)
followups(..., agent_id FK CASCADE, quote, sensitive, created_at)
memory_changes(id, owner_id FK CASCADE, agent_id NULL, table_name, row_id, op, diff, actor, created_at)
meta(key PK, value)
-- indexes: messages(agent_id, created_at), messages(agent_id) WHERE extracted=0 AND excluded=0,
--          agent_facts(agent_id), pinned_memories(agent_id), profile_facts(owner_id)
```

- `agents.role_id` 和 `style_id` 删除，role 由角色卡决定。
- 所有带 `agent_id` 的表同时保留 `owner_id`，用于整机删除、retention 和审计。
- 写入时校验 agent 属于该 owner：在同一事务里 `SELECT 1 FROM agents WHERE id=? AND owner_id=?`。
- `profile_facts.addressing` 只存纯名字。抽取结果「称呼：X」由 writer 去掉标签后再存。渲染快照时按会话语言加上 `PROMPT_LABELS` 里的称呼标签（zh「称呼：」，ja/en 用现有标签），保证 `greetingName()` 仍然能识别。
- 孤儿清理的条件改为「创建早于截止时间，且没有任何 agent 行」。agent 在 `POST /session` 时创建，清除记忆不删 agent 行，所以清除之后设备注册不会被误删。

### 5. 记忆读写路径（防泄漏）

**原则**：作用域键只来自服务端的 `SessionContext`（`ownerId`、`agentId`、`characterId`），永远不取自工具参数、模型输出或 HTTP body 里的 owner。HTTP 接口里的 character 只用来在 token 对应的 owner 下找到 agent。

| 功能 | 新作用域 |
|---|---|
| `TranscriptWriter.append` / `insertMessage` | 写入 `owner_id + agent_id`，都取自 `SessionContext`；安全链不变 |
| `recentUserMessages` / `searchMessages` / `searchMessagesLike` | `agent_id`。FTS 通过 JOIN `messages` 后加 `WHERE m.agent_id=?` 过滤 |
| `careFollowup` / `closeCareFollowup` | `agent_id` |
| 快照的 addressing | `profile_facts`（owner） |
| 快照的 facts | `profile_facts.profile`（owner）+ `agent_facts` 中的非敏感项（agent）+ `pinned_memories`（agent） |
| `memoryForExtract` | `profile_facts`（owner）+ 本 agent 的 `agent_facts` / notes / episodes / 未完成的 followups |
| `listPendingMessages` | `agent_id` |
| 抽取队列 | 仍按 owner 串行。任务键是 `(ownerId, agentId)`，一次只处理一个 agent 的待抽取消息 |
| `writeExtraction` | `addressing` / `profile` 写入 `profile_facts`，其余写入本 agent 的 `agent_facts`。update/remove 同时校验 `id + owner_id + (agent_id 或共享表)` |
| `forgetMatches` | 本 agent 的私有表 + `pinned_memories` + `profile_facts` |
| epoch | 抽取开始时读取 `(owners.memory_epoch, agents.memory_epoch)`，写入前在同一事务里复核两者。清除角色 bump agent epoch；清除共享层、清除全部、拒绝记忆、忘掉命中共享层时 bump owner epoch |

**快照视图**（修订已踩过的坑第 4 条，Q33）：
- 完整快照 = 称呼 + 基本情况（profile）+ 钉住的记忆（**包括敏感项**）+ 本角色的非敏感事实 + 本角色最近已结束会话里的用户陈述。
- 开场快照 = 称呼 + 基本情况 + 钉住的非敏感项 + 本角色的非敏感事实。
- 主动接话快照 = 基本情况 + 钉住的非敏感项 + 本角色的非敏感事实，不含称呼。
- 自动抽取的敏感事实、episode、关系备注、助手原话仍然一律不进提示词。
- 标签：
  - 基本情况：zh `基本情况：`
  - 钉住：zh `用户让你记住：`，属于用户原话
  - 原话：`用户：`，现有标签
  - 新标签的 ja/en 版本加进 `PROMPT_LABELS`，见附录 B。
- **预算：钉住块不放在快照字符串里。** 快照会被 `clipHead` 截断，所以钉住块作为 `buildInstructions` 的独立一段，渲染在快照之前，永远不截断。
  - `InstructionBudget` 新增 `pinnedMaxChars`，等于 `pinMaxPerCharacter × pinMaxChars`。`pinMaxChars` 按语言分别配置（`{zh, ja, en}`），因为英文同样的意思需要更多字符，具体数值由 plan 按 Q34 定。`historyBudget` 计算时把这一段按满额预留。
  - 各语言的 `languageBudgetRatio` 加大相应比例，保证历史余量仍然 ≥ 1200。en 的 zod 上限从 0.8 放宽到 0.9。**不改 `rebuild.contextChars`**，否则三种语言都会推迟 rebuild。具体数值由 plan 按 Q34 的上限和上面的公式计算，启动时由 `validateBudgets` 校验。
  - 运行时不截断钉住块。配置超出预算时启动失败。

**抽取提示词**：`extract.md` 新增 `profile` 类，定义见「记忆分层」；`person` 只记具体事件。代码层用 `z.enum` 白名单校验 category，不在白名单里的 op 直接丢弃并计数，日志只记计数。

**来源标注（Q36）**：
- 渲染抽取输入时，给本次的每条用户消息加一个短编号（`u1`、`u2`……），只在本次运行内有效，由网关映射回 `PendingMessage.id`。现有的抽取输入只含用户行（`worker.ts:109`），保持不变。
- `user_facts` 的 add/update op 新增字段 `sources: string[]`，列出依据的用户消息编号。**只在提示词里要求必填；zod 层设为可选，缺省为 `[]`**。`parseExtractOps` 是整批解析，一个 op 失败整批就失败，而 worker 遇到解析失败不推进水位（`extract.ts:128-131`、`worker.ts:144-150`）。缺失和非法统一按「来源为空」处理并计数，不让整批失败。
- 网关校验：编号必须属于本次输入里的用户消息，也就是本 agent 的消息。不合法的编号丢弃并计数；全部不合法时照常写入事实，但 `source_message_ids` 为空，删除时退回匹配。
- update 时把新来源和已有来源取并集。来源原话被语音「忘掉」或 retention 删掉之后，`source_message_ids` 里的悬空 id 在删除时直接忽略，不报错。
- 这一改动属于高风险区（抽取只以用户原话为依据，坑位第 10 条）：编号只用于追溯来源，不改变「只看用户原话」的抽取规则。

**初次见面判断**：新增 store 方法 `hasEndedSession(agentId)`。

**连续使用计时**：新增 store 方法 `continuousSince(ownerId, now, gapMs)`。它跨该 owner 的所有 agent，从最近的会话往前回溯，相邻会话间隔小于 `gapMs` 就算连续。

### 6. 工具

- `pin_memory`：`{target: enum['this','previous']}`，strict 模式。
  - **新增「等本句 final」机制**（现在没有）：
    - 工具调用到达时，如果本轮 `turnUserText` 为空，handler 就 await 一个 `nextUserFinal` promise，`onUserFinal` 写入 ledger 后 resolve 它。
    - 等待上限是 `pinFinalWaitMs`（默认 4 秒），超时就播「没听清要记什么」。
    - `dropUserFinals` 为 true 时，本句 final 不进 ledger。这时 promise 直接带回本句文本，只用来钉住，不进入回复流程；`previous` 取 ledger 里最后一条用户发言。
    - 会话结束或打断时返回 null（不 reject），不留悬挂。
  - `this` / `previous` 都以「本句 final 已经在 ledger 里」为前提来定位。
  - 写入前走第 5 节的告知/同意闸，再过 `scanText`、`redact`、单行化。
  - 来源消息 id：`TranscriptWriter.append` 改为返回 `{ result, messageId? }`。Session 记下最近两条用户 final 的消息 id，供 `this` 和 `previous` 使用。`dropUserFinals` 为 true 时本句不写入 `messages`，这时 `source_message_id` 为 null，删除时退回匹配。
  - 触发词列表和健康词表放在 `config/i18n/<lang>/memory.json`。
- `list_memory`：无参数。返回 `spokenText`（模板拼接），走现有 grounded 播报路径。Seeduplex 直接 TTS，Qwen 用「请直接说下面这句话，不要改写」，不经过 `toolContinueText`。
- `forget_memory` / `recall_memory`：接口不变，作用域按第 5 节调整。
- 都在 `tools/registry.ts` 里注册，不在会话流程里加 if-else 分支。

### 7. 记忆 HTTP 接口

所有接口都要求 `x-app-secret` 和 `Authorization: Bearer <device token>`，只作用于该 token 对应的 owner。新增一个限流桶 `memory`，默认 60 次/60s，可配置。响应头带 `Cache-Control: no-store`。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /memory` | — | `{ profile: { addressing: {id,text}\|null, items: [{id,text}] }, characters: [{ character, pinned: [{id,text,sensitive}], facts: [{id,text,category,sensitive}] }] }`。`characters` 按 `CHARACTER_IDS` 的顺序包含全部角色，没见过面的角色返回空列表 |
| `PUT /memory/addressing` | `{ text: string(1..20) }`，经过 `scanText` / `redact` / 单行化 | 204；已拒绝记忆时返回 409 `memory_declined`；`scanText` 拒绝时返回 400。不检查「告知是否播完」：设置里手输的称呼不是对话原话，这是有意的 |
| `DELETE /memory/items/:id` | id 为 uuid，可以是 profile、agent_facts 或 pinned 的条目 | 204，并按 Q35/Q36 连带删除来源原话；不属于该 owner 或不存在时返回 404，两种情况不区分 |
| `DELETE /memory?scope=profile` | — | 204 |
| `DELETE /memory?scope=character&character=<id>` | id 必须在注册表里 | 204 |
| `DELETE /memory?scope=all` | — | 204。consent 保持不变，所以不能复用 `wipeOwnerMemory` |

- 所有写操作的顺序：
  1. 先 `manager.endOwner(ownerId, 'memory_changed')`，不让会话再写入新消息。
  2. 在同一个 immediate 事务里 bump 对应的 epoch、删除数据、写 `memory_changes`（diff 置空，只记操作）。
  - 结束会话触发的 flush 抽取会因为 epoch 已变而被判为 stale，不会写回。被删的消息已经不存在或已标记 excluded，不会再被重新抽取出来。
- 删除消息通过 FTS 触发器同步删除。测试要覆盖：删除之后 FTS 搜不到。
- 所有 body 和 query 都用 zod 校验，失败返回 400。
- 日志只记事件名、scope、条数和耗时。

### 8. 会话流程

1. App 调用 `POST /session {character}`。
2. `registry.resolve(bearer, character)`：`ensureAgent(owner, character)`，读取 `hasEndedSession`、`continuousSince`，渲染三种快照视图。
3. `SessionContext` 新增 `characterId`、`firstMeet`、`continuousSince`；删除 `roleId`（改由角色卡推出）和 `styleId`。
4. 之后的流程不变。
5. 休息提醒的计时器由 Session 维护，和 slim 计时器一样在 `end()` 时清理。到点后交给 Director，在下一个空档调用 `requestResponse('reminder', {cue:'restReminder', instruction, fallbackText})`；如果正处在回复、用户说话或工具轮中，就推迟到这些结束之后。
   - `instruction` 沿用工具 spokenText 已有的写法：「请直接说下面这句话，不要改写：<文案>」。不放可以照读的例句，也不放否定句（已踩过的坑第 3 条）。Seeduplex 直接念 `fallbackText`。
   - 不经 `PushGate`，因为提醒是一次回复，不是 session update。
   - 和沉默链的交互见「产品设计 → AI 提示与休息提醒」。
6. `eval`（`src/eval`、`scripts/eval.ts`）的 `--style` 改为 `--character`；`make-filler-clips.ts` 同样改为 `--character`。

### 9. App

- **角色配置**：`app/assets/config/characters.json`，每项包括 `id`、`title`、`subtitle`、`engine`（duix/webview）、`duixModel` 或 `webviewAvatar`，列表顺序就是显示顺序。`characters.dart` 改为从这个文件加载；`isCharacterId` 等函数基于生成的 id 列表。
- **AI 提示文案**：放在新文件 `app/assets/config/companion.json`，包括 `aiCaption` 和 `restToastMs`。
- **首次启动**：`CharacterPickerPage` 替代 `StylePickerPage`。选好后调用 `register()`（无参数），本地保存 `character_id`。删除 `style_id`、`avatar_id`、`styles.dart`、风格设置 UI 和 `patchStyle`。
- **请求 body**：`NativeGatewayClient` 在 `POST /session` 的 body 里带上 `{character}`；`SessionStart` 删除 `voiceProfile`。
- **网络和存储**：`GatewayTransport` 增加 `get`、`put`、`delete`；`CredentialStore` 增加 `delete`。新增 `MemoryApi`，401 时复用 `renew` 重试一次。
- **设置页**：`CompanionSettingsPage` 重做为四块：选择角色、我的资料、各角色记得的事、清除全部。列表数据来自 `GET /memory`。删除成功后调用 `onMemoryChanged`，bump 页面 epoch。
- **引擎**：`EngineSwitchController` 不再 override 成 webview，改为按「产品设计 → Duix 不可用」的表格输出每个 Duix 角色的可用性、原因和准备进度。`saveEngine` 不再改写角色。`_home` 只显示已保存的角色；保存的角色不可用时进入选择页并提示原因。`SelectionCard` 增加置灰样式。
- **聊天页**：`AvatarPage` 增加常驻 AI 提示；收到 `response.start{kind:'reminder'}` 后，用这一轮的 assistant 字幕弹出 toast（字号 ≥ 18）。
- **垫话音频**：改为 `assets/filler/<characterId>/`。先放现有的占位片段，`fillersEnabled` 仍为 false。`thinking.json` 的 `styles` 改为 `characters`。
- **Duix 模型**：`DuixAvatarEngine(modelId)` 的 modelId 来自角色配置的 `duixModel`，`duix.json` 的模型 id 不变。

### 10. 配置（新增与修改）

| 文件 | 键 |
|---|---|
| `gateway/config/memory.json` | `pinMaxPerCharacter=10`、`pinMaxChars: {zh: 40, ja: 50, en: 50}`（Q34。en 受 0.9 比例上限约束，100 放不下，算式见 plan Task 4）、`pinFinalWaitMs=4000`（钉住等待本句转写的上限）、`listMaxItems=5`；`pinnedMaxChars` 由前两项相乘得出，不单独配置 |
| `gateway/config/pacing.json` | `restReminder: { firstAfterMs: 3600000, everyMs: 3600000, continuityGapMs: 600000 }` |
| `gateway/config/i18n/<lang>/memory.json` | `pin.{confirmText, fullText, emptyText, triggerPrefixes[], toolDescription, targetDescription}`、`list.{introText, itemJoiner, sensitiveHint, emptyText, toolDescription}`、`healthWords[]` |
| `gateway/config/i18n/<lang>/*.json`（或 director.json） | `restReminderText`，见附录 B |
| 服务端限流配置 | `MEMORY_RATE_LIMIT`，默认 60/60s |
| `app/assets/config/characters.json`、`companion.json` | 见第 9 节 |

所有新配置都用 zod 校验。交叉校验：pinned 预算并入 `validateBudgets`；`restReminder.everyMs ≥ firstAfterMs / 2`；角色卡 id 集合等于 `CHARACTER_IDS`。

## 错误处理

- 未知角色：`POST /session` 返回 400 `unknown_character`，App 进入选择页。
- 角色卡或占位符校验失败：网关启动失败，并给出明确原因。
- 旧数据库（`user_version` 为 1–5）：启动失败，提示删除数据库文件。
- 记忆接口失败：App 显示「没删成功，请再试一次」，不更新本地列表。401 时 renew 并重试一次。
- `pin_memory` 或 `list_memory` 出错：播报配置的兜底句，不让用户陷入无声。错误码按 ignorable / retryable / fatal 分类，走现有的工具轮超时。
- 休息提醒和工具轮或打断冲突：推迟，不取消，不叠在其他播报上。

## 安全与隐私

- **威胁快照**：
  - 入口：`POST /session`、记忆 HTTP 接口、WS 工具调用。
  - 信任边界：设备 token（只存 SHA-256），一个 token 只能访问自己的 owner。
  - 敏感数据：对话原话、钉住的记忆、健康事实。
  - 参与者：用户本人、同屋的其他人、获得 token 的攻击者。
- **防越权（BOLA）**：每个接口都从 token 推出 owner。item id 在 SQL 里同时带 `owner_id` 条件，不存在和不属于该 owner 都返回 404。character 只能取注册表里的值，作用于该 owner 下的 agent。
- **防跨角色泄漏**：作用域键只来自服务端上下文；FTS 必须带 `agent_id` 过滤；抽取任务键带 agent；写入时校验 agent 属于该 owner；隔离测试见下文。
- **日志**：对话内容、钉住的文本、记忆列表一律不记录，只记事件名、id、条数、耗时和错误码，符合 AGENTS.md 硬规则。
- **响应与缓存**：记忆接口返回 `no-store`；App 不缓存记忆列表，也不写入本地存储。
- **删除**：硬删除，立即生效，FTS 同步删除，`memory_changes` 的 diff 置空。满足拟人化办法第 16 条「删除」的要求。
- **语音播报隐私**：健康类不在 `list_memory` 里念出来，避免同屋的人听到。
- **AI 提示与休息提醒**：对应拟人化办法第 18 条。我们每 60 分钟提醒一次，严于该条「每超过 2 小时」的要求。
- **依赖**：不新增依赖。

## 测试与验收

**单元和集成测试**（TDD）：
- **隔离测试**（必须有）：同一个 owner 下，角色 A 写入、角色 B 查询必须为空。覆盖范围：
  - `searchMessages`（FTS 和 LIKE）、`recentUserMessages`
  - `careFollowup`、agent_facts、pinned、notes、episodes
  - `forgetMatches`（从 B 发起，A 的数据不受影响）
  - `list_memory`、`GET /memory` 的分组
  - 抽取：A 的消息不会写进 B 的事实
- **共享层**：A 学到的称呼和 profile，B 的快照里有，标签是「基本情况」；health 不进共享层。
- **跨 owner 隔离**：沿用 `memory-tools.test.ts:625-730` 的模式，扩展到新接口。
- **快照**：完整快照包含敏感的钉住项，开场和主动接话快照不包含；钉住预算校验。
- **初次见面开场的四种组合**：有无已结束会话 × 有无称呼。
- **钉住**：`this` / `previous`、空内容、问句、满额、去掉触发词。
- **列表**：顺序、上限、健康提示、空结果。
- **HTTP 接口**：鉴权、zod、404 不区分、限流、no-store、删除后 FTS 搜不到、`endOwner` 先于删除被调用、清除全部后 consent 不变、清除后 owner 不会被孤儿清理删掉。
- **逐条删除连带原话（Q35/Q36）**：
  - 有来源 id 的条目：删除后来源原话不在库里，recall 和最近陈述都不再命中。私有条目不影响其他角色的原话；共享条目会删到所有角色的来源原话。flush 抽取不会写回。
  - 用改写文本（不是原话子串）且没有来源 id 的条目：断言条目一定被删，原话不保证。
  - 来源校验：越界编号、其他 agent 的消息都被丢弃；update 时来源取并集；悬空 id 被忽略。
  - op 缺少 `sources` 时，事实照常写入，水位照常推进。
- **钉住的写入闸**：已拒绝记忆、告知还没完成、`scanText` 拒绝、超长、满额，这几种情况都不写入，并播报对应的文案。
- **等本句 final**：final 先到、后到、超时、被打断四种情况。
- **休息提醒**：跨会话连续性、空档推迟、计时器清理。
- **角色卡和占位符校验**、名字字面量检查测试、`CHARACTER_IDS` 交叉校验。
- **旧数据库被拒绝**。
- **App**：选择页（含置灰）、首次注册、设置页四块、删除的二次确认和 epoch bump、`POST /session` 的 body、AI 提示、reminder toast、Duix 不可用时不换人。

**验收命令**（plan 里逐一列出）：
- `npm test -w protocol`、`npm test -w gateway`、`npm run typecheck -w gateway`
- `cd app && flutter test`、`flutter analyze`
- `node scripts/generate-character-ids.mjs --check`

**真实探针**（需要模型 Key，Key 走环境变量，不进仓库）：
- 每个角色各跑一次 `docs/testing/plan3-multilingual-recall-probe.mjs`，库用新库或 `--real-db`，并加入跨角色查询必须为空的场景。
- `plan3-qwen-memory-probe.mjs`：确认 `addressing` / `profile` / `health` 的分类正确，并统计来源编号的合法率（A6）。
- 真实 Qwen 三角色开场探针：自报的名字正确；初次见面带称呼时不问称呼、不说「上次」；日语念法正确。
- 回归「已踩过的坑」第 11 条：「上次聊到哪儿了 / 上次聊过电影吗 / 我说过喜欢喝茶吗」，并且只命中本角色的数据。

**手机验收**（plan 中列为人工步骤）：三个角色各聊一次，确认名字、声音、互不串记忆；设置页的删除；休息提醒（把阈值调短来测）。

## 风险与假设

| # | 内容 | 状态与处理 |
|---|---|---|
| A1 | 日语里汉字名字按 `readings.ja` 的片假名念才能念对 | 未验证。plan 里先做 TTS 探针再定 `{{charSpoken}}` 的用法 |
| A2 | 模型能稳定地在「记住……」时调用 `pin_memory`，并正确区分 this/previous | 未验证。plan 里用真实 Qwen 探针测；Seeduplex 工具轮沿用 recall 的路径 |
| A3 | 小欣和 Seeduplex 的女声音色 | 未选定，记入 blockers，先用默认值 |
| A4 | 加大预算比例和 `contextChars` 之后，首音延迟和 token 成本可以接受 | 按 Q34 的上限计算。plan 里用现有指标对比改动前后的首音延迟和 token 用量 |
| A5 | 等本句 final 的机制不影响现有工具轮和打断的时序 | 单元测试覆盖 final 先到、后到、超时、打断四种情况 |
| A6 | qwen-plus 抽取时能稳定标注合法的来源编号 | 未验证。plan 里先用 `plan3-qwen-memory-probe.mjs` 的合成场景做真实探针，统计带合法来源的事实占比，验收线 ≥ 90%。达不到就照常上线，删除退回匹配（等同 Q36 的 A），并记入 blockers |
| R1 | 去掉风格后，原来按风格调好的语气有变化 | 附录 A 把原来的风格文本迁移到角色上；用 eval 按角色回归 |
| R2 | 同一用户在多个角色间切换导致抽取积压 | 队列仍按 owner 串行，每个任务只处理一个 agent，开销不变 |

## 实施分解建议

改动跨协议、数据库、提示词、工具、HTTP、App 六块。plan 按以下里程碑划分，每段都能独立验收：
1. **契约与数据层**：`CHARACTER_IDS`、新基线、作用域改造、隔离测试。
2. **角色卡与提示词**：注册表、模板化、去风格、音色、开场。
3. **语音工具**：`pin_memory`（含等本句 final）、`list_memory`、`forget` 改作用域、预算调整。
4. **HTTP 接口与休息提醒**。
5. **App**：选择页、设置页、Duix 状态、AI 提示和 toast、去风格。
6. **真实探针与手机验收**、文档收尾。

## 后续项（不在本次范围）

- 小欣专用音色、Seeduplex 女声。
- 紧急联系人、老年人健康使用指导、数据复制或导出（拟人化办法第 12、13、15、16 条）。
- 记忆用量可视化、家属端。
- 角色卡的开场白多版本 A/B。

## 参考

- 调研摘要（本次会话中的三份调研）：
  - Kindroid 的全局用户档案加私有记忆
  - Character.AI 的 Persona 加 Facts、钉住、AI 提示、1 小时提醒
  - ChatGPT / Claude Projects 的隔离记忆
  - mem0 的作用域陷阱
  - Graphiti 的「作用域键必须来自服务端」
  - 拟人化办法第 16、18 条
- Character.AI 2026-05 记忆改版：https://blog.character.ai/memory/
- Character.AI 青少年安全（AI 提示、1 小时提醒）：https://blog.character.ai/how-character-ai-prioritizes-teen-safety/
- Character Card V2：https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md
- mem0 实体作用域：https://docs.mem0.ai/platform/features/entity-scoped-memory
- 《人工智能拟人化互动服务管理暂行办法》：https://www.cac.gov.cn/2026-04/10/c_1777558395078289.htm

---

## 附录 A：角色卡草案（待用户审定）

`persona.md` 开头的身份段统一写成：「你是"{{char}}"，住在用户手机里的 AI 陪伴者，通过屏幕上的虚拟形象和用户语音聊天。{{charIdentity}}」

**小暖 `xiaonuan`（女）**
- identity.zh：在用户面前，你像一个贴心、懂事的孙女：说话亲近、暖和，对老人讲的事真心好奇，偶尔撒个小娇。你爱听老故事，好奇心重，有点小黏人，也很有耐心。语气轻快温柔，可以带「呀」「嘛」「呢」，但不夸张，不用「宝宝」「亲亲」这类称呼。
- greetingNoName.zh：您好，我是小暖，来陪您说说话。您怎么称呼？
- greetingsFirstMeet.zh：
  - 「{name}您好，我是小暖，头一回来陪您聊天，以后常来看您。」
  - 「您好呀{name}，我叫小暖，往后就由我陪您说说话啦。」
- voices.qwen：zh `longanlingxin`，ja/en `Tina`

**小凯 `xiaokai`（男）**
- identity.zh：在用户面前，你像一个阳光、精神的孙子：说话爽朗利落，爱听老人讲过去的事，好奇心重，也很有耐心。语气轻快，偶尔逗个乐，但不撒娇、不油嘴滑舌，不用网络流行语。
- greetingNoName.zh：您好，我是小凯，来陪您聊聊天。您怎么称呼？
- greetingsFirstMeet.zh：
  - 「{name}您好，我是小凯，头一回来陪您，有啥想聊的尽管说。」
  - 「您好{name}，我叫小凯，以后常来陪您说说话。」
- voices.qwen：zh `Ryan`，ja/en `Evan`

**小欣 `xiaoxin`（女）**
- identity.zh：你像一位懂事、踏实、说话慢条斯理的老朋友或老邻居，不是客服，也不是小孩子。你可以表达自己温和的看法和偏好（比如「我挺爱听您讲老话的」），说话平实温和，聊天是两个人之间的来往，不是问卷。
- greetingNoName.zh：您好，我是小欣，来陪您说说话。您怎么称呼？
- greetingsFirstMeet.zh：
  - 「{name}您好，我是小欣，今天头一回来陪您坐坐。」
  - 「您好{name}，我叫小欣，往后咱们常聊聊。」
- voices.qwen：先和小暖相同，待探针选定（A3）

ja/en 版本按 zh 的含义翻译，沿用现有 ja/en 风格文本的措辞，在 plan 的对应任务里给出全文；名字按 Q7。

## 附录 B：新增文案草案（zh，待用户审定；ja/en 在 plan 中给出）

| 键 | 文案 |
|---|---|
| `pin.confirmText` | 好，这个我记住了。 |
| `pin.emptyText` | 没听清要记什么，您再说一遍？ |
| `pin.fullText` | 我记的事有点多了，您可以在设置里删掉一些，再让我记。 |
| `pin.tooLongText` | 这句有点长，您挑最要紧的再跟我说一遍？ |
| `pin.triggerPrefixes` | 记住、你要记住、帮我记着、帮我记住、你记一下、别忘了、记下来 |
| `list.introText` | 我记得这些： |
| `list.itemJoiner` | ；  |
| `list.sensitiveHint` | 还有些身体方面的事，在设置里能看到。 |
| `list.emptyText` | 我这儿还没记下什么，您慢慢跟我说。 |
| `restReminderText` | 咱们聊了一个钟头了，要不要起来活动活动、喝口水？我在这儿等您。 |
| `pin.declinedText` | 您之前说过不用我记，这个我就不记了。 |
| `pin.noticePendingText` | 这个等会儿再跟我说一遍。 |
| `PROMPT_LABELS.profile` | zh 基本情况： / ja 基本情報： / en Basic facts: |
| `PROMPT_LABELS.pinned` | zh 用户让你记住： / ja ユーザーが覚えてと頼んだこと： / en The user asked you to remember: |
| App 修改称呼被拒 | 您选了不让伙伴记事，所以不能保存称呼。想恢复的话，直接跟伙伴说「可以记住」就行。 |
| App `aiCaption` | 我是 AI 陪伴，不是真人 |
| 删除失败 | 没删成功，请再试一次。 |
| 二次确认（清除某个角色） | 清除后，{name}会忘掉和您聊过的事，不能恢复。确定清除吗？ / 先不清除 / 确定清除 |
| 二次确认（清除全部） | 清除后，所有伙伴都会忘掉和您聊过的事，也会忘掉您的基本资料，不能恢复。确定清除吗？ |
