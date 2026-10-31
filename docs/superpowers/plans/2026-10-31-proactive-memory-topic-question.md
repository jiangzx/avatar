# 主动记忆/随机话题问句实施计划

日期：2026-10-31
状态：**T1–T6 实现完成；T0 真实模型探针未跑；T7 部分完成（gateway/protocol/admin 回归通过；召回 `--temp` 在 HEAD 失败，见 blockers；真实库迁移、`--real-db`、真机 7 项待做）。**
设计：`docs/superpowers/specs/2026-10-31-proactive-memory-topic-question-design.md`（已批准）

## 执行方式

`executing-plans`：用户 2026-10-31 要求“写完计划后直接实现”。T2–T6 都会改 `gateway/src/session/proactive/runtime.ts`，按任务顺序实现，不并行 subagent，避免同一文件冲突。

分支：从当前 master 新建 `feat/proactive-topic-question`（或等价 worktree）。当前工作区有大量无关未提交改动；不覆盖它们，只 `git add <明确路径>`，禁止 `git add -A`。

## 目标

zh 的 context/check 两段，当引擎选中 `interestTopic`/`selfShare` 时，主动句最后带一个记忆/随机话题问句；70/30；无记忆用话题卡；用户拒绝记负偏好；用户说“换个话题”时当前回复结束后立刻换新话题。leave/rest/checkin 与其他意图不变；en/ja 行为不变。

## 非目标

不改 App/协议；不做 en/ja 引擎行为；不做按角色分池；不做敏感健康话题；不改普通回复路径；不新增模型调用；不训练模型。

## 全局约束

- 回复用简体中文；代码注释用英文、简短。
- 日志不含对话内容（音频/ASR/回复/记忆正文/称呼/话题 prompt/key 值）。只记事件名、类型、计数、耗时、错误码；新字段名避开 `text/transcript/content/reply/utterance/prompt/message/instruction/quote/summary`。
- Key 不进日志、错误信息、仓库；只 `git add <明确路径>`。
- TDD：每个任务先写失败测试、确认失败，再实现、确认通过，然后提交。
- 没跑过的不能说完成；报告真实命令和结果。卡住超过 20 分钟记 `docs/blockers.md`。
- 高风险区（四段沉默、记忆注入、记忆 schema）：开工前读 `docs/project/roadmap.md`「记忆与回忆：已踩过的坑」；改后必须跑 gateway 全量、`npm run typecheck -w gateway`、真实记忆库召回探针。
- 冻结契约（见下）不能改名/改形状；要改先停下报告。

## 环境与命令

```bash
# repo root
npm test -w gateway
npm run typecheck -w gateway
npm test -w gateway -- test/<file>.test.ts
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$MEMORY_DB_PATH"
git diff --check
```

T0/T7 真实 Qwen 探针需要 `gateway/.env` 的 `DASHSCOPE_API_KEY`/`QWEN_ENDPOINT`；没有 Key 时记 blocker，跳过探针，不声称通过。

## 任务表

| 任务 | 内容 | 依赖 |
|---|---|---|
| T0 | 真实 Qwen `mustAsk` 探针（建议前置；无 Key 可跳过并记 blocker） | 无 |
| T1 | `proactivity.json` + schema、i18n `proactivity.json`、`director.json` intents/fallbacks、24 条 zh 话题卡 + en/ja id 对齐、admin descriptor、文案测试 | T0（可跳过） |
| T2 | 记忆材料：facts/pins 读取、最近 3 个已结束会话/7 天、过滤、key、`stmt` hash、纯选择函数 + 测试 | T1 |
| T3 | 意图/渲染契约：`question` 三态、`mustAsk`/`withQuestion*`/`withFollowUp`、问题材料、`topicKey`、`checkSpoken`、兜底组 + 测试 | T1、T2 |
| T4 | 概率/轮次：`random` 注入、每轮一次 70/30、同源同话题、follow-up、重置、`has.question` + 测试 | T2、T3 |
| T5 | 负偏好：v9 迁移、store 方法、拒绝/换话题检测、upsert、90 天冷却、删除覆盖 + 测试 | T1、T3、T4 |
| T6 | 立即换话题：`pendingSwitch`、`takeSwitchRequest`、Director/Session 接线、取消/上限/日志 + 测试 | T5 |
| T7 | 收尾：全量回归、typecheck、真实库备份/迁移/召回探针、真机 7 项、roadmap/坑位修订、验收记录 | T1–T6 |

## 冻结契约

```ts
// gateway/src/session/proactive/intent.ts
constraints: { maxChars: number; question: 'forbidden' | 'allowed' | 'required'; mustExpress: 'presence' | null };
material: { quotes: ...; facts: ...; question?: { text: string; said: string | null; topic: boolean } };
questionKey?: string;

// gateway/src/session/proactive/assemble.ts
interface IntentMaterial {
  thread?: ThreadRecord; openLoop?: string; openLoopSensitive?: boolean;
  topic?: string; family?: string;
  question?: { source: 'memory' | 'card'; form: 'quote' | 'topic'; text: string; said: string | null; key: string; cardIndex: number | null };
}

// gateway/src/adapters/types.ts
interface ProactiveRequest { cue: string; instruction: string; fallbackText: string; topicKey?: string }

// gateway/src/session/proactive/acceptance.ts
interface PendingLine { kind: ScoredKind; threadId?: string; topicKey?: string }

// gateway/src/session/proactive/config.ts
topicQuestion: {
  enabled: boolean; memoryRatio: number; recentSessions: number; recentDays: number;
  declineCooldownDays: number; minStatementChars: number;
  factCategories: Array<'preference' | 'person' | 'other' | 'profile'>;
};

// gateway/src/session/proactive/runtime.ts
interface ProactiveRules {
  silence: SilenceRules; healthWords: readonly string[]; declinePhrases: readonly string[];
  evidence: EvidenceRules;
  topicQuestion: { switchPhrases: readonly string[]; topicDeclinePhrases: readonly string[]; factKeywords: readonly string[]; factBlockKeywords: readonly string[] };
}
ProactiveRuntimeDeps { ...; random: () => number; }
MemoryStore { listTopicAvoid(...); recordTopicAvoid(...); clearTopicAvoid(...); deleteTopicAvoidKeys(...); ... }

// gateway/src/roles/types.ts
FALLBACK_KEYS += 'interestTopicStatement' | 'selfShareQuestion';
IntentCopy += withQuestionQuote, withQuestionTopic, mustAsk, withFollowUp;
```

## T0 — 真实 Qwen `mustAsk` 探针

- 新建 `gateway/scripts/probe-topic-question.ts`，复用 `probe-intent-grounding.ts` 的连接与日志方式；合成记忆/话题材料，跑 20–40 次 `interestTopic`/`selfShareQuestion`。
- 统计：问句率、两个问号率、材料外作品名/数字/健康词；结果写 `docs/testing/2026-10-31-topic-question-probe.json`（只放合成场景）。
- 通过线：问句率 ≥90%、两个问号 ≤5%、材料外事实 0。不达线先调 T1 文案；仍不达在 T7 记 blocker，不阻止实现。
- 无 Key：记 `docs/blockers.md`，跳过，T1 继续。

## T1 — 配置、文案、话题卡

**Files:**
- Modify `gateway/config/proactivity.json`、`gateway/src/session/proactive/config.ts`
- Create `gateway/config/i18n/zh/proactivity.json`、`en/proactivity.json`、`ja/proactivity.json`
- Modify `gateway/src/i18n/load.ts`、`gateway/src/i18n/types.ts`
- Modify `gateway/roles/elder-companion/zh/director.json`
- Modify `gateway/roles/elder-companion/{zh,en,ja}/topics.json`
- Modify `gateway/src/roles/types.ts`、`gateway/src/config.ts`
- Modify `gateway/config/admin/descriptors/proactivity.json`、`copy.json`
- Test `gateway/test/proactivity-config.test.ts`、`intent-copy.test.ts`、`i18n.test.ts`、`fileCatalog.test.ts`、`config-snapshot.test.ts`

**Steps:**
1. 先写失败测试：新 `topicQuestion` 字段/边界、i18n 新文件 schema、`IntentCopy` 四字段、`FALLBACK_KEYS` 两组、24 条 topic id 三语对齐、admin descriptor 可解析。
2. 改 schema/类型/JSON；zh 文案用 spec 附录 C；24 条卡用 spec 附录 A；en/ja 只补同 id 短翻译。
3. 跑目标测试 → 全量 gateway → typecheck。
4. 提交。

**Acceptance:** 新配置可加载；`intent-copy` 全绿（5 条下限、≤30 字、无作品名/健康词、rest 无问号、presence 关键词、interestTopic/selfShareQuestion 有问号、Statement/selfShare 无问号）；topic id 三语一致；admin descriptor 可解析。

## T2 — 记忆材料选择

**Files:**
- Create `gateway/src/session/proactive/questionMaterial.ts`（纯函数）
- Modify `gateway/src/session/proactive/runtime.ts`（`ensureLoaded` 读 facts/pins/sessions；新字段）
- Test `gateway/test/proactive-question-material.test.ts`

**Steps:**
1. 先写失败测试：
   - 优先级 threads → facts → statements；`avoid` 排除；敏感/health/safety/addressing/block 关键词排除。
   - `factCategories` + `factKeywords`/`factBlockKeywords`；pins 非敏感。
   - `listSessions` 最后 3 个 ended/7 天；`listSessionUserLines` 过滤证据/短句/问句/健康；`stmt` hash 稳定。
   - 无材料返回 null；`source/form/key/cardIndex` 正确。
2. 实现 `questionMaterial.ts`：`pickMemoryMaterial`、`pickTopicCard`、`pickQuestionMaterial(random, ratio)`；用 `node:crypto` 做 `sha256`；`normalizeUtterance`/`isMemoryEvidence`/`containsPhrase`。
3. `runtime.ensureLoaded` 增加 facts/pins/session statements 与 avoid 读取（T5 前可用空集合/注入参数，T5 接 store）。
4. 跑目标测试 → typecheck → 全量 gateway。
5. 提交。

**Acceptance:** 材料选择纯函数测试全绿；无敏感/健康材料进入结果；无记忆时返回 null。

## T3 — 意图/渲染契约

**Files:**
- Modify `gateway/src/session/proactive/intent.ts`、`assemble.ts`、`render.ts`、`check.ts`
- Modify `gateway/src/adapters/types.ts`、`gateway/src/roles/types.ts`、`gateway/src/config.ts`（T1 已加文案字段）
- Modify `gateway/src/session/proactive/runtime.ts`（render/fallbackKey）
- Test `gateway/test/proactive-render.test.ts`、`proactive-grounding.test.ts`、`intent-copy.test.ts`

**Steps:**
1. 先写失败测试：
   - `question` 三态按 moment/kind 设置；`interestTopic`/`selfShare` 在 context/check required、leave forbidden；rest forbidden；其他 allowed。
   - `mustAsk`/`withQuestionQuote`/`withQuestionTopic`/`withFollowUp` 渲染；`noQuestion` 仍对 forbidden。
   - `interestTopic`/`selfShareQuestion` 兜底组；`topicKey` 写到 `ProactiveRequest`；`fallbackFor` 保留 key。
   - `checkSpoken` 的 `question`/`questionMissing`；材料包含问题材料。
2. 实现类型/组装/渲染/核对；更新现有测试期望。
3. 跑目标测试 → typecheck → 全量 gateway。
4. 提交。

**Acceptance:** 契约测试全绿；每句最多一个问句；问题材料进入核对材料；`topicKey` 不进入协议。

## T4 — 概率与轮次

**Files:**
- Modify `gateway/src/session/proactive/runtime.ts`、`engine.ts`
- Test `gateway/test/proactive-runtime.test.ts`、`proactive-engine.test.ts`、new `proactive-question-runtime.test.ts`

**Steps:**
1. 先写失败测试：
   - `random` 注入；70/30；每轮只调用一次；无记忆 → 100% 话题卡。
   - 同轮同源同话题；check follow-up；content 重置、light 保持、decline 重置。
   - leave 不要求问句；rest/checkin 不变；其他意图不追加。
   - `has.question` 防止无材料时 `selfShare` 被选中。
   - 话题卡轮换 + avoid 过滤；全排除时用最久未用卡并记日志。
2. 实现 `episodeQuestion`/`episodeAsked`、`pickQuestionMaterial` 接入 `silenceLine`、`has.question`。
3. 跑目标测试 → typecheck → 全量 gateway。
4. 提交。

**Acceptance:** 概率/轮次测试全绿；无额外模型调用；`random` 在测试中可固定。

## T5 — 负偏好（v9 + store + 检测 + 删除）

**Files:**
- Modify `gateway/src/memory/migrations.ts`、`store.ts`
- Modify `gateway/src/session/proactive/runtime.ts`、`acceptance.ts`
- Modify `gateway/src/session/session.ts`（rules 接线）
- Test `gateway/test/memory-store.test.ts`、`memory-tools.test.ts`、new `proactive-topic-avoid.test.ts`

**Steps:**
1. 先写失败测试：
   - v8→v9；`proactive_topic_avoid` upsert/冷却/agent 隔离；只存 key。
   - `onUserFinal` 只认紧接回复/15 秒窗口；switch/decline 分类；`topicKey` 从 `acceptance` 传来。
   - clearAgent/clearAll/forget/deleteItem/clearProfile 删除覆盖；`ForgetResult.topicAvoid`。
2. 实现 migration/store/接口/runtime 检测/删除。
3. 跑目标测试 → typecheck → 全量 gateway。
4. 提交。

**Acceptance:** 负偏好测试全绿；无原文；删除路径覆盖；`recall_memory` 不受影响。

## T6 — 立即换话题

**Files:**
- Modify `gateway/src/session/proactive/runtime.ts`、`gateway/src/session/director.ts`、`gateway/src/session/session.ts`
- Test `gateway/test/director-silence.test.ts`、`proactive-session.test.ts`、new `proactive-switch.test.ts`

**Steps:**
1. 先写失败测试：
   - “换个话题”后 `pendingSwitch`；当前回复结束 `onAiTurnEnded` 直发；不 arm 6 秒。
   - 新抽排除被拒 key；barge/新语音/超时取消；上限 `capped`；普通回复无 key 不触发。
   - 日志事件与 `pending='context'` 后续阶梯。
2. 实现 runtime `takeSwitchRequest`、Director `takePendingSwitch`、Session 接线/当前 affect card。
3. 跑目标测试 → typecheck → 全量 gateway。
4. 提交。

**Acceptance:** 立即换话题测试全绿；无 6 秒等待；新话题不等于被拒话题；barge/上限安全。

## T7 — 收尾

- `npm test -w gateway`、`npm run typecheck -w gateway`、`git diff --check`。
- 真实库：`VACUUM INTO` 备份 → 迁移 v9 → `user_version=9`、新表空；三角色 zh 召回探针 true/true/false、`newTitleFlag` 全 false。
- 真机 7 项（spec §12.3）；不能做记 `docs/blockers.md`，不声称通过。
- 更新 `docs/project/roadmap.md`：状态、实际命令与结果、下一项；修正 6/8/10/10 与文本规划器旧描述；更新坑位第 4、8 条并新增负偏好坑位。
- 新增 `docs/testing/2026-10-31-proactive-topic-question-acceptance.md`，只放合成场景与结果。
- 完成后用 `requesting-code-review` / `verification-before-completion` 复查。

## 验收

- 有记忆 → 记忆问句；无记忆 → 话题卡；70/30 每轮一次；同轮同话题。
- context/check 的 `interestTopic`/`selfShare` 必问；leave/rest/checkin 不问；其他意图不追加。
- 拒绝 → 负偏好写入、跨通话避开、随记忆删除；90 天冷却/0 永久。
- “换个话题” → 当前回复结束后立刻新问句，无 6 秒等待。
- 敏感/健康不进话题问句；日志无对话内容；en/ja 行为不变。
- gateway 全量、typecheck、真实库召回探针、真机 7 项有真实记录。

## 执行结果

- [ ] T0 探针（未运行；`gateway/.env` 有 Key，但没有跑真实模型调用）
- [x] T1 配置/文案/话题卡
- [x] T2 记忆材料
- [x] T3 意图/渲染
- [x] T4 概率/轮次
- [x] T5 负偏好
- [x] T6 立即换话题
- [x] T7 收尾（部分）：gateway 128/1510、typecheck；protocol 3/16 + typecheck；admin 24/132 + typecheck + build；`git diff --check` clean。`--temp` 召回探针在 HEAD 失败于 `zh_vague_recent_only`；HEAD~1 通过 133，HEAD 独立 worktree 同样失败，归因 `d6d688a`。`MEMORY_DB_PATH` 未设置，真实库 v9 迁移/`--real-db`/真机 7 项未做。详见 `docs/testing/2026-10-31-proactive-topic-question-acceptance.md` 与 `docs/blockers.md`。
