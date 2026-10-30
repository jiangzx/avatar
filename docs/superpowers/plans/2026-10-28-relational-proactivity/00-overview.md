# 关系连续的主动互动 — Implementation Plan Overview（P0、P1、P2、P3 前半）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划定为 subagent-driven-development，全程只用这一种。

**Goal:** P0 下架 Seeduplex 并保留适配器框架；P1 建一个多天、多会话、带记忆的剧本评测，并录下改造前的基线；P2 建好关系连续所需的数据层（事项线、情绪轨迹、关系画像、反思、主动偏好与计数），对话行为不变；P3 前半做 Qwen 服从度探针、`proactivity.json` 配置接入和纯计算的决策引擎。P3 后半（意图渲染、接入会话）、P4、P5 在探针结果出来后另写。

**Architecture:**
- P0 只删不加：删掉 Seeduplex 的实现、配置、角色卡音色、探针与专属测试、后台提示；保留 `RealtimeAdapter` 接口、三个能力标记和会话里按标记分支的两处代码。推送闸门的回归测试先改用本地 Qwen 上游，再删适配器，覆盖不中断。
- P1 在现有 `gateway/src/eval/` 旁边加「旅程」评测：剧本描述若干天里的若干次会话；runner 用临时 SQLite + `DeviceRegistry` + 抽取 worker 串起会话，用配置快照构造 deps，用可注入的墙钟模拟日期（沉默计时器仍是真实时间）；评委按会话打分，CLI 多次运行取中位数并给出比较门槛。
- P2 只加数据、不改对话行为：`followups` 表演进为事项线（加 `kind`、来源原话 id、提及次数等列），新增 `reflections`、`mood_summaries`、`proactive_*` 表（迁移 v8）；消息表上的触发器保证「删原话 → 删依据它的事项与反思」；会话结束时确定性写情绪摘要；抽取之后同一队列里异步跑反思；关系画像从 `sessions` 推导；设置页接口与 protocol 增加可选字段（App 展示另做）。
- P3 前半：先用最小探针验证 Qwen 是否只用锁定材料说话；`proactivity.json` 接入配置快照与后台；决策引擎是纯函数（候选 → 硬规则 → 打分 → 选择），此时还不接入会话。

**Tech Stack:** Node 24.21+（`node:sqlite`）、TypeScript 7、vitest 5、zod 4（网关现有版本）、React + Ant Design（admin 现有版本）。不新增任何依赖。

**Spec（约束）：** `docs/superpowers/specs/2026-10-28-relational-proactivity-design.md`（已批准，2026-10-28）。决策 Q1–Q26 见 spec「已确认决策」；P0 范围见 spec「现状事实 › Seeduplex 的分布」；P1 设计见 spec「测试与验收」。每个任务的实现者先读 spec 对应章节，再读本总览，最后读自己的任务文件。

## Global Constraints

- 回复用简体中文；代码注释用英文，简短。
- 日志永远不含对话内容（音频、ASR 文本、回复文本、记忆正文、称呼）。日志只记事件名、id、计数、耗时、错误码；字段名不能含 `fieldGuard` 禁用词（text/transcript/content/reply/utterance/prompt/message/instruction/quote/summary）。
- 评测剧本和结果只能放在 `docs/testing/`，全部是手写的合成内容（AGENTS.md 第 2 条例外）。CLI 只往 stderr 打场景 id，不打印剧本或回复正文。
- Key 不进日志、错误信息、仓库。只用 `git add <明确路径>`，禁止 `git add -A`，不覆盖与任务无关的未提交改动。
- 分层：server → (session, identity) → (adapter, memory, roles)；`eval/` 只被 `scripts/` 使用，不被生产代码 import。没有模块级可变状态：`SimClock`、数据库、worker 都在 runner 里按旅程创建。
- 只在边界（剧本 JSON、评委 JSON、CLI 参数）用 zod 校验，失败就拒绝。
- **高风险区**：本计划不改开场、四段沉默、召回、记忆注入的行为。P1-T1 只把四处写时间戳的 `Date.now()` 换成可注入时钟（生产行为不变）。P0-T4 改写 `AGENTS.md` 一行与 roadmap 坑位第 7、12 条，属于用户已批准的 spec「坑位契约修订」。完成后必须跑 gateway 全量测试、typecheck 和真实记忆库召回探针。
- TDD：每个任务先写失败测试、确认失败，再实现、确认通过，然后提交。提交信息结尾的 `Co-Authored-By` 行以执行时会话系统给出的署名为准，任务文件里写的只是示例。
- 没跑过的东西不能说完成。报告里写真实命令和结果。
- 卡住超过 20 分钟（环境、Key）：做一次手动验证，记入 `docs/blockers.md`，按 AGENTS.md 第 7 条处理，并在进度报告里列出所有跳过的项。
- 冻结契约（下文）不能改名或改形状。确实要改：停下报告，由协调者更新本总览和受影响任务后再继续。

## 环境前置（执行机器）

| 项 | 要求 | 检查命令 |
|---|---|---|
| 分支 | `dev-proactivity`（已推送到 origin，含 spec 与本计划，基于 `dev-admin` `bf49c4f`） | `git fetch origin && git switch dev-proactivity && git pull --ff-only && ls docs/superpowers/plans/2026-10-28-relational-proactivity/` |
| Node | ≥ 24.21 | `node -v` |
| 依赖 | 仓库根目录 `npm ci` | `npm ls --workspaces --depth=0` |
| 模型 Key（P0-T4 Qwen smoke、P1-T6 基线） | `gateway/.env` 中 `DASHSCOPE_API_KEY`、`QWEN_ENDPOINT`、`QWEN_SUMMARIZER_ENDPOINT`；不要打印内容 | `test -f gateway/.env && echo ok` |
| 记忆库（P0-T4 覆盖层核对、召回探针） | `MEMORY_DB_PATH` 指向仓库外的真实库，只读使用 | `test -f "$MEMORY_DB_PATH" && echo ok` |

## 命令

```bash
# repo root
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
npm test -w gateway -- test/<file>.test.ts                      # one gateway test file
npm test -w admin && npm run typecheck -w admin && npm run build -w admin
node docs/testing/plan3-mock-smoke.mjs                           # Mock smoke (see docs/blockers.md for its two stale asserts)
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$MEMORY_DB_PATH"
# after P1-T5
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --adapter qwen \
  --journeys docs/testing/relational-eval/journeys.json --judge docs/testing/relational-eval/rubric.md \
  --runs 3 --out docs/testing/relational-eval/results-baseline.json
node --env-file-if-exists=gateway/.env --import tsx gateway/scripts/eval-journey.ts --compare docs/testing/relational-eval/results-baseline.json docs/testing/relational-eval/results-after.json
```

## 计划与任务

计划按 P0 → P1 → P2 → P3 前半的顺序执行，每份结束都能独立验收。任务文件命名 `p<计划>-<序号>-<名字>.md`。

### 计划 P0：下架 Seeduplex（保留适配器框架）

| 任务 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| P0-T1 | `p0-01-push-seam-qwen.md` | 推送闸门回归测试（blockers #48）改用本地 Qwen 上游，不再 import Seeduplex | 无 |
| P0-T2 | `p0-02-gateway-removal.md` | 删除网关里的 Seeduplex：适配器、`ADAPTER`/`SEEDUPLEX_*`、角色卡 `voices.seeduplex`、`VoiceAdapter`、注释、专属测试、5 个探针脚本、`.env.example` | T1 |
| P0-T3 | `p0-03-admin-protocol.md` | 后台概览去掉「当前使用 Seeduplex」提示；protocol 注释；历史标签保留 | T2 |
| P0-T4 | `p0-04-acceptance.md` | `AGENTS.md` 一行、roadmap 坑位第 7、12 条；全量回归、Mock/Qwen smoke、真实库覆盖层只读核对、召回探针；roadmap 状态 | T1–T3 |

### 计划 P1：多会话剧本评测与基线

| 任务 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| P1-T1 | `p1-01-clock-injection.md` | Session 四处时间戳改用 `deps.now`；`applyExtractOps` 接收 `now`，worker 传入自己的时钟 | P0 |
| P1-T2 | `p1-02-journey-schema.md` | `SimClock`、旅程剧本 schema、会话时间换算 | T1 |
| P1-T3 | `p1-03-journey-runner.md` | `runJourney`：临时库 + 注册表 + worker + 快照 deps，逐会话驱动；harness 导出复用 | T2 |
| P1-T4 | `p1-04-journey-judge.md` | 旅程评委：按会话打分（含编造、挽留计数）、输入构造、聚合；`rubric.md` | T2 |
| P1-T5 | `p1-05-journey-cli.md` | `scripts/eval-journey.ts`：多次运行、结果 JSON、中位数、`--compare` 门槛 | T3、T4 |
| P1-T6 | `p1-06-baseline.md` | `journeys.json` 剧本；真实 Qwen 跑三次基线并入库；roadmap | T5 |

### 计划 P2：数据层（对话行为不变）

| 任务 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| P2-T1 | `p2-01-schema-v8.md` | 迁移 v8：`followups` 加列并回填来源、四张新表、引用删除触发器；清空角色与语音「忘掉」覆盖新表；版本断言与召回探针同步 | P1 |
| P2-T2 | `p2-02-thread-extraction.md` | 抽取写事项类型（`kind`）与来源原话 id；zh 抽取提示词 | T1 |
| P2-T3 | `p2-03-thread-store.md` | 事项查询与生命周期写入（列出、标记已提及、关闭） | T1 |
| P2-T4 | `p2-04-mood-summary.md` | 情绪摘要：会话结束确定性聚合写库、读取 | T1 |
| P2-T5 | `p2-05-relationship-stats.md` | 关系画像：从 `sessions` 推导首次见面、次数、时长、活跃天数、作息直方图 | T1 |
| P2-T6 | `p2-06-reflection.md` | 反思：提示词（zh/ja/en）、配置、worker 任务、写库；旅程 runner 等反思完成 | T1 |
| P2-T7 | `p2-07-proactive-store.md` | 主动档位、接受/拒绝计数、每日计数、最近兜底句 | T1 |
| P2-T8 | `p2-08-settings-admin.md` | protocol 可选字段；设置页列出与删除事项、反思、情绪摘要；后台条数 | T2–T6 |
| P2-T9 | `p2-09-acceptance.md` | 全量回归；真实库副本迁移与召回探针；旅程 Mock 冒烟；roadmap | T1–T8 |

### 计划 P3（前半）：探针、配置与决策引擎

| 任务 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| P3-T0 | `p3-00-qwen-probe.md` | 真实 Qwen 服从度探针：锁定材料（含敏感原话）下是否编造；结果决定 P3 后半的渲染方案 | P2 |
| P3-T1 | `p3-01-proactivity-config.md` | `proactivity.json` schema、快照、交叉校验、覆盖键、后台「主动互动」场景 | P3-T0 |
| P3-T2 | `p3-02-decision-engine.md` | 意图契约与决策引擎（纯函数）：候选、硬规则、打分、接受率系数、疲劳、档位、事项资格 | P3-T1 |

## 冻结契约

以下名字和形状在任务之间共享，不能改：

```ts
// gateway/src/session/session.ts — SessionDeps (existing field, now also used for transcript/notice/tool timestamps)
now?: () => number;

// gateway/src/memory/extract.ts
export function applyExtractOps(store: MemoryStore, ownerId: string, agentId: string,
  epochsAtStart: { owner: number; agent: number }, ops: readonly ResolvedOp[], messageIds: readonly string[],
  now?: number): 'applied' | 'stale' | 'incomplete';

// gateway/src/eval/simClock.ts
export class SimClock {
  constructor(base?: () => number);
  readonly now: () => number;  // arrow property (safe to pass unbound): base() + offset
  setTo(at: number): void;     // after this, now() === at, then keeps ticking with base
}

// gateway/src/eval/journey.ts
export const DAY_MS = 86_400_000;
export type JourneySession = { day: number; time: string; character?: CharacterId; turns: string[]; silenceAfterMs?: number; note?: string };
export type Journey = { id: string; title: string; character: CharacterId; start: string; sessions: JourneySession[] };
export function loadJourneys(path: string): Journey[];
export function parseJourneys(raw: unknown): Journey[];
export function sessionStartAt(journey: Journey, session: JourneySession): number; // epoch ms, Asia/Shanghai wall time
export interface JourneyReply { turn: number; kind: ResponseKind; text: string }
export interface SessionRun { index: number; day: number; time: string; startedAt: number; character: CharacterId; firstMeet: boolean; replies: JourneyReply[] }
export interface JourneyRun { journeyId: string; sessions: SessionRun[] }
export interface JourneyEnv {
  snapshot: ConfigSnapshot;
  factories: SnapshotFactories;
  runtime: Omit<SessionRuntimeDeps, 'store' | 'writer' | 'worker' | 'now' | 'onReplyMetrics'>;
  /** Extraction client; undefined = no memory extraction (Mock runs). */
  extractClient?: TextModelClient;
  logger?: Logger;
}
export function runJourney(env: JourneyEnv, journey: Journey, cfg: EvalConfig): Promise<JourneyRun>;

// gateway/src/eval/judge.ts (existing, now exported)
export function parseJudgeJson(raw: string): unknown;

// gateway/src/eval/harness.ts (existing, now exported)
export class SimTransport; export interface Played; export function playResponses(...); export function playSilence(...);

// gateway/src/eval/journeyJudge.ts
export const JOURNEY_DIMENSIONS = ['continuity', 'naturalness', 'noRepetition', 'empathyFit', 'noIntrusion'] as const;
export type JourneyDimension = (typeof JOURNEY_DIMENSIONS)[number];
export type SessionScores = Record<JourneyDimension, number> & { fabrications: number; retentionPressure: number };
export interface JourneyJudgeInput { journeyId: string; title: string; note: string | null;
  previous: Array<{ day: number; time: string; character: CharacterId; turns: Array<{ role: 'user' | 'assistant'; text: string }> }>;
  current: { day: number; time: string; character: CharacterId; turns: Array<{ role: 'user' | 'assistant'; text: string }> } }
export function toJourneyJudgeInputs(journey: Journey, run: JourneyRun): JourneyJudgeInput[];
export function judgeJourneySession(client: TextModelClient, rubric: string, input: JourneyJudgeInput, policy: PolicySpec, opts: JudgeOptions): Promise<SessionScores | null>;
export interface RunAggregate { scored: number; failures: number; mean: Record<JourneyDimension, number> | null; fabrications: number; retentionPressure: number }
export function aggregateRun(scores: ReadonlyArray<SessionScores | null>): RunAggregate;

// gateway/src/eval/journeyResults.ts
export interface JourneyResults { commit: string; dirty: boolean; date: string; adapter: string; journeyFile: string; rubricFile: string | null; judgeModel: string | null;
  runs: Array<{ aggregate: RunAggregate | null; journeys: Array<{ id: string; title: string; sessions: Array<SessionRun & { scores: SessionScores | null }> }> }>;
  median: Record<JourneyDimension, number> | null; fabricationsTotal: number; retentionPressureTotal: number }
export function medianOf(runs: JourneyResults['runs']): Record<JourneyDimension, number> | null;
export interface JourneyGate { fabricationsZero: boolean; continuityUpHalf: boolean; naturalnessNotDown: boolean; noIntrusionNotDown: boolean; empathyFitNotDown: boolean; pass: boolean }
export function compareJourneyResults(before: JourneyResults, after: JourneyResults): JourneyGate;
```

### P2 冻结契约

```ts
// gateway/src/memory/store.ts (memory layer: must not import from session/)
export const THREAD_KINDS = ['event', 'concern', 'plan'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];
export type AffectEmotion = 'neutral' | 'happy' | 'sad' | 'love';
export type FollowupChange =
  | { op: 'add'; text: string; dueAt: number; quote?: string; sensitive?: boolean; kind?: ThreadKind; sourceMessageIds?: readonly string[] }
  | { op: 'update'; id: string; text?: string; dueAt?: number }
  | { op: 'remove'; id: string };
export interface ThreadRecord { id: string; kind: ThreadKind; quote: string; dueAt: number; sensitive: boolean;
  mentionCount: number; lastMentionedAt: number | null; createdAt: number; sourceSessionId: string | null }
export type ThreadCloseReason = 'resolved' | 'declined' | 'expired';
export interface MoodSummaryInput { sessionId: string; dominant: AffectEmotion; peakIntensity: 1 | 2 | 3;
  endEmotion: AffectEmotion; endIntensity: 1 | 2 | 3; endTrend: 'better' | 'worse' | 'flat'; crisis: boolean }
export interface MoodSummaryRecord extends MoodSummaryInput { id: string; createdAt: number }
export interface RelationshipStats { firstMetAt: number | null; sessions: number; totalMinutes: number; activeDays: number;
  lastSessionAt: number | null; hourHistogram: number[] /* 24 buckets, Asia/Shanghai, ended sessions only */ }
export interface ReflectionRecord { id: string; text: string; evidenceMessageIds: string[]; createdAt: number }
export type ProactiveTier = 'quiet' | 'moderate' | 'active';
export interface DeletedItem { kind: 'profile' | 'agent_fact' | 'pinned' | 'thread' | 'reflection' | 'mood'; agentId: string | null; text: string; sourceMessageIds: string[] }

// MemoryStore additions (SqliteMemoryStore implements all)
listOpenThreads(ownerId: string, agentId: string): ThreadRecord[];
markThreadMentioned(ownerId: string, id: string, now: number): boolean;
closeThread(ownerId: string, id: string, reason: ThreadCloseReason, now: number): boolean;
recordMoodSummary(ownerId: string, agentId: string, input: MoodSummaryInput, now: number): boolean;
listMoodSummaries(ownerId: string, agentId: string, limit: number): MoodSummaryRecord[];
relationshipStats(ownerId: string, agentId: string): RelationshipStats;
listSessionUserLines(ownerId: string, agentId: string, sessionId: string): Array<{ id: string; text: string }>;
insertReflections(ownerId: string, agentId: string, sessionId: string, items: ReadonlyArray<{ text: string; evidenceMessageIds: readonly string[] }>, now: number): number;
listReflections(ownerId: string, agentId: string, limit: number): ReflectionRecord[];
getProactiveTier(ownerId: string, agentId: string): ProactiveTier | undefined;
setProactiveTier(ownerId: string, agentId: string, tier: ProactiveTier, now: number): void;
recordProactiveOutcome(ownerId: string, agentId: string, kind: string, outcome: 'accepted' | 'rejected', now: number): void;
proactiveStats(ownerId: string, agentId: string): Array<{ kind: string; accepted: number; rejected: number }>;
incrementProactiveDaily(ownerId: string, agentId: string, day: string): number;
proactiveDaily(ownerId: string, agentId: string, day: string): number;
recentFallbackLines(ownerId: string, agentId: string, key: string, limit: number): number[];
recordFallbackLine(ownerId: string, agentId: string, key: string, line: number, now: number, keep: number): void;

// gateway/src/memory/extract.ts
export function attachQuoteSources(ops: readonly ResolvedOp[], users: ReadonlyArray<{ id: string; text: string }>): ResolvedOp[];

// gateway/src/session/mood.ts
export function summarizeMood(summary: AffectSummary, last: AffectCard | null, peak: number, sessionId: string): MoodSummaryInput | null;

// gateway/src/memory/worker.ts — MemoryWorkerOptions additions and method
reflectPrompts?: Partial<Record<Language, string>>;
export interface ReflectConfig { enabled: boolean; maxTokens: number; maxItems: number; maxChars: number; contextItems: number }
reflect?: ReflectConfig;   // structurally equal to MemoryBudgetConfig['reflect']; memory/ must not import session/pacing.ts
reflectSession(ownerId: string, agentId: string, sessionId: string, language?: Language): Promise<void>;

// gateway/src/roles/catalog.ts — RoleCatalog addition
reflectPrompt(language?: Language): string;

// gateway/config/memory.json — new key
"reflect": { "enabled": true, "maxTokens": 400, "maxItems": 3, "maxChars": 60, "contextItems": 10 }

// protocol/src/memoryApi.ts — additive, optional
export interface MemoryThreadItem extends MemoryItem { kind: 'event' | 'concern' | 'plan'; sensitive: boolean }
export interface MemoryMoodItem { id: string; day: string; emotion: 'neutral' | 'happy' | 'sad' | 'love'; peak: 1 | 2 | 3 }
// MemoryOverview.characters[i] gains: threads?: MemoryThreadItem[]; reflections?: MemoryItem[]; moods?: MemoryMoodItem[]
```

```ts
// gateway/src/session/proactive/assemble.ts
export interface PlannedIntent { intent: ProactiveIntent; purpose: IntentPurpose; fallbackOnly: boolean; allowCare: boolean }
```

## 依赖与并行

全部顺序执行，不并行。P1 依赖 P0 完成（P1-T3 的 runner 只支持 mock/qwen）；P2 依赖 P1（P2-T6 修改 P1 的 runner）；P3 前半依赖 P2（决策引擎读 P2 的数据形状）。每份计划结束时停下，等用户确认再开始下一份。
