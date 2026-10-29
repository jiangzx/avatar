# P2-T2：抽取写入事项类型与来源原话

**Spec：** 「事项线」（类型、有日期的事件、证据规则）、坑位第 1、10 条（证据只认用户陈述原话、健康事实必须 sensitive）。

抽取模型新增可选字段 `kind`（`event` / `concern` / `plan`）。worker 在原话校验通过之后，把这条原话对应的用户消息 id 记进 `source_message_ids`，这样删除那句原话时事项会被 P2-T1 的触发器一起删掉。

- `kind` 写错或不认识时只丢掉这个字段，不让整批抽取失败（`.catch(undefined)`）。
- 只调中文提示词。ja/en 提示词不改：`kind` 是可选字段，缺省按 `concern` 写库。
- care 的行为不变：care 仍按 `followups` 中最新一条有原话的记录回访（`careFollowup` 查询不看 `kind`）。

**Files:**
- Modify: `gateway/src/memory/store.ts`（`THREAD_KINDS`、`ThreadKind`、`FollowupChange`、`insertFollowup`、`writeFollowup`）
- Modify: `gateway/src/memory/extract.ts`（`FollowupAdd.kind`、`attachQuoteSources`）
- Modify: `gateway/src/memory/worker.ts`（调用 `attachQuoteSources`）
- Modify: `gateway/roles/_shared/zh/extract.md`
- Test: `gateway/test/thread-extraction.test.ts`

**Interfaces:**
- Consumes: P2-T1 的 `followups.kind`、`followups.source_message_ids` 列。
- Produces（冻结）：`THREAD_KINDS`、`ThreadKind`、`FollowupChange`（add 带 `kind?`、`sourceMessageIds?`）、`attachQuoteSources(ops, users)`。

- [ ] **Step 1：写失败测试**

创建 `gateway/test/thread-extraction.test.ts`：

```ts
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadI18n } from '../src/i18n/load.ts';
import { attachQuoteSources, parseExtractBatch, type TextModelClient } from '../src/memory/extract.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { MemoryWorker } from '../src/memory/worker.ts';
import { seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });
const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));
const policy = { timeoutMs: 1_000, retries: 0, backoffMs: 0, maxBackoffMs: 0 };
const quoteRules = { maxChars: 80, safety: i18n.safety, evidence: i18n.evidence };

describe('thread kind in extraction ops', () => {
  it('keeps a known kind and drops an unknown one without failing the batch', () => {
    const batch = parseExtractBatch(JSON.stringify({ ops: [
      { op: 'add', table: 'followups', text: '问问复查', dueAt: 9_000, quote: '我明天去复查', kind: 'event' },
      { op: 'add', table: 'followups', text: '问问睡眠', dueAt: 9_000, quote: '最近睡不好', kind: 'worry' },
    ] }));
    expect(batch.ops).toHaveLength(2);
    expect(batch.ops[0]).toMatchObject({ kind: 'event' });
    expect(batch.ops[1]).not.toHaveProperty('kind');
  });

  it('links a kept quote to the user line it was copied from', () => {
    const ops = attachQuoteSources([
      { op: 'add', table: 'followups', text: '问问复查', dueAt: 9_000, quote: '我明天要去医院复查腰' },
      { op: 'add', table: 'followups', text: '接着聊', dueAt: 9_000 },
    ], [{ id: 'm0', text: '你好' }, { id: 'm1', text: '我明天要去医院复查腰，有点担心。' }]);
    expect(ops[0]).toMatchObject({ sourceMessageIds: ['m1'] });
    expect(ops[1]).not.toHaveProperty('sourceMessageIds');
  });
});

describe('worker writes threads', () => {
  it('stores the kind and the source line id of a quoted followup', async () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(db);
    const store = new SqliteMemoryStore(db);
    const w = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: w.ownerId, agentId: w.agentId, role: 'user', text: '我后天上午要去医院复查腰。', bigrams: '', now: 2 });
    const client: TextModelClient = {
      complete: async () => JSON.stringify({ ops: [
        { op: 'add', table: 'followups', text: '问问复查', dueAt: 9_000, quote: '我后天上午要去医院复查腰', sensitive: true, kind: 'event' },
        { op: 'add', table: 'followups', text: '下次接着聊天气', dueAt: 9_000 },
      ] }),
    };
    const worker = new MemoryWorker({ store, client, systemPrompt: '陈述。', maxTokens: 80, policy, quote: quoteRules });
    await worker.enqueue(w.ownerId, w.agentId, 'session_end');
    expect(db.prepare('SELECT text, kind, source_message_ids AS src, quote IS NOT NULL AS quoted FROM followups ORDER BY text').all()).toEqual([
      { text: '下次接着聊天气', kind: 'concern', src: '[]', quoted: 0 },
      { text: '问问复查', kind: 'event', src: '["m1"]', quoted: 1 },
    ]);
    // P2-T1 trigger: deleting the cited line drops the thread, not the plain followup.
    store.deleteMessagesByIds(w.ownerId, w.agentId, ['m1']);
    expect(db.prepare('SELECT text FROM followups').all()).toEqual([{ text: '下次接着聊天气' }]);
  });
});
```

- [ ] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/thread-extraction.test.ts`
Expected: FAIL——`attachQuoteSources` 不存在；`kind` 被丢弃。

- [ ] **Step 3：store 类型与写入**

`gateway/src/memory/store.ts`：

在 `DeletedItem` 上方加：

```ts
/** A followup with a quote and no done_at is a thread (spec 2026-10-28). */
export const THREAD_KINDS = ['event', 'concern', 'plan'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];
```

`FollowupChange` 的 add 分支改为：

```ts
  | { op: 'add'; text: string; dueAt: number; quote?: string; sensitive?: boolean; kind?: ThreadKind; sourceMessageIds?: readonly string[] }
```

`insertFollowup` 语句改为：

```ts
    insertFollowup: p(`INSERT INTO followups (id, owner_id, agent_id, text, due_at, done_at, source_session_id, quote, sensitive, created_at, kind, source_message_ids)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`),
```

`writeFollowup` 的 add 分支里，`this.q.insertFollowup.run(...)` 改为：

```ts
      // Only a quoted followup cites a user line; the citation trigger deletes it with that line.
      const sources = op.quote !== undefined ? unionIds(op.sourceMessageIds ?? []) : [];
      this.q.insertFollowup.run(id, ownerId, agentId, op.text, op.dueAt, sessionId, op.quote ?? null, sensitive, now, op.kind ?? 'concern', JSON.stringify(sources));
```

（`unionIds` 是该文件已有的去重 helper，`writeFact` 也在用。）

- [ ] **Step 4：抽取 schema 与来源链接**

`gateway/src/memory/extract.ts`：
- import 改为 `import { ExtractIncompleteError, THREAD_KINDS, type MemoryStore } from './store.ts';`
- `FollowupAdd` 在 `sensitive` 后加：

```ts
  /** Unknown values are dropped, not fatal: one bad label must not lose the batch. */
  kind: z.enum(THREAD_KINDS).optional().catch(undefined),
```

- 在 `vetFollowupQuotes` 后面加：

```ts
/** Links each kept quote to the user line it was copied from, so deleting that line drops the thread. */
export function attachQuoteSources(ops: readonly ResolvedOp[], users: ReadonlyArray<{ id: string; text: string }>): ResolvedOp[] {
  return ops.map((op) => {
    if (op.table !== 'followups' || op.op !== 'add' || op.quote === undefined) return op;
    const key = normalizeForMatch(op.quote);
    const source = users.find((row) => normalizeForMatch(row.text).includes(key));
    return { ...op, sourceMessageIds: source ? [source.id] : [] };
  });
}
```

- `.catch(undefined)` 会让解析结果里留下 `kind: undefined` 键（下游按缺省处理没问题，但测试与日志里会看到这个键）。把 `parseExtractBatch` 最后一行 `return { ops: z.array(OpSchema).parse(kept), droppedCategory, missingSources, invalidSources };` 替换为：

```ts
  const ops = z.array(OpSchema).parse(kept).map((op) => {
    if (op.table === 'followups' && op.op === 'add' && op.kind === undefined) {
      const { kind: _unknown, ...rest } = op;
      return rest;
    }
    return op;
  });
  return { ops, droppedCategory, missingSources, invalidSources };
```

- [ ] **Step 5：worker 调用**

`gateway/src/memory/worker.ts`：import 列表加 `attachQuoteSources`；`run()` 里：

```ts
    const sourced = resolveFactSources(vetted, refs);
    const linked = attachQuoteSources(sourced.ops, users);
    const applied = applyExtractOps(this.opts.store, ownerId, agentId, epochs, linked, consumed.map((row) => row.id), now);
```

（P1-T1 已经把 `now` 作为第 7 个参数传入；`users` 是本轮的用户消息行，含 `id` 与 `text`。）

- [ ] **Step 6：中文抽取提示词**

`gateway/roles/_shared/zh/extract.md`：

第 13 行改为：

```
- followups：必填 text、dueAt。dueAt 必须是正整数毫秒时间戳，根据输入的“现在”计算，不要用日期字符串。可选 quote（字符串）、sensitive（布尔值）、kind（字符串），规则见下文。
```

在以 `- followups 的 quote：` 开头的那一行后面加一行：

```
- followups 的 kind：填了 quote 时必须填。event＝有具体日子的事（复查、子女来访、出门办事），dueAt 填那件事发生的时间；concern＝持续的牵挂（腿疼、睡不好、心里挂着的事），dueAt 填大约一天后；plan＝打算去做、还没有具体日子的事（想学太极、打算换手机），dueAt 填大约三天后。分不清就填 concern。
```

- [ ] **Step 7：运行测试**

Run: `npm test -w gateway -- test/thread-extraction.test.ts test/extract.test.ts test/worker.test.ts test/memory-store.test.ts`
Expected: PASS。

- [ ] **Step 8：全量、typecheck 与召回探针**

```bash
npm test -w gateway && npm run typecheck -w gateway
node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp
```

Expected：全部通过（抽取属于高风险区：坑位第 10 条）。

- [ ] **Step 9：提交**

```bash
git add gateway/src/memory/store.ts gateway/src/memory/extract.ts gateway/src/memory/worker.ts gateway/roles/_shared/zh/extract.md gateway/test/thread-extraction.test.ts
git commit -m "feat(memory): extract thread kinds and link quotes to their source line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
