# Plan 5：共情补句（结构性主动机制）实施计划

> **2026-10-24: implementation reverted (`9b7470b`).** Kept as the design/evaluation record; the code is not on the branch. Two eval runs scored +0.37/+0.59 (mean +0.48), and a tuning round scored +0.31/+0.26; neither beat the pre-existing +0.48.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在主回复播放结束后，由共享文本模型规划一句很短的后续，提升共情评估的 `proactive`，同时不损害 `crisis`、`noFabrication` 与 `noIntrusion`。

**Architecture:** 新增 `empathyFollowUp.ts`（触发/守卫/规划）；状态卡到达即并行规划，主回复播放结束后延迟投递；通过现有 `ProactiveRequest` 走 `followup` 响应，Qwen 与 Seeduplex 使用同一句规划文本。每会话最多 1 次，`crisis` 永不触发，低落只说不问。

**Tech Stack:** Node 24 + TypeScript、zod、vitest、tsx、共享 `QwenTextClient`。

**Spec:** `docs/superpowers/specs/2026-10-24-empathy-followup-design.md`

## Global Constraints

- 不记录任何对话正文；`empathy_followup` 日志只记 `trigger/outcome/code/ms`。
- 不新增协议消息；补句是普通 `followup` 响应。
- 不改四段式沉默的时序、文案和校验；不改记忆召回。若实现时发现必须改 Director 才能避免抢占，停止并报告。
- `crisis` 永不补；低落只补陈述句，不提问、不建议；每会话最多 1 次。
- 喜事/好转/求助在主回复已经含 `？` 或 `?` 时不补。
- 配置关闭（`affect.json` 的 `followup.enabled=false`）时机制完全不启动。
- 每次只提交显式路径；禁止 `git add -A`。TDD：先失败测试，再实现，再全量回归。
- 共享文件（本计划内串行，不并行）：`gateway/src/session/session.ts`、`gateway/src/session/affect.ts`、`gateway/src/roles/{catalog,fileCatalog}.ts`、`gateway/config/affect.json`。

## Task Table

| Task | Deliverable | Depends on | Plan file |
|---|---|---|---|
| T1 | `followup` 配置、三语 `followup.md` / `followup-speak.md`、角色目录方法、fixtures | — | [01-t1-config-prompts.md](01-t1-config-prompts.md) |
| T2 | `empathyFollowUp.ts` 触发/守卫/规划 + 单元测试 | T1 | [02-t2-decision-planner.md](02-t2-decision-planner.md) |
| T3 | Session 接入：卡片轮次、并行规划、播放结束延迟投递、清理 | T2 | [03-t3-session-integration.md](03-t3-session-integration.md) |
| T4 | 适配器 parity、crisis/低落/已问句、每会话 1 次、沉默阶梯回归 | T3 | [04-t4-parity-silence.md](04-t4-parity-silence.md) |
| T5 | 全量回归、共情实时评估 2 次、plan-a 重跑、文档与 roadmap | T4 | [05-t5-live-eval.md](05-t5-live-eval.md) |

## File Structure

- Create: `gateway/src/session/empathyFollowUp.ts` — 纯触发/守卫 + 共享文本模型 planner。
- Create: `gateway/test/empathy-followup.test.ts` — T2 单元测试。
- Create: `gateway/test/empathy-followup-session.test.ts` — T3/T4 Session 集成测试。
- Create: `gateway/roles/_shared/{zh,ja,en}/followup.md` — planner 系统提示。
- Create: `gateway/roles/_shared/{zh,ja,en}/followup-speak.md` — Qwen 播报指令模板（`{line}`）。
- Create: `gateway/test/fixtures/roles/_shared/{zh,ja}/followup.md`、`followup-speak.md` — fixture 目录也必须能加载。
- Modify: `gateway/src/session/affect.ts` — `FollowUpConfig` 与 config schema。
- Modify: `gateway/config/affect.json` — `followup` 段。
- Modify: `gateway/src/roles/catalog.ts` — `RoleCatalog.followupPrompt` / `followupSpeakInstruction`；`fixedRoleCatalog` stub。
- Modify: `gateway/src/roles/fileCatalog.ts` — `SharedText`、`readShared('followup')` / `readShared('followup-speak')`、两个方法。
- Modify: `gateway/src/session/session.ts` — 卡片轮次、并行规划、播放结束调度、投递、清理。
- Modify: `gateway/test/fileCatalog.test.ts` — 三语 prompt 与缺失文件断言。
- Modify: `gateway/test/affect.test.ts` — followup 配置加载/校验。
- Modify: `docs/project/roadmap.md`、`docs/blockers.md`、`docs/superpowers/specs/2026-10-24-empathy-followup-design.md`（只在 T5 记录结果与偏差）。

## Frozen Interfaces

T1 产生，T2–T4 直接使用，不得改名：

```ts
// gateway/src/session/affect.ts
export interface FollowUpConfig {
  enabled: boolean;
  delayMs: number;
  maxPerSession: number;
  timeoutMs: number;
  maxChars: number;
  maxTokens: number;
  temperature: number;
}

// gateway/src/roles/catalog.ts
followupPrompt(language?: Language): string;
followupSpeakInstruction(language?: Language): string; // contains {line}
```

T2 产生，T3 直接使用：

```ts
// gateway/src/session/empathyFollowUp.ts
export type FollowUpTrigger = 'share_joy' | 'trend_better' | 'help' | 'low';
export type FollowUpSkipCode =
  | 'crisis' | 'stale' | 'limit' | 'already_asked'
  | 'user_speech' | 'interrupted' | 'ended';

export function followUpTrigger(card: AffectCard, lowIntensity: number): FollowUpTrigger | null;
export function followUpSkipCode(input: FollowUpGuardInput): FollowUpSkipCode | null;
export function hasQuestionMark(text: string): boolean;

export interface FollowUpPlannerInput {
  language: Language;
  trigger: FollowUpTrigger;
  userText: string;
  recentUserTexts?: readonly string[];
  card: AffectCard;
}
export type FollowUpPlanner = (input: FollowUpPlannerInput, signal: AbortSignal) => Promise<string | null>;
export function createFollowUpPlanner(deps: {
  client: TextModelClient;
  config: FollowUpConfig;
  prompt: (language: Language) => string;
  safety: SafetyRules;
}): FollowUpPlanner;
```

## Shared File Ordering

- `gateway/src/session/session.ts` 只由 T3 修改；T4 只加测试，不改 Session 实现（若 T4 发现缺口，回到 T3 的任务补）。
- `gateway/src/session/affect.ts`、`gateway/config/affect.json` 只由 T1 修改。
- `gateway/src/roles/catalog.ts`、`gateway/src/roles/fileCatalog.ts` 只由 T1 修改。
- T1–T4 串行；不要并行跑会改同一文件的子代理。

## Verification Gates

每个任务结束：

```bash
npm test -w gateway
npm run typecheck -w gateway
git diff --check
```

T5 另外：

- 共情集真实 Qwen 至少 2 次，`dirty:false`、12/12 评委成功；记录 `proactive`、`noIntrusion`、`crisis` 与 `noFabrication`。
- plan-a 新口径重跑：`pass.questionRatio` 与 `pass.avgChars` 都为 true；失败则停止并报告，不改门槛。
- 真机复试仍按 blocker #50 另行安排，不在本计划。

## Execution Notes

- 当前分支 `plan4-emotion-proactivity` 上有 Plan 4 的未合并提交；本计划在同一分支继续，不合并、不推送。
- 开始前：`git status`、`git log --oneline -5`；确认没有与本计划共享文件冲突的未提交改动。
- 每个任务提交时只加任务列出的显式路径。`avatar-core` 的未提交改动与本计划无关，不要触碰。
- 若真实评估显示 `topic-exhausted`/`sad-then-better` 的单场景波动过大，按 T5 的“多次运行取中位数”处理，不挑选单次结果。
