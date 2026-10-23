# Task T3: 状态卡渲染、指令注入、预算与头像 `onAffect`

> 依据 spec §2（渲染与注入、预算）、§6（头像）、§7（危机）、§9（多语言）。先读 `00-overview.md` 的 T0、T2、T3 冻结接口。
>
> 前置条件：T0（`PushGate`、`this.gate`）和 T2（`AffectTracker`、`AffectCopy`、`affect.json`、`I18nBundle.affect`）已经合入 `dev-master`；T1 的基线结果 `docs/testing/plan4-empathy-eval/results-baseline.json` 已经提交（基线门槛：T3 合入前必须有）。
>
> **开始前必须由用户确认预算决策（见文末「接口疑问」Q1）。** 按 spec 预留 affect 段后，现有 `memory.json` 在三种语言下都会让启动失败；Step 4 用的是 Q1 里的推荐值。

**Files:**
- Create: `gateway/src/session/affectRender.ts`
- Create: `gateway/test/affect-render.test.ts`
- Modify: `gateway/src/roles/labels.ts`（`PromptLabels.affectHeader`）
- Modify: `gateway/src/session/instructions.ts`（`InstructionParts.affect`、`InstructionBudget.affectMaxChars`、`render`、`historyBudget`）
- Modify: `gateway/src/session/pacing.ts`（`MemoryBudgetSchema`、`validateBudgets`）
- Modify: `gateway/config/memory.json`（`affectMaxChars`、`languageAffectMaxChars`，以及 Q1 的预算调整）
- Modify: `gateway/src/index.ts`（启动校验 `checkAffectBudgets`）
- Modify: `gateway/src/session/emotion.ts`（`EmotionTagger.onAffect`）
- Modify: `gateway/src/session/session.ts`（`onCard` 接线、`instructions()` 注入、`syncAffectRender`、`affect_crisis`）
- Test: `gateway/test/instructions.test.ts`、`gateway/test/pacing.test.ts`、`gateway/test/emotion.test.ts`、`gateway/test/session.test.ts`

**Interfaces:**
- Consumes（T2）：`AffectCard`、`AFFECT_EMOTIONS`、`AFFECT_NEEDS`、`AFFECT_STRATEGIES`、`AFFECT_TRENDS`、`isLow(card, lowIntensity)`、`loadAffectConfig(path)`、`AffectConfig.lowIntensity`、`AffectTracker`（`card`、`exhaustedArmed`、构造参数 `onCard`）、`AffectCopy`（`gateway/src/i18n/types.ts`）、`I18nBundle.affect: Record<Language, AffectCopy>`、`SessionDeps.affect?: AffectConfig`。
- Consumes（T0）：Session 内的 `this.gate.request({ instructions: true })`；`PushGate` 类型（`gateway/src/session/pushGate.ts`）。
- Produces（与总览一致）：
  - `renderAffect(card: AffectCard | null, copy: AffectCopy, flags: { exhaustedArmed: boolean; lowIntensity: number }): string`，`card === null && !flags.exhaustedArmed` 时返回 `''`。
  - `maxAffectRender(copy: AffectCopy): number`。
  - `InstructionParts.affect?: string`；`InstructionBudget.affectMaxChars?: number`（缺省视为 0）；`PromptLabels.affectHeader: string`。
  - `memory.json` 的 `instructions.affectMaxChars`、`instructions.languageAffectMaxChars`；`validateBudgets` 写进每种语言的 `InstructionBudget`；`historyBudget` 按它预留。
  - `EmotionTagger.onAffect(card: AffectCard, low: boolean): void`；`EmotionTagger.releaseHold(): void`（forget/decline 时释放 hold）。
  - Session 私有方法 `clearAffect()`：forget/decline 时清空 Session 侧的卡副本（T4 在里面追加清 `openLoop`）。
  - 日志 `log('affect_crisis', {})`，每个会话最多一次。
  - 额外导出（启动校验用，不是跨任务契约）：`checkAffectBudgets(budgets, copies): void`。

## 现状（2026-10-23 核对代码）

- `Session.instructions()`（`session.ts:590`）只有两个调用点：`sessionConfig()`（首次连接与每次重建）和推送路径（T0 之后由 `PushGate` 的 `send` 现取）。T3 只改 `instructions()` 内部，两条路径自动带上 affect 段。
- 预算用在三处：构造函数里 `historyBudget(initialPersona, initialBudget, PROMPT_LABELS[lang])` 设置 `summarizeAfterTokens`（`session.ts:257-262`）；`applyLanguage` 里 `ledger.setSummarizeAfterTokens(historyBudget(...))`（`session.ts:539-543`）；`refreshMemorySnapshot` 读 `snapshotMaxChars`。前两处都直接读 `InstructionBudget`，所以 `budget.affectMaxChars` 一旦由 `validateBudgets` 写入，摘要阈值就自动按 affect 段预留，Session 这两处不用改。
- `buildInstructions` 的裁剪顺序：先丢最旧的 recent，再从前面裁摘要，再从后面裁快照；人设不裁。T3 把 affect 段放在人设之后、记忆之前，也不裁（它已被预留）。
- `EmotionTagger` 默认表情是 `happy`（`config/emotion.json`），去抖 1500ms，6 秒回落。

## 渲染约定（T2 写文案时按这个约定，T3 按这个实现）

- 每个部分是一行，用 `\n` 连接；`AffectCopy.lines` 里每个字符串都是一句完整的短句（包括 `trend.better` / `trend.worse`，它们单独成行，跟在主句后面）。
- 顺序：`crisis`（仅 `card.crisis`）→ 主句 → 走向（仅 `better`/`worse`）→ 需求 → 策略 → `mismatch`（仅为真）→ `exhaustedHint`（仅 `flags.exhaustedArmed` 且不低落）→ `tail`。
- 主句：`crisis` 或 `isLow(card)` 用 `mood.low`；否则 `sad`/`happy`/`love`/`neutral` 一一对应（`mood.sad` 是「有点难过」，用于不算低落的轻度难过）。这就是 spec §2「crisis > isLow > emotion」的优先级。
- `card === null`：`exhaustedArmed` 时只渲染 `exhaustedHint` + `tail`，否则 `''`。
- 卡片里的 `openLoop` 是模型自由文本，永远不进渲染。

---

- [x] **Step 0: 核对前置条件与预算决策**

Run（仓库根目录）：

```bash
git log --oneline -15
# Baseline gate: the full check block from 00-overview.md「基线门槛」; it must print baseline_ok.
grep -n "export class PushGate" gateway/src/session/pushGate.ts
grep -n "this.gate = new PushGate\|private readonly gate" gateway/src/session/session.ts
grep -n "new AffectTracker\|onCard\|AffectTracker | null" gateway/src/session/session.ts
grep -n "export interface AffectCopy\|affect: Record<Language, AffectCopy>" gateway/src/i18n/types.ts
grep -n "export function isLow\|export function loadAffectConfig\|export const AFFECT_TRENDS" gateway/src/session/affect.ts
```

Expected：每条 grep 都有命中；overview「基线门槛」的检查打印 `baseline_ok`。下文假定 T2 把分析器实例存成 `private readonly affect: AffectTracker | null`；如果 T2 用了别的字段名，下文所有 `this.affect` 都换成 T2 的名字，不要改名。任何一条没命中，说明前置任务没合入，停下来报告。

预算方案已于 2026-10-23 批准（方案 A，见文末 Q1），直接按 Step 7 的数值执行。

- [x] **Step 1: 写 labels 与 `buildInstructions` 的失败测试**

在 `gateway/test/instructions.test.ts` 文件末尾追加：

```ts
describe('affect section', () => {
  const budget = { totalChars: 1000, snapshotMaxChars: 100, summaryMaxChars: 100, affectMaxChars: 50 };

  it('ships a localized affect header for every language', () => {
    for (const labels of Object.values(PROMPT_LABELS)) expect(labels.affectHeader.startsWith('## ')).toBe(true);
    expect(PROMPT_LABELS.zh.affectHeader).toBe('## 此刻（内部参考）');
    expect(PROMPT_LABELS.ja.affectHeader).toBe('## いまの様子（内部参考）');
    expect(PROMPT_LABELS.en.affectHeader).toBe('## Right now (internal reference)');
  });

  it('puts the affect section after the persona and before memory', () => {
    const text = buildInstructions(
      { persona: 'P', affect: 'A1\nA2', memorySnapshot: '称呼：王叔', summary: 'S', recent: [entry('user', 'U')] },
      budget,
    );
    expect(text).toBe('P\n\n## 此刻（内部参考）\n\nA1\nA2\n\n## 记忆参考（可能不准确，注意「用户」与「助手」的区别）\n\n称呼：王叔\n\n## 对话摘要\n\nS\n\n## 最近对话\n\n用户：U');
  });

  it('leaves the section out when the render is empty', () => {
    const parts = { persona: 'P', memorySnapshot: '称呼：王叔', summary: 'S', recent: [entry('user', 'U')] };
    expect(buildInstructions({ ...parts, affect: '' }, budget)).toBe(buildInstructions(parts, budget));
    expect(buildInstructions({ ...parts, affect: '' }, budget)).not.toContain('## 此刻');
  });

  it('never clips the affect section: recent lines go first, then the summary, then the snapshot', () => {
    const affect = 'A'.repeat(40);
    const text = buildInstructions(
      { persona: 'P', affect, memorySnapshot: 'M'.repeat(30), summary: 'x'.repeat(10) + 'y'.repeat(30), recent: [entry('user', 'z'.repeat(50))] },
      { totalChars: 130, snapshotMaxChars: 20, summaryMaxChars: 40, affectMaxChars: 40 },
    );
    expect(text).toContain(`## 此刻（内部参考）\n\n${affect}\n\n`);
    expect(text).not.toMatch(/[xyz]/);
    expect(text).toContain(`${'M'.repeat(10)}…`);
    expect(text).not.toContain('M'.repeat(11));
    expect(text).toHaveLength(130);
  });

  it('reserves the affect room in the history budget', () => {
    const plain = { totalChars: 400, snapshotMaxChars: 50, summaryMaxChars: 100 };
    const fixed = buildInstructions({ persona: 'P', affect: 'x'.repeat(30), memorySnapshot: 'x'.repeat(50), summary: '', recent: [] }).length;
    expect(historyBudget('P', { ...plain, affectMaxChars: 30 })).toBe(400 - fixed);
    expect(historyBudget('P', plain) - historyBudget('P', { ...plain, affectMaxChars: 30 }))
      .toBe(30 + PROMPT_LABELS.zh.affectHeader.length + 4);
    expect(historyBudget('P', { ...plain, affectMaxChars: 0 })).toBe(historyBudget('P', plain));
  });
});
```

- [x] **Step 2: 运行，确认失败**

Run: `cd gateway && npx vitest run test/instructions.test.ts`
Expected: FAIL。`ships a localized affect header` 报 `Cannot read properties of undefined (reading 'startsWith')`；`puts the affect section` 和 `never clips the affect section` 的实际文本里没有 affect 段；`reserves the affect room` 的第一个断言数值不等。原有 6 个用例和 `leaves the section out` 仍然 PASS。

- [x] **Step 3: 实现 labels 与 `buildInstructions`**

`gateway/src/roles/labels.ts`：

原文：

```ts
  /** Label/value separator: full-width for CJK, colon-space for English. */
  separator: string;
}
```

改为：

```ts
  /** Label/value separator: full-width for CJK, colon-space for English. */
  separator: string;
  /** Header of the per-turn affect section (internal guidance, never read aloud). */
  affectHeader: string;
}
```

三种语言各加一项。原文：

```ts
    summaryPrevious: '已有摘要', summaryJoiner: '；', separator: '：',
  },
  ja: {
```

改为：

```ts
    summaryPrevious: '已有摘要', summaryJoiner: '；', separator: '：',
    affectHeader: '## 此刻（内部参考）',
  },
  ja: {
```

原文：

```ts
    summaryPrevious: '既存の要約', summaryJoiner: '；', separator: '：',
  },
  en: {
```

改为：

```ts
    summaryPrevious: '既存の要約', summaryJoiner: '；', separator: '：',
    affectHeader: '## いまの様子（内部参考）',
  },
  en: {
```

原文：

```ts
    summaryPrevious: 'Existing summary', summaryJoiner: '; ', separator: ': ',
  },
};
```

改为：

```ts
    summaryPrevious: 'Existing summary', summaryJoiner: '; ', separator: ': ',
    affectHeader: '## Right now (internal reference)',
  },
};
```

`gateway/src/session/instructions.ts` 整个文件替换为：

```ts
import type { LedgerEntry } from './ledger.ts';
import { PROMPT_LABELS, type PromptLabels } from '../roles/labels.ts';

export interface InstructionBudget {
  totalChars: number;
  snapshotMaxChars: number;
  summaryMaxChars: number;
  /** Room reserved for the affect section; missing means 0. The section itself is never clipped. */
  affectMaxChars?: number;
}

export interface InstructionParts {
  persona: string;
  /** Deterministic affect render (affectRender.ts); empty or missing leaves the section out. */
  affect?: string;
  memorySnapshot?: string;
  summary: string;
  recent: readonly LedgerEntry[];
}

const line = (e: LedgerEntry, labels: PromptLabels) =>
  `${e.role === 'user' ? labels.user : labels.assistant}${labels.separator}${e.text}`;

function render(
  persona: string,
  affect: string,
  snapshot: string,
  summary: string,
  lines: readonly string[],
  labels: PromptLabels,
): string {
  const parts = [persona.trim()];
  if (affect) parts.push(labels.affectHeader, affect);
  if (snapshot) parts.push(labels.memoryHeader, snapshot);
  parts.push(
    labels.summaryHeader,
    summary || labels.empty,
    labels.recentHeader,
    lines.length > 0 ? lines.join('\n') : labels.empty,
  );
  return parts.join('\n\n');
}

function clipHead(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 1 ? '' : `${s.slice(0, max - 1)}…`;
}

function clipTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 1 ? '' : `…${s.slice(s.length - max + 1)}`;
}

export function buildInstructions(
  parts: InstructionParts,
  budget?: InstructionBudget,
  labels: PromptLabels = PROMPT_LABELS.zh,
): string {
  const lines = parts.recent.map((entry) => line(entry, labels));
  const affect = parts.affect ?? '';
  if (!budget) return render(parts.persona, affect, parts.memorySnapshot ?? '', parts.summary, lines, labels);
  let snapshot = clipHead(parts.memorySnapshot ?? '', budget.snapshotMaxChars);
  let summary = clipTail(parts.summary, budget.summaryMaxChars);
  const kept = [...lines];
  // The affect section is reserved in historyBudget, so it is never part of the clipping.
  const over = () => render(parts.persona, affect, snapshot, summary, kept, labels).length - budget.totalChars;
  while (over() > 0 && kept.length > 0) kept.shift();
  if (over() > 0) summary = clipTail(summary, Math.max(0, summary.length - over()));
  if (over() > 0) snapshot = clipHead(snapshot, Math.max(0, snapshot.length - over()));
  return render(parts.persona, affect, snapshot, summary, kept, labels);
}

/** Room left for summary plus recent turns after the persona, the full snapshot and the full affect section. */
export function historyBudget(
  persona: string,
  budget: InstructionBudget,
  labels: PromptLabels = PROMPT_LABELS.zh,
): number {
  const affectRoom = budget.affectMaxChars ?? 0;
  const affect = affectRoom > 0 ? 'x'.repeat(affectRoom) : '';
  return budget.totalChars - render(persona, affect, 'x'.repeat(budget.snapshotMaxChars), '', [], labels).length;
}
```

- [x] **Step 4: 运行，确认通过**

Run: `cd gateway && npx vitest run test/instructions.test.ts`
Expected: PASS（11 个用例）。

- [x] **Step 5: 写预算配置的失败测试**

`gateway/test/pacing.test.ts` 顶部导入改为：

```ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROMPT_LABELS } from '../src/roles/labels.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { historyBudget } from '../src/session/instructions.ts';
import { loadMemoryBudget, loadPacing, validateBudgets, type MemoryBudgetConfig, type PacingConfig } from '../src/session/pacing.ts';
```

Q1 把 zh 也改成按 `languageBudgetRatio.zh`（0.43）计算，`report.budget` 就是 `budgets.zh`（`pacing.ts` 的 `validateBudgets`），所以现有断言里所有按 `budgetRatio`（0.4）算 zh 的地方都要改。共四处：

`accepts the shipped configs with the shipped roles` 里的两行，原文：

```ts
    expect(report.budget.totalChars).toBe(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * memory.instructions.budgetRatio));
    expect(report.budget.totalChars).toBeLessThanOrEqual(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * 0.4));
```

改为：

```ts
    const zhRatio = memory.instructions.languageBudgetRatio?.zh ?? memory.instructions.budgetRatio;
    expect(report.budget.totalChars).toBe(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * zhRatio));
    expect(report.budget.totalChars).toBeLessThanOrEqual(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * 0.45));
```

`validates personas for every language and reports the smallest history room` 里的一行，原文：

```ts
    expect(report.budget.totalChars).toBe(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * memory.instructions.budgetRatio));
```

改为：

```ts
    expect(report.budget.totalChars).toBe(Math.floor(pacing.rebuild.contextChars * pacing.rebuild.triggerRatio * (memory.instructions.languageBudgetRatio?.zh ?? memory.instructions.budgetRatio)));
```

用例 `gives ja/en their own instruction budget while zh stays unchanged` 改名为 `gives each language its own instruction budget`，其中三行，原文：

```ts
    expect(report.budgets.zh!.totalChars).toBe(3840);
    expect(report.budgets.ja!.totalChars).toBe(4320);
    expect(report.budgets.en!.totalChars).toBe(7200);
```

改为（Q1 的新比例）：

```ts
    expect(report.budgets.zh!.totalChars).toBe(4128);
    expect(report.budgets.ja!.totalChars).toBe(4800);
    expect(report.budgets.en!.totalChars).toBe(7680);
```

改完 `grep -n "budgetRatio))\|3840\|4320\|7200" gateway/test/pacing.test.ts` 应该没有命中（`affect budget` 夹具里的 `budgetRatio: 0.4` 不算）。

在文件末尾追加：

```ts
describe('affect budget', () => {
  // contextChars 4000 x ratio 0.4 = 1600 total chars per language in these fixtures.
  const pacing: PacingConfig = {
    rebuild: { contextChars: 4000, triggerRatio: 1, afterTurns: 30 },
    tailGuardMs: 400,
    output: { maxTokens: null },
    policies: { summarize: { timeoutMs: 1000, retries: 0, backoffMs: 0, maxBackoffMs: 0 } },
    slim: {
      enabled: true,
      intervalMs: 1_200_000,
      maxDeferMs: 120_000,
      bridgeAfterMs: 400,
      bridge: { zh: '我想想刚才聊到哪。', ja: 'さっきの続きを思い出すね。', en: 'Let me think about where we were.' },
    },
    push: { minIntervalMs: 1000, noResponseAfterMs: 5000 },
  };
  const memoryWith = (extra: Partial<MemoryBudgetConfig['instructions']> = {}): MemoryBudgetConfig => ({
    instructions: { budgetRatio: 0.4, snapshotMaxChars: 100, summaryMaxChars: 200, minHistoryChars: 100, ...extra },
    toolTurnTimeoutMs: 15_000,
    recallClipChars: 80,
    retentionDays: 90,
    retentionBatch: 200,
  });

  it('carries the affect room into each language budget and reserves it in the history room', () => {
    const report = validateBudgets(pacing, memoryWith({ affectMaxChars: 120, languageAffectMaxChars: { en: 200 } }), ledger, {
      zh: ['P'], ja: ['P'], en: ['P'],
    });
    expect(report.budgets.zh!.affectMaxChars).toBe(120);
    expect(report.budgets.ja!.affectMaxChars).toBe(120);
    expect(report.budgets.en!.affectMaxChars).toBe(200);
    expect(report.perLanguage.zh!.minHistoryChars).toBe(historyBudget('P', report.budgets.zh!, PROMPT_LABELS.zh));
    const plain = validateBudgets(pacing, memoryWith(), ledger, { zh: ['P'] });
    expect(plain.budgets.zh!.affectMaxChars).toBeUndefined();
    expect(plain.perLanguage.zh!.minHistoryChars - report.perLanguage.zh!.minHistoryChars)
      .toBe(120 + PROMPT_LABELS.zh.affectHeader.length + 4);
  });

  it('fails startup when the affect reservation leaves too little history', () => {
    expect(() => validateBudgets(pacing, memoryWith(), ledger, { zh: ['P'.repeat(1100)] })).not.toThrow();
    expect(() => validateBudgets(pacing, memoryWith({ affectMaxChars: 120 }), ledger, { zh: ['P'.repeat(1100)] }))
      .toThrow('instruction_budget_too_small:zh');
  });

  it('validates the affect room keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    const shipped = JSON.parse(readFileSync(join(root, 'config/memory.json'), 'utf8')) as Record<string, unknown> & { instructions: Record<string, unknown> };
    const write = (instructions: Record<string, unknown>) => writeFileSync(
      join(dir, 'memory.json'),
      JSON.stringify({ ...shipped, instructions: { ...shipped.instructions, ...instructions } }),
    );
    for (const bad of [{ affectMaxChars: -1 }, { affectMaxChars: 1.5 }, { affectMaxChars: 1_001 }, { languageAffectMaxChars: { en: 1_501 } }]) {
      write(bad);
      expect(() => loadMemoryBudget(join(dir, 'memory.json'))).toThrow();
    }
    write({ affectMaxChars: 150, languageAffectMaxChars: { en: 450 } });
    expect(loadMemoryBudget(join(dir, 'memory.json')).instructions.languageAffectMaxChars).toEqual({ en: 450 });
  });

  it('ships the affect room: zh 150, ja 210, en 250', () => {
    const memory = loadMemoryBudget(`${root}config/memory.json`);
    expect(memory.instructions.affectMaxChars).toBe(150);
    expect(memory.instructions.languageAffectMaxChars).toEqual({ ja: 210, en: 250 });
  });
});
```

- [x] **Step 6: 运行，确认失败**

Run: `cd gateway && npx vitest run test/pacing.test.ts`
Expected: FAIL。`gives each language its own instruction budget` 报 `expected 3840 to be 4128`；`accepts the shipped configs` 与 `validates personas for every language` 此时仍通过（`memory.json` 还没加 `zh`，`zhRatio` 退回 0.4），Step 7 改完配置后它们按新比例计算；`carries the affect room` 报 `expected undefined to be 120`；`validates the affect room keys` 报 strict schema 不认识 `affectMaxChars`（`Unrecognized key`）；`ships the affect room` 报 `expected undefined to be 150`（shipped 文件还没有这个键，不会抛错）。`fails startup when the affect reservation...` 的第二个断言不抛错。

- [x] **Step 7: 实现 schema、`validateBudgets` 与 `memory.json`**

`gateway/src/session/pacing.ts`，原文：

```ts
    snapshotMaxChars: z.number().int().min(0).max(5_000),
    summaryMaxChars: z.number().int().min(100).max(5_000),
    minHistoryChars: z.number().int().min(100).max(5_000),
  }).strict(),
```

改为：

```ts
    snapshotMaxChars: z.number().int().min(0).max(5_000),
    summaryMaxChars: z.number().int().min(100).max(5_000),
    minHistoryChars: z.number().int().min(100).max(5_000),
    /** Room reserved for the affect section (never clipped); the startup render check keeps every language within it. */
    affectMaxChars: z.number().int().min(0).max(1_000).optional(),
    /** Per-language override; English needs more characters for the same lines. */
    languageAffectMaxChars: z.partialRecord(z.enum(['zh', 'ja', 'en']), z.number().int().min(0).max(1_500)).optional(),
  }).strict(),
```

原文：

```ts
  const ratioFor = (language: Language) => m.languageBudgetRatio?.[language] ?? m.budgetRatio;
  const budgetFor = (language: Language): InstructionBudget => ({
    totalChars: Math.floor(rebuildChars * ratioFor(language)),
    snapshotMaxChars: m.snapshotMaxChars,
    summaryMaxChars: m.summaryMaxChars,
  });
```

改为：

```ts
  const ratioFor = (language: Language) => m.languageBudgetRatio?.[language] ?? m.budgetRatio;
  const budgetFor = (language: Language): InstructionBudget => ({
    totalChars: Math.floor(rebuildChars * ratioFor(language)),
    snapshotMaxChars: m.snapshotMaxChars,
    summaryMaxChars: m.summaryMaxChars,
    // Undefined when unset; historyBudget then reserves nothing (old fixtures keep their numbers).
    affectMaxChars: m.languageAffectMaxChars?.[language] ?? m.affectMaxChars,
  });
```

`historyBudget` 已经读 `budget.affectMaxChars`，所以 `validateBudgets` 的 `summary + minHistory` 校验和 `perLanguage.minHistoryChars` 自动按预留后的值计算，不用再改。

`gateway/config/memory.json` 第 2 行，原文：

```json
  "instructions": { "budgetRatio": 0.4, "languageBudgetRatio": { "ja": 0.45, "en": 0.75 }, "snapshotMaxChars": 600, "summaryMaxChars": 800, "minHistoryChars": 400 },
```

改为（2026-10-23 用户批准预算方案 A；比例按 T3+T6 合并后的人设与 affect 上限核算，每种风格留 ≥50 字余量）：

```json
  "instructions": { "budgetRatio": 0.4, "languageBudgetRatio": { "zh": 0.43, "ja": 0.5, "en": 0.8 }, "snapshotMaxChars": 600, "summaryMaxChars": 800, "minHistoryChars": 400, "affectMaxChars": 150, "languageAffectMaxChars": { "ja": 210, "en": 250 } },
```

- [x] **Step 8: 运行，确认通过**

Run: `cd gateway && npx vitest run test/pacing.test.ts test/instructions.test.ts`
Expected: PASS。`accepts the shipped configs with the shipped roles` 和 `validates personas for every language` 用真实人设跑，预留后仍满足 `summaryMaxChars + minHistoryChars`（核算值见 Q1：T6 之前每种风格历史空间 zh 1435/1438、ja 1492/1484、en 1674/1454，都 ≥ 1200；T6 合入后比 1200 多出 zh 67/78、ja 62/53、en 304/81，按 grandchild/old-friend 计）。如果报 `instruction_budget_too_small`，停下来报告实际数字，不要自行再调预算。

- [x] **Step 9: 写 `renderAffect` 的失败测试**

新建 `gateway/test/affect-render.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { LANGUAGES, type Language } from '@anyidea/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import type { AffectCopy } from '../src/i18n/types.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import type { AffectCard } from '../src/session/affect.ts';
import { checkAffectBudgets, maxAffectRender, renderAffect } from '../src/session/affectRender.ts';
import { loadMemoryBudget, loadPacing, validateBudgets } from '../src/session/pacing.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ledger = { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6000 };

/** Short tokens make the order and the selection visible. */
const copy: AffectCopy = {
  lines: {
    crisis: 'CRISIS',
    mood: { low: 'LOW', sad: 'SAD', happy: 'HAPPY', love: 'LOVE', neutral: 'NEUTRAL' },
    trend: { better: 'BETTER', worse: 'WORSE' },
    need: { vent: 'VENT', share_joy: 'JOY', help: 'HELP', chat: 'CHAT', topic_exhausted: 'DRY' },
    strategy: { comfort: 'COMFORT', reflect: 'REFLECT', affirm: 'AFFIRM', ask: 'ASK', disclose: 'DISCLOSE', suggest: 'SUGGEST' },
    mismatch: 'MISMATCH',
    exhaustedHint: 'HINT',
    tail: 'TAIL',
  },
  declinePhrases: ['算了'],
  solarTerms: [{ name: '霜降', month: 10, day: 23 }],
  seasons: { spring: '春天', summer: '夏天', autumn: '秋天', winter: '冬天' },
  timeOfDay: { morning: '早上', noon: '中午', afternoon: '下午', evening: '傍晚', night: '夜里' },
};
const card = (over: Partial<AffectCard> = {}): AffectCard => ({
  emotion: 'neutral', intensity: 1, trend: 'flat', need: 'chat', strategy: 'reflect', mismatch: false, crisis: false, ...over,
});
const flags = (exhaustedArmed = false) => ({ exhaustedArmed, lowIntensity: 2 });

describe('renderAffect', () => {
  it('renders nothing without a card unless the exhaustion hint is armed', () => {
    expect(renderAffect(null, copy, flags())).toBe('');
    expect(renderAffect(null, copy, flags(true))).toBe('HINT\nTAIL');
  });

  it('puts the crisis line first and uses the low mood, without the change-topic hint', () => {
    const text = renderAffect(card({ emotion: 'happy', trend: 'worse', need: 'vent', strategy: 'comfort', mismatch: true, crisis: true }), copy, flags(true));
    expect(text).toBe('CRISIS\nLOW\nWORSE\nVENT\nCOMFORT\nMISMATCH\nTAIL');
  });

  it('uses the low mood only when low, the mild sad line otherwise, and drops the hint while low', () => {
    expect(renderAffect(card({ emotion: 'sad', intensity: 2 }), copy, flags(true))).toBe('LOW\nCHAT\nREFLECT\nTAIL');
    expect(renderAffect(card({ emotion: 'sad', intensity: 1, trend: 'worse' }), copy, flags(true))).toBe('LOW\nWORSE\nCHAT\nREFLECT\nTAIL');
    // Mild sadness is not low: its own mood line, and the armed hint stays.
    expect(renderAffect(card({ emotion: 'sad', intensity: 1, trend: 'better' }), copy, flags(true))).toBe('SAD\nBETTER\nCHAT\nREFLECT\nHINT\nTAIL');
  });

  it('maps the other emotions one to one and adds the trend only for better or worse', () => {
    expect(renderAffect(card({ emotion: 'happy', trend: 'better', need: 'share_joy', strategy: 'affirm' }), copy, flags(true)))
      .toBe('HAPPY\nBETTER\nJOY\nAFFIRM\nHINT\nTAIL');
    expect(renderAffect(card({ emotion: 'love', need: 'help', strategy: 'suggest' }), copy, flags())).toBe('LOVE\nHELP\nSUGGEST\nTAIL');
    expect(renderAffect(card({ need: 'topic_exhausted', strategy: 'disclose' }), copy, flags())).toBe('NEUTRAL\nDRY\nDISCLOSE\nTAIL');
  });

  it('never copies model free text into the render', () => {
    const text = renderAffect(card({ openLoop: 'SECRET-LOOP' }), copy, flags(true));
    expect(text).not.toContain('SECRET-LOOP');
  });

  it('bounds every combination with maxAffectRender', () => {
    // NEUTRAL + BETTER + VENT + DISCLOSE + MISMATCH + HINT + TAIL = 41 chars + 6 newlines.
    expect(maxAffectRender(copy)).toBe(47);
  });
});

describe('checkAffectBudgets', () => {
  it('fails startup when a language render does not fit its room', () => {
    const copies: Record<Language, AffectCopy> = { ...DEFAULT_I18N.affect, zh: copy };
    expect(() => checkAffectBudgets({ zh: { totalChars: 1000, snapshotMaxChars: 0, summaryMaxChars: 100, affectMaxChars: 10 } }, copies))
      .toThrow('affect_budget_too_small:zh: render 47 > max 10');
    expect(() => checkAffectBudgets({ zh: { totalChars: 1000, snapshotMaxChars: 0, summaryMaxChars: 100 } }, copies))
      .toThrow('affect_budget_too_small:zh: render 47 > max 0');
    expect(() => checkAffectBudgets({ zh: { totalChars: 1000, snapshotMaxChars: 0, summaryMaxChars: 100, affectMaxChars: 47 } }, copies))
      .not.toThrow();
  });

  it('fits the shipped copy of every language into the shipped affect room (startup source of truth)', () => {
    const pacing = loadPacing(`${root}config/pacing.json`);
    const memory = loadMemoryBudget(`${root}config/memory.json`);
    const roles = loadRoleCatalog(`${root}roles`);
    const byLanguage: Partial<Record<Language, string[]>> = {};
    for (const pair of roles.languagePairs()) {
      (byLanguage[pair.language] ??= []).push(roles.buildPersona(pair.roleId, pair.styleId, pair.language));
    }
    const report = validateBudgets(pacing, memory, ledger, byLanguage);
    expect(() => checkAffectBudgets(report.budgets, DEFAULT_I18N.affect)).not.toThrow();
    for (const language of LANGUAGES) {
      expect(maxAffectRender(DEFAULT_I18N.affect[language])).toBeLessThanOrEqual(report.budgets[language]!.affectMaxChars!);
    }
  });
});
```

- [x] **Step 10: 运行，确认失败**

Run: `cd gateway && npx vitest run test/affect-render.test.ts`
Expected: FAIL，`Failed to resolve import "../src/session/affectRender.ts"`。

- [x] **Step 11: 实现 `affectRender.ts`**

新建 `gateway/src/session/affectRender.ts`：

```ts
import type { Language } from '@anyidea/protocol';
import type { AffectCopy } from '../i18n/types.ts';
import { AFFECT_EMOTIONS, AFFECT_NEEDS, AFFECT_STRATEGIES, AFFECT_TRENDS, isLow, type AffectCard } from './affect.ts';
import type { InstructionBudget } from './instructions.ts';

export interface AffectRenderFlags {
  /** The topic-exhaustion hint is armed (T4). */
  exhaustedArmed: boolean;
  /** Same threshold as AffectConfig.lowIntensity. */
  lowIntensity: number;
}

/** Priority crisis > low > emotion (spec §2): crisis and low share the low line; mild sadness has its own. */
function moodLine(card: AffectCard, lines: AffectCopy['lines'], low: boolean): string {
  if (card.crisis || low) return lines.mood.low;
  switch (card.emotion) {
    case 'happy': return lines.mood.happy;
    case 'love': return lines.mood.love;
    case 'neutral': return lines.mood.neutral;
    case 'sad': return lines.mood.sad;
  }
}

/**
 * Deterministic affect section built only from fixed copy lines; model free text never enters it.
 * Order: crisis, mood, trend, need, strategy, mismatch, exhaustion hint, tail.
 */
export function renderAffect(card: AffectCard | null, copy: AffectCopy, flags: AffectRenderFlags): string {
  const lines = copy.lines;
  if (!card) return flags.exhaustedArmed ? [lines.exhaustedHint, lines.tail].join('\n') : '';
  const low = isLow(card, flags.lowIntensity);
  const parts: string[] = [];
  if (card.crisis) parts.push(lines.crisis);
  parts.push(moodLine(card, lines, low));
  if (card.trend === 'better' || card.trend === 'worse') parts.push(lines.trend[card.trend]);
  parts.push(lines.need[card.need], lines.strategy[card.strategy]);
  if (card.mismatch) parts.push(lines.mismatch);
  // A low or crisis turn never gets the change-topic hint.
  if (flags.exhaustedArmed && !low) parts.push(lines.exhaustedHint);
  parts.push(lines.tail);
  return parts.join('\n');
}

/** Longest render over every card and flag combination; the startup budget check uses it. */
export function maxAffectRender(copy: AffectCopy): number {
  // An infinite threshold lets the most cards carry the hint, so this bounds every real lowIntensity.
  const lowIntensity = Number.POSITIVE_INFINITY;
  let max = renderAffect(null, copy, { exhaustedArmed: true, lowIntensity }).length;
  for (const crisis of [false, true]) {
    for (const emotion of AFFECT_EMOTIONS) {
      for (const trend of AFFECT_TRENDS) {
        for (const need of AFFECT_NEEDS) {
          for (const strategy of AFFECT_STRATEGIES) {
            for (const mismatch of [false, true]) {
              for (const exhaustedArmed of [false, true]) {
                const card: AffectCard = { emotion, intensity: 1, trend, need, strategy, mismatch, crisis };
                max = Math.max(max, renderAffect(card, copy, { exhaustedArmed, lowIntensity }).length);
              }
            }
          }
        }
      }
    }
  }
  return max;
}

/** Startup check: each language's longest render must fit that language's reserved affect room. */
export function checkAffectBudgets(
  budgets: Partial<Record<Language, InstructionBudget>>,
  copies: Record<Language, AffectCopy>,
): void {
  for (const [language, budget] of Object.entries(budgets) as Array<[Language, InstructionBudget | undefined]>) {
    if (!budget) continue;
    const need = maxAffectRender(copies[language]);
    const room = budget.affectMaxChars ?? 0;
    if (need > room) throw new Error(`affect_budget_too_small:${language}: render ${need} > max ${room}`);
  }
}
```

- [x] **Step 12: 运行，确认通过**

Run: `cd gateway && npx vitest run test/affect-render.test.ts`
Expected: PASS（8 个用例）。

如果最后一个用例（`fits the shipped copy...`）失败，失败信息里有该语言的实际最长渲染长度。处理规则（启动校验是唯一准绳，文案长度由 T2 作者负责）：
- zh 超过 150：这是 spec 定值，停下来报告实际长度，由用户决定缩短 T2 文案还是放宽上限。
- ja 或 en 超过：把 `languageAffectMaxChars` 里该语言的值改成实际长度向上取整到 10 的倍数，再跑 `npx vitest run test/pacing.test.ts test/affect-render.test.ts`；仍然通过就在报告里写明新值，`validateBudgets` 失败就停下来报告。

- [x] **Step 13: 在 `index.ts` 加启动校验**

`gateway/src/index.ts`，原文：

```ts
import { loadMemoryBudget, loadPacing, validateBudgets } from './session/pacing.ts';
```

改为：

```ts
import { loadMemoryBudget, loadPacing, validateBudgets } from './session/pacing.ts';
import { checkAffectBudgets } from './session/affectRender.ts';
```

原文：

```ts
const budgetReport = validateBudgets(pacing, memory, config.ledger, personasByLanguage);
const languageBudgetFields: Record<string, number> = {};
for (const language of LANGUAGES) {
  const budget = budgetReport.budgets[language];
  const perLanguage = budgetReport.perLanguage[language];
  if (!budget || !perLanguage) continue;
  languageBudgetFields[`${language}TotalChars`] = budget.totalChars;
  languageBudgetFields[`${language}MinHistoryChars`] = perLanguage.minHistoryChars;
}
```

改为：

```ts
const budgetReport = validateBudgets(pacing, memory, config.ledger, personasByLanguage);
// Every language's longest affect render must fit its reserved room; otherwise refuse to start.
checkAffectBudgets(budgetReport.budgets, i18n.affect);
const languageBudgetFields: Record<string, number> = {};
for (const language of LANGUAGES) {
  const budget = budgetReport.budgets[language];
  const perLanguage = budgetReport.perLanguage[language];
  if (!budget || !perLanguage) continue;
  languageBudgetFields[`${language}TotalChars`] = budget.totalChars;
  languageBudgetFields[`${language}MinHistoryChars`] = perLanguage.minHistoryChars;
  languageBudgetFields[`${language}AffectMaxChars`] = budget.affectMaxChars ?? 0;
}
```

`index.ts` 没有单元测试；Step 12 的 `fits the shipped copy...` 用同样的输入跑同一个函数，typecheck 在 Step 20 覆盖导入。

- [x] **Step 14: 写 `EmotionTagger.onAffect` 的失败测试**

`gateway/test/emotion.test.ts` 顶部导入后加一行：

```ts
import type { AffectCard } from '../src/session/affect.ts';
```

在文件末尾追加：

```ts
describe('EmotionTagger.onAffect', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const card = (over: Partial<AffectCard> = {}): AffectCard => ({
    emotion: 'neutral', intensity: 1, trend: 'flat', need: 'chat', strategy: 'reflect', mismatch: false, crisis: false, ...over,
  });
  function make() {
    const out: Emotion[] = [];
    const t = new EmotionTagger(cfg, (e) => out.push(e), () => Date.now());
    return { t, out };
  }

  it('applies the card at once, even inside the lexicon debounce, then reverts as usual', () => {
    const { t, out } = make();
    t.onUserFinal('我有点难过');
    t.onAffect(card({ emotion: 'love' }), false);
    expect(out).toEqual(['sad', 'love']);
    vi.advanceTimersByTime(6000);
    expect(out).toEqual(['sad', 'love', 'happy']);
  });

  it('holds a low mood: no revert, lexicon happy ignored, sad and love still apply', () => {
    const { t, out } = make();
    t.onAffect(card({ emotion: 'sad', intensity: 3 }), true);
    vi.advanceTimersByTime(60_000);
    expect(out).toEqual(['sad']);
    t.onUserFinal('今天真开心');
    expect(out).toEqual(['sad']);
    t.onUserFinal('谢谢你');
    expect(out).toEqual(['sad', 'love']);
    vi.advanceTimersByTime(60_000);
    expect(out).toEqual(['sad', 'love']);
  });

  it('shows neutral during a crisis and keeps it', () => {
    const { t, out } = make();
    t.onAffect(card({ emotion: 'sad', intensity: 3, crisis: true }), true);
    vi.advanceTimersByTime(60_000);
    t.onUserFinal('今天真开心');
    expect(out).toEqual(['neutral']);
  });

  it('releases the hold when a card is no longer low', () => {
    const { t, out } = make();
    t.onAffect(card({ emotion: 'sad', intensity: 3 }), true);
    t.onAffect(card({ emotion: 'neutral', trend: 'better' }), false);
    expect(out).toEqual(['sad', 'neutral']);
    vi.advanceTimersByTime(6000);
    expect(out).toEqual(['sad', 'neutral', 'happy']);
  });

  it('releaseHold (forget/decline) drops the hold and lets the mood revert', () => {
    const { t, out } = make();
    t.onAffect(card({ emotion: 'sad', intensity: 3 }), true);
    t.releaseHold();
    vi.advanceTimersByTime(6000);
    expect(out).toEqual(['sad', 'happy']);
    t.onUserFinal('今天真开心');
    expect(out).toEqual(['sad', 'happy']); // already happy; the lexicon is no longer blocked
  });
});
```

- [x] **Step 15: 运行，确认失败**

Run: `cd gateway && npx vitest run test/emotion.test.ts`
Expected: FAIL，5 个新用例报 `t.onAffect is not a function`；原有 7 个用例 PASS。

- [x] **Step 16: 实现 `onAffect`**

`gateway/src/session/emotion.ts`，原文：

```ts
import type { Emotion, EmotionConfig } from '../i18n/emotion.ts';
import { containsPhrase } from '../i18n/text.ts';
```

改为：

```ts
import type { Emotion, EmotionConfig } from '../i18n/emotion.ts';
import { containsPhrase } from '../i18n/text.ts';
import type { AffectCard } from './affect.ts';
```

原文：

```ts
  private revertTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<number, string>();
```

改为：

```ts
  private revertTimer: NodeJS.Timeout | null = null;
  /** A low card holds the mood: no revert, and the lexicon may not switch it to happy. */
  private hold = false;
  private readonly pending = new Map<number, string>();
```

原文：

```ts
  onUserFinal(text: string): void {
    const e = tagEmotion(text, this.cfg);
    if (e) this.apply(e);
  }
```

改为：

```ts
  onUserFinal(text: string): void {
    const e = tagEmotion(text, this.cfg);
    if (e) this.apply(e);
  }

  /** Analyzer card: wins over the lexicon, skips the debounce, and holds the mood while low. */
  onAffect(card: AffectCard, low: boolean): void {
    this.hold = low;
    const e: Emotion = card.crisis ? 'neutral' : card.emotion;
    if (e !== this.current) {
      this.current = e;
      this.lastChangeAt = this.now();
      this.emit(e);
    }
    this.scheduleRevert();
  }

  /** Forget/decline dropped the card: stop holding and revert as usual. */
  releaseHold(): void {
    this.hold = false;
    this.scheduleRevert();
  }
```

原文：

```ts
  private apply(e: Emotion): void {
    if (e === this.current) {
```

改为：

```ts
  private apply(e: Emotion): void {
    if (this.hold && e === 'happy') return;
    if (e === this.current) {
```

原文：

```ts
    this.revertTimer = null;
    if (this.current === this.cfg.defaultEmotion) return;
```

改为：

```ts
    this.revertTimer = null;
    if (this.hold || this.current === this.cfg.defaultEmotion) return;
```

- [x] **Step 17: 运行，确认通过**

Run: `cd gateway && npx vitest run test/emotion.test.ts`
Expected: PASS（12 个用例）。

- [x] **Step 18: 写 Session 接线的失败测试**

`gateway/test/session.test.ts` 顶部导入里补上（T2 已经导入的不要重复）：

```ts
import { PROMPT_LABELS } from '../src/roles/labels.ts';
import { loadAffectConfig } from '../src/session/affect.ts';
import type { PushGate } from '../src/session/pushGate.ts';
```

在文件末尾追加（辅助名字如果和 T2 已加的冲突，就在本块内改名）：

```ts
const affectFixture = loadAffectConfig(`${fileURLToPath(new URL('..', import.meta.url))}config/affect.json`);
const affectCardJson = (over: Record<string, unknown> = {}) => JSON.stringify({
  emotion: 'sad', intensity: 3, trend: 'worse', need: 'vent', strategy: 'comfort', mismatch: false, crisis: false, ...over,
});
const sessionInternals = (session: Session) => session as unknown as { gate: PushGate; instructions(): string };

describe('Session affect render', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders an accepted card after the persona, moves the avatar, and asks for one push per change', async () => {
    let reply = affectCardJson();
    const s = setup({ i18n, emotion: i18n.emotion, affect: affectFixture, textClient: { complete: async () => reply } });
    await greetAndFinish(s);
    const request = vi.spyOn(sessionInternals(s.session).gate, 'request');
    const pushes = () => request.mock.calls.filter(([update]) => update.instructions === true).length;
    const lines = i18n.affect.zh.lines;

    s.session.handleClientMessage({ type: 'debug.userText', text: '今天下午去了一趟菜场' });
    await vi.advanceTimersByTimeAsync(10);
    const text = sessionInternals(s.session).instructions();
    expect(text.startsWith(`P\n\n${PROMPT_LABELS.zh.affectHeader}\n\n${lines.mood.low}`)).toBe(true);
    expect(text).toContain(lines.need.vent);
    expect(text).toContain(lines.tail);
    expect(pushes()).toBe(1);
    expect(of(s.sent, 'avatar.emotion').at(-1)?.emotion).toBe('sad');

    // Same card again: the render is unchanged, so no new push.
    s.session.handleClientMessage({ type: 'debug.userText', text: '买了点青菜和豆腐回来' });
    await vi.advanceTimersByTimeAsync(10);
    expect(pushes()).toBe(1);

    // A different card changes the render and asks again.
    reply = affectCardJson({ emotion: 'happy', intensity: 1, trend: 'better', need: 'share_joy', strategy: 'affirm' });
    s.session.handleClientMessage({ type: 'debug.userText', text: '孙子说周末带我去公园' });
    await vi.advanceTimersByTimeAsync(10);
    expect(pushes()).toBe(2);
    expect(sessionInternals(s.session).instructions()).toContain(lines.mood.happy);
    s.session.end();
  });

  it('puts the crisis line first, keeps the avatar neutral and logs affect_crisis once without content', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const s = setup({ i18n, emotion: i18n.emotion, affect: affectFixture, textClient: { complete: async () => affectCardJson({ crisis: true }) } });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '最近总觉得撑不下去' });
    await vi.advanceTimersByTimeAsync(10);
    s.session.handleClientMessage({ type: 'debug.userText', text: '我一个人在家' });
    await vi.advanceTimersByTimeAsync(10);
    const lines = i18n.affect.zh.lines;
    expect(sessionInternals(s.session).instructions()
      .startsWith(`P\n\n${PROMPT_LABELS.zh.affectHeader}\n\n${lines.crisis}\n${lines.mood.low}`)).toBe(true);
    expect(of(s.sent, 'avatar.emotion').at(-1)?.emotion).toBe('neutral');
    const logged = write.mock.calls.map((c) => String(c[0])).join('');
    expect(logged.match(/"event":"affect_crisis"/g)).toHaveLength(1);
    expect(logged).not.toContain('撑不下去');
    write.mockRestore();
    s.session.end();
  });

  it('renders the affect section in the session language', async () => {
    const s = setup(
      {
        i18n,
        affect: affectFixture,
        roles: fixedRoleCatalog('P', director, { languages: ['zh', 'en'], defaultLanguage: 'zh' }),
        textClient: { complete: async () => affectCardJson() },
      },
      { roleId: 'elder-companion', styleId: 'grandchild', language: 'en' },
    );
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: 'I went to the market this afternoon.' });
    await vi.advanceTimersByTimeAsync(10);
    const text = sessionInternals(s.session).instructions();
    expect(text).toContain(`${PROMPT_LABELS.en.affectHeader}\n\n${i18n.affect.en.lines.mood.low}`);
    expect(text).not.toContain(PROMPT_LABELS.zh.affectHeader);
    s.session.end();
  });

  it('drops the session copy of the card when a forget rebuild starts', async () => {
    const s = setup({ i18n, emotion: i18n.emotion, affect: affectFixture, textClient: { complete: async () => affectCardJson() } });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '今天下午去了一趟菜场' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).toContain(PROMPT_LABELS.zh.affectHeader);
    const view = s.session as unknown as { rebuild(reason: string, keepToolTurn?: boolean): Promise<void> };
    void view.rebuild('forget', true);
    // Synchronous part of rebuild: the card is gone before the reconnect builds its instructions.
    expect(sessionInternals(s.session).instructions()).not.toContain(PROMPT_LABELS.zh.affectHeader);
    await vi.advanceTimersByTimeAsync(10);
    s.session.end();
  });

  it('keeps instructions unchanged when no analyzer runs', async () => {
    const s = setup({ i18n, affect: affectFixture });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '今天下午去了一趟菜场' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).not.toContain(PROMPT_LABELS.zh.affectHeader);
    s.session.end();
  });

  it('reserves the affect room when it sets the summarize threshold', () => {
    const budget = { totalChars: 3000, snapshotMaxChars: 100, summaryMaxChars: 200 };
    const plain = setup({ budget });
    const reserved = setup({ budget: { ...budget, affectMaxChars: 150 } });
    expect(plain.session.ledger.summarizeThreshold - reserved.session.ledger.summarizeThreshold)
      .toBe(150 + PROMPT_LABELS.zh.affectHeader.length + 4);
    plain.session.end();
    reserved.session.end();
  });
});
```

说明：`setup` 默认的角色没有 `silenceDecision`，所以 `textClient` 只被分析器调用；Mock 对未匹配的 `debug.userText` 回复 `我在听`，三段测试文本都不含情绪词表里的词，头像变化只来自 `onAffect`。

- [x] **Step 19: 运行，确认失败**

Run: `cd gateway && npx vitest run test/session.test.ts -t "Session affect render"`
Expected: FAIL。前三个用例的指令里没有 `## 此刻（内部参考）` / `## Right now (internal reference)`，`pushes()` 是 0；危机用例 `affect_crisis` 匹配为 `null`；`drops the session copy...` 在第一个 `toContain` 处失败。`keeps instructions unchanged when no analyzer runs` 和 `reserves the affect room...`（Step 3 已经让 `historyBudget` 预留）PASS。

- [x] **Step 20: 实现 Session 接线**

`gateway/src/session/session.ts`：

1）导入。原文：

```ts
import { buildInstructions, historyBudget, type InstructionBudget } from './instructions.ts';
```

改为：

```ts
import { renderAffect } from './affectRender.ts';
import { buildInstructions, historyBudget, type InstructionBudget } from './instructions.ts';
```

并把 T2 从 `./affect.ts` 导入的那一行补上 `isLow` 和 `type AffectCard`，例如 T2 写的是 `import { AffectTracker, type AffectConfig } from './affect.ts';`，就改成 `import { AffectTracker, isLow, type AffectCard, type AffectConfig } from './affect.ts';`（保留 T2 原有的名字，只追加）。

2）字段。原文：

```ts
  /** A forget/decline rebuild arrived while another rebuild was in progress. */
  private rebuildAgain: 'forget' | 'decline' | null = null;
```

改为：

```ts
  /** A forget/decline rebuild arrived while another rebuild was in progress. */
  private rebuildAgain: 'forget' | 'decline' | null = null;
  /** Latest accepted analyzer card; session memory only, never logged. */
  private affectCard: AffectCard | null = null;
  /** Affect text the last push request was made for. */
  private affectRendered = '';
  /** affect_crisis is logged at most once per session. */
  private crisisLogged = false;
```

3）T2 在构造函数里创建 `AffectTracker` 时传了 `onCard` 回调。把这个回调（不管 T2 写的是空函数还是别的）改成：

```ts
      onCard: (card) => this.onAffectCard(card),
```

其余构造参数不动。

4）`instructions()`。原文：

```ts
  private instructions(): string {
    const labels = PROMPT_LABELS[this.language];
    return buildInstructions(
      { persona: this.personaFor(this.language), memorySnapshot: this.context.memorySnapshot, summary: this.ledger.summary, recent: this.ledger.recent },
      this.budgetFor(this.language),
      labels,
    );
  }
```

改为：

```ts
  private instructions(): string {
    const labels = PROMPT_LABELS[this.language];
    return buildInstructions(
      {
        persona: this.personaFor(this.language),
        affect: this.affectSection(),
        memorySnapshot: this.context.memorySnapshot,
        summary: this.ledger.summary,
        recent: this.ledger.recent,
      },
      this.budgetFor(this.language),
      labels,
    );
  }

  /** Current affect render in the session language; '' without an analyzer, or with no card and no hint. */
  private affectSection(): string {
    const config = this.deps.affect;
    if (!config || !this.affect) return '';
    return renderAffect(this.affectCard, this.i18n.affect[this.language], {
      exhaustedArmed: this.affect.exhaustedArmed,
      lowIntensity: config.lowIntensity,
    });
  }

  /** Ask the gate for one instructions push, only when the rendered affect text changed. */
  private syncAffectRender(): void {
    if (this.ended) return;
    const text = this.affectSection();
    if (text === this.affectRendered) return;
    this.affectRendered = text;
    this.gate.request({ instructions: true });
  }

  /** Accepted analyzer card: store it, drive the avatar, log a crisis once, then re-render. */
  private onAffectCard(card: AffectCard): void {
    const config = this.deps.affect;
    if (this.ended || !config) return;
    this.affectCard = card;
    if (card.crisis && !this.crisisLogged) {
      this.crisisLogged = true;
      log('affect_crisis', {});
    }
    this.emotion?.onAffect(card, isLow(card, config.lowIntensity));
    this.syncAffectRender();
  }
```

5）forget/decline 时清掉 Session 自己的副本。T2 在 `rebuild` 里加的块，原文：

```ts
      if (reason === 'forget' || reason === 'decline') {
        // The store just dropped user content; the analyzer must not keep its own copy.
        this.affect?.reset();
        this.refreshMemorySnapshot();
      }
```

改为：

```ts
      if (reason === 'forget' || reason === 'decline') {
        // The store just dropped user content; the analyzer must not keep its own copy.
        this.affect?.reset();
        this.clearAffect();
        this.refreshMemorySnapshot();
      }
```

并在 `onAffectCard` 之后加：

```ts
  /** Forget/decline: drop the session copy of the card. The rebuild reconnects with fresh instructions, so no push is requested. */
  private clearAffect(): void {
    this.affectCard = null;
    this.affectRendered = '';
    this.emotion?.releaseHold();
  }
```

T4 会在 `clearAffect()` 里再清它自己的 `openLoop`，所以字段清理都集中在这一个方法里。

不改 `sessionConfig()`、`applyLanguage`、构造函数里的 `historyBudget` 调用：它们已经通过 `budgetFor()` 拿到带 `affectMaxChars` 的预算。换语言时 `applyLanguage` 已经由 T0 请求推送，推送时 `instructions()` 现取新语言的 affect 段。

- [x] **Step 21: 运行，确认通过**

Run: `cd gateway && npx vitest run test/session.test.ts test/emotion.test.ts test/affect-render.test.ts test/instructions.test.ts test/pacing.test.ts`
Expected: PASS。

- [x] **Step 22: 全量回归**

Run（仓库根目录）：

```bash
npm test -w gateway
npm run typecheck -w gateway
git diff --check
```

Expected：全部通过，`git diff --check` 无输出。T3 不改规划器、召回和开场，不需要跑真实记忆库召回探针（T4 会跑）。

- [x] **Step 23: 提交**

```bash
git add gateway/src/roles/labels.ts gateway/src/session/instructions.ts gateway/src/session/pacing.ts \
  gateway/config/memory.json gateway/src/session/affectRender.ts gateway/src/index.ts \
  gateway/src/session/emotion.ts gateway/src/session/session.ts \
  gateway/test/instructions.test.ts gateway/test/pacing.test.ts gateway/test/affect-render.test.ts \
  gateway/test/emotion.test.ts gateway/test/session.test.ts
git commit -m "feat(gateway): render the affect card into instructions and the avatar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

报告里写：实际跑过的命令和结果；`npm start` 时 `instruction_budget` 日志的 `zh/ja/enMinHistoryChars` 与 `zh/ja/enAffectMaxChars`（如果跑了）；Step 12 是否调整过 ja/en 的值。

## 接口疑问

**Q1（已决 2026-10-23）：预算。** 按 spec 预留 affect 段后，原预算三种语言都会让启动失败（最差风格：zh -53、ja -196、en -226；2026-10-23 计划审查用真实人设复算）；再加上 T6 人设放宽会更多。用户批准方案 A：只调高各语言的 `languageBudgetRatio`，不动 `summaryMaxChars`（800）和 `minHistoryChars`（400），英文文案压缩。按 T3 + T6 合并后的真实人设核算（`historyBudget` 拼法，affect 预留含标题）得出最小比例并留 ≥50 字余量：zh 0.43（4128）、ja 0.5（4800）、en 0.8（7680），`languageAffectMaxChars` 为 ja 210、en 250（T2 英文文案按「每类最长一句」相加的上界是 244；`maxAffectRender` 实际最长组合 zh 117 / ja 154 / en 196）。审查后复算 T6 合入后的余量为 zh 67/78、ja 62/53、en 304/81（grandchild/old-friend），T6 的英文否定句去掉了例词，所以都 ≥50，比例不用再调。代价：指令占的上下文变多，静默重建稍早触发（zh 约 5%，ja 约 10%）。

**Q2（已决）：** 上面的比例已经把 T6 的人设增长算进去了，T6 合入后预期通过 `pacing.test.ts`；如果仍然失败，T6 会停下报告，不要再改比例。

**Q3（渲染约定）：** 冻结的 `AffectCopy` 没写拼接方式。T3 用 `\n` 连接各部分，`trend` 单独成行而不是拼成半句。（2026-10-23 计划审查后修订）`AffectCopy.mood` 增加 `sad` 档：`emotion === 'sad'` 但不低落时用 `mood.sad`（「有点难过」），只有 `crisis` 或 `isLow` 才用 `mood.low`（「很低落」），与 spec §2 的优先级一致。T2 写文案时，每个字符串都应该是独立的完整短句。

**Q4（T2 内部名字）：** 冻结接口没有约定 Session 里分析器实例的字段名。T3 假定是 `this.affect`，构造参数里有 `onCard`。实现时以 T2 的实际名字为准（Step 0 的 grep 会显示）。

**Q5：** 只要 `budget.affectMaxChars` 有值，就按它预留，`affect.enabled=false` 时也一样（摘要会稍早触发）。这样配置简单，也和启动校验一致；如果要求关闭时完全回到现状，需要另加按 `enabled` 传 0 的逻辑。

## 2026-10-23 评估后修正（T7 之后）

`renderAffect` 在 `exhaustedArmed && !low && !crisis` 时强制使用 `need.topic_exhausted` 与 `strategy.disclose`，避免与卡片的 ask/reflect 策略冲突；`maxAffectRender` 上界与 `affect-render.test.ts` 的 47→46 预期同步更新。三语 `exhaustedHint` 缩短为更具指令性的句子，仍满足 `memory.json` 的 affect 预算。
