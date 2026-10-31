# 主动记忆/随机话题问句设计

## 状态

设计已确认（2026-10-31，grilling Q1–Q23）。本文只记录设计，不含实现，也不含计划；实现计划在本文批准后另写。

- 决策来源：2026-10-31 会话 Q1–Q23，用户逐轮确认。
- 影响范围：zh 的四段沉默（context/check/leave）、主动意图渲染、记忆材料读取、主动负偏好存储、少量 Director/Session 接口。
- 高风险区：四段沉默、记忆注入、记忆库 schema。开工前按 `docs/project/roadmap.md` 的「记忆与回忆：已踩过的坑」确认；改后必须跑 gateway 全量测试、`npm run typecheck -w gateway`，并用真实记忆库跑一次召回探针。
- 前置阅读：`docs/project/roadmap.md`「关系连续的主动互动」「记忆与回忆：已踩过的坑」；`docs/superpowers/specs/2026-10-28-relational-proactivity-design.md`。

## 背景与目标

用户反馈：主动说话后，用户常只回“嗯/哦”，话题接不下去；主动内容有时也不像记得用户。

目标：

1. 在 zh 的 context/check 两段，当引擎选中 `interestTopic` 或 `selfShare` 时，主动句最后带一个话题问句。
2. 问句优先来自最近记忆；没有可用记忆时来自话题卡；两者按 70/30 概率选择。
3. 用户明确说“不感兴趣/不想聊这个”时，记住负偏好，跨通话避开该话题；用户说“换个话题”时，当前回复结束后立刻换一个新话题问，不等 6 秒。
4. 保持现有防编造、防打扰、敏感记忆不进入主动提示词的契约。

不在范围：

- leave/rest/checkin 加新问句；其他主动意图（事项回访、情绪关心、日常问候、接话、家人引导）追加新问句。
- en/ja 的主动引擎行为；只做 zh。en/ja 的话题卡为 id 对齐而补齐，不改变运行时行为。
- 按角色分话题池；三个角色共享角色级话题池。
- App 新界面、协议新消息、普通回复路径改造、会话外主动联系、模型微调。
- 敏感健康话题问句；健康类仍走现有 `threadSensitive`/`withCare` 路径。

## 已确认决策

| # | 决策 | 选择 |
|---|---|---|
| Q1 | 要解决的问题 | 主动说完后用户只回“嗯/哦”，以及希望用户更容易开口（A+C） |
| Q2 | 生效范围 | context/check/leave 的主动开口；rest/checkin 豁免 |
| Q3 | 每段都加问句 | 初选 A；后按 Q9/Q11/Q15 收窄为“context/check 的 `interestTopic`/`selfShare` 才带问句” |
| Q4 | 记忆与随机 | 70% 记忆 / 30% 话题卡；无可用记忆时 100% 话题卡 |
| Q5 | 随机话题来源 | 配置中的人工话题池，模型只做口语化，不补池外人名/作品/地点 |
| Q6 | “最近记忆”范围 | 未结束事项 + 非敏感事实 + 最近已结束会话的用户原话；敏感健康只走现有关怀路径 |
| Q7 | 问句形态 | 先陈述/分享，再邀请；不用“您对 X 感兴趣吗”式问卷 |
| Q8 | 问句挂载 | 每句最多一个问句；原先的“每句都加”由 Q11/Q15 收窄 |
| Q9 | leave | context/check 强制问；leave 只留话头/收尾，不强制问 |
| Q10 | 抽取粒度 | 每轮沉默抽一次；三段同源同话题、逐步深入；材料优先级：事项 → 事实 → 最近陈述；接受偶尔重复 |
| Q11 | 生效意图 | 只有 `interestTopic` 和 `selfShare` 带新问句；其他意图保持原有问句行为，不追加 |
| Q12 | 语言/角色/话题池 | 只做 zh；en/ja 行为不变；三角色共享池；zh 话题卡扩到 20–30 条 |
| Q13 | “不感兴趣” | 持久化负偏好，跨通话避开 |
| Q14 | 交付 | 短 spec + 小计划 + TDD + 真机验收 |
| Q15 | 最终问句规则 | 确认按 Q9/Q11 收窄 |
| Q16 | 负偏好对象/期限 | 话题卡 + 记忆 key；默认 90 天冷却，配置可设 0 = 永久 |
| Q17 | 清除记忆 | 负偏好随记忆一起清；不新增 App 可见列表 |
| Q18 | 下一步 | 先写 spec，审完再写 plan；执行用 subagent-driven-development |
| Q19 | 可用事实 | 只挑话题型非敏感事实；挑不到退回陈述/话题卡 |
| Q20 | 拒绝判定 | 只认主动问句之后紧接着的那句用户回复；配置短语；不做情感分析 |
| Q21 | “换个话题” | 立刻换新话题并问 |
| Q22 | 不同拒绝短语 | “换个话题”立刻换；“不感兴趣/不想聊这个/别聊这个”只接住、记负偏好，等下一轮沉默 |
| Q23 | “立刻”的落地 | 当前回复结束后立刻发下一句新话题问题，无 6 秒等待 |

## 现状事实（2026-10-31 复核）

以下为当前代码行为，不是设计愿望。

1. **四段计时**：`context/check/leave/checkin = 6/6/6/6 秒`，`rest = 180 秒`（`gateway/roles/elder-companion/{zh,en,ja}/director.json`；`gateway/src/session/director.ts` 的默认值仍是 6/8/10/10，仅 fixture 省略字段时使用）。每段计时从上一句播放结束开始。
2. **每段可用意图**（`gateway/src/session/proactive/engine.ts` 的 `MOMENT_KINDS`）：
   - `silenceContext`：`threadFollowup`、`moodCheck`、`routine`、`interestTopic`、`continueThread`、`humanConnection`。
   - `silenceCheck`：`threadFollowup`、`interestTopic`、`continueThread`、`selfShare`。
   - `silenceLeave`：`interestTopic`、`selfShare`。
   - `silenceCheckin`：空；`presenceCheck` 由结构规则决定。
   - `silenceRest`：空；`restQuiet` 由结构规则决定。
   - `topicExhausted`：`threadFollowup`、`interestTopic`、`humanConnection`、`selfShare`。
3. **问句限制**：`buildIntent` 只在 `restQuiet` 把 `allowQuestion` 设为 false；`presenceCheck` 允许问。没有 `mustAsk`/“必须问”的约束。`check.ts` 只记录“不该问却问”，没有“该问却没问”。
4. **zh 与 en/ja 的差异**：只有 zh 的 `director.json` 有 `intents`/`fallbacks`；en/ja 没有。zh 走引擎意图渲染；en/ja 走 Director 的固定阶段文案（`contextInstruction`/`checkInstruction`/`leaveInstruction` 等）。en/ja 的 `topics.json` 存在，但引擎不选意图。
5. **话题卡**：每个语言 10 条（`gateway/roles/elder-companion/<lang>/topics.json`）；`interestTopic` 用 `card.prompt` 作为锁定材料；选择是“最久未用”轮换，跨会话持久化在 `proactive_fallbacks` 的 `topicCard` key；`pickFallback` 不是随机。`TopicCard.fallbackText` 只给旧 `topicInstruction`/schema 用，当前引擎的兜底句来自 `copy.fallbacks.interestTopic`。
6. **现有兜底句**：`interestTopic` 5 条里有 4 条是问句、1 条是陈述；`selfShare` 5 条全是陈述（`gateway/roles/elder-companion/zh/director.json:165-185`）。
7. **记忆材料**：`ProactiveRuntime.ensureLoaded` 已读 `listOpenThreads`、最近 30 条**已结束会话**的用户原话（`recentUserMessages`）、情绪摘要、关系统计；没有读 facts/pins，也没有读会话边界。`recentUserMessages` 只返回 `{text}`；`listSessions` 返回 `{id, agentId, startedAt, endedAt}`；`listSessionUserLines` 返回 `{id, text}`。最近 3 个已结束会话可以通过 `listSessions` + `listSessionUserLines` 精确取，不需要新查询。
8. **Facts**：`profile_facts` 的 `category` 是 `addressing|profile`，无 `sensitive` 列（按契约非敏感）；`agent_facts` 的 `category` 是 `preference|person|health|other|safety`，有 `sensitive` 标志；`pinned_memories` 有 `sensitive` 标志。`listProfileFacts`/`listAgentFacts`/`listPinned` 已存在。主动快照（`renderMemoryViews().proactive`）已经只含 profile + 非敏感 pins + 非敏感 facts，可作为契约依据。
9. **接受窗口**：`AcceptanceTracker` 15 秒；`ProactiveRuntime.onUserFinal` 用 `rules.declinePhrases`（`affect.json`）+ `quietPhrases`（`director.json`）+ `tierDown`（`silence.json`）判 decline。`InFlight` 是私有的，包含 `planned`/`topicIndex`/`line`；`live` 在 `onLineEnded` 清空；`Session` 在 `responseStarted` 后只保留 `proactiveSeq`，不再持有请求对象。当前没有结构化的 “topic key” 从句子开始带到用户回复时。
10. **删除路径**：`clearAgentMemory`/`clearAllMemory` 会清 `proactive_stats`/`proactive_daily`/`proactive_fallbacks`；`forgetMatches`/`deleteMemoryItem` 不碰任何 `proactive_*` 表；`proactive_prefs`（档位）不被 `clearAgentMemory` 删除。
11. **文档偏差**：`roadmap.md:148` 和 `:217` 仍写 6/8/10/10 与“文本模型规划器”；当前代码是 6/6/6/6，且文本规划器已在 P4 删除。实现时一并修正，避免下一个人按旧契约改回。

## 设计总览

在 zh 的 `silenceContext` 和 `silenceCheck` 两段，当引擎选中 `interestTopic` 或 `selfShare` 时：

1. 先决定这一轮沉默的问句来源（记忆或话题卡），一轮只抽一次，70/30。
2. 选一条可用材料：未结束事项 → 话题型非敏感事实 → 最近 3 个已结束会话里的用户原话；没有可用记忆则话题卡。
3. 用现有写法 A（锁定材料、只允许用【】里的事实/话题）渲染主动句，并要求最后用一个问句收住。
4. 用户回复后，如果紧接着说“不感兴趣/不想聊这个/别聊这个”，记录负偏好，下一次不再问这个材料；如果紧接着说“换个话题”，记录负偏好，并在当前回复结束后立刻问一个新话题，不等 6 秒。
5. leave 只留话头/收尾，不强制问；rest/checkin 不变；其他意图不变。

## 生效范围与问句规则

### 3.1 约束表

| moment | kind | 问句约束 |
|---|---|---|
| `silenceContext` | `interestTopic` | `required` |
| `silenceContext` | `threadFollowup`/`moodCheck`/`routine`/`continueThread`/`humanConnection` | `allowed`（原有行为） |
| `silenceCheck` | `interestTopic`、`selfShare` | `required` |
| `silenceCheck` | `threadFollowup`/`continueThread` | `allowed`（原有行为） |
| `silenceLeave` | `interestTopic`、`selfShare` | `forbidden`（只留话头/收尾） |
| `silenceCheckin` | `presenceCheck` | `allowed`（它本来就要问“还在听吗”） |
| `silenceRest` | `restQuiet` | `forbidden` |
| `topicExhausted` | `selfShare` 等 | `allowed`（话题聊干路径不变） |
| `sessionStart` | `greetingPlain` 等 | `allowed`（开场不在本次范围） |

说明：

- `required`：渲染时追加 `mustAsk`，事后核对记录 `questionMissing`；兜底句必须是问句。
- `forbidden`：渲染时追加 `noQuestion`；兜底句必须是陈述。
- `allowed`：不加约束，保持原有行为。
- 每句最多一个问句；`required` 的渲染同时追加“只问一个，不要两个问号”。
- 用户明确拒绝/换话题时，以用户的话为准，不再追问同一个材料。

### 3.2 每句的形态

- `interestTopic`：用锁定材料起话题，最后用问句收住。材料是记忆原话/事实/事项时用 `withQuote`/`withTopic`；材料是话题卡时用 `withTopic`。
- `selfShare`：先说一句自己的小事/小感受（不编造用户的事），再用一个问句问用户；问句材料用新的 `withQuestionQuote`/`withQuestionTopic` 锁定。
- 问句风格：先陈述/分享，再邀请（Q7 C）。不要“您对 X 感兴趣吗”式问卷；不要连续两个问号。
- leave 的 `interestTopic`/`selfShare` 只留一句陈述/话头；兜底用陈述组。

### 3.3 一轮沉默内的组织

- 每轮沉默（从 context 开始到 checkin/rest 结束）只抽一次来源；同一轮内所有需要的问句共用同一话题。
- 第一次问句用 `withQuote`/`withTopic`；同一轮的第二句（check 或 leave）如果还需要问，追加 `withFollowUp`（“顺着刚才的话题问得更具体一点，不要重复上一句，也不要换话题”）。
- 如果 context 选中的不是 `interestTopic`/`selfShare`（例如事项回访），这一轮不抽来源；如果 check 选中了 `interestTopic`/`selfShare`，在 check 抽。leave 不抽、不要求问句。
- 用户回复了实质内容（`content`）→ 本轮结束，下一次沉默重新抽。
- 用户只回“嗯/哦”（`light`）→ 本轮继续，来源不变。
- 用户拒绝/换话题→ 本轮结束；换话题走第 8 节的立即换话题。

## 材料选择

### 4.1 优先级

记忆材料按以下顺序取第一条可用项：

1. **未结束事项**（`listOpenThreads`）：非敏感、`quote` 通过 `isMemoryEvidence`、不含健康词、未在本会话提过（`mentioned`）、未在负偏好表里。key：`thread:<id>`。
2. **话题型非敏感事实**：
   - `profile_facts` 的 `profile` 类（排除 `addressing`）；
   - `agent_facts` 的非敏感 `preference`/`person`/`other`（排除 `health`/`safety`）；
   - 非敏感 `pinned_memories`。
   - 过滤：`factCategories` 允许的类别；命中 `factBlockKeywords`/`healthWords` 的跳过；`profile`/`other`/pins 需要命中 `factKeywords`；`preference`/`person` 可只按类别。无合适事实则进入下一优先级。
   - key：`fact:<id>` 或 `pin:<id>`。
3. **最近已结束会话的用户原话**：
   - `listSessions` 过滤本 `agentId`、`endedAt !== null`、`endedAt >= now - recentDays*DAY`；按 `startedAt` 倒序取最近 `recentSessions` 个会话。
   - `listSessionUserLines` 每个会话取最新一条通过 `isMemoryEvidence`、长度 ≥ `minStatementChars`、不含健康词/`factBlockKeywords`、未在负偏好表里的原话。
   - key：`stmt:<sha256(normalizeUtterance(text))>`；`saidWhen` 以会话 `startedAt` 为锚点。
   - 当前会话永远不算“上一段”，因为它还没结束（查询天然排除）。

没有可用记忆 → 话题卡。没有可用话题卡（空池或全部被负偏好排除）→ 用配置里的通用问句兜底，记录日志，不静默。

### 4.2 敏感边界

以下材料绝不用于话题问句：

- `agent_facts.sensitive = 1`、`category = health|safety`；
- `pinned_memories.sensitive = 1`；
- 事项 `sensitive = 1`；
- 含 `healthWords` 的原话/事实/事项；
- `profile_facts` 的 `addressing`；
- 命中 `factBlockKeywords` 的事实/原话。

健康类仍走现有 `threadSensitive`/`withCare`，不进入本功能。

### 4.3 材料 key 与不存原文

负偏好只存 key，不存原话/事实文本：

- 话题卡：`card:<topic card id>`。
- 事实：`fact:<fact id>`。
- 置顶：`pin:<pin id>`。
- 事项：`thread:<thread id>`。
- 原话：`stmt:<sha256(normalizeUtterance(text))>`。

key 只用于选择过滤和删除；日志只记 key 类型（`card|fact|pin|thread|stmt`），不记 key 值，更不记文本。

## 概率与每轮沉默

### 5.1 70/30

- 配置：`proactivity.json` 的 `topicQuestion.memoryRatio`（默认 70，0–100）。
- 每轮沉默只在第一次需要问句时抽一次：
  - 有可用记忆且 `random() * 100 < memoryRatio` → 记忆；
  - 否则 → 话题卡；
  - 没有可用记忆 → 100% 话题卡。
- `random` 通过 `ProactiveRuntimeDeps.random` 注入（默认 `Math.random`），测试可把它固定为 0/0.99 等值。
- 同一轮内不再抽；check/leave 复用同一来源与话题。
- 用户实质回复后重置；拒绝/换话题也重置。

### 5.2 话题卡轮换与负偏好

- 继续使用 `proactive_fallbacks` 的 `topicCard` 轮换（最久未用优先）。
- 选择时先排除 `proactive_topic_avoid` 里仍在冷却期的 `card:<id>`。
- 如果所有卡都被排除：使用最久未用的卡（从全部卡里选），记录 `proactive_topic_pool_exhausted`；不静默、不重复问同一个被拒话题。

### 5.3 记忆材料的重复

- 事项线有生命周期，天然轮换。
- 事实/原话没有“问过没有”的记录；接受偶尔重复（Q10 A）。
- 用户拒绝后写入负偏好，后续选择排除该 key。
- 不新增“已问过”表；负偏好表只记拒绝。

## 意图与渲染契约

### 6.1 约束类型

把 `ProactiveIntent.constraints.allowQuestion: boolean` 改为：

```ts
constraints: {
  maxChars: number;
  question: 'forbidden' | 'allowed' | 'required';
  mustExpress: 'presence' | null;
}
```

- `restQuiet` → `forbidden`。
- `interestTopic`/`selfShare` 在 `silenceContext`/`silenceCheck` → `required`。
- `interestTopic`/`selfShare` 在 `silenceLeave` → `forbidden`。
- 其他 → `allowed`。
- `checkSpoken` 的 `CheckSpec` 同步改为 `question`；`SpokenCheck` 增加 `questionMissing`；`ViolationKind` 增加 `questionMissing`。`question` 记录“forbidden 却问”，`questionMissing` 记录“required 却没问”。只记日志，不拦截、不重说（保持现有契约）。

### 6.2 材料模型

`IntentMaterial` 增加问题材料：

```ts
question?: {
  source: 'memory' | 'card';
  form: 'quote' | 'topic';   // quote = 用户原话/事项；topic = 事实/话题卡
  text: string;
  said: string | null;       // quote 用；topic 为 null
  key: string;               // card:/fact:/pin:/thread:/stmt:
  cardIndex: number | null; // 话题卡在 topics 数组里的下标；记忆为 null
};
```

`ProactiveIntent.material` 增加：

```ts
question?: { text: string; said: string | null; topic: boolean };
questionKey?: string;
```

- `interestTopic`：问题材料就是主材料；`shapeFor` 用 `question` 生成 `quotes`/`facts`，`mustAsk` 由约束决定。
- `selfShare`：主内容没有材料；问题材料单独渲染 `withQuestionQuote`/`withQuestionTopic`。
- 其他 kind 不设置 `question`；行为不变。
- `renderIntent` 把 `questionKey` 写到 `ProactiveRequest.topicKey`（内部字段，不进入协议）。

### 6.3 文案片段

`IntentCopy` 增加：

- `withQuestionQuote`：`再问老人一个问题，问句只能用下面【】里老人说过的话；不要补充人名、地名、作品名、日期、数字或其他细节。\n【{material}】`
- `withQuestionTopic`：`再问老人一个问题，问句只能用下面【】里的话题；不要补充人名、地名、作品名、日期、数字或其他细节。\n【{material}】`
- `mustAsk`：`最后用一个问句收住；只问一个问题，不要用两个问号。`
- `withFollowUp`：`顺着刚才的话题问得更具体一点，不要重复上一句，也不要换话题。`

`noQuestion` 保留给 `forbidden`。

`DirectorSchema` 的 `intents` 对象、`roles/types.ts` 的 `IntentCopy`、`intent-copy.test.ts` 同步增加这四个字段。只有 zh 有 `intents`；en/ja 不受影响。

### 6.4 兜底组

`FallbackKey` 增加两组：

- `interestTopicStatement`：leave 用，5 条陈述/话头。
- `selfShareQuestion`：context/check 用，5 条“自己的小事 + 一个问题”。

`interestTopic` 保持 5 条问句（把现有唯一一条陈述改成问句）；`selfShare` 保持 5 条陈述（leave 用）。`fallbacks` 的 schema、`FALLBACK_KEYS`、`FallbackGroups`、admin `copy.json` 描述符同步增加两组。

`buildIntent` 的 `fallbackKey`：

- `interestTopic`：`question === 'required'` → `interestTopic`；否则 → `interestTopicStatement`。
- `selfShare`：`question === 'required'` → `selfShareQuestion`；否则 → `selfShare`。
- 其他 kind 不变。

### 6.5 事后核对

`onLineEnded` 的 `checkSpoken` 材料要包含主材料 + 问题材料（`intent.material.question.text` 与 `said`），避免把问题里的锁定事实误判为编造。新增 `questionMissing` 日志：

```ts
logger.warn('proactive_grounding_violation', {
  kind: intent.kind,
  violationKind: 'questionMissing',
  count: 1,
});
```

### 6.6 `ProactiveRequest`

`gateway/src/adapters/types.ts` 的 `ProactiveRequest` 增加可选内部字段：

```ts
topicKey?: string;
```

Qwen/Mock 适配器忽略它；它不进入协议、不进入日志值。`fallbackFor` 生成的“照读兜底句”请求要保留 `topicKey`，这样用户对兜底句说“不感兴趣”也能记录。

## 负偏好

### 7.1 表

新增 migration v9（加在现有 `MIGRATIONS` 末尾，additive only）：

```sql
CREATE TABLE proactive_topic_avoid (
  owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  topic_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('card', 'fact', 'pin', 'thread', 'stmt')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, agent_id, topic_key)
) STRICT;
CREATE INDEX proactive_topic_avoid_agent ON proactive_topic_avoid (agent_id, created_at);
```

- 只存 key + 来源 + 时间；不存原话/事实/话题文本。
- 按 `owner_id`/`agent_id` 隔离；跨角色不共享。
- 90 天冷却：选择时排除 `created_at > now - declineCooldownDays * DAY` 的 key；`declineCooldownDays = 0` 表示永久（不过滤）。
- 过期行可在写入/预取时顺手清理，避免无限增长；清理不影响删除语义。

### 7.2 写入

`ProactiveRuntime.onUserFinal`：

1. 继续用现有 `lights`/`declinePhrases`/`quietPhrases`/`tierDown` 判 `declined`。
2. 新增：
   - `switchIntent = !light && hasAny(text, rules.topicQuestion.switchPhrases)`；
   - `topicDecline = !light && hasAny(text, rules.topicQuestion.topicDeclinePhrases)`；
   - 两者任一为真时，`declined` 也为真。
3. 用 `AcceptanceTracker.onUserFinal` 解析当前行；`PendingLine` 增加 `topicKey?: string`（在 `onLineStarted` 从 `planned.intent.questionKey` 带入）。
4. 如果解析出的 `line.topicKey` 存在且 `switchIntent || topicDecline`：
   - 写 `proactive_topic_avoid`（upsert，更新 `created_at`）；
   - 更新内存里的 avoid 集合；
   - 日志 `proactive_topic_declined`，只记 `source`/`keyType`/`switch`。
5. 如果 `switchIntent` 且 `line.topicKey` 存在：
   - 设置 `pendingSwitch = { language, key, at: now }`；
   - 日志 `proactive_switch_pending`。
6. 如果 `switchIntent` 但当前没有 `topicKey`（比如普通回复里说“换个话题”）：不设置 pendingSwitch，交给实时模型的正常回复处理。
7. 重置本轮问题来源/`episodeAsked`；如果是 `light` 则保留。

只认“主动问句之后紧接着的那句用户回复”，且在接受窗口（15 秒）内；窗口外不记。不做情感分析。

### 7.3 读取

`ProactiveRuntime.ensureLoaded` 增加：

- `store.listTopicAvoid(ownerId, agentId, since)` → `Map<topicKey, createdAt>`；`since` 由 `declineCooldownDays` 计算，0 时为 `null`。
- 选择材料时排除 `avoid.has(key)`（且在冷却期内）。
- 写入/删除后同步更新内存集合，避免同一会话内重复问。

### 7.4 删除

负偏好随记忆删除，不新增 App 可见列表（Q17 A）：

- `clearAgentMemory`：`DELETE FROM proactive_topic_avoid WHERE owner_id = ? AND agent_id = ?`。
- `clearAllMemory`：`DELETE FROM proactive_topic_avoid WHERE owner_id = ?`。
- `wipeOwnerMemory`：经 `clearAllMemory` 覆盖。
- `forgetMatches`：
  - 在删除前先查出匹配的 fact/pin/thread id，删除 `fact:<id>`/`pin:<id>`/`thread:<id>`；
  - 在 blank 消息前读出被匹配消息的 text（以及 `triggerText`），逐条计算 `stmt:<sha256(normalizeUtterance(text))>` 并删除；不能只对 `query` 哈希，因为用户可能只说了关键词；
  - `ForgetResult` 增加 `topicAvoid` 计数；`forget_memory` 的总数/确认文案纳入该计数。
- `deleteMemoryItem`：按 item 类型删除 `fact:<id>`/`pin:<id>`/`thread:<id>`。
- `clearProfile`：删除被清 profile fact 对应的 `fact:<id>`，覆盖所有 agent（profile 是共享层）。
- `forget` 删除原话后，对应 `stmt:` key 一并删除；不保留可反推文本的哈希。

## 立即换话题

### 8.1 触发

- 用户紧接着主动问句说“换个话题/换一个话题/说点别的/聊点别的”等 `switchPhrases`；
- 当前行有 `topicKey`（即 `interestTopic`/`selfShare` 的记忆/话题卡材料）；
- 在接受窗口（15 秒）内；
- 不是 `light`。

### 8.2 时序

1. 用户说完“换个话题”，实时模型照常生成当前回复（通常是一句“好，咱们换个话题”）。
2. `ProactiveRuntime.onUserFinal` 记录负偏好，设置 `pendingSwitch`。
3. 当前回复播放结束、`Director.onAiTurnEnded` 执行时：
   - 在 hard-stop/notice/reminder 检查之后，先问 `deps.takePendingSwitch?.()`；
   - 如果有未过期的 pendingSwitch，且未被上限/静音/离开/用户新语音取消：
     - 构建一条新的 `interestTopic` 问句（强制 `question: 'required'`，新的 70/30 抽取，排除被拒绝的 key）；
     - 设置 `pending = 'context'`，直接 `requestResponse('followup', request)`，不启动 6 秒计时；
     - 日志 `proactive_switch`（`fromKind`、`source`、`delayMs`、`capped`）。
   - 没有 pendingSwitch → 走现有 `onAiTurnEnded` 的阶梯逻辑。
4. 新问句播放结束后，`pending = 'context'` 让阶梯继续到 check；如果用户仍然沉默，check 复用本轮话题做一次追问。
5. 如果当前回复被用户打断、用户又说了新内容、或 pendingSwitch 超过 10 秒，取消 pendingSwitch，按正常阶梯继续。
6. 如果会话/每日上限已满，不发新问句，只保留当前回复；日志 `proactive_switch_capped`。
7. 如果被拒绝的材料是最后一个可用话题（所有卡都被排除），用最久未用的卡或通用问句兜底；不静默。

### 8.3 计数与统计

- 立即换话题的新问句算一条 scored 主动行：计 `sessionSpoken`/`todaySpoken`，写 `proactive_stats`，走接受窗口。
- 当前回复本身是普通 `reply`，不计主动行。
- 新问句的 `topicKey` 同样进入接受窗口；如果用户又拒绝，继续记录负偏好。

### 8.4 “不感兴趣”与“换个话题”的区别

- `switchPhrases`：立即换，见 8.2。
- `topicDeclinePhrases`（不感兴趣/不想聊这个/别聊这个/不想说这个）：只接住、记负偏好；不立即再问；当前回复结束后按正常阶梯走，下一轮沉默再抽新话题。
- 两者同时命中：按 switch 处理。
- 普通回复里的“换个话题”（没有 `topicKey`）：不触发网关的立即换话题；交给实时模型正常回复。

## 配置

### 9.1 `gateway/config/proactivity.json`

新增：

```json
"topicQuestion": {
  "enabled": true,
  "memoryRatio": 70,
  "recentSessions": 3,
  "recentDays": 7,
  "declineCooldownDays": 90,
  "minStatementChars": 5,
  "factCategories": ["preference", "person", "other", "profile"]
}
```

Zod 校验（`gateway/src/session/proactive/config.ts`，`.strict()`）：

- `enabled`: boolean；
- `memoryRatio`: int 0–100；
- `recentSessions`: int 1–10；
- `recentDays`: int 1–365；
- `declineCooldownDays`: int 0–3650（0 = 永久）；
- `minStatementChars`: int 2–50；
- `factCategories`: `('preference'|'person'|'other'|'profile')[]`，去重。

交叉校验：`enabled=false` 时运行时不设置 `required`、不抽来源、不写负偏好（kill switch）。

后台管理（可选但建议，保持现有 proactivity 页可调）：

- `topicQuestion.enabled`（boolean）
- `topicQuestion.memoryRatio`（0–100，unit `%`）
- `topicQuestion.recentSessions`（1–10）
- `topicQuestion.recentDays`（1–365，unit 天）
- `topicQuestion.declineCooldownDays`（0–3650，unit 天）
- `topicQuestion.minStatementChars`（2–50）

`factCategories`/关键词留在 repo 配置，不进后台，避免多选 UI。

### 9.2 `gateway/config/i18n/<lang>/proactivity.json`（新文件）

```json
{
  "switchPhrases": ["换个话题", "换一个话题", "说点别的", "聊点别的"],
  "topicDeclinePhrases": ["不感兴趣", "不想聊这个", "别聊这个", "不想说这个", "不想聊了"],
  "factKeywords": ["喜欢", "爱", "常", "习惯", "拿手", "家里", "孙女", "孙子", "花", "茶", "戏", "歌", "吃", "做", "走", "看"],
  "factBlockKeywords": ["住址", "地址", "身份证", "收入", "工资", "年龄", "岁", "病", "医院", "药"]
}
```

- 新增 `ProactivityFileSchema` 到 `gateway/src/i18n/load.ts`；`loadI18n` 加载。
- zh 用上面的列表；en/ja 提供同 schema 的空数组（或翻译后的短语，但引擎不跑，行为不变）。
- `ProactiveRules` 增加 `topicQuestion: { switchPhrases, topicDeclinePhrases, factKeywords, factBlockKeywords }`；`Session` 构建规则时传入。
- 现有 `affect.json` 的 `declinePhrases` 不改；新列表是叠加的，只用于本功能的负偏好/换话题判定。

### 9.3 `gateway/roles/elder-companion/zh/director.json`

- `intents` 增加 `withQuestionQuote`、`withQuestionTopic`、`mustAsk`、`withFollowUp`。
- `fallbacks.interestTopic` 改成 5 条问句。
- 新增 `fallbacks.interestTopicStatement`（5 条陈述/话头）。
- 保留 `fallbacks.selfShare`（5 条陈述，leave 用）。
- 新增 `fallbacks.selfShareQuestion`（5 条“自己的小事 + 一个问题”）。
- `topicInstruction` 保留现状（无运行时读者），不在本次删除。

### 9.4 话题卡

- zh `topics.json` 扩到 24 条（附录 A）。
- en/ja `topics.json` 补同样的 24 个 id（短翻译）；`fileCatalog` 的跨语言 id 对齐测试必须通过。运行时仍只有 zh 的引擎会选 `interestTopic`，en/ja 行为不变。
- `prompt` ≤40 字，`fallbackText` ≤60 字；`TopicsSchema` 上限 50，够用。

## 数据模型与迁移

### 10.1 迁移

- `gateway/src/memory/migrations.ts` 追加 v9（只在 `MIGRATIONS` 末尾新增，不修改 v1–v8）。
- 新表 `proactive_topic_avoid`（见 7.1）。
- `migrate` 的 `user_version` 检查、备份/回滚流程沿用现有；真实库应用前先 `VACUUM INTO` 备份，记录版本。
- 迁移测试：v8 → v9；新表为空；旧表数据不变；`clearAgentMemory`/`clearAllMemory` 覆盖新表。

### 10.2 MemoryStore 接口

新增（名称可在计划里微调）：

```ts
listTopicAvoid(ownerId: string, agentId: string, since: number | null): Map<string, number>;
recordTopicAvoid(ownerId: string, agentId: string, key: string, source: TopicSource, now: number): void;
clearTopicAvoid(ownerId: string, agentId: string): void;
deleteTopicAvoidKeys(ownerId: string, agentId: string, keys: readonly string[]): number;
deleteTopicAvoidForProfile(ownerId: string, factIds: readonly string[]): number;
```

- `source` 由 key 前缀推导：`card|fact|pin|thread|stmt`。
- `recordTopicAvoid` 用 `INSERT ... ON CONFLICT ... DO UPDATE SET created_at = excluded.created_at, source = excluded.source`。
- 读失败按“无负偏好”处理并记日志 `proactive_topic_avoid_store_error`；写失败不阻塞回复，记日志。
- `MemoryStore` 是接口 + SQLite 实现；测试用 temp DB。

### 10.3 删除覆盖

- `clearAgentMemory`：删除该 agent 的 avoid 行。
- `clearAllMemory`：删除该 owner 的 avoid 行。
- `clearProfile`：删除被清 profile fact 对应的 `fact:<id>`（覆盖所有 agent）。
- `forgetMatches`：删除匹配的 `fact|pin|thread` key 和 `stmt:<hash>`；删除前先查 id、读出将被 blank 的原话再算 hash；`ForgetResult.topicAvoid` 计数。
- `deleteMemoryItem`：删除单项对应的 key。
- 不在 `proactive_fallbacks` 里复用；两者语义不同：一个是轮换，一个是负偏好。

## 日志与指标

只记事件名、类型、计数、耗时；不记原话、事实文本、话题 prompt、key 值。

- `proactive_question_planned`：`{ moment, kind, source: 'memory'|'card', keyType, decideMs }`。
- `proactive_question_fallback`：`{ kind, source }`（模型超时/无音频后照读兜底句）。
- `proactive_grounding_violation`：沿用；新增 `violationKind: 'questionMissing'`。
- `proactive_topic_declined`：`{ source, keyType, switch: boolean }`。
- `proactive_switch_pending`：`{ keyType }`。
- `proactive_switch`：`{ fromKind, source, delayMs, capped }`。
- `proactive_switch_cancelled`：`{ code: 'barge'|'new_user'|'timeout'|'blocked' }`。
- `proactive_topic_pool_exhausted`：`{ cards }`。
- `proactive_topic_avoid_store_error` / `proactive_question_store_error`：`{ code }`。
- 现有 `reply_metrics` 继续记录首音延迟/生成时间/token/错误码；问句变长可能增加 TTS 时长，真机看指标，不在协议里加字段。

## 失败处理与降级

- **模型超时/无音频**：现有 `fallbackFor` 照读兜底句；`required` 的兜底组必须是问句；`forbidden` 的兜底组必须是陈述。`topicKey` 保留，用户对兜底句拒绝也能记录。
- **记忆读取失败**：按无记忆处理，走话题卡；日志 `proactive_question_store_error`；不阻塞。
- **负偏好读取失败**：按空表处理；不阻塞。
- **负偏好写入失败**：不阻塞回复；日志；本次会话内仍用内存集合避开。
- **无可用记忆且话题卡池空/全被排除**：用配置通用问句兜底（`interestTopic` 问句组），记录 `proactive_topic_pool_exhausted`；不静默。
- **立即换话题超时/被打断/被新语音取消**：取消 pendingSwitch，按正常阶梯走；日志。
- **上限已满**：不发立即换话题的新问句；日志 `proactive_switch_capped`；当前回复保留。
- **敏感/健康**：过滤在材料选择层；如果唯一材料是敏感，退回话题卡/通用问句，不进入健康话题。
- **en/ja**：不设置 `required`，不抽来源，不写负偏好；现有路径不变。
- **kill switch**：`topicQuestion.enabled=false` 时不设置 `required`、不抽来源、不写负偏好；保留现有 `interestTopic`/`selfShare` 行为。

## 测试与验收

### 12.1 单元测试

- 概率：`memoryRatio=0` 总是话题卡；`=100` 有记忆时总是记忆；70/30 用注入的 `random` 固定验证；每轮只调用一次 `random`。
- 材料优先级：事项 → 事实 → 最近陈述；敏感/health/safety/addressing/block 关键词排除；`profile`/`other`/pins 的关键词过滤；最近 3 个已结束会话/7 天窗口；当前会话排除；`stmt` hash 稳定。
- 轮次：同一轮同源同话题；check 的 follow-up；leave 不要求问句；rest/checkin 不变；`light` 不重置；`content` 重置。
- 契约：`question: 'forbidden'|'allowed'|'required'`；`interestTopic`/`selfShare` 在 context/check required、leave forbidden；其他意图 allowed；`checkSpoken` 的 `questionMissing`。
- 渲染：`withQuestionQuote`/`withQuestionTopic`/`mustAsk`/`withFollowUp`；`interestTopic` 问句组、`interestTopicStatement`、`selfShare`、`selfShareQuestion`；每句最多一个问号。
- 负偏好：拒绝/换话题识别；只认紧接回复；15 秒窗口；key 生成；upsert；90 天冷却/0 永久；agent 隔离；无原文；选择排除；删除覆盖（clear/forget/delete item/profile）。
- 立即换话题：pendingSwitch 生成；当前回复结束后立即发；无 6 秒计时；新抽排除被拒 key；barge/新语音/超时取消；上限；日志。
- 配置：`ProactivitySchema` 新字段、边界、`.strict()`；i18n 新文件 schema；`factCategories` 去重；admin descriptor/overlay。
- 迁移：v8→v9；备份/回滚；新表；旧表不变。
- 文案：`intent-copy.test.ts` 的新字段、5 条下限、≤30 字、无作品名/健康词、`restQuiet` 无问号、`presenceCheck` 关键词、`interestTopic`/`selfShareQuestion` 有问号、`interestTopicStatement`/`selfShare` 无问号。

### 12.2 集成测试

- `proactive-session.test.ts`：有记忆 → 记忆问句；无记忆 → 话题卡问句；leave 无新问句；checkin/rest 不变；其他意图不追加；en/ja 不变。
- `director-silence.test.ts`：立即换话题在 `onAiTurnEnded` 直发；不 arm 6 秒；barge 取消；notice/reminder 优先。
- `proactive-runtime.test.ts`：`InFlight`/`live`/acceptance 的 `topicKey` 传递；兜底请求保留 key；拒绝后同会话不再问；重载后从 store 恢复。
- `memory-tools.test.ts`：`recall_memory` 不受影响；`forget` 删除 `stmt` key；`list_memory` 不暴露负偏好。
- `memory-store.test.ts`：新表 CRUD、upsert、冷却、clear/delete。
- `i18n.test.ts`/`config-snapshot.test.ts`：新文件/新字段/交叉校验。
- `fileCatalog.test.ts`：24 个 topic id 三语对齐。
- `push-seam.test.ts`：不新增 session.update；立即换话题走 `requestResponse`，不中途刷新指令。

### 12.3 真实环境

- `npm test -w gateway` 全量。
- `npm run typecheck -w gateway`。
- 真实记忆库召回探针：`上次聊到哪儿了 / 上次聊过电影吗 / 我说过喜欢喝茶吗`，前两个只能引用真实用户陈述并自然包装，第三个必须找不到；不得出现新作品名或固定模板句。
- 真实库迁移前 `VACUUM INTO` 备份；迁移后 `user_version=9`，新表行数 0；三角色 zh 探针 true/true/false，`newTitleFlag` 全 false。
- 真机验收（用户在场）：
  1. 有记忆：主动问句引用真实最近事实/原话，无新作品名/人名/地名/数字。
  2. 无记忆：话题卡问句，无编造。
  3. 用户沉默：context/check 有问句；leave 收尾；checkin 只问还在听；每句最多一个问号；没有连环问。
  4. 用户说“不感兴趣”：当前回复接住；负偏好写入；下一通不再问该话题；不立即再问。
  5. 用户说“换个话题”：当前回复结束后立刻新问句，无 6 秒等待，话题确实换了。
  6. 敏感健康：不作话题问句；现有健康关怀路径不变。
  7. en/ja：行为不变。
- 日志检查：只有事件名/类型/计数，无原话/事实/话题文本/key 值。
- 验收记录写入 `docs/testing/`，roadmap 更新状态、命令与结果。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 打扰/连环问 | 每句最多一个问句；leave 不强制；rest/checkin 不变；沿用上限/安静档/接受窗口；真机第 3 项 |
| 编造 | 写法 A 锁定材料；`withQuote`/`withQuestionQuote` 禁止补人名/作品/地名/日期/数字；事后 `checkSpoken` 只记日志；兜底句不含用户事实 |
| 重复 | 话题卡已有跨会话轮换；事项线生命周期；负偏好排除被拒材料；事实/原话接受偶尔重复 |
| 永久误判 | 默认 90 天冷却；`declineCooldownDays=0` 才永久；随记忆清除 |
| 敏感泄露 | 只选非敏感 facts/pins/threads/statements；health/safety/addressing/block 关键词排除；负偏好表只存 key；日志不记文本 |
| 立即换话题两个回复背靠背 | Q23 A 接受；当前回复通常很短；barge/新语音/超时取消；上限；真机第 5 项 |
| en/ja 话题卡 id 对齐 | 只补 id + 短翻译，不改行为；`fileCatalog` 测试 |
| 迁移风险 | v9 additive；真实库先备份；v8→v9 测试；新表为空 |
| 模型不服从 `mustAsk` | T0 探针测问句率；不足则调文案/兜底；`questionMissing` 日志监控 |
| 延迟 | 材料读取在 `ensureLoaded` 每天一次；无额外模型调用；问句变长只影响 TTS 时长；看 `reply_metrics` |
| 记忆事实过期 | 预取每天一次；可在提取完成后调用 `proactive.reload()`（计划里定）；不阻塞本次 |

## 坑位契约修订

实现时与代码一起更新 `docs/project/roadmap.md`：

1. 「记忆与回忆：已踩过的坑」第 8 条（四段式由决策引擎运行）：补充 context/check 的 `interestTopic`/`selfShare` 问句约束；leave 不强制问；敏感材料不进入话题问句；每句最多一个问句。
2. 第 4 条（快照只注入用户可核对的内容）：补充话题问句材料只进当次 Qwen 指令（写法 A），不进会话常驻指令/快照/规划器；负偏好只存 key，不存文本。
3. 新增一条负偏好坑位：`proactive_topic_avoid` 按 agent 隔离、只存 key/hash、90 天冷却/0 永久、随记忆删除；不能把话题文本写进日志或表。
4. 修正 `roadmap.md:148`/`:217` 的 6/8/10/10 与文本规划器描述为当前 6/6/6/6 + 决策引擎。
5. 修正 `roadmap.md` 中“前三段主动接话题/问小问题”的旧描述，明确当前是 context/check 的 `interestTopic`/`selfShare` 才带新问句，leave 收尾。

## 实施分期（供 writing-plans 细化）

建议 7 个任务，subagent-driven-development；共享文件/冻结契约在计划 overview 里列：

- **T0 探针（建议前置）**：用真实 Qwen 跑 20–40 次 `interestTopic`/`selfShare` 的 `mustAsk` 探针，记录问句率、两个问号率、材料外事实；不达 90% 问句率先调文案，不改架构。
- **T1 配置/文案/话题卡**：`proactivity.json` + schema、i18n `proactivity.json`、`director.json` intents/fallbacks、zh 24 条话题卡、en/ja id 对齐、admin descriptor、相关文案测试。
- **T2 记忆材料**：facts/pins 读取、最近 3 个已结束会话/7 天窗口、过滤、key、`stmt` hash、`ensureLoaded`、单元测试。
- **T3 意图/渲染契约**：`question` 三态、`mustAsk`/`withQuestion*`/`withFollowUp`、问题材料、`topicKey`、`checkSpoken`、兜底组、测试。
- **T4 概率/轮次**：`random` 注入、每轮一次 70/30、同源同话题、follow-up、重置、测试。
- **T5 负偏好**：v9 迁移、store 方法、检测、upsert、冷却、删除覆盖、测试。
- **T6 立即换话题**：`pendingSwitch`、`takePendingSwitch`、Director/Session 接线、取消/上限/日志、测试。
- **T7 收尾**：全量回归、typecheck、真实库迁移/召回探针、真机 7 项、roadmap/坑位修订、验收记录。

实施约束：

- 当前工作区有大量未提交改动；实现必须新建 branch/worktree，不能覆盖无关改动，不能 `git add -A`，只加显式路径。
- en/ja 只补 topic id/短翻译和 i18n 空数组，不改引擎行为。
- 开工前先读 roadmap 的「记忆与回忆：已踩过的坑」并按规约向用户确认；改后跑全量/typecheck/真实库召回探针。

## 附录 A：zh 话题卡（24 条）

`prompt` 是锁定材料；`fallbackText` 保留给 schema/旧路径，统一写成自然问句或陈述。

| id | prompt | fallbackText |
|---|---|---|
| weather | 今天的天气和要不要添衣服 | 今天外头天气变得快，您记得添件衣服。 |
| meal | 今天吃了什么好吃的 | 说起来我挺好奇，您今天吃了点什么好吃的？ |
| walk | 出门走走、晒晒太阳 | 天气好的时候出去走走，晒晒太阳挺舒服的。 |
| old-song | 年轻时爱听的一首老歌 | 我最近学了几句老歌，您年轻时爱听哪首？ |
| family | 家里人最近的近况 | 家里人最近都挺好吧，有空多跟他们打打电话。 |
| skill | 用户年轻时的拿手本事 | 我总觉得您年轻时肯定有一门拿手的本事。 |
| season | 眼下的时节和应季的吃食 | 这个时节的菜最新鲜，吃着也香。 |
| flowers | 家里养的花草或者窗外的景 | 家里要是养点花草，看着心情也亮堂。 |
| tv | 最近爱看的电视节目或戏曲 | 最近有什么好看的电视或者戏，您给我推荐推荐。 |
| snack | 小时候爱吃的零嘴 | 我听好多人说，小时候的糖葫芦最好吃。 |
| tea | 平时爱喝的茶 | 您平时爱喝什么茶呀？我最近也在学着泡茶。 |
| grandchildren | 孙辈最近的趣事 | 您孙辈最近有没有什么好玩的事，说给我听听？ |
| cooking | 拿手的家常菜 | 您最拿手的家常菜是什么呀？ |
| radio | 常听的广播或节目 | 您平时爱听广播吗？有没有常听的节目？ |
| opera | 爱看的戏曲 | 您爱看戏吗？最爱听哪一出？ |
| travel | 年轻时去过的地方 | 您年轻时去过哪些地方呀？ |
| old-photos | 家里的老照片 | 家里有没有老照片，您愿意讲讲照片里的故事吗？ |
| market | 逛早市或买菜 | 您平时爱逛早市吗？买菜有什么窍门？ |
| sewing | 针线活或手工 | 您会做针线活吗？以前是不是常自己做衣服？ |
| chess | 下棋或打牌 | 您平时爱下棋还是打牌呀？ |
| morning-exercise | 早上锻炼 | 您早上有锻炼的习惯吗？都做些什么？ |
| neighbors | 邻居和街坊 | 您和邻居们常来往吗？ |
| festival | 过节和家里的习俗 | 快过节了，您家里有什么老习俗吗？ |
| childhood | 小时候的趣事 | 您小时候有什么好玩的事，讲给我听听？ |

检查：`prompt` ≤40 字、`fallbackText` ≤60 字；24 个 id 在 zh/en/ja 三语一致；en/ja 用短翻译。

## 附录 B：拒绝/换话题短语

`gateway/config/i18n/zh/proactivity.json`：

- `switchPhrases`：`换个话题`、`换一个话题`、`说点别的`、`聊点别的`。
- `topicDeclinePhrases`：`不感兴趣`、`不想聊这个`、`别聊这个`、`不想说这个`、`不想聊了`。

规则：

- 只认主动问句之后紧接着的那句用户回复，且在接受窗口（15 秒）内。
- `light` 不算。
- 同时命中：按 switch 处理。
- 没有 `topicKey` 的普通回复：不触发网关的负偏好/立即换话题；交给实时模型。
- 不做情感分析，不因为“今天不想聊”之类泛化文本误记；只认配置短语。

## 附录 C：文案片段与兜底句

### `intents` 新增

```json
"withQuestionQuote": "再问老人一个问题，问句只能用下面【】里老人说过的话；不要补充人名、地名、作品名、日期、数字或其他细节。\n【{material}】",
"withQuestionTopic": "再问老人一个问题，问句只能用下面【】里的话题；不要补充人名、地名、作品名、日期、数字或其他细节。\n【{material}】",
"mustAsk": "最后用一个问句收住；只问一个问题，不要用两个问号。",
"withFollowUp": "顺着刚才的话题问得更具体一点，不要重复上一句，也不要换话题。"
```

### `interestTopic`（context/check，5 条问句）

```
说起来我挺好奇，您今天吃了点什么好吃的？
您平时最爱做点啥打发时间呀？
您年轻时爱听哪首老歌呀？
最近有没有什么好玩的事，跟我说说？
天气好的时候，您爱出去走走吗？
```

### `interestTopicStatement`（leave，5 条陈述/话头）

```
天气好的时候出去走走，晒晒太阳挺舒服的。
这个时节的菜最新鲜，吃着也香。
家里要是养点花草，看着心情也亮堂。
我最近学了几句老歌，还挺有意思的。
小时候的零嘴，现在想起来还觉得香。
```

### `selfShare`（leave，5 条陈述，保留现有）

```
我最近学了几句老歌，唱得还不太准呢。
我今天听人聊起做饭的窍门，还挺有意思的。
说个我自己的小事：我特别喜欢听人讲过去的故事。
我最近对种花挺感兴趣，听说茉莉特别香。
我这阵子在琢磨怎么泡茶更香，还没琢磨明白呢。
```

### `selfShareQuestion`（context/check，5 条“自己的小事 + 问题”）

```
我最近学了几句老歌，您年轻时爱听哪首？
我今天听人聊起做饭的窍门，您平时爱做啥菜？
我最近对种花挺感兴趣，您家里养过花吗？
我这阵子在琢磨怎么泡茶，您平时爱喝什么茶？
我最近喜欢听人讲过去的事，您愿意说说吗？
```

所有行 ≤30 字，无作品名/地名/健康词；`restQuiet` 无问号；`presenceCheck` 保留“还在听/随时”关键词。

## 修订记录

- 2026-10-31：初稿，来自 grilling Q1–Q23。用户确认：Q3 初选 A，后按 Q9/Q11/Q15 收窄；Q13 B 持久化负偏好；Q16 C 默认 90 天冷却、0 永久；Q17 A 随记忆删除、不新增 UI；Q18 A 先 spec 后 plan；Q19 B 只挑话题型事实；Q20 A 只认紧接回复；Q21 B/Q22 A/Q23 A 立即换话题、当前回复结束后无 6 秒等待。
