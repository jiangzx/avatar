# 多语言 M2 收尾修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在不改变中文既有行为、不进入 M3 范围的前提下，修掉 M2 整分支复查留下的合并前限制（A1–A8），并把真实记忆库只读探针扩展到 zh/ja/en 查询。

**Architecture:** 只做有界修复：en 召回模式按配置收窄；摘要阈值按会话当前语言预算计算并在换语时只降不升；情绪词改用共享的 `containsPhrase`；删除死配置、收敛重复 helper、补诊断与覆盖；ja/en 只做内容审校。召回、四段沉默、`detectLanguage`、适配器行为和 `app/` 均不改机制。

**Tech Stack:** Node 24 + TypeScript、zod、vitest、SQLite FTS5、Flutter（只跑回归，不改客户端）。

**Spec:** `docs/superpowers/specs/2026-10-21-multilingual-conversation-design.md` 第 4–5 期；风险契约见 `docs/project/roadmap.md`「记忆与回忆：已踩过的坑」「打断与沉默：已踩过的坑」。

## Global Constraints

- 不记录对话正文（音频、ASR 文本、回复文本）；测试/探针只记事件名、语言代码、计数、字节数、耗时、错误码。
- 中文配置、词表、固定话术和四段式机制保持逐字不变；本计划只改 en 配置、按语言预算的会话计算、内容审校。
- 召回高风险契约不变：证据只认用户陈述句；检索只命中 `role='user'`；模糊回忆只取最近已结束会话的用户陈述；当前句排除；不做跨语言翻译。
- 四段沉默契约不变：Director 阶段机、规划器、checkin 内容校验、配置兜底都不改。
- `detectLanguage` 仍只认整句显式换语请求；不在用户说话/打断时 `updateInstructions`。
- 不进入 M3：不实现 Seeduplex 日语提示、不做适配器能力表、不做语言重建/音色热换、不碰真机、不重启 8787、不改 `app/`。
- 不做真实库迁移；真实库探针只读，不打印正文，不写库。C1 的 en/ja 查询只做只读诊断，不断言命中。
- 提交只用显式路径，禁止 `git add -A`；每个任务 TDD（先失败测试，再实现，再全绿），任务结束提交。
- 每个任务结束后更新 gitignored 的 `.superpowers/sdd/2026-10-21-multilingual-m2-localization/progress.md`（不提交）。

## 高风险改动契约

1. **A1 只改 en 配置和召回前置匹配**：zh/ja `recentQueryPatterns`、`questionPatterns`、`queryFramePatterns` 零改动；不改变 `recall()` 的候选来源、证据过滤、`sameUtterance`、`grounded()`。
2. **A3 只改摘要触发阈值**：不改召回 SQL、快照视图、证据判定；阈值只允许降低，不允许把已有语言会话的摘要推迟。
3. **A4 只改情绪词匹配函数**：不改情绪优先级、debounce、revert、协议消息。
4. **A8 只改 ja/en 内容**：不改 `director.json` 固定兜底话术、数值字段、parity 校验；固定话术表仍逐字保留。
5. **真实库探针**：保持 `DatabaseSync(..., { readOnly: true })`；预 M2 schema 继续走同 SQL 的只读 fallback；输出只含 `language/query/hits/evidenceCount/newTitleFlag`。

---

## 文件结构

**修改（召回与语言）**

- `gateway/config/i18n/en/memory.json` — 收窄 question/recent 模式，增加 exact/recent 与 frame 前缀。
- `gateway/src/i18n/types.ts` — `RecallTextCopy` 增加 `recentQueryExactPatterns`。
- `gateway/src/i18n/load.ts` — schema 接受可选 `recentQueryExactPatterns`。
- `gateway/src/session/tools/recall.ts` — 区分 substring 模糊问与整句模糊问。
- `gateway/src/session/tools/registry.ts` — 传递 exact 模式。

**修改（预算）**

- `gateway/src/session/ledger.ts` — `summarizeThreshold` getter/setter（只降不升）。
- `gateway/src/session/session.ts` — 当前语言预算优先；换语时降低阈值。
- `gateway/src/index.ts`、`gateway/scripts/eval.ts` — 去掉全局 `maxHistoryChars`；eval 补 i18n 依赖。

**修改（情绪/卫生）**

- `gateway/src/session/emotion.ts` — 使用 `containsPhrase`。
- `gateway/src/unique.ts`（新增）— 唯一 `unique` helper。
- `gateway/src/config.ts`、`gateway/src/i18n/load.ts`、`gateway/src/i18n/emotion.ts` — 复用 helper。
- `gateway/src/i18n/language.ts`、`gateway/src/session/language.ts`、`gateway/src/memory/backfill.ts` — 复用 KANA。
- `gateway/src/memory/extract.ts` — 语言化空提示词错误；删除 test-only loader。
- `gateway/src/memory/backfill.ts` — `limit<=0` 防御。
- `gateway/src/session/tools/consent.ts`、`gateway/src/session/tools/registry.ts` — options object。
- `gateway/src/roles/catalog.ts`、`gateway/src/roles/fileCatalog.ts`、`gateway/src/index.ts` — 可测的缺语言 helper、`shared_missing:<lang>:directory`。
- `gateway/config/memory.json`、`gateway/src/session/pacing.ts` — 删除 `recallPhraseMaxChars`。

**修改（内容/文档/探针）**

- `gateway/roles/elder-companion/ja/styles/old-friend.md`
- `gateway/roles/elder-companion/en/styles/grandchild.md`
- `gateway/roles/elder-companion/en/director.json`（仅 `variationHintLabel`）
- `docs/testing/plan3-multilingual-recall-probe.mjs`（zh/ja/en 只读真实库查询）
- `docs/testing/plan3-mock-smoke.mjs`（显式 zh 回归）
- `docs/superpowers/plans/2026-10-21-multilingual-m2-localization.md`（补勾）
- `docs/project/roadmap.md`、`docs/blockers.md`（closeout 记录）

---

### Task 1: 收窄 en 召回问句与模糊问模式（A1）

**Files:**
- Modify: `gateway/config/i18n/en/memory.json`
- Modify: `gateway/src/i18n/types.ts`
- Modify: `gateway/src/i18n/load.ts`
- Modify: `gateway/src/session/tools/recall.ts`
- Modify: `gateway/src/session/tools/registry.ts`
- Test: `gateway/test/evidence.test.ts`
- Test: `gateway/test/memory-tools.test.ts`
- Test: `docs/testing/plan3-multilingual-recall-probe.mjs`

**Interfaces:**
- Produces: `RecallCopy.recentQueryExactPatterns: readonly string[]`（可选，默认空）。
- Consumes: 既有 `recentQueryPatterns`、`queryFramePatterns`、`questionPatterns`。

- [x] **Step 1: 写失败测试（证据问句）**

在 `gateway/test/evidence.test.ts` 的 `rejects ja/en questions but keeps statements` 之后加：

```ts
it('keeps en statements that start with what/how/have', () => {
  expect(isMemoryEvidence('What a lovely afternoon at the park.', rules)).toBe(true);
  expect(isMemoryEvidence('How wonderful it was to see my grandson.', rules)).toBe(true);
  expect(isMemoryEvidence('Have a good day with your family.', rules)).toBe(true);
  expect(isMemoryEvidence('What did you do today?', rules)).toBe(false);
  expect(isMemoryEvidence('Have you eaten?', rules)).toBe(false);
});
```

- [x] **Step 2: 写失败测试（召回路由）**

在 `gateway/test/memory-tools.test.ts` 的 en 模糊回忆用例后加：

```ts
it('routes en specific recall to FTS instead of vague recall', async () => {
  const store = new SqliteMemoryStore(open());
  const a = owner(store, 'en-specific');
  store.recordSessionStart('s-old', a.agentId, 1);
  say(store, a.ownerId, 'en-movie', 'I like watching old movies.', 2, 's-old');
  say(store, a.ownerId, 'en-park', 'I went to the park yesterday.', 3, 's-old');
  store.recordSessionEnd('s-old', a.agentId, 4);
  const ctx = () => ctxFor(store, worker(store), a);

  for (const query of [
    'Do you remember what movie we watched?',
    'Did we talk about movies?',
    'What did we say about movies?',
  ]) {
    const hit = await registryFor('en').handle('recall_memory', { query }, ctx());
    expect(hit.spokenFound).toBe(true);
    expect(hit.text).toContain('I like watching old movies.');
    expect(hit.text).not.toContain('I went to the park yesterday.');
  }

  for (const query of ['Do you remember?', 'What did we say?', 'What did we talk about?']) {
    const vague = await registryFor('en').handle('recall_memory', { query }, ctx());
    expect(vague.spokenFound).toBe(true);
    expect(vague.text).toContain('I went to the park yesterday.');
  }
});
```

- [x] **Step 3: 跑测试确认失败**

Run: `npm test -w gateway -- test/evidence.test.ts test/memory-tools.test.ts`
Expected: FAIL（en 问句模式仍把 `What/How/Have` 陈述判为非证据；具体查询仍走 recent 路径）。

- [x] **Step 4: 扩展 exact 模糊问接口**

`gateway/src/i18n/types.ts` 的 `RecallTextCopy` 加：

```ts
  /** Whole-utterance vague questions; only match when the query has no extra content. */
  recentQueryExactPatterns: readonly string[];
```

`gateway/src/i18n/load.ts` 的 `MemoryFileSchema.recall` 加：

```ts
    recentQueryExactPatterns: StringList.optional(),
```

`gateway/src/session/tools/recall.ts` 的 `RecallCopy` 加同名字段，并实现：

```ts
/** Exact vague questions keep their bare form; a specific "what did we say about X" must not match. */
function isRecentQuery(normalized: string, copy: RecallCopy): boolean {
  const key = normalized.replace(/[?？!！.。…]+$/u, '');
  const norm = (pattern: string) => pattern.replace(/\s/g, '').toLowerCase();
  if (copy.recentQueryExactPatterns.some((pattern) => {
    const value = norm(pattern);
    return value.length > 0 && key === value;
  })) return true;
  return copy.recentQueryPatterns.some((pattern) => {
    const value = norm(pattern);
    return value.length > 0 && normalized.includes(value);
  });
}
```

把 `recall()` 里的 recent 判断替换为：

```ts
  if (isRecentQuery(normalized, copy)) {
```

`gateway/src/session/tools/registry.ts` 的 `recallTool` 参数加：

```ts
      recentQueryExactPatterns: options.memory.recall.recentQueryExactPatterns ?? [],
```

- [x] **Step 5: 改 en 配置**

`gateway/config/i18n/en/memory.json`：

```json
"recentQueryPatterns": [
  "what did we talk about",
  "what were we talking about",
  "what did we discuss",
  "last conversation",
  "talked about last time"
],
"recentQueryExactPatterns": [
  "what did we say",
  "what did i say",
  "last time we talked",
  "do you remember",
  "remember when",
  "did we talk"
],
"queryFramePatterns": [
  "^(?:did|do|have)\\s+(?:i|you|we)\\s+(?:ever\\s+)?(?:say|said|tell|told|mention(?:ed)?|talk\\s+about)\\s+(?:(?:that|i|you|we)\\s+)*",
  "^(?:do|did)\\s+you\\s+remember\\s+(?:(?:that|what|when|where|who|how|if)\\s+)?",
  "^what\\s+(?:did|do|does)\\s+(?:i|you|we)\\s+(?:say|said|tell|told|mention(?:ed)?|talk\\s+about|discuss(?:ed)?)\\s+(?:about\\s+)?",
  "^i\\s+(?:said|told\\s+you|mentioned)\\s+(?:(?:that|i|you|we)\\s+)*"
]
```

`evidence.questionPatterns` 改为：

```json
"questionPatterns": [
  "^(?:what|where|when|who|why|how)\\s+(?:did|do|does|is|are|was|were|have|has|had|can|could|would|should|will)\\b",
  "^(?:do|did|does|are|is|was|were|can|could|would|should|will|have|has|had)\\s+(?:i|you|we|they|he|she|it)\\b",
  "^how\\s+about\\b",
  "^tell me\\b"
]
```

- [x] **Step 6: 扩展合成探针**

在 `docs/testing/plan3-multilingual-recall-probe.mjs` 的 en vague owner 增加一条更新的陈述：

```js
insert(store, vagueOwner.ownerId, 'probe-vague-session', 'en-vague-park', 'user', 'I went to the park yesterday.', 4_150);
```

在 `en vague recall` 断言后加：

```js
for (const query of [
  'Do you remember what movie we watched?',
  'Did we talk about movies?',
  'What did we say about movies?',
]) {
  const hit = await en.handle('recall_memory', { query }, vagueCtx());
  check(hit.spokenFound === true, 'en_specific_found');
  check(historyLines(hit, 'en').includes('I like watching old movies.'), 'en_specific_movie');
  check(!historyLines(hit, 'en').includes('I went to the park yesterday.'), 'en_specific_park_excluded');
}
for (const query of ['Do you remember?', 'What did we say?', 'What did we talk about?']) {
  const vague = await en.handle('recall_memory', { query }, vagueCtx());
  check(vague.spokenFound === true, 'en_bare_vague_found');
  check(historyLines(vague, 'en')[0] === 'I went to the park yesterday.', 'en_bare_vague_newest');
}
```

- [x] **Step 7: 跑聚焦、全量与真实库**

Run: `npm test -w gateway -- test/evidence.test.ts test/memory-tools.test.ts`
Expected: PASS。

Run: `node docs/testing/plan3-multilingual-recall-probe.mjs --temp`
Expected: PASS，checks 大于 78。

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS。

Run: `node docs/testing/plan3-multilingual-recall-probe.mjs --real-db /Users/jed/.avatar/memory.db`
Expected: 三个中文查询仍为 `true/true/false`；不打印正文。

- [x] **Step 8: 提交**

```bash
git add gateway/config/i18n/en/memory.json gateway/src/i18n/types.ts gateway/src/i18n/load.ts gateway/src/session/tools/recall.ts gateway/src/session/tools/registry.ts gateway/test/evidence.test.ts gateway/test/memory-tools.test.ts docs/testing/plan3-multilingual-recall-probe.mjs
git commit -m "fix(gateway): narrow en recall question patterns"
```

---

### Task 2: 按语言预算恢复摘要触发点（A3）+ eval 预算接线（A6）

**Files:**
- Modify: `gateway/src/session/ledger.ts`
- Modify: `gateway/src/session/session.ts`
- Modify: `gateway/src/index.ts`
- Modify: `gateway/scripts/eval.ts`
- Test: `gateway/test/session.test.ts`

**Interfaces:**
- Produces: `ConversationLedger.summarizeThreshold: number`（getter）、`setSummarizeAfterTokens(tokens: number): void`（只降不升）。
- Consumes: `historyBudget(persona, budget, labels)`、`SessionDeps.budgets`。

- [x] **Step 1: 写失败测试**

在 `gateway/test/session.test.ts` 的 `uses the initial language budget for the history room` 后加：

```ts
it('ignores a smaller global history fallback when a language budget exists', () => {
  const s = setup(
    {
      roles: fixedRoleCatalog('P', director, { languages: ['zh'], defaultLanguage: 'zh' }),
      budget: { totalChars: 4_000, snapshotMaxChars: 0, summaryMaxChars: 60 },
      maxHistoryChars: 500,
    },
    ownedCtx,
  );
  expect(s.session.ledger.summarizeThreshold).toBeGreaterThan(500);
  s.session.end();
});

it('lowers the summary threshold when switching to a smaller language budget', () => {
  const s = setup(
    {
      roles: fixedRoleCatalog('P', director, { languages: ['zh', 'ja'], defaultLanguage: 'zh' }),
      budgets: {
        zh: { totalChars: 4_000, snapshotMaxChars: 0, summaryMaxChars: 60 },
        ja: { totalChars: 1_200, snapshotMaxChars: 0, summaryMaxChars: 60 },
      },
    },
    ownedCtx,
  );
  const before = s.session.ledger.summarizeThreshold;
  s.session.setInitialLanguage('ja');
  expect(s.session.ledger.summarizeThreshold).toBeLessThan(before);
  s.session.end();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/session.test.ts`
Expected: FAIL（`summarizeThreshold` 不存在；全局 fallback 覆盖语言预算）。

- [x] **Step 3: 实现阈值 getter/setter**

`gateway/src/session/ledger.ts`：

```ts
export class ConversationLedger {
  private summarizeAfterTokens: number;

  constructor(private readonly opts: LedgerOptions = DEFAULT_LEDGER_OPTIONS) {
    this.summarizeAfterTokens = opts.summarizeAfterTokens;
  }

  get summarizeThreshold(): number {
    return this.summarizeAfterTokens;
  }

  /** Only lower it: a later language switch must never postpone summarization. */
  setSummarizeAfterTokens(tokens: number): void {
    if (!Number.isFinite(tokens)) return;
    this.summarizeAfterTokens = Math.min(this.summarizeAfterTokens, tokens);
  }

  needsSummary(): boolean {
    const tokens = estimateTokens(this.summaryText) + this.entries.reduce((n, e) => n + estimateTokens(e.text), 0);
    return this.userTurns() > this.opts.summarizeAfterTurns || tokens > this.summarizeAfterTokens;
  }
}
```

- [x] **Step 4: 会话按当前语言计算 history room**

`gateway/src/session/session.ts` 构造器：

```ts
    const initialBudget = this.budgetFor(this.language);
    const languageRoom = initialBudget
      ? historyBudget(initialPersona, initialBudget, PROMPT_LABELS[this.language])
      : undefined;
    const history = languageRoom ?? deps.maxHistoryChars ?? Number.POSITIVE_INFINITY;
    this.ledger = new ConversationLedger({ ...ledgerOpts, summarizeAfterTokens: Math.min(ledgerOpts.summarizeAfterTokens, history) });
```

`applyLanguage` 在 `this.language = next;` 后加：

```ts
    const budget = this.budgetFor(next);
    if (budget) {
      const room = historyBudget(this.personaFor(next), budget, PROMPT_LABELS[next]);
      this.ledger.setSummarizeAfterTokens(room);
    }
```

把 `SessionDeps.maxHistoryChars` 注释改为“per-language budget 缺失时的测试 fallback”。

- [x] **Step 5: 去掉生产/eval 的全局阈值，补 eval i18n**

`gateway/src/index.ts` 删除 SessionDeps 里的：

```ts
      maxHistoryChars: budgetReport.minHistoryChars,
```

`gateway/scripts/eval.ts` 删除：

```ts
  maxHistoryChars: report.minHistoryChars,
```

并在 SessionDeps 里加：

```ts
  budgets: report.budgets,
  i18n,
  languageRules: i18n.language,
  noticeKeywordsByLanguage: Object.fromEntries(
    (['zh', 'ja', 'en'] as const).map((language) => [language, i18n.memory[language].noticeKeywords]),
  ),
```

文件头注释加一句：`// Scenarios are zh-only; multilingual behavior is covered by gateway/test/multilingual.test.ts.`

- [x] **Step 6: 跑聚焦、全量与真实库**

Run: `npm test -w gateway -- test/session.test.ts test/ledger.test.ts`
Expected: PASS。

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS。

Run: `node docs/testing/plan3-multilingual-recall-probe.mjs --real-db /Users/jed/.avatar/memory.db`
Expected: `true/true/false` 不变。

- [x] **Step 7: 提交**

```bash
git add gateway/src/session/ledger.ts gateway/src/session/session.ts gateway/src/index.ts gateway/scripts/eval.ts gateway/test/session.test.ts
git commit -m "fix(gateway): scope summary threshold to session language"
```

---

### Task 3: emotion 大小写与整词匹配（A4）

**Files:**
- Modify: `gateway/src/session/emotion.ts`
- Modify: `gateway/config/i18n/en/emotion.json`
- Test: `gateway/test/emotion.test.ts`

- [x] **Step 1: 写失败测试**

在 `gateway/test/emotion.test.ts` 的 `ships a valid merged lexicon config` 后加：

```ts
it('matches English emotion words regardless of sentence case', () => {
  const shipped = DEFAULT_I18N.emotion;
  expect(tagEmotion('Sad day today.', shipped)).toBe('sad');
  expect(tagEmotion('Lonely evening.', shipped)).toBe('sad');
  expect(tagEmotion('Thank you for the tea.', shipped)).toBe('love');
  expect(tagEmotion('A deep sadness.', shipped)).toBe('sad');
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/emotion.test.ts`
Expected: FAIL（`Sad`/`Lonely`/`Thank` 大小写不匹配；`sadness` 未入词表）。

- [x] **Step 3: 实现共享短语匹配**

`gateway/src/session/emotion.ts`：

```ts
import { containsPhrase } from '../i18n/text.ts';
// ...
export function tagEmotion(text: string, cfg: EmotionConfig): Emotion | null {
  for (const e of cfg.priority) if (cfg.lexicon[e].some((w) => containsPhrase(text, w))) return e;
  return null;
}
```

`gateway/config/i18n/en/emotion.json` 的 `sad` 数组补 `"sadness"`、`"loneliness"`。

- [x] **Step 4: 跑聚焦与全量**

Run: `npm test -w gateway -- test/emotion.test.ts`
Expected: PASS。

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS；中文情绪用例不变。

- [x] **Step 5: 提交**

```bash
git add gateway/src/session/emotion.ts gateway/config/i18n/en/emotion.json gateway/test/emotion.test.ts
git commit -m "fix(gateway): match emotion words case-insensitively"
```

---

### Task 4: 删除死配置与收敛卫生项（A2 + A7）

**Files:**
- Modify: `gateway/config/memory.json`
- Modify: `gateway/src/session/pacing.ts`
- Create: `gateway/src/unique.ts`
- Modify: `gateway/src/config.ts`
- Modify: `gateway/src/i18n/load.ts`
- Modify: `gateway/src/i18n/emotion.ts`
- Modify: `gateway/src/i18n/language.ts`
- Modify: `gateway/src/session/language.ts`
- Modify: `gateway/src/memory/backfill.ts`
- Modify: `gateway/src/memory/extract.ts`
- Modify: `gateway/src/session/tools/consent.ts`
- Modify: `gateway/src/session/tools/registry.ts`
- Modify: `gateway/src/roles/catalog.ts`
- Modify: `gateway/src/roles/fileCatalog.ts`
- Modify: `gateway/src/index.ts`
- Test: `gateway/test/memory-text.test.ts`
- Test: `gateway/test/extract.test.ts`
- Test: `gateway/test/fileCatalog.test.ts`
- Test: `gateway/test/silence.test.ts`
- Test: `gateway/test/session.test.ts`

- [x] **Step 1: 写失败/守卫测试**

`gateway/test/memory-text.test.ts` 的 kana backfill 用例后加：

```ts
it('ignores a non-positive backfill limit', () => {
  const db = open();
  const store = new SqliteMemoryStore(db);
  expect(backfillKanaBigrams(store, 0)).toBe(0);
  expect(backfillKanaBigrams(store, -1)).toBe(0);
});
```

`gateway/test/extract.test.ts` 的逐语言 prompt 用例改为：

```ts
it('loads a shared extract prompt for every language with language-tagged errors', () => {
  const roles = fileURLToPath(new URL('../roles', import.meta.url));
  const zh = loadExtractPrompt(join(roles, '_shared', 'zh', 'extract.md'));
  const ja = loadExtractPrompt(join(roles, '_shared', 'ja', 'extract.md'), 'ja');
  const en = loadExtractPrompt(join(roles, '_shared', 'en', 'extract.md'), 'en');
  expect(ja).toContain('JSON');
  expect(en).toContain('JSON');
  expect(ja).not.toBe(zh);
  expect(en).not.toBe(zh);
});
```

并在临时空文件上断言：

```ts
it('tags an empty extract prompt with its language', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'extract-')), 'extract.md');
  writeFileSync(path, '   ');
  expect(() => loadExtractPrompt(path, 'ja')).toThrow(/empty_extract_prompt:ja/);
});
```

`gateway/test/fileCatalog.test.ts` 加：

```ts
it('reports a missing shared directory with the language', () => {
  const dir = copyFixtures();
  rmSync(join(dir, '_shared', 'ja'), { recursive: true, force: true });
  expect(() => loadRoleCatalog(dir, 'test-role')).toThrow(/shared_missing:ja:directory/);
});

it('reports which required role languages are missing', () => {
  const roles = fixedRoleCatalog('P', director, { languages: ['zh'], defaultLanguage: 'zh' });
  expect(missingRoleLanguages(roles, 'elder-companion', ['zh', 'ja', 'en'])).toEqual(['ja', 'en']);
});
```

`gateway/test/silence.test.ts` 在 `describe` 开头加：

```ts
it('ships the frozen zh silence pack verbatim', () => {
  expect(silence.zh).toEqual(zhRules);
});
```

`gateway/test/session.test.ts` 加：

```ts
it('uses the latest language for session-end extraction', async () => {
  const seen: Array<{ reason: string; language?: Language }> = [];
  const extractor = {
    extractOwner: async (_ownerId: string, reason: string, language?: Language) => { seen.push({ reason, language }); },
  };
  const s = setup({ roles: fixedRoleCatalog('P', director, { languages: ['zh', 'ja'], defaultLanguage: 'zh' }), worker: extractor }, ownedCtx);
  s.session.setInitialLanguage('ja');
  s.session.end();
  await vi.advanceTimersByTimeAsync(0);
  expect(seen.some((item) => item.reason === 'session_end' && item.language === 'ja')).toBe(true);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/memory-text.test.ts test/extract.test.ts test/fileCatalog.test.ts test/silence.test.ts test/session.test.ts`
Expected: FAIL（`loadExtractPrompts` 签名/`missingRoleLanguages`/`shared_missing:ja:directory`/非正 limit 等未实现）。

- [x] **Step 3: 实现卫生项**

1. 新建 `gateway/src/unique.ts`：

```ts
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
```

`config.ts`、`i18n/load.ts`、`i18n/emotion.ts` 删除本地 `unique`，改 import。

2. `i18n/language.ts` 导出 `KANA`；`session/language.ts`、`memory/backfill.ts` 改为 import。

3. `memory/backfill.ts` 开头加：

```ts
  if (!Number.isInteger(limit) || limit <= 0) return 0;
```

4. `memory/extract.ts`：

```ts
export function loadExtractPrompt(
  path = fileURLToPath(new URL('../../roles/_shared/zh/extract.md', import.meta.url)),
  language: Language = 'zh',
): string {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error(`empty_extract_prompt:${language}`);
  return text;
}
```

删除 `loadExtractPrompts`；`extract.test.ts` 改为逐语言调用。

5. `session/tools/consent.ts` 改为 options object：

```ts
export function consentTool(copy: { prompt: string; confirmedText: string; toolDescription: string }): ToolHandler {
```

内部用 `copy.prompt`/`copy.confirmedText`/`copy.toolDescription`；`registry.ts` 调用改为 `consentTool({ prompt: options.memory.declineConfirmPrompt, confirmedText: options.memory.declineConfirmedText, toolDescription: options.memory.recall.consentToolDescription })`。

6. `roles/catalog.ts` 增加：

```ts
export function missingRoleLanguages(
  roles: RoleCatalog,
  roleId: string,
  required: readonly Language[],
): Language[] {
  const supported = roles.supportedLanguages(roleId);
  return required.filter((language) => !supported.includes(language));
}
```

`index.ts` 改用它生成 `role_languages_incomplete`。

7. `roles/fileCatalog.ts` 的 `sharedFor` 缺目录错误改为：

```ts
    if (!text) throw new Error(`shared_missing:${language}:directory`);
```

8. 删除 `config/memory.json` 的 `recallPhraseMaxChars` 与 `pacing.ts` 的 schema 字段。

- [x] **Step 4: 跑聚焦与全量**

Run: `npm test -w gateway -- test/memory-text.test.ts test/extract.test.ts test/fileCatalog.test.ts test/silence.test.ts test/session.test.ts test/memory-tools.test.ts`
Expected: PASS。

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add gateway/src/unique.ts gateway/src/config.ts gateway/src/i18n/load.ts gateway/src/i18n/emotion.ts gateway/src/i18n/language.ts gateway/src/session/language.ts gateway/src/memory/backfill.ts gateway/src/memory/extract.ts gateway/src/session/tools/consent.ts gateway/src/session/tools/registry.ts gateway/src/roles/catalog.ts gateway/src/roles/fileCatalog.ts gateway/src/index.ts gateway/config/memory.json gateway/src/session/pacing.ts gateway/test/memory-text.test.ts gateway/test/extract.test.ts gateway/test/fileCatalog.test.ts gateway/test/silence.test.ts gateway/test/session.test.ts
git commit -m "refactor(gateway): remove dead recall config and dedupe helpers"
```

---

### Task 5: 真实库 zh/ja/en 只读探针 + smoke 语言边界 + plan 补勾（C1 + A6 + A5）

**Files:**
- Modify: `docs/testing/plan3-multilingual-recall-probe.mjs`
- Modify: `docs/testing/plan3-mock-smoke.mjs`
- Modify: `docs/superpowers/plans/2026-10-21-multilingual-m2-localization.md`

- [x] **Step 1: 扩展真实库查询**

`docs/testing/plan3-multilingual-recall-probe.mjs` 顶部替换 `ROADMAP_QUERIES`：

```js
const REAL_DB_QUERIES = [
  { language: 'zh', query: '上次聊到哪儿了' },
  { language: 'zh', query: '上次聊过电影吗' },
  { language: 'zh', query: '我说过喜欢喝茶吗' },
  // Read-only cross-language diagnostics: a zh-only database may legitimately return no hits.
  { language: 'en', query: 'What did we talk about?' },
  { language: 'ja', query: '前に何を話した' },
  { language: 'en', query: 'tea' },
  { language: 'ja', query: 'お茶' },
];
```

`runQueries` 改为：

```js
async function runQueries(store, ownerId) {
  for (const { language, query } of REAL_DB_QUERIES) {
    const outcome = await registryFor(language).handle('recall_memory', { query }, toolContext(store, ownerId));
    const lines = historyLines(outcome, language);
    console.log(JSON.stringify({
      language,
      query,
      hits: outcome.spokenFound === true,
      evidenceCount: lines.length,
      newTitleFlag: newTitleFlag(outcome.spokenText ?? '', lines),
    }));
  }
}
```

`runRealDb` 调用改为 `await runQueries(store, ownerId);`。文件头注释说明：en/ja 查询是只读诊断，不断言命中；`newTitleFlag` 结构上为 false。

- [x] **Step 2: smoke 显式 zh**

`docs/testing/plan3-mock-smoke.mjs`：

```js
          send({ type: 'session.start', clientInfo: { platform: 'test', audioPath: 'B', language: 'zh' } });
```

头部注释加：`// zh regression smoke; multilingual behavior is covered by gateway/test/multilingual.test.ts.`

- [x] **Step 3: 补勾 plan Task 1–5**

把 `docs/superpowers/plans/2026-10-21-multilingual-m2-localization.md` 中 Task 1–5 的 37 个 `- [x]` 改为 `- [x]`；Task 6 已是 `[x]`，不动。

- [x] **Step 4: 验证**

Run: `node --check docs/testing/plan3-multilingual-recall-probe.mjs && node --check docs/testing/plan3-mock-smoke.mjs`
Expected: PASS。

Run: `node docs/testing/plan3-multilingual-recall-probe.mjs --temp`
Expected: PASS。

Run: `node docs/testing/plan3-multilingual-recall-probe.mjs --real-db /Users/jed/.avatar/memory.db`
Expected: 7 行 JSON；只读、无正文；中文三行仍 `true/true/false`。en/ja 行只作诊断，不要求命中。

Run: `node --import tsx docs/testing/plan3-mock-smoke.mjs`
Expected: `passed: true`（若环境无法启动 8797，记录 NOT RUN，不伪造通过）。

- [x] **Step 5: 提交**

```bash
git add docs/testing/plan3-multilingual-recall-probe.mjs docs/testing/plan3-mock-smoke.mjs docs/superpowers/plans/2026-10-21-multilingual-m2-localization.md
git commit -m "test: extend multilingual probe and tick M2 plan"
```

---

### Task 6: ja/en 内容审校与 en 提示标签空格（A8 + D1）

**Files:**
- Modify: `gateway/roles/elder-companion/ja/styles/old-friend.md`
- Modify: `gateway/roles/elder-companion/en/styles/grandchild.md`
- Modify: `gateway/roles/elder-companion/en/director.json`
- Test: `gateway/test/config.test.ts`

- [x] **Step 1: 内容修改**

`ja/styles/old-friend.md`：

- `落ち着いた、年老いた友人や隣人のような存在` → `落ち着いた、昔からの友人や隣人のような存在`
- `自分のかすかな考えや好み` → `自分なりの考えや好み`
- `物わかりがよく` → `物分かりがよく`

`en/styles/grandchild.md`：

- 删除 `"I talked with several grandparents today."` 示例，改为：`You can have a small "AI life" of your own, but never invent human experiences, and never talk about other users.`
- `You are steady:` 改为 `You love old stories, are curious, a little playful, and very patient.`

`en/director.json` 的 `variationHintLabel` 末尾补一个空格（`... requirements): `），使拼接后的提示为 `: ` 开头 content。

- [x] **Step 2: 加配置守卫测试**

`gateway/test/config.test.ts`：

```ts
it('gives the en silence hint label a trailing space', () => {
  const roles = loadRoleCatalog(`${root}roles`);
  const label = roles.director('elder-companion', 'en').silenceDecision?.variationHintLabel;
  expect(label?.endsWith(': ')).toBe(true);
});
```

- [x] **Step 3: 验证**

Run: `npm test -w gateway -- test/config.test.ts test/fileCatalog.test.ts test/silence.test.ts`
Expected: PASS；固定兜底话术与 parity 不变。

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS。

- [x] **Step 4: 提交**

```bash
git add gateway/roles/elder-companion/ja/styles/old-friend.md gateway/roles/elder-companion/en/styles/grandchild.md gateway/roles/elder-companion/en/director.json gateway/test/config.test.ts
git commit -m "fix(gateway): polish ja/en persona copy"
```

---

### Task 7: Closeout 验证与文档（A5 收尾）

**Files:**
- Modify: `docs/project/roadmap.md`
- Modify: `docs/blockers.md`
- Modify: `docs/superpowers/plans/2026-10-21-multilingual-m2-closeout.md`（勾选本计划步骤）

- [x] **Step 1: 跑完整验证**

Run: `npm test -w gateway`
Expected: PASS，记录文件/用例数。

Run: `npm run typecheck -w gateway`
Expected: PASS。

Run: `cd app && flutter test`
Expected: 182 项通过。

Run: `npm test`
Expected: protocol 6、gateway 当前数、avatar-core 114 + 5 skipped。

Run: `git diff --check`
Expected: 无输出。

Run: `node docs/testing/plan3-multilingual-recall-probe.mjs --temp`
Expected: PASS。

Run: `node docs/testing/plan3-multilingual-recall-probe.mjs --real-db /Users/jed/.avatar/memory.db`
Expected: 7 行 JSON；中文三行 `true/true/false`；不打印正文。

- [x] **Step 2: 更新 roadmap / blockers**

`docs/project/roadmap.md` 文首 M2 段追加本轮 closeout 结果：实际测试计数、探针结果、仍 deferred 的 B1/B2/B3/C1 迁移/D1 grounded。`docs/blockers.md` 只补 M2 closeout 说明；#45/#46 状态不变。

- [x] **Step 3: 勾选本计划并提交文档**

```bash
git add docs/project/roadmap.md docs/blockers.md docs/superpowers/plans/2026-10-21-multilingual-m2-closeout.md
git commit -m "docs: record M2 closeout verification"
```

- [ ] **Step 4: 整分支复查**

对本轮 `14165e4..HEAD` 做 scoped review；确认无新增 Critical/Important 后，再按 finishing-a-development-branch 给合并选项。未得到用户明确同意前不合并、不推送。

---

## 计划自检

**覆盖检查**

- A1：Task 1（证据问句 + 具体/模糊路由 + 探针）。
- A2：Task 4（删除死配置）。
- A3：Task 2（按语言 history room + 换语阈值）。
- A4：Task 3（大小写/整词情绪匹配）。
- A5：Task 5 补勾 + Task 7 文档。
- A6：Task 2 eval 依赖 + Task 5 smoke 显式 zh。
- A7：Task 4（unique/KANA/backfill/extract prompt/consent/shared-dir/role languages/silence fixture/session-end language）；worker labels/prompt 耦合推迟 M3。
- A8：Task 6（ja/en 内容 + en 标签空格）。
- C1：Task 5（真实库 zh/ja/en 只读查询，不迁移）。
- B1/B2/B3、D1 grounded：明确不做，Task 7 记录。

**占位符检查**

- 没有 TBD/TODO；每个测试步骤给出可执行断言，每个实现步骤给出具体代码或配置片段。

**类型一致性**

- `recentQueryExactPatterns` 在 `i18n/types.ts`、`load.ts`、`recall.ts`、`registry.ts` 四处同名。
- `summarizeThreshold`/`setSummarizeAfterTokens` 只在 ledger/session/test 使用。
- `missingRoleLanguages` 在 roles/catalog 定义、index 与 fileCatalog.test 使用。
- `consentTool` 改为 options object 后只有 registry 一个调用点。
