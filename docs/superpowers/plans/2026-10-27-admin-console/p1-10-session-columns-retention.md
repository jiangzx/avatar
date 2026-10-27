# P1-T10: 会话结束原因与 adapter、用量保留清理、删除 owner 连带删除日志

**目标：** `sessions` 表写入 `adapter` 和 `end_reason`；用量按 `admin.json` 的 `retention.usageDays`（180 天）每日批量清理；删除 owner（包括孤儿清理）时同时删除 `log_events` 里属于他的行（`usage_events` 由外键级联删除）。

**实现的 spec 章节：** 「架构 / 数据模型」中「删除用户时…」「保留清理…」两条；决策 Q8、Q23、Q35。

**前置：** P1-T2（新列与表）、P1-T3（`ownerShortId`）、P1-T4（`log_events` 写入与日志保留清理、`admin.json` 的 `retention`）、P1-T9（`usage_events` 有数据）。开始前跑 `npm test -w gateway && npm run typecheck -w gateway` 确认全绿。

**行号说明：** P1-T5、P1-T6 改过 `registry.ts`、`index.ts` 的日志调用，下文行号是 2026-10-27 的位置，执行时按符号名定位。`index.ts` 里根 logger、admin 配置的变量名以 P1-T4、P1-T6 实际写入的为准（下文写作 `logger`、`adminConfig`）。

**Files:**
- Modify: `gateway/src/memory/store.ts`（接口 :56-57；预编译语句 :274-279、:285 附近；`recordSessionStart`/`recordSessionEnd` :506-512；`closeOpenSessions` :514-517；`deleteOwner` :523-525；`deleteOrphanOwners` :535-541）
- Modify: `gateway/src/identity/registry.ts`（`DeviceRegistryDeps`；`lifecycle` :67-74）
- Create: `gateway/src/usage/retention.ts`
- Modify: `gateway/src/index.ts`（registry 传 `adapterName`；每日清理加用量）
- Test: `gateway/test/session-columns.test.ts`（新建）
- Test: `gateway/test/identity.test.ts`（追加 1 个用例）
- Test: `gateway/test/usage-retention.test.ts`（新建）

**Interfaces:**
- Consumes：C1（`sessions.end_reason`、`sessions.adapter`、`log_events.oid`、`usage_events.ts`）；C2 `ownerShortId`；C5 `admin.json` `retention.usageDays`。
- Produces（C4 的落地，**名字与总览不同，见下方说明**）：
  ```ts
  // MemoryStore (gateway/src/memory/store.ts)
  recordSessionStart(sessionId: string, agentId: string, now: number, adapter?: string): void;
  recordSessionEnd(sessionId: string, agentId: string, now: number, reason?: string): void;
  // DeviceRegistryDeps
  adapterName?: string;
  // gateway/src/usage/retention.ts
  export function purgeExpiredUsage(db: DatabaseSync, olderThan: number, limit: number): number;
  ```
- **契约说明：** 总览 C4 写的是 `insertSession` / `endSession`，但现有 `MemoryStore` 的公开方法名是 `recordSessionStart` / `recordSessionEnd`（`insertSession`、`endSession` 只是内部预编译语句名）。本任务沿用现有公开名，只追加可选参数，这样十几处现有测试调用不用改。P2-T5 写 `owner_banned` 时调用的是 `SessionManager.endOwner(ownerId, 'owner_banned')`，原因经 `lifecycle.ended` 传到这里，不直接调 store。

## `end_reason` 取值表

只有 **已开始**（`session.start` 成功）的会话才有 `sessions` 行，所以只会出现下列值：

| 值 | 来源 | 含义 |
|---|---|---|
| `client_end` | `SessionManager.end()`（App 发 `session.end`） | 用户挂断 |
| `grace_expired` | `disconnected()` 后宽限期到 | 断线后没有重连 |
| `start_timeout` | 已开始的会话被新连接认领后未在时限内 resume | 重连后没有完成恢复 |
| `owner_replaced` | `create()` / `endOwner(..., 'owner_replaced')` | 同一用户开了新会话 |
| `owner_deleted` | dev 删除路由 / P2-T5 后台删除用户（`endOwner(..., 'owner_deleted')`） | 用户数据被删除 |
| `owner_banned` | P2-T5 封禁（`endOwner(..., 'owner_banned')`） | 用户被封禁 |
| `shutdown` | `SessionManager.shutdown()` | 网关正常关机 |
| `process_restart` | 启动时 `closeOpenSessions()` | 上一个进程异常退出，会话被补记结束 |

`unclaimed`、`start_failed` 发生在会话开始之前，没有 `sessions` 行。`end_reason` 为 NULL 只表示会话仍在进行。

## Steps

- [x] **Step 1: 写失败的 store 测试**

新建 `gateway/test/session-columns.test.ts`：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerShortId } from '../src/log/ownerId.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];

function open(): DatabaseSync {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
});

const session = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT ended_at, end_reason, adapter FROM sessions WHERE id = ?').get(id) as { ended_at: number | null; end_reason: string | null; adapter: string | null };

describe('session columns', () => {
  it('stores the adapter at start and the reason at end', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const who = seedOwner(store, 'h1', 1);
    store.recordSessionStart('s1', who.agentId, 10, 'qwen');
    expect(session(db, 's1')).toEqual({ ended_at: null, end_reason: null, adapter: 'qwen' });
    store.recordSessionEnd('s1', who.agentId, 20, 'client_end');
    expect(session(db, 's1')).toEqual({ ended_at: 20, end_reason: 'client_end', adapter: 'qwen' });
    // A second end does not overwrite the first.
    store.recordSessionEnd('s1', who.agentId, 30, 'shutdown');
    expect(session(db, 's1')).toEqual({ ended_at: 20, end_reason: 'client_end', adapter: 'qwen' });
  });

  it('keeps the old call shape working with NULL columns', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const who = seedOwner(store, 'h1', 1);
    store.recordSessionStart('s1', who.agentId, 10);
    store.recordSessionEnd('s1', who.agentId, 20);
    expect(session(db, 's1')).toEqual({ ended_at: 20, end_reason: null, adapter: null });
  });

  it('marks sessions closed at startup as process_restart', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const who = seedOwner(store, 'h1', 1);
    store.recordSessionStart('open', who.agentId, 10, 'mock');
    store.recordSessionStart('done', who.agentId, 11, 'mock');
    store.recordSessionEnd('done', who.agentId, 12, 'client_end');
    expect(store.closeOpenSessions(99)).toBe(1);
    expect(session(db, 'open')).toMatchObject({ end_reason: 'process_restart' });
    expect(session(db, 'done')).toMatchObject({ end_reason: 'client_end' });
  });
});

describe('owner deletion and logs', () => {
  const insertLog = (db: DatabaseSync, oid: string | null) =>
    db.prepare("INSERT INTO log_events (ts, level, event, oid) VALUES (1, 'info', 'x', ?)").run(oid);
  const logOids = (db: DatabaseSync) =>
    (db.prepare('SELECT oid FROM log_events ORDER BY id').all() as Array<{ oid: string | null }>).map((r) => r.oid);

  it('deletes the owner log lines by short id and keeps everyone else', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha', 1);
    const b = seedOwner(store, 'hb', 1);
    insertLog(db, ownerShortId(a.ownerId));
    insertLog(db, ownerShortId(b.ownerId));
    insertLog(db, null);
    expect(store.deleteOwner(a.ownerId)).toBe(true);
    expect(logOids(db)).toEqual([ownerShortId(b.ownerId), null]);
  });

  it('leaves logs alone when the owner does not exist', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    insertLog(db, ownerShortId('missing-owner'));
    expect(store.deleteOwner('missing-owner')).toBe(false);
    expect(logOids(db)).toEqual([ownerShortId('missing-owner')]);
  });

  it('deletes orphan owners together with their log lines', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const orphan = store.createOwner({ tokenHash: 'ho', now: 1 });
    insertLog(db, ownerShortId(orphan.ownerId));
    expect(store.deleteOrphanOwners(1_000, 10)).toBe(1);
    expect(logOids(db)).toEqual([]);
  });
});
```

说明：最后一个用例依赖「从未有 agent 行的 owner 是孤儿」（多角色计划的规则）；`createOwner` 不建 agent，所以它是孤儿。若 `deleteOrphanOwners` 的签名或条件与此不同，按 `gateway/test/identity.test.ts` 里孤儿清理用例的写法调整造数据的方式，断言不变。

- [x] **Step 2: 运行，确认失败**

Run: `npm test -w gateway -- test/session-columns.test.ts`
Expected: FAIL：`adapter`、`end_reason` 为 NULL；`process_restart` 未写；删除 owner 后日志仍在。

- [x] **Step 3: 实现 store 改动**

`gateway/src/memory/store.ts`：

1. 顶部 import 加：

```ts
import { ownerShortId } from '../log/ownerId.ts';
```

2. 接口（:56-57）改为：

```ts
  recordSessionStart(sessionId: string, agentId: string, now: number, adapter?: string): void;
  recordSessionEnd(sessionId: string, agentId: string, now: number, reason?: string): void;
```

3. 预编译语句（:274-279）改为：

```ts
    insertSession: p('INSERT INTO sessions (id, agent_id, started_at, adapter) VALUES (?, ?, ?, ?)'),
    endSession: p('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND agent_id = ? AND ended_at IS NULL'),
    closeOpenSessions: p(`UPDATE sessions SET ended_at = COALESCE(
      (SELECT MAX(created_at) FROM messages WHERE session_id = sessions.id),
      started_at
    ), end_reason = 'process_restart' WHERE ended_at IS NULL`),
```

4. 在 `deleteOwner: p('DELETE FROM owners WHERE id = ?'),`（:285）之后加：

```ts
    // Log lines carry only the short owner id (no foreign key), so they are deleted explicitly.
    deleteOwnerLogs: p('DELETE FROM log_events WHERE oid = ?'),
```

5. 实现（:506-512）改为：

```ts
  recordSessionStart(sessionId: string, agentId: string, now: number, adapter?: string): void {
    this.q.insertSession.run(sessionId, agentId, now, adapter ?? null);
  }

  recordSessionEnd(sessionId: string, agentId: string, now: number, reason?: string): void {
    this.q.endSession.run(now, reason ?? null, sessionId, agentId);
  }
```

6. `deleteOwner`（:523-525）改为：

```ts
  deleteOwner(ownerId: string): boolean {
    // usage_events cascade with the owner row; log_events go by short id in the same transaction.
    return this.tx(() => {
      const deleted = this.q.deleteOwner.run(ownerId).changes === 1;
      if (deleted) this.q.deleteOwnerLogs.run(ownerShortId(ownerId));
      return deleted;
    });
  }
```

7. `deleteOrphanOwners` 循环体 `for (const id of ids) this.q.deleteOwner.run(id);` 改为：

```ts
      for (const id of ids) {
        this.q.deleteOwner.run(id);
        this.q.deleteOwnerLogs.run(ownerShortId(id));
      }
```

注意 `deleteOwner` 现在用 `this.tx`。若调用方已经在一个 `tx` 里调用 `deleteOwner`（用 `grep -n "deleteOwner(" gateway/src` 检查），嵌套 `BEGIN` 会报错；当前只有 `registry.deleteOwner` 和 dev 路由在事务外调用。

- [x] **Step 4: 运行，确认通过**

Run: `npm test -w gateway -- test/session-columns.test.ts test/memory-store.test.ts test/identity.test.ts test/identity-http.test.ts`
Expected: 全部 PASS。

- [x] **Step 5: 写失败的 registry 测试**

在 `gateway/test/identity.test.ts` 的 `it('records sessions only for owned contexts', ...)` 之后追加：

```ts
  it('stores the adapter and the end reason through the lifecycle', () => {
    const database = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(database);
    const store = new SqliteMemoryStore(database);
    const registry = new DeviceRegistry({
      store, roles: fixedRoleCatalog('P', director), characters: shippedCharacters(), now: () => now,
      continuityGapMs: 600_000, adapterName: 'qwen',
      limits: { maxOwners: 10, dailyCap: 10, orphanOwnerDays: 7, orphanCleanupBatch: 2 },
    });
    const ctx = ctxOf(registry, register(registry));
    registry.lifecycle.started('s-adapter', ctx);
    registry.lifecycle.ended('s-adapter', ctx, 'grace_expired');
    expect(database.prepare('SELECT adapter, end_reason FROM sessions WHERE id = ?').get('s-adapter')).toEqual({ adapter: 'qwen', end_reason: 'grace_expired' });
  });
```

Run: `npm test -w gateway -- test/identity.test.ts`
Expected: FAIL（typecheck 意义上 `adapterName` 还不存在；vitest 运行时 `adapter`、`end_reason` 为 NULL）。

- [x] **Step 6: registry 传 adapter 与原因**

`gateway/src/identity/registry.ts`：

1. `DeviceRegistryDeps` 中 `continuityGapMs` 之后加：

```ts
  /** Realtime adapter name stored on each session row (config ADAPTER). */
  adapterName?: string;
```

2. `lifecycle`（:67-74）改为：

```ts
    this.lifecycle = {
      started: (sessionId, ctx) => {
        if (ctx.agentId !== undefined) deps.store.recordSessionStart(sessionId, ctx.agentId, this.now(), deps.adapterName);
      },
      ended: (sessionId, ctx, reason) => {
        if (ctx.agentId !== undefined) deps.store.recordSessionEnd(sessionId, ctx.agentId, this.now(), reason);
      },
    };
```

3. `gateway/src/index.ts` 的 `new DeviceRegistry({ ... })` 参数里、`continuityGapMs: pacing.restReminder.continuityGapMs,` 之后加：

```ts
      adapterName: config.adapter,
```

Run: `npm test -w gateway -- test/identity.test.ts`
Expected: PASS。

- [x] **Step 7: 写失败的用量保留测试**

新建 `gateway/test/usage-retention.test.ts`：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { purgeExpiredUsage } from '../src/usage/retention.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

describe('purgeExpiredUsage', () => {
  it('deletes rows older than the cutoff in bounded batches', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(db);
    const insert = db.prepare("INSERT INTO usage_events (ts, kind, adapter, model) VALUES (?, 'summarize', 'text', 'qwen-flash')");
    for (const ts of [1, 2, 3, 4, 100]) insert.run(ts);
    expect(purgeExpiredUsage(db, 50, 3)).toBe(3);
    expect(purgeExpiredUsage(db, 50, 3)).toBe(1);
    expect(purgeExpiredUsage(db, 50, 3)).toBe(0);
    expect((db.prepare('SELECT ts FROM usage_events').all() as Array<{ ts: number }>).map((r) => r.ts)).toEqual([100]);
  });
});
```

Run: `npm test -w gateway -- test/usage-retention.test.ts`
Expected: FAIL，`../src/usage/retention.ts` 不存在。

- [x] **Step 8: 实现用量清理**

新建 `gateway/src/usage/retention.ts`：

```ts
import type { DatabaseSync } from 'node:sqlite';

/** Deletes at most `limit` usage rows older than `olderThan`. Returns rows deleted; callers loop until < limit. */
export function purgeExpiredUsage(db: DatabaseSync, olderThan: number, limit: number): number {
  const result = db.prepare('DELETE FROM usage_events WHERE id IN (SELECT id FROM usage_events WHERE ts < ? ORDER BY id LIMIT ?)').run(olderThan, limit);
  return Number(result.changes);
}
```

Run: `npm test -w gateway -- test/usage-retention.test.ts`
Expected: PASS。

- [x] **Step 9: 接到每日清理**

`gateway/src/index.ts`：

1. import 区加：

```ts
import { purgeExpiredUsage } from './usage/retention.ts';
```

2. 在 `expireTranscripts` 函数之后加：

```ts
/** Usage rows older than retention.usageDays (admin.json), in batches like transcripts. */
async function expireUsage(): Promise<void> {
  if (!memoryDb) return;
  const olderThan = Date.now() - adminConfig.retention.usageDays * DAY_MS;
  const limit = memory.retentionBatch;
  for (;;) {
    const started = performance.now();
    let deleted: number;
    try {
      deleted = purgeExpiredUsage(memoryDb, olderThan, limit);
    } catch {
      logger.warn('usage_retention_failed', {});
      return;
    }
    logger.info('usage_retention_batch', { deleted, ms: Math.round(performance.now() - started) });
    if (deleted < limit) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
```

3. `runCleanup` 里在 `void expireTranscripts()...` 之后加一行：

```ts
    void expireUsage().catch(() => logger.warn('usage_retention_failed', {}));
```

4. 确认日志保留：运行 `grep -n "log_events" gateway/src/index.ts gateway/src/log/*.ts`，应能看到 P1-T4 写的按 `retention.logDays` 清理 `log_events` 的代码，并且它也挂在 `runCleanup`（或 P1-T4 自己的定时器）上。**看不到就停下报告**（这是 P1-T4 的交付，不要在本任务里补写）。

- [x] **Step 10: 全量回归与类型检查**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS。

- [x] **Step 11: 提交**

```bash
git add gateway/src/memory/store.ts gateway/src/identity/registry.ts gateway/src/usage/retention.ts gateway/src/index.ts \
  gateway/test/session-columns.test.ts gateway/test/identity.test.ts gateway/test/usage-retention.test.ts
git commit -m "feat(gateway): store session end reasons and expire usage rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收

- 已开始的会话都有 `adapter`；结束后 `end_reason` 取值在上表内；重启补记为 `process_restart`。
- 删除 owner（含孤儿清理）后，他的 `usage_events`（级联）和 `log_events`（按短 id）都被删除，其他人的行不受影响。
- 用量按 180 天批量清理，日志清理由 P1-T4 负责且已接入。
