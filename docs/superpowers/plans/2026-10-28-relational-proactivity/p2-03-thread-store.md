# P2-T3：事项查询与生命周期写入

**Spec：** 「事项线」生命周期（提起次数、关闭原因）、Q19（按角色隔离）。

决策引擎（P3）需要读出某个角色所有未关闭的事项线，选中一条后记一次「已提及」，用户表示已解决或婉拒时关闭。本任务只提供 store 方法；何时可提、上限几次由 P3 的纯函数按 `proactivity.json` 判断。

关闭时同时清空原话（与 `closeCareFollowup` 一致，数据最小化）；审计行不带原话。

**Files:**
- Modify: `gateway/src/memory/store.ts`
- Test: `gateway/test/thread-store.test.ts`

**Interfaces:**
- Consumes: P2-T1 列；P2-T2 `ThreadKind`。
- Produces（冻结）：`ThreadRecord`、`ThreadCloseReason`、`listOpenThreads`、`markThreadMentioned`、`closeThread`。

- [ ] **Step 1：写失败测试**

创建 `gateway/test/thread-store.test.ts`：

```ts
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { agentOf, seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

function setup() {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  const store = new SqliteMemoryStore(db);
  const a = seedOwner(store, 'h1');
  const b = agentOf(store, a.ownerId, 'xiaokai');
  const add = (w: { ownerId: string; agentId: string }, id: string, quote: string | null, kind: string, createdAt: number, doneAt: number | null = null) =>
    db.prepare(`INSERT INTO followups (id, owner_id, agent_id, text, due_at, done_at, source_session_id, quote, sensitive, created_at, kind)
      VALUES (?, ?, ?, 'summary', 5000, ?, 's1', ?, 1, ?, ?)`).run(id, w.ownerId, w.agentId, doneAt, quote, createdAt, kind);
  return { db, store, a, b, add };
}

describe('thread store', () => {
  it('lists only this agent’s open quoted followups, newest first', () => {
    const { store, a, b, add } = setup();
    add(a, 't-old', '我腿疼', 'concern', 10);
    add(a, 't-new', '我后天去复查', 'event', 20);
    add(a, 'plain', null, 'concern', 30);
    add(a, 'done', '想学太极', 'plan', 40, 41);
    add(b, 'other', '别的角色的事', 'concern', 50);
    expect(store.listOpenThreads(a.ownerId, a.agentId)).toEqual([
      { id: 't-new', kind: 'event', quote: '我后天去复查', dueAt: 5000, sensitive: true, mentionCount: 0, lastMentionedAt: null, createdAt: 20, sourceSessionId: 's1' },
      { id: 't-old', kind: 'concern', quote: '我腿疼', dueAt: 5000, sensitive: true, mentionCount: 0, lastMentionedAt: null, createdAt: 10, sourceSessionId: 's1' },
    ]);
  });

  it('counts mentions and closes a thread, clearing its quote', () => {
    const { db, store, a, add } = setup();
    add(a, 't1', '我腿疼', 'concern', 10);
    expect(store.markThreadMentioned(a.ownerId, 't1', 100)).toBe(true);
    expect(store.markThreadMentioned(a.ownerId, 't1', 200)).toBe(true);
    expect(store.listOpenThreads(a.ownerId, a.agentId)[0]).toMatchObject({ mentionCount: 2, lastMentionedAt: 200 });
    expect(store.closeThread(a.ownerId, 't1', 'resolved', 300)).toBe(true);
    expect(store.listOpenThreads(a.ownerId, a.agentId)).toEqual([]);
    expect(db.prepare('SELECT done_at, close_reason, quote FROM followups WHERE id = ?').get('t1')).toEqual({ done_at: 300, close_reason: 'resolved', quote: null });
    // Closed threads cannot be mentioned or closed again.
    expect(store.markThreadMentioned(a.ownerId, 't1', 400)).toBe(false);
    expect(store.closeThread(a.ownerId, 't1', 'declined', 400)).toBe(false);
    // The audit row is content-free.
    expect(db.prepare("SELECT op, diff FROM memory_changes WHERE row_id = 't1' AND op = 'close'").all()).toEqual([{ op: 'close', diff: '' }]);
  });

  it('never touches another owner’s thread', () => {
    const { store, a, add } = setup();
    const other = seedOwner(store, 'h2');
    add(a, 't1', '我腿疼', 'concern', 10);
    expect(store.markThreadMentioned(other.ownerId, 't1', 100)).toBe(false);
    expect(store.closeThread(other.ownerId, 't1', 'resolved', 100)).toBe(false);
    expect(store.listOpenThreads(a.ownerId, a.agentId)).toHaveLength(1);
  });
});
```

- [ ] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/thread-store.test.ts`
Expected: FAIL——方法不存在。

- [ ] **Step 3：实现**

`gateway/src/memory/store.ts`：

在 `ThreadKind` 下面加类型：

```ts
export interface ThreadRecord {
  id: string;
  kind: ThreadKind;
  /** Verbatim user words; the only material a thread may put in a model instruction. */
  quote: string;
  dueAt: number;
  sensitive: boolean;
  mentionCount: number;
  lastMentionedAt: number | null;
  createdAt: number;
  sourceSessionId: string | null;
}
export type ThreadCloseReason = 'resolved' | 'declined' | 'expired';
```

`MemoryStore` 接口在 `clearStaleCareQuotes` 后加：

```ts
  /** Open threads of this agent (quoted, not done), newest first. */
  listOpenThreads(ownerId: string, agentId: string): ThreadRecord[];
  /** Counts one proactive mention. False when the thread is closed or foreign. */
  markThreadMentioned(ownerId: string, id: string, now: number): boolean;
  /** Closes a thread and clears its quote; the audit row is content-free. False when closed or foreign. */
  closeThread(ownerId: string, id: string, reason: ThreadCloseReason, now: number): boolean;
```

`prepareStatements` 里 `clearStaleCareQuotes` 后加：

```ts
    listOpenThreads: p(`SELECT id, kind, quote, due_at, sensitive, mention_count, last_mentioned_at, created_at, source_session_id
      FROM followups WHERE owner_id = ? AND agent_id = ? AND done_at IS NULL AND quote IS NOT NULL
      ORDER BY created_at DESC, rowid DESC`),
    markThreadMentioned: p(`UPDATE followups SET mention_count = mention_count + 1, last_mentioned_at = ?
      WHERE id = ? AND owner_id = ? AND done_at IS NULL AND quote IS NOT NULL`),
    closeThread: p('UPDATE followups SET done_at = ?, close_reason = ?, quote = NULL WHERE id = ? AND owner_id = ? AND done_at IS NULL'),
```

`SqliteMemoryStore` 在 `clearStaleCareQuotes` 方法后加：

```ts
  listOpenThreads(ownerId: string, agentId: string): ThreadRecord[] {
    return this.q.listOpenThreads.all(ownerId, agentId).map((r) => ({
      id: r.id as string,
      kind: r.kind as ThreadKind,
      quote: r.quote as string,
      dueAt: r.due_at as number,
      sensitive: r.sensitive === 1,
      mentionCount: r.mention_count as number,
      lastMentionedAt: (r.last_mentioned_at as number | null) ?? null,
      createdAt: r.created_at as number,
      sourceSessionId: (r.source_session_id as string | null) ?? null,
    }));
  }

  markThreadMentioned(ownerId: string, id: string, now: number): boolean {
    return this.q.markThreadMentioned.run(now, id, ownerId).changes === 1;
  }

  closeThread(ownerId: string, id: string, reason: ThreadCloseReason, now: number): boolean {
    return this.tx<boolean>(() => {
      const owner = this.q.followupAgent.get(id, ownerId);
      if (this.q.closeThread.run(now, reason, id, ownerId).changes !== 1) return false;
      this.audit(ownerId, (owner?.agent_id as string | undefined) ?? null, 'followups', id, 'close', '', 'proactive', now);
      return true;
    });
  }
```

（`followupAgent` 是已有语句：`SELECT agent_id FROM followups WHERE id = ? AND owner_id = ?`。）

- [ ] **Step 4：运行测试与 typecheck**

Run: `npm test -w gateway -- test/thread-store.test.ts && npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add gateway/src/memory/store.ts gateway/test/thread-store.test.ts
git commit -m "feat(memory): list, mention and close threads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
