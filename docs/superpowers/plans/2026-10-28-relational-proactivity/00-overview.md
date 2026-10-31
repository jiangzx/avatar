# 关系连续的主动互动 — Implementation Plan Overview（P0–P5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划定为 subagent-driven-development，全程只用这一种。

**Goal:** P0 下架 Seeduplex 并保留适配器框架；P1 建一个多天、多会话、带记忆的剧本评测，并录下改造前的基线；P2 建好关系连续所需的数据层（事项线、情绪轨迹、关系画像、反思、主动偏好与计数），对话行为不变；P3 前半做 Qwen 服从度探针、`proactivity.json` 配置接入和纯计算的决策引擎。P3 后半（2026-10-29 追加）把意图组装、渲染、兜底、事后核对接入四段沉默与话题聊干，并做接受判定与语音调档；开场仍按现状，留给 P4。P4（2026-10-29 追加）改造已知称呼开场、删除 care 与文本规划器、熟悉度语气进会话指令；P5（2026-10-29 追加）做最终评测门槛、真机验收与真人盲测。

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

### 计划 P3（后半）：意图渲染与接入四段沉默（2026-10-29 追加）

**渲染方案（用户 2026-10-29 已定，spec 开放项 3）：** 非敏感意图用探针写法 A 的指令交给 Qwen 说；`sensitive=1` 的事项（健康类）不进实时模型指令，直接说兜底句组 `fallbacks.threadSensitive`；事后核对增加材料外健康词计数，只记日志。

**执行约定：** 代码只在执行机器上实现与验证。本计划编写时**没有**在编写机试跑任何代码（与 P0–P3 前半不同）；测试期望按公式和现有代码手算。执行者发现计划里的签名、文件位置与现有代码不一致时，以现有代码为准做最小调整，并在任务报告里逐条列出；冻结契约要改形状时停下报告。

| 任务 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| P3-T3 | `p3-03-intent-copy.md` | `director.json` 的 `intents`（写法 A 指令片段、目的、语气、时间说法）与 `fallbacks.*` 十组兜底句（zh）；i18n `silence.json` 新增档位、告别、家人词表（zh/ja/en）；`proactivity.json` 新增 `material.familyLookback`；快照交叉校验 `fallbackAfterMs`；后台「文案」场景开放十组兜底句 | P3-T2 |
| P3-T4 | `p3-04-intent-render.md` | 纯函数：意图组装（`buildIntent`、应对阶段、时间说法、北京日期）、渲染（写法 A / 敏感直接兜底 / 照读句）、兜底选句（不重复）、事后核对（作品名、数字、材料外健康词、问句、checkin 要义） | P3-T3 |
| P3-T5 | `p3-05-proactive-runtime.md` | 会话级 `ProactiveRuntime`：预取决策上下文、按沉默段决策与组装、话题聊干把关、开口计数与事项提及、接受判定、语音调档、跨会话写入（按记忆告知与同意把关）、四类内容无关日志 | P3-T4 |
| P3-T6 | `p3-06-wire-silence.md` | **高风险**：`SilencePlan` 增加 `request`/`quiet`，`Director` 照说现成请求或安静跳段；`Session.planProactiveLine` 沉默段先问运行时，运行时不管时才走原文本规划器；`Session` 接线（请求归属、超时兜底、播完核对、用户终稿判定、话题聊干把关、忘记后重载） | P3-T5 |
| P3-T7 | `p3-07-acceptance.md` | 坑位第 4、8 条修订；WAL 备份后真实库迁到 v8；全量回归、召回探针、Mock 冒烟、真实 Qwen 旅程评测对比基线；roadmap | P3-T6 |

**编写计划时定的取舍（用户 2026-10-29 已确认全部 11 条；P3-T7 Step 8 写入 spec 修订记录）：**

1. **开场不动，规划器暂留**：已知称呼开场、care 关怀、首次见面都保持现状，属于 P4。接法是保留 `Director` 现有的「每段沉默先问 `planProactiveLine`」口子：`Session` 在这个口子里先问决策引擎；引擎给出请求就照说、选安静就跳到下一段、用户在告别就收住；只有引擎不处理的情况（当前语言没有 `intents`，或还没聊起来且不知道称呼）才走原来的文本规划器。这样 `Director` 的计时与状态机只加两个分支，现有沉默测试基本不用改。zh 已聊起来或已知称呼时，四段沉默不再调文本模型（spec「`planProactiveLine` 在 P3 中移除」的实质）；规划器代码与 checkin 词表硬校验在 P4 随开场改造一起删除——它们在 P3 之后只服务开场、zh 无称呼的头几段和 ja/en。
2. **ja/en 保持现状**：Q21 只调中文，ja/en 不写 `intents`/`fallbacks`，四段沉默继续由原规划器说（失败说配置文案），没有体验退步。
3. **话题聊干只保留「AI 说自己的小事」**：话题聊干现在是给被动回复的指令里加一行提示（`exhaustedHint`），这一行进的是会话指令。为了不让事项原话、家人原话进会话常驻指令，话题聊干时机只给引擎 `selfShare` 一个候选（事项、兴趣、家人都置空）；引擎选中才挂提示，选 `quiet` 就不挂。计入本会话与今天的主动次数，但不做接受判定。
4. **`continueThread` 的材料**：优先用情绪卡的 `openLoop`；没有时用用户本段最后一句实质发言，但必须先过 `isMemoryEvidence`（提问、质疑、回忆问句不能当材料，坑位第 1 条）。含 `healthWords` 的那句按健康类处理：不进指令，照读 `continueThread` 兜底句（把 2026-10-29 的健康类规则延伸到本会话原话）。`humanConnection` 的家人原话同样排除含健康词的句子。
5. **语音调档后不另说确认句**：用户说「少说点」时，Qwen 本来就会自动回复这句话；再插一条主动句会和自动回复撞车。档位照常调整并记日志，确认由被动回复完成。这偏离 spec「调节后说一句确认（兜底句组）」。
6. **接受判定的窗口**从这句播完（或被打断）开始计；轻回应不计、窗口继续；窗口内 AI 又主动开口或会话结束仍无回应，按拒绝计。`acceptance.windowMs`（15 s）比最短沉默段长，所以实际窗口是「到下一句主动开口为止」，不另加交叉校验。
7. **跨会话写入按记忆告知把关**：档位、接受计数、今日次数、兜底句与话题卡去重、事项提及与婉拒关闭，只在 `memoryGate()==='ok'`（告知已播且未拒绝）时写库；否则只在本会话内存里计数。存储层的这几个方法本身不检查同意（P2-T7 现状）。
8. **超时兜底（UNVERIFIED）**：主动请求发出后 `fallbackAfterMs`（3 s）内没有 `response.created`，且此刻没有在生成、没有在播、用户没在说、不在工具轮，就照读同一意图的兜底句一次；不发 `response.cancel`（坑位「打断与沉默」第 6 条）。Qwen 迟到的原请求与兜底句是否会连说两句未验证；P3-T7 用日志里 `proactive_fallback` 与相邻 `response_start` 计数检查。
9. **行为变化风险**：引擎有疲劳系数和每次会话上限（适中档 4 句），四段沉默不再每段都说，「安静」会明显变多。这是 Q13 的设计；P3-T7 用旅程评测的 noIntrusion / naturalness 检查，必要时在后台调门槛与上限，不改代码。
10. **`humanConnection` 的周上限没做**：spec 意图表写「有周上限」，但现有数据没有按意图记录最近一次开口时间（`proactive_stats` 只有累计数）。P3 先靠本会话新鲜度、每天上限和接受率系数约束，周上限在 P4 评估是否需要加列。
11. **旧的 `*Text` 配置文案暂不并入句组**：它们仍服务原规划器路径（ja/en、zh 无称呼的头几段）和后台现有描述符；P4 删除规划器时一并清理（spec「现有 18 句 `*Text` 在 P3/P4 中并入或改写」）。

### P3 后半冻结契约

```ts
// gateway/src/roles/types.ts
export const INTENT_PURPOSES = ['threadEventBefore', 'threadEventAfter', 'threadConcern', 'threadPlan',
  'moodCheckNow', 'moodCheckEarlier', 'routineMorning', 'routineNoon', 'routineEvening', 'routineNight',
  'continueThread', 'interestTopic', 'humanConnection', 'selfShare', 'presenceCheck', 'restQuiet'] as const;
export type IntentPurpose = (typeof INTENT_PURPOSES)[number];
export const FALLBACK_KEYS = ['threadFollowup', 'threadSensitive', 'moodCheck', 'routine', 'continueThread',
  'interestTopic', 'humanConnection', 'selfShare', 'presenceCheck', 'restQuiet'] as const;
export type FallbackKey = (typeof FALLBACK_KEYS)[number];
export interface IntentCopy {
  frame: string;            // {maxChars} {purpose}
  withQuote: string;        // {said} {material}
  withTopic: string;        // {material}
  withoutMaterial: string;
  noQuestion: string;
  speakLine: string;        // {line}
  purposes: Record<IntentPurpose, string>;
  tones: { new: string; familiar: string; oldFriend: string; explore: string; comfort: string; suggest: string };
  saidWhen: { justNow: string; today: string; yesterday: string; days: readonly string[] /* 2..6 days ago, length 5 */; lastWeek: string; earlier: string };
}
export type FallbackGroups = Record<FallbackKey, readonly string[]>;
// DirectorConfig gains: intents?: IntentCopy; fallbacks?: FallbackGroups;   (both or neither)

// gateway/src/i18n/types.ts — SilenceRules gains
tierDown: readonly string[]; tierUp: readonly string[]; farewell: readonly string[]; familyWords: readonly string[];

// gateway/src/session/proactive/config.ts — ProactivitySchema gains
material: { familyLookback: number };   // 1..200

// gateway/src/session/proactive/assemble.ts
export interface IntentMaterial { thread?: ThreadRecord; openLoop?: string; openLoopSensitive?: boolean; topic?: string; family?: string }
export interface PlannedIntent { intent: ProactiveIntent; purpose: IntentPurpose; fallbackOnly: boolean }
export function beijingDay(at: number): string;                       // 'YYYY-MM-DD'
export function careStage(card: AffectCard | null): CareStage;
export function saidWhen(at: number, now: number, words: IntentCopy['saidWhen']): string;
export function buildIntent(decision: Decision, input: BuildInput): PlannedIntent | null;  // null for quiet / greetingPlain

// gateway/src/session/proactive/render.ts
export function renderIntent(planned: PlannedIntent, copy: IntentCopy, fallbackLine: string): ProactiveRequest;
export function speakLineRequest(copy: IntentCopy, line: string): ProactiveRequest;

// gateway/src/session/proactive/fallback.ts
export function pickFallback(count: number, recent: readonly number[]): number;

// gateway/src/session/proactive/check.ts
export interface SpokenCheck { titles: number; numbers: number; health: number; question: boolean; presenceMissing: boolean }
export function checkSpoken(text: string, spec: CheckSpec, rules: CheckRules): SpokenCheck;

// gateway/src/session/director.ts — SilencePlan gains (both optional, additive)
request?: ProactiveRequest;   // spoken as-is instead of wrapping `text` in speakInstruction
quiet?: boolean;              // move to the next silence step without speaking

// gateway/src/session/proactive/runtime.ts
export type SilenceStep = 'context' | 'check' | 'leave' | 'checkin' | 'rest';
export type ProactiveLineResult = { request: ProactiveRequest } | { quiet: true } | { close: true } | null;

// gateway/src/session/proactive/runtime.ts
export class ProactiveRuntime {
  constructor(deps: ProactiveRuntimeDeps);
  silenceLine(input: SilenceInput): ProactiveLineResult;
  approveExhausted(armedCount: number, input: { language: Language; card: AffectCard | null; lowIntensity: number }): boolean;
  owns(request: ProactiveRequest): boolean;
  onRequestRefused(request: ProactiveRequest): void;
  onLineStarted(request: ProactiveRequest): void;
  fallbackFor(request: ProactiveRequest): ProactiveRequest | null;
  onLineEnded(text: string, interrupted: boolean): void;
  onUserFinal(text: string, light: boolean, language: Language): void;
  reload(): void;
  end(): void;
}

// gateway/src/session/affect.ts — AffectTracker gains
get exhaustedArmedCount(): number;
```

### 计划 P4：开场改造与清理（2026-10-29 追加）

**前提：** P3 后半验收通过（P3-T7）。P4 的代码建立在 P3 后半的冻结契约上；**开工前先做 P4-T0 复核**：对照执行机器上 P3 的实际代码与 P3-T7 评测结果，确认下表依赖的名字和形状都在，评测里主动开口没有编造。任何一条不成立就停下报告，由编写机修订 P4 计划后再执行。与 P3 后半一样，本计划没有在编写机试跑任何代码。

| 任务 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| P4-T0 | （无文件，写进任务报告） | 复核 P3 实际代码与评测结果：`ProactiveRuntime` 方法、`IntentCopy`、`buildIntent`/`renderIntent` 签名、`SilencePlan.request/quiet`、`proactive_*` 日志都在；`results-p3.json` 编造没有来自主动开口 | P3 |
| P4-T1 | `p4-01-thread-retention.md` | 每晚的「care 原话 7 天清空」改成按事项生命周期关闭过期事项（`expired`），修复事项超过 7 天就从 `listOpenThreads` 消失的问题；删除 `clearStaleCareQuotes`。**它只依赖 P3-T1 的配置，可以提前到 P3-T7 之后立即做**（P3 上线后真实库里的事项就会受这个问题影响） | P3-T1（按序放在 P4-T0 之后） |
| P4-T2 | `p4-02-opening-intent.md` | 开场意图：`IntentCopy.opening`、目的 `greetingPlain`；`buildIntent` 支持 `greetingPlain`；`renderIntent` 开场带称呼；运行时 `prefetch`、`openingLine`（同一语言重试复用同一句）、开场兜底句（`greetingNameTexts` / `greetingCareTexts` 开头 + 该意图兜底句） | P4-T1 |
| P4-T3 | `p4-03-wire-opening.md` | **高风险**：`Director` 开场顺序改为「首次见面模板 → 引擎开场 → 称呼模板 → 配置开场」；`Session` 删除 care 关怀开场，接入引擎开场与超时兜底；删除 `care.ts`、`care.md`、`carePrompt`、`careFollowup`、`closeCareFollowup`；`affect.care` 退役但保留在基线里（已存覆盖层仍能构建） | P4-T2 |
| P4-T4 | `p4-04-familiarity-tone.md` | 开放项 2：按熟悉度把一句固定语气说明接在人设后面（`familiarityTones`，只 zh）；启动预算检查计入最长那句 | P4-T3 |
| P4-T5 | `p4-05-remove-planner.md` | 删除文本模型沉默规划器（`silence.ts`、`silenceDecision`、`Session.textPlan` 与只服务它的接线）；不知道称呼的开场、zh 未开口前几段、ja/en 四段沉默改说配置指令 | P4-T3 |
| P4-T6 | `p4-06-human-connection-interval.md` | `humanConnection` 周上限：`proactive_stats.updated_at` 读出上次结果时间，`humanConnection.minIntervalDays`（7）内不再引导联系家人 | P4-T2 |
| P4-T7 | `p4-07-acceptance.md` | 坑位第 4、5、8 条修订；回归、召回探针、旅程评测（对比基线与 P3）、共情评估与 plan-a；真机开场验收（用户在场）；roadmap | P4-T1–T6 |

**编写计划时定的取舍（用户 2026-10-29 已确认全部 10 条；P4-T7 写入 spec 修订记录）：**

1. **不知道称呼的开场**：规划器删除后，由 Qwen 按 `greetingInstruction`（自我介绍、问称呼）直接说，不再先由文本模型写句子。仍是「自我介绍并问称呼、不提记忆」，按 Q15「首次见面和不知道称呼的开场保持现状」的实质处理；少一次文本模型调用，开场更快。
2. **ja/en 四段沉默与 zh 未开口前几段**：规划器删除后说配置指令（`contextInstruction`/`followupInstruction` 等，由 Qwen 按指令说），Q21「ja/en 只保证能加载、能兜底」。
3. **开场兜底句不新增句组**：`greetingPlain` 的兜底用现有 `greetingNameTexts`（后台已可改）；事项、情绪、作息开场的兜底用 `greetingCareTexts` 的开头（「{name}，又见面啦。」）接上该意图的兜底句，与原 care 开场的拼法相同。
4. **开场的事项原话**：非敏感事项原话作为锁定材料进开场指令（Qwen item 模式下会留在本次通话的上下文里），与 P3 坑位第 4 条修订一致；健康类开场照读拼好的兜底句，原话不进指令。原 care「原话只进文本模型」的例外随 care 一起删除。
5. **`affect.care` 退役但不删**：代码不再读它；后台描述符删除；基线 JSON 与 schema 保留，原因是已存的覆盖层若含 `affect:care.maxAgeDays`，删掉键会让整个覆盖层在启动时被拒（`config_overlay_rejected`，所有后台改动失效）。执行机器上确认线上覆盖层不含 care 键后，再在以后的清理里删除。
6. **事项过期**：每晚关闭「再也不会被提起」的事项（提及次数到上限，或超过事件后 `postDays` / 牵挂 `expireDays` / 计划 `maxDays`），关闭即清空原话；不再按创建 7 天一刀切。
7. **熟悉度语气放在角色 `director.json`**（`familiarityTones`），不是 spec 写的 i18n 文件：它是角色口吻，且只调 zh；ja/en 没有这项就不加语气说明。
8. **旧 `*Text` / `*Instruction` 配置文案保留**：它们是配置路径（ja/en、无称呼、引擎不处理时）的兜底，不再并入句组。
9. **`humanConnection` 周上限的近似**：`proactive_stats.updated_at` 在记录接受 / 拒绝时更新，约等于上次开口时间（开口后最晚到下一句或会话结束就会记结果）。不新增表或列。
10. **称呼模板开场不再依赖文本模型**：`safeGreeting`（`greetingNameTexts`）在引擎不处理时总是可用，Mock 部署也一样；以前只有接了文本模型才启用。

### 计划 P5：验收（2026-10-29 追加）

| 任务 | 文件 | 内容 | 依赖 |
|---|---|---|---|
| P5-T1 | `p5-01-eval-gate.md` | Q20 门槛：真实 Qwen 旅程评测 3 次中位数对比基线（编造 0、连续性与自然度各 +0.5、不打扰与共情不退步）；不达标按规则调参重跑，最多三轮 | P4 |
| P5-T2 | `p5-02-regression-evals.md` | 共情评估两次（不退步口径）与 plan-a persona 门槛 | P5-T1 |
| P5-T3 | `p5-03-device-acceptance.md` | 真机验收清单 12 项（用户在场），只记通过与否 | P5-T2 |
| P5-T4 | `p5-04-blind-test.md` | 小范围真人盲测：同一套脚本卡在基线与新版本上各聊一次，测试者不知道哪个是哪个，只收分数 | P5-T3 |
| P5-T5 | `p5-05-closeout.md` | 收尾：roadmap、spec 状态、`finishing-a-development-branch`（合并与否由用户决定） | P5-T4 |

**P5 编写计划时定的取舍（用户 2026-10-29 已确认全部 4 条）：**

1. **真人盲测用合成剧本的转写稿**：隐私规则不允许保存真实对话或音频，所以盲测让 3–5 位测试者给「基线 vs 最终版本」同一会话的 A/B 转写稿打分（随机标号、只收分数、测试者用代号）。两套网关跨三天的语音盲测作为可选项，默认不做。
2. **盲测只出报告**，不设自动门槛；建议口径是连续性、自然度高于基线，不打扰、共情不低于基线，结论由用户定。
3. **共情评估的「不退步」口径**：六个维度两次平均不低于 Plan 4 合并基准 −0.3，`noFabricationAllFive` 两次为真；不用 `compare.mjs` 的「前三项 +1」退出码。旅程评测在 P3 的「不退步」容忍 −0.2（P5 用 Q20 原门槛）。
4. **调参最多三轮**，三轮仍不过就停下交给用户；编造不调参，直接报告。

### P4 冻结契约（在 P3 后半契约之上增加）

```ts
// gateway/src/session/proactive/lifecycle.ts
export function threadExpired(thread: ThreadRecord, now: number, cfg: ProactivityConfig): boolean;
export function expireThreads(store: MemoryStore, ownerId: string, now: number, cfg: ProactivityConfig): number;

// gateway/src/roles/types.ts
// INTENT_PURPOSES gains 'greetingPlain'; IntentCopy gains:
opening: string;   // {maxChars} {name} {purpose}
// DirectorConfig gains:
familiarityTones?: { new: string; familiar: string; oldFriend: string };
// DirectorConfig loses (P4-T5): silenceDecision

// gateway/src/session/proactive/render.ts
export function renderIntent(planned: PlannedIntent, copy: IntentCopy, fallbackLine: string, opts?: { name?: string }): ProactiveRequest;
export function composeOpening(head: string, name: string, line: string): string;

// gateway/src/session/proactive/runtime.ts — ProactiveCopy gains
greetingNameTexts?: readonly string[];
greetingHeads?: readonly string[];
// ProactiveRuntime gains
prefetch(): void;
familiarityTier(): Familiarity;
openingLine(input: { language: Language; name: string | null; firstMeet: boolean }): ProactiveRequest | null;

// gateway/src/session/director.ts — DirectorDeps gains
openingRequest?(): ProactiveRequest | null;

// gateway/src/memory/store.ts — MemoryStore gains / loses
proactiveLastAt(ownerId: string, agentId: string, kind: string): number | null;
// loses: careFollowup, closeCareFollowup, clearStaleCareQuotes

// gateway/src/session/proactive/config.ts — humanConnection gains
minIntervalDays: number;   // 1..30, baseline 7
```

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

全部顺序执行，不并行。P1 依赖 P0 完成（P1-T3 的 runner 只支持 mock/qwen）；P2 依赖 P1（P2-T6 修改 P1 的 runner）；P3 前半依赖 P2（决策引擎读 P2 的数据形状）；P3 后半依赖 P3 前半，T3→T7 顺序执行；**执行顺序（用户 2026-10-29 确认）：P3-T3 → … → P3-T7 → P4-T1（提前，修事项 7 天消失）→ 停下等用户确认 → P4-T0 → P4-T2 → … → P4-T7 → 停下 → P5-T1 → … → P5-T5。** P4-T0 复核时把已完成的 P4-T1 一并核对。每份计划结束时停下，等用户确认再开始下一份。
