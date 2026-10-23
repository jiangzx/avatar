# Plan 4 情感共鸣与主动性 — Implementation Plan Overview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给小暖加一层会话内情感分析和主动性：状态卡驱动指令、规划器和头像，开场能关怀回访上次的未了之事，并先修复 Seeduplex 播报中推指令导致下一轮无响应（#48）。

**Architecture:** 所有 session 变更先收口到 `PushGate`，只在缝隙推送（T0）。`AffectTracker` 在每条非轻回应终稿后调用共享文本模型，产出 zod 校验的 `AffectCard`（T2）。卡片经确定性模板渲染进实时指令，同时驱动头像（T3）、沉默规划器和话题聊干引导（T4）。跨会话关怀扩展现有 `followups` 表，开场由 Session 有界等待关怀句（T5）。

**Tech Stack:** Node 24 + TypeScript（`tsx`）、zod 4.6.5、vitest、`node:sqlite`；Qwen/Seeduplex realtime 适配器；共享 `TextModelClient`（默认 `qwen-plus`）。

**Spec（已批准，约束）：** `docs/superpowers/specs/2026-10-22-emotion-proactivity-design.md`。每个任务的实现者必须先读 spec 中对应的章节，再读本总览。

## Global Constraints

- 回复用简体中文；代码注释用英文，简短。
- 日志永远不记对话内容（音频、ASR 文本、回复文本、状态卡逐句标签、原话）。只记事件名、id、计数、耗时、错误码。
- 对话文本只能存记忆库（`MemoryStore`），并且必须可删除；不存音频。合成评估场景和结果可以放 `docs/testing/`。
- 不提交密钥；只用 `git add <明确路径>`，禁止 `git add -A`；不覆盖与任务无关的未提交改动。
- 可调数值只放配置文件（`gateway/config/*.json`、`gateway/config/i18n/<lang>/*.json`、`gateway/roles/**`），边界处用 zod 校验，交叉值在启动时互相检查。
- 分层：server → (session, identity) → (adapter, memory, roles)，不允许反向 import；不加模块级可变状态；共享资源靠注入。
- 超时、重试统一走 `runWithPolicy`（`gateway/src/reliability/policy.ts`）。
- 高风险区（记忆召回、开场与四段沉默、Seeduplex 工具轮）：改动前先读 `docs/project/roadmap.md` 的「打断与沉默：已踩过的坑」「记忆与回忆：已踩过的坑」。改后必须跑 gateway 全量测试、typecheck，以及真实记忆库召回探针。坑位契约只按 spec §5 修订第 4 条。
- TDD：每个任务先写失败测试、确认失败，再实现、确认通过，然后提交。提交信息结尾的 `Co-Authored-By` 行以执行时会话系统给出的署名为准；各任务里写的 `Claude Opus 5.5` 只是示例。
- 只有本计划用到的新依赖可以加；本计划不加任何 npm 依赖。
- 没跑过的东西不能说完成；报告里写真实命令和结果。

## 命令

在仓库根目录执行：

```bash
npm test -w gateway                    # vitest run
npx vitest run --root gateway test/<file>.test.ts   # 单文件（或 cd gateway && npx vitest run test/<file>.test.ts）
npm run typecheck -w gateway
git diff --check
```

真实记忆库召回探针（只读）：

```bash
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --real-db "$HOME/.avatar/memory.db"
```

期望结果：zh「上次聊到哪儿了」`hits:true`；「上次聊过电影吗」`hits:true`；「我说过喜欢喝茶吗」`hits:false`；`newTitleFlag:false`。

各任务里写的 `"$HOME/.avatar/memory.db"` 只是示例：真实库路径以网关使用的 `MEMORY_DB_PATH`（`gateway/.env`）为准，本机可能不在该位置（2026-10-23 审查时 `$HOME/.avatar/memory.db` 不存在）。路径不存在时写「真实库召回探针 NOT RUN：db_missing」，不要声称通过；T7 的处理见其 Step 7。

## 任务与依赖

| 文件 | Task | 内容 | 依赖 |
|---|---|---|---|
| `01-t0-push-gate.md` | T0 | `PushGate` + `updateSession` + 迁移两条现有推送路径 + `no_response_after_final` | — |
| `02-t1-eval-baseline.md` | T1 | eval 扩展（`silenceAfterMs`、judge、rubric、12 场景）+ 跑基线 | T0 |
| `03-t2-affect-tracker.md` | T2 | `affect.json` / i18n `affect.json` / `affect.md` + `AffectTracker` + 日志 | T0 |
| `04-t3-affect-render.md` | T3 | `renderAffect` + 指令注入 + 预算 + 头像 `onAffect` + 危机 | T2 |
| `05-t4-planner-exhaustion.md` | T4 | 规划器输入（affect / openLoop / 时间节气）+ 规则 + 话题聊干 | T3 |
| `06-t5-care-followup.md` | T5 | `grounding.ts` + 迁移 + 抽取 quote + `careFollowup` + 关怀开场 + 删除链路 | T4（用 T2 的 `affect.json` `care` 段；锚点建立在 T3/T4 之后的 `session.ts`、`affect.ts` 上） |
| `07-t6-persona.md` | T6 | 人设放宽（zh）+ ja/en parity | T1 基线已跑；T3（`memory.json` 的预算比例已按 T6 的人设增长算好，T6 先合入会让启动预算校验失败） |
| `08-t7-verification.md` | T7 | 真实探针、评估对比、召回回归、roadmap / 契约更新 | T0–T6 |

与 spec 分期表的差异：T5 依赖 T4（spec 写的是只依赖 T0、可与 T2–T4 并行）。原因：`care` 配置在 T2 创建的 `affect.json` 中，且 T5 与 T3/T4 改同一批锚点，并行必冲突（2026-10-23 计划审查后改为严格串行）。

**2026-10-23 计划审查修订（用户已接受，spec 已同步）：**

- `AffectCopy.mood` 增加 `sad` 档：不算低落的轻度难过用「有点难过」，只有 `crisis` 或 `isLow` 才用「很低落」（T2 文案、T3 渲染）。
- 话题聊干冷却：冷却 N 表示随后 N 条终稿都不预备（T4）。
- 人设否定句里不举例词（坑位：否定句里的词会被照读）；感叹词例子按 spec 用「哎呀」「哟」「真的呀」（T6）。
- 从没被问过、超过 `care.maxAgeDays` 的 quote 由每日保留任务置空；`care.timeoutMs` 必须小于 `sessionStartTimeoutMs`（T5 启动校验）。
- `greetingCareTexts` 要么每种语言都有，要么都没有（T5 启动 parity 校验，spec §9）。
- T7 关怀探针只测真实模型生成与校验；选取、回退、关闭由 T5 单元测试覆盖。
- `affect.json` 不接受 spec「配置」里提到的可选 `model` 字段（strict schema；本期复用共享文本客户端，不新建端点，T2 接口疑问 6）。

**基线门槛：** T1 的基线结果文件必须在 T3、T5、T6 任何一个合入之前提交到 `dev-master`。T3、T5、T6 开始前都在仓库根目录跑下面的检查（只看文件存在不够：脏工作区、评委失败、或不在当前分支历史上的基线都无效）：

```bash
BASE_COMMIT=$(node -e "const r=JSON.parse(require('node:fs').readFileSync('docs/testing/plan4-empathy-eval/results-baseline.json','utf8')); if (r.dirty!==false||r.adapter!=='qwen'||r.judge?.failures!==0||r.results?.length!==12) { console.error('baseline_invalid'); process.exit(1); } console.log(r.commit)") \
  && git merge-base --is-ancestor "$BASE_COMMIT" HEAD && echo baseline_ok
```

没有打印 `baseline_ok` 就停下报告，不要开始任务。

**执行顺序（严格串行）：** T0 → T1（跑基线）→ T2 → T3 → T4 → T5 → T6 → T7。T5 不与 T3/T4 并行：它在 `session.ts` 字段区（`private rebuildAgain` 之后）和 `affect.ts` 导入区与 T3/T4 用同一个插入锚点，并行开发 rebase 必然冲突；T5 的验证命令也依赖 T4 的 `topic-exhaustion.test.ts`。

## Worktree 准备（如果用独立 worktree 串行开发）

```text
git worktree add ../avatar-plan4-<task> dev-master
cd ../avatar-plan4-<task>
npm ci
cp ../avatar/gateway/.env gateway/.env        # if present; never commit
```

本计划不改 `app/`、`avatar-core/`、`protocol/`，不需要 Flutter 构建。

## 冻结接口（跨任务契约）

实现者只看得到自己的任务。下面这些名字、签名和形状，所有任务必须原样使用。需要改的话，停下来报告，不要在下游任务里改上游定义。

### T0 产出

`gateway/src/session/pushGate.ts`：

```ts
export interface PushRequest {
  /** Re-read and send the current instructions when flushed. */
  instructions?: boolean;
  /** Present = change voice; value undefined = adapter default. */
  voice?: { value: string | undefined };
}

export interface PushGateDeps {
  /** Session seam: slimSeamOpen() && !modelGenerating && !ended. */
  seamOpen: () => boolean;
  /** Called at most once per flush with the merged request. */
  send: (update: PushRequest) => void;
  now: () => number;
  minIntervalMs: number;
}

export class PushGate {
  constructor(deps: PushGateDeps);
  /** Merge into the pending update, then try to flush. */
  request(update: PushRequest): void;
  /** Send the pending update if the seam is open, the interval has passed, and this turn has not pushed yet. */
  flush(): void;
  /** A new user turn begins: allow one more push this turn. */
  onUserFinal(): void;
  /** Drop pending work (after a successful reconnect). */
  clearPending(): void;
  readonly hasPending: boolean;
  dispose(): void;
}
```

`gateway/src/adapters/types.ts` 在 `RealtimeAdapter` 上新增可选方法：

```ts
/** One combined session change. Seeduplex sends a single full session.update; Qwen a single partial one. */
updateSession?(update: { instructions?: string; voice?: { value: string | undefined } }): void;
```

`gateway/src/session/pacing.ts` 的 `PacingSchema` 新增：

```ts
push: z.object({
  minIntervalMs: z.number().int().min(0).max(10_000),
  noResponseAfterMs: z.number().int().min(1_000).max(30_000),
}).strict(),
```

`gateway/config/pacing.json` 写入 `"push": { "minIntervalMs": 1000, "noResponseAfterMs": 5000 }`。`SessionDeps` 新增 `push?: PacingConfig['push']`（测试省略时用默认值 `{ minIntervalMs: 0, noResponseAfterMs: 5000 }`）。

日志事件：`log('no_response_after_final', { sinceFinalMs })`；每次推送 `log('session_push', { instructions: boolean, voice: boolean })`（内容无关，T7 统计推送频率）。说明：spec 写的 `adapter` 字段不加，网关启动日志已经标明适配器，Session 也拿不到适配器名，加了是 YAGNI。

T0 另外提供（2026-10-23 统一修订）：`Director.isLightFinal(text: string): boolean`（`lightPhrases` 整句或空串算轻回应；`quietPhrases` 不算），后续任务判轻回应只用它；`MockAdapter.sessionUpdates` 记录 `updateSession` 调用。缝隙判定比上面注释更严：还要求适配器已连接，并且不在「终稿或主动请求之后、回复开始之前」的窗口里；打断停播与 VAD 静音边沿不触发推送（坑位第 6 条）。`clearPending()` 同时重置「每轮一次」计数。

Session 内部：`private pushInstructions()` 改为 `this.gate.request({ instructions: true })`；`applyLanguage` 改为 `this.gate.request({ instructions: true, voice: { value: this.voiceFor(next) } })`；删除 `languagePushPending` / `maybePushLanguage`。

### T1 产出

- `gateway/src/eval/harness.ts` 的 `ScenarioSchema` 新增可选字段 `silenceAfterMs: z.number().int().min(1_000).max(60_000).optional()`：最后一轮之后，在这段时间里继续收集主动回复（`ReplyRecord.kind === 'followup'`）。
- `gateway/src/eval/judge.ts`：

```ts
export const JUDGE_DIMENSIONS = ['holdEmotion', 'nameFeeling', 'proactive', 'noSycophancy', 'noFabrication', 'noIntrusion'] as const;
export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];
export type JudgeScores = Record<JudgeDimension, number>; // integers 1..5
export interface JudgeInput { scenarioId: string; title: string; turns: readonly { role: 'user' | 'assistant'; text: string }[] }
export function judgeScenario(client: TextModelClient, rubric: string, input: JudgeInput, policy: PolicySpec, signal?: AbortSignal): Promise<JudgeScores | null>;
export function summarizeScores(rows: readonly JudgeScores[]): JudgeScores; // per-dimension mean, 2 decimals
```

- eval CLI 新增 `--scenarios <path>` 和 `--judge <rubricPath>` 两个参数。结果 JSON 写到 `--out`。
- `judgeScenario` 末尾另有可选参数 `opts?: { maxTokens: number; temperature: number }`，由 `eval.json` 的 `judge` 段传入。
- 结果 JSON 顶层：`commit`、`dirty`、`date`、`adapter`、`style`、`scenarioFile`、`rubricFile`、`judgeModel`、`gated`、`summary`、`judge`（`scored`、`failures`、`mean`、`firstThreeMean`、`noFabricationAllFive`）、`results[]`。
- `scripts/eval.ts` 在 Qwen 且有文本端点时注入 `textClient`（与生产一致）和 T0 的 `push`；T2 再补 `affect`。
- 场景与评分标准：`docs/testing/plan4-empathy-eval/scenarios.json`、`rubric.md`；基线结果 `docs/testing/plan4-empathy-eval/results-baseline.json`（记录提交 hash）。

### T2 产出

`gateway/config/affect.json`（内容见 spec「配置」一节，另加 `"sessionLinesMax": 200`；`care` 段为 `{ "maxAgeDays": 7, "timeoutMs": 1500, "maxChars": { "zh": 40, "ja": 50, "en": 120 }, "quoteMaxChars": 80, "maxTokens": 120, "temperature": 0.7 }`）。加载与类型：

```ts
// gateway/src/session/affect.ts
export const AFFECT_EMOTIONS = ['neutral', 'happy', 'sad', 'love'] as const; // same values as EMOTIONS
export const AFFECT_NEEDS = ['vent', 'share_joy', 'help', 'chat', 'topic_exhausted'] as const;
export const AFFECT_STRATEGIES = ['comfort', 'reflect', 'affirm', 'ask', 'disclose', 'suggest'] as const;
export const AFFECT_TRENDS = ['better', 'worse', 'flat'] as const;
export const AffectCardSchema: z.ZodType<AffectCard>; // .strict()
export interface AffectCard {
  emotion: (typeof AFFECT_EMOTIONS)[number];
  intensity: 1 | 2 | 3;
  trend: (typeof AFFECT_TRENDS)[number];
  need: (typeof AFFECT_NEEDS)[number];
  strategy: (typeof AFFECT_STRATEGIES)[number];
  mismatch: boolean;
  crisis: boolean;
  openLoop?: string;
}
export interface AffectConfig {
  enabled: boolean;
  historyEntries: number;
  sessionLinesMax: number;
  maxInputChars: number;
  maxTokens: number;
  temperature: number;
  policy: PolicySpec;
  lowIntensity: number;
  exhausted: { shortMaxChars: number; shortStreakTrigger: number; cooldownTurns: number; declineCooldownTurns: number };
  care: { maxAgeDays: number; timeoutMs: number; maxChars: Record<Language, number>; quoteMaxChars: number; maxTokens: number; temperature: number };
  timeZone: string;
  solarTermWindowDays: number;
}
export function loadAffectConfig(path: string): AffectConfig;
export function isLow(card: AffectCard | null, lowIntensity: number): boolean;
export interface AffectSummary { calls: number; failures: number; byEmotion: Record<AffectCard['emotion'], number>; crisis: 0 | 1; exhaustedArmed: number; exhaustedRevoked: number }
export interface AffectTrackerDeps {
  client: TextModelClient;
  config: AffectConfig;
  prompt: (language: Language) => string;
  history: () => readonly LedgerEntry[];
  evidence: EvidenceRules;
  safety: SafetyRules;
  /** Called with each accepted card (never with a stale one). */
  onCard: (card: AffectCard) => void;
}
export class AffectTracker {
  constructor(deps: AffectTrackerDeps);
  /** Non-light user final. Starts one analysis; aborts the previous one. */
  onUserFinal(text: string, language: Language): void;
  /** Light or short final: T2 only records the line; T4 adds the exhaustion counters. */
  onLightFinal(text: string, language: Language): void;
  readonly card: AffectCard | null;
  /** T4 sets this; T2 always returns false. */
  readonly exhaustedArmed: boolean;
  summary(): AffectSummary;
  /** Forget/decline: drop the card, session lines, and any analysis in flight. T4 also clears the exhaustion streak. */
  reset(): void;
  dispose(): void;
}
export function affectSummaryFields(summary: AffectSummary): Record<string, number>; // log() takes flat fields only
```

i18n：`gateway/config/i18n/{zh,ja,en}/affect.json`，由 `gateway/src/i18n/load.ts` 读入 `I18nBundle.affect: Record<Language, AffectCopy>`。T2 一次性定义完整 schema 并填好三种语言的内容，T3、T4 只读取，不改 schema：

```ts
// gateway/src/i18n/types.ts
export interface AffectCopy {
  lines: {
    crisis: string;
    /** low = crisis or isLow; sad = mild sadness that is not low (2026-10-23 review). */
    mood: { low: string; sad: string; happy: string; love: string; neutral: string };
    trend: { better: string; worse: string };
    need: Record<'vent' | 'share_joy' | 'help' | 'chat' | 'topic_exhausted', string>;
    strategy: Record<'comfort' | 'reflect' | 'affirm' | 'ask' | 'disclose' | 'suggest', string>;
    mismatch: string;
    exhaustedHint: string;
    tail: string;
  };
  declinePhrases: readonly string[];
  /** Approximate dates; month 1-12, day 1-31. */
  solarTerms: readonly { name: string; month: number; day: number }[];
  seasons: { spring: string; summer: string; autumn: string; winter: string };
  timeOfDay: { morning: string; noon: string; afternoon: string; evening: string; night: string };
}
```

角色：`SharedText` 新增 `affect`（读 `roles/_shared/<lang>/affect.md`）；`RoleCatalog` 新增 `affectPrompt(language?: Language): string`；`fixedRoleCatalog` 同步加上。

`SessionDeps` 新增 `affect?: AffectConfig`。Session 只在 `deps.textClient && deps.affect?.enabled` 时创建 `AffectTracker`。`index.ts` 加载 `affect.json` 并传入。

日志：`log('affect', { outcome, ms, code? })`；会话结束 `log('affect_summary', affectSummaryFields(summary))`（`byEmotion` 展开成 `emotionSad` 等扁平键）。Session 在 forget/decline 重建时调用 `this.affect?.reset()`。Session 字段名固定为 `private readonly affect: AffectTracker | null`。

### T3 产出

- `gateway/src/session/affectRender.ts`：`export function renderAffect(card: AffectCard | null, copy: AffectCopy, flags: { exhaustedArmed: boolean; lowIntensity: number }): string`。`card === null && !flags.exhaustedArmed` 时返回 `''`。
- `InstructionParts.affect?: string`；`InstructionBudget.affectMaxChars?: number`（缺省视为 0）；`PromptLabels.affectHeader: string`。
- `memory.json` 的 `instructions` 新增 `affectMaxChars: number`、`languageAffectMaxChars?: Partial<Record<Language, number>>`；`validateBudgets` 写进每种语言的 `InstructionBudget`；`historyBudget` 按它预留。
- **预算（2026-10-23 用户批准方案 A）：** `"languageBudgetRatio": { "zh": 0.43, "ja": 0.5, "en": 0.8 }`，`summaryMaxChars` 800、`minHistoryChars` 400 不变，`affectMaxChars` 150，`languageAffectMaxChars` `{ "ja": 210, "en": 250 }`。比例按 T3+T6 合并后的真实人设核算，每种风格留 ≥50 字余量（审查后复算：zh 67/78、ja 62/53、en 304/81）；英文 affect 文案按「每类最长一句」相加的上界为 244，英文人设新增压短。
- `export function maxAffectRender(copy: AffectCopy): number`：用于启动校验，返回最长渲染组合的字符数。
- `EmotionTagger.onAffect(card: AffectCard, low: boolean): void`；`EmotionTagger.releaseHold(): void`。
- Session 私有 `clearAffect()`：在 T2 的 `this.affect?.reset()` 之后调用，清 Session 侧的 `affectCard`/`affectRendered` 并释放头像 hold；T4 在其中追加 `this.openLoop = undefined`。forget/decline 之后，指令和规划器输入都不能再带旧卡或原话（spec §8）。
- 日志 `log('affect_crisis', {})`：每个会话最多一次。

### T4 产出

- `SilenceContext` 新增：`affect?: { emotion; intensity; trend; need; low: boolean; crisis: boolean }`、`openLoop?: string`、`timeOfDay: string`、`season: string`、`solarTerm?: string`（取值是 `AffectCopy` 里的本地化词语）。
- `gateway/src/session/timeContext.ts`：`export function timeContext(now: number, timeZone: string, windowDays: number, copy: AffectCopy): { timeOfDay: string; season: string; solarTerm?: string }`。
- `DirectorDeps` 新增 `getPlanExtras?: () => Pick<SilenceContext, 'affect' | 'openLoop' | 'timeOfDay' | 'season' | 'solarTerm'>`。`timeOfDay`/`season` 在类型上为可选，避免改动现有沉默契约的精确断言。
- `AffectTrackerDeps` 新增可选 `declinePhrases?: (language: Language) => readonly string[]`；话题聊干状态放在新文件 `gateway/src/session/topicExhaustion.ts` 的 `TopicExhaustion` 类里，`AffectTracker.reset()` 会调用它的 `reset()`（清空连续计数和预备状态，保留冷却）。
- Session 字段 `openLoop` 在 T3 的 `clearAffect()` 里清空（forget/decline 后规划器拿不到旧原话）。
- `AffectTracker` 实现 `exhaustedArmed`、`onLightFinal` 计数、婉拒冷却。新增 `onSubstantiveFinal(text)` 内部逻辑；对外接口不变。

### T5 产出

- `gateway/src/memory/grounding.ts`：从 `recall.ts` 原样移出 `grounded(text, source)`、`sameUtterance(a, b)`、`parsePhrase(raw)`，另导出 `normalizeForMatch(text)`；`recall.ts` 改为从这里导入；`affect.ts` 的本地副本 `matchKey` 改用它。
- 迁移：`MIGRATIONS` 末尾追加一步，`ALTER TABLE followups ADD COLUMN quote TEXT; ... sensitive INTEGER NOT NULL DEFAULT 0; ... created_at INTEGER;`。
- `MemoryStore` 新增：

```ts
careFollowup(ownerId: string, currentSessionId: string, now: number, maxAgeMs: number): { id: string; quote: string; createdAt: number } | undefined;
closeCareFollowup(ownerId: string, id: string, now: number): void; // done_at = now, quote = NULL, audit without quote
clearStaleCareQuotes(ownerId: string, olderThan: number): number; // daily retention: quote = NULL once older than care.maxAgeDays
```

- `gateway/src/session/care.ts`：`export function generateCareLine(client: TextModelClient, system: string, input: { userLine: string; daysAgo: number }, opts: { timeoutMs: number; maxChars: number; maxTokens: number; temperature: number }, safety: SafetyRules): Promise<string | null>`。Session 传 `care.maxChars[language]`。
- `followups.update` 不用 `.strict()`：zod 默认剥离未知键，update 带的 `quote`/`sensitive` 被丢弃，不让整批抽取作废。
- `DirectorConfig.greetingCareTexts?: readonly string[]`；`SharedText.care`；`RoleCatalog.carePrompt(language?: Language): string`。

## 共享文件与归属

| 文件 | 修改的任务 | 规则 |
|---|---|---|
| `gateway/src/session/session.ts` | T0、T2、T3、T4、T5 | 串行合入；每个任务只改自己的段落 |
| `gateway/src/session/director.ts` | T0、T4 | T0 只加 `isLightFinal`；T4 改规划输入；T5 不改 Director |
| `gateway/src/roles/{catalog,fileCatalog}.ts` | T2、T5 | 各加一个 shared 文本 |
| `gateway/src/i18n/{load,types}.ts` | T2 | 只有 T2 修改 |
| `gateway/src/session/instructions.ts`、`pacing.ts` | T0（pacing）、T3 | — |
| `gateway/roles/elder-companion/*/director.json` | T4（规划器规则）、T5（`greetingCareTexts`） | 键不重叠 |
| `gateway/roles/elder-companion/*/styles/*.md` | T6 | 只有 T6 修改 |
| `gateway/src/index.ts` | T0、T2、T3、T5 | 各自只加依赖注入或启动校验 |
| `gateway/scripts/eval.ts` | T0（`push`）、T1（整文件替换，保留 `push`）、T2（`affect`） | T1 的完整版本以 T0 合入后的文件为准 |
| `gateway/src/session/affect.ts` | T2、T4、T5 | T4 接 `TopicExhaustion`；T5 只把 `matchKey` 换成 `normalizeForMatch` |
| `gateway/config/memory.json` | T3 | 预算数值见上文 T3 产出 |
| `docs/project/roadmap.md` | T7 | 其他任务只在自己的报告里写，不改 roadmap |
