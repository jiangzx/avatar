# P1-T2: 迁移 v7（后台与可观测的全部新表）

**目标：** 在 `MIGRATIONS` 追加第 2 步，一次建齐总览 C1 的全部新表和新列，`user_version` 从 6 升到 7。现有 v6 库原地升级，数据全部保留。本任务**不加任何读写方法**，各表的访问代码由使用它的任务添加（P1-T4 `log_events`、P1-T8 `price_entries`、P1-T9 `usage_events`、P1-T10 `sessions` 新列、P2 `admin_audit` 和 `owners.banned_at`、P3 `config_versions` 和 `secrets`）。

**实现的 spec 章节：** 「架构 → 数据模型（迁移 v7，只增不删）」；写 spec 时按默认处理的第 1 点（只做增量迁移，保留现有记忆数据）。

**前置：** 无（可与 P1-T3 并行）。开始前跑 `npm test -w gateway && npm run typecheck -w gateway`，确认基线全绿。

**Files:**
- Modify: `gateway/src/memory/migrations.ts:11-165`（`MIGRATIONS` 数组末尾追加第 2 个元素；文件头注释说明 v7）
- Modify: `gateway/test/memory-store.test.ts:46-56,89-123`（版本号断言随 v7 更新）
- Modify: `docs/testing/plan3-multilingual-recall-probe.mjs:17,420`（召回探针接受 v6 和 v7）
- Test: `gateway/test/schema-v7.test.ts`（新建）

**Interfaces:**
- Consumes：`migrate(db, steps?)`、`openDatabase(path, opts)`、`BASELINE_VERSION`、`MIGRATIONS`（现有）；测试辅助 `seedOwner`（`gateway/test/helpers/memory.ts`）。
- Produces：总览 C1 的 SQL，逐字一致。迁移后 `PRAGMA user_version = 7`；`BASELINE_VERSION + MIGRATIONS.length - 1 === 7`。

## Steps

- [ ] **Step 1: 写失败的 v7 测试**

新建 `gateway/test/schema-v7.test.ts`：

```ts
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_VERSION, MIGRATIONS, migrate } from '../src/memory/migrations.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

function rawDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys = ON');
  dbs.push(db);
  return db;
}

const columns = (db: DatabaseSync, table: string): string[] =>
  db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => (row as { name: string }).name);
const names = (db: DatabaseSync, type: 'table' | 'index'): string[] =>
  db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type).map((row) => (row as { name: string }).name);
const count = (db: DatabaseSync, sql: string, ...args: (string | number)[]): number => (db.prepare(sql).get(...args) as { n: number }).n;

describe('schema v7', () => {
  it('is the latest version', () => {
    expect(BASELINE_VERSION + MIGRATIONS.length - 1).toBe(7);
  });

  it('creates every admin and observability table with its columns and indexes', () => {
    const db = rawDb();
    expect(migrate(db)).toBe(7);
    expect(names(db, 'table')).toEqual(expect.arrayContaining(['usage_events', 'price_entries', 'log_events', 'config_versions', 'secrets', 'admin_audit']));
    expect(columns(db, 'usage_events')).toEqual([
      'id', 'ts', 'owner_id', 'agent_id', 'session_id', 'character_id', 'kind', 'adapter', 'model',
      'input_text_tokens', 'input_audio_tokens', 'output_text_tokens', 'output_audio_tokens', 'cached_tokens',
      'input_tokens', 'output_tokens', 'first_audio_ms', 'gen_ms', 'error_code', 'estimated', 'price_id', 'cost_micro_yuan',
    ]);
    expect(columns(db, 'price_entries')).toEqual([
      'id', 'model', 'effective_from', 'input_text', 'input_audio', 'output_text', 'output_audio', 'cached', 'source', 'checked_at', 'created_at', 'actor',
    ]);
    expect(columns(db, 'log_events')).toEqual(['id', 'ts', 'level', 'event', 'sid', 'oid', 'char', 'seq', 'job', 'fields']);
    expect(columns(db, 'config_versions')).toEqual(['id', 'created_at', 'base_version', 'overlay', 'note', 'actor', 'kind']);
    expect(columns(db, 'secrets')).toEqual(['name', 'ciphertext', 'iv', 'tag', 'last4', 'updated_at', 'actor']);
    expect(columns(db, 'admin_audit')).toEqual(['id', 'ts', 'actor', 'action', 'target', 'detail']);
    expect(columns(db, 'sessions')).toEqual(expect.arrayContaining(['end_reason', 'adapter']));
    expect(columns(db, 'owners')).toEqual(expect.arrayContaining(['banned_at']));
    expect(names(db, 'index')).toEqual(expect.arrayContaining([
      'usage_events_owner_ts', 'usage_events_ts', 'usage_events_session', 'log_events_sid', 'log_events_oid', 'log_events_ts', 'admin_audit_ts',
    ]));
  });

  it('upgrades a v6 database in place and keeps its rows', () => {
    const db = rawDb();
    expect(migrate(db, [MIGRATIONS[0]!])).toBe(6);
    const store = new SqliteMemoryStore(db);
    const seeded = seedOwner(store, 'h-v6', 1_000);
    store.recordSessionStart('s-v6', seeded.agentId, 2_000);
    expect(migrate(db)).toBe(7);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    expect(new SqliteMemoryStore(db).findDevice('h-v6')).toEqual({ deviceId: seeded.deviceId, ownerId: seeded.ownerId });
    expect(db.prepare('SELECT end_reason, adapter FROM sessions WHERE id = ?').get('s-v6')).toEqual({ end_reason: null, adapter: null });
    expect(db.prepare('SELECT banned_at FROM owners WHERE id = ?').get(seeded.ownerId)).toEqual({ banned_at: null });
  });

  it('cascades usage rows with their owner but keeps system rows and log rows', () => {
    const db = rawDb();
    migrate(db);
    const store = new SqliteMemoryStore(db);
    const owner = seedOwner(store, 'h-cascade');
    const insert = db.prepare('INSERT INTO usage_events (ts, owner_id, kind, adapter, model) VALUES (?, ?, ?, ?, ?)');
    insert.run(1, owner.ownerId, 'realtime_reply', 'qwen', 'm');
    insert.run(2, null, 'memory_extract', 'text', 'm');
    db.prepare("INSERT INTO log_events (ts, level, event, oid) VALUES (1, 'info', 'x', 'abc123def456')").run();
    expect(store.deleteOwner(owner.ownerId)).toBe(true);
    expect(count(db, 'SELECT count(*) AS n FROM usage_events WHERE owner_id IS NOT NULL')).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM usage_events WHERE owner_id IS NULL')).toBe(1);
    // log_events has no FK on purpose: P1-T10 deletes them by ownerShortId.
    expect(count(db, 'SELECT count(*) AS n FROM log_events')).toBe(1);
  });

  it('defaults estimated to 0 and log fields to an empty object', () => {
    const db = rawDb();
    migrate(db);
    db.prepare("INSERT INTO usage_events (ts, kind, adapter, model) VALUES (1, 'summarize', 'text', 'qwen-flash')").run();
    db.prepare("INSERT INTO log_events (ts, level, event) VALUES (1, 'info', 'x')").run();
    expect(db.prepare('SELECT estimated, cost_micro_yuan FROM usage_events').get()).toEqual({ estimated: 0, cost_micro_yuan: null });
    expect(db.prepare('SELECT fields FROM log_events').get()).toEqual({ fields: '{}' });
  });

  it('accepts only the three config version kinds', () => {
    const db = rawDb();
    migrate(db);
    const insert = db.prepare("INSERT INTO config_versions (created_at, overlay, actor, kind) VALUES (1, '{}', 'admin', ?)");
    for (const kind of ['publish', 'rollback', 'reset']) insert.run(kind);
    expect(() => insert.run('edit')).toThrow(/CHECK/);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -w gateway -- test/schema-v7.test.ts`
Expected: FAIL。`is the latest version` 报 `expected 6 to be 7`，其余用例报 `no such table: usage_events` 或列不一致。

- [ ] **Step 3: 追加迁移步骤**

在 `gateway/src/memory/migrations.ts` 中，`MIGRATIONS` 数组第一个模板字符串结束的 `` `, `` 之后、`];` 之前，追加第 2 个元素（内容与总览 C1 逐字一致）：

```ts
  `
  -- v7: admin console and observability (spec 2026-10-27-admin-console-design.md). Additive only.
  -- One row per model call. Owner rows cascade; agent/session ids are plain text so usage survives memory clears.
  CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    owner_id TEXT REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT,
    session_id TEXT,
    character_id TEXT,
    kind TEXT NOT NULL,
    adapter TEXT NOT NULL,
    model TEXT NOT NULL,
    input_text_tokens INTEGER,
    input_audio_tokens INTEGER,
    output_text_tokens INTEGER,
    output_audio_tokens INTEGER,
    cached_tokens INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    first_audio_ms INTEGER,
    gen_ms INTEGER,
    error_code TEXT,
    estimated INTEGER NOT NULL DEFAULT 0,
    price_id TEXT,
    cost_micro_yuan INTEGER
  );
  CREATE INDEX usage_events_owner_ts ON usage_events (owner_id, ts);
  CREATE INDEX usage_events_ts ON usage_events (ts);
  CREATE INDEX usage_events_session ON usage_events (session_id);
  -- Admin-added prices. Baseline prices live in gateway/config/pricing.json. Units: micro-yuan per million tokens.
  CREATE TABLE price_entries (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    effective_from INTEGER NOT NULL,
    input_text INTEGER NOT NULL,
    input_audio INTEGER,
    output_text INTEGER NOT NULL,
    output_audio INTEGER,
    cached INTEGER,
    source TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    actor TEXT NOT NULL
  );
  -- info+ log lines for the admin trace page. oid is ownerShortId(owner id), never the raw id.
  CREATE TABLE log_events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    event TEXT NOT NULL,
    sid TEXT,
    oid TEXT,
    char TEXT,
    seq INTEGER,
    job TEXT,
    fields TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX log_events_sid ON log_events (sid, ts);
  CREATE INDEX log_events_oid ON log_events (oid, ts);
  CREATE INDEX log_events_ts ON log_events (ts);
  CREATE TABLE config_versions (
    id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    base_version INTEGER,
    overlay TEXT NOT NULL,
    note TEXT,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('publish', 'rollback', 'reset'))
  );
  CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL,
    tag BLOB NOT NULL,
    last4 TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    actor TEXT NOT NULL
  );
  CREATE TABLE admin_audit (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX admin_audit_ts ON admin_audit (ts);
  ALTER TABLE sessions ADD COLUMN end_reason TEXT;
  ALTER TABLE sessions ADD COLUMN adapter TEXT;
  ALTER TABLE owners ADD COLUMN banned_at INTEGER;
  `,
```

同时把文件头 `MIGRATIONS` 的注释改成：

```ts
/**
 * Ordered schema steps. Step i brings PRAGMA user_version to BASELINE_VERSION + i.
 * Append only: never edit a shipped step. Step 0 is the multi-character baseline (spec 技术设计 §4);
 * step 1 (v7) adds the admin console and observability tables (admin-console spec, additive only).
 */
```

- [ ] **Step 4: 运行新测试，确认通过**

Run: `npm test -w gateway -- test/schema-v7.test.ts`
Expected: PASS，6 个用例全过。

- [ ] **Step 5: 更新现有迁移测试的版本断言**

`gateway/test/memory-store.test.ts` 有三处写死了 v6 或「只有一步」，改为：

1. `creates an owner-only WAL database at the multi-character baseline`（约第 54 行）：

```ts
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: LATEST });
```

2. `builds the v6 baseline with per-agent tables and no legacy columns`（约第 89–93 行）：用例名改为 `builds the v6 baseline tables (later steps only add)`，并把

```ts
    expect(MIGRATIONS).toHaveLength(1);
```

改为

```ts
    expect(MIGRATIONS).toHaveLength(2);
```

同一用例里 `columns('owners')` 的精确断言补上 v7 新增的 `banned_at`：

```ts
    expect(columns('owners')).toEqual(['id', 'created_at', 'last_seen_at', 'memory_consent', 'notified_at', 'memory_epoch', 'banned_at']);
```

3. `applies steps appended after the baseline in order and is idempotent`（约第 117–123 行）：探针步骤现在是第 3 步，版本是 8：

```ts
    expect(migrate(db, steps)).toBe(8);
    expect(migrate(db, steps)).toBe(8);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
```

- [ ] **Step 6: 更新召回探针的版本检查**

`docs/testing/plan3-multilingual-recall-probe.mjs`：

- 第 17 行注释里的 `It requires the multi-character baseline (user_version 6)` 改为 `It requires the multi-character baseline (user_version 6) or its additive v7 upgrade`。
- 第 420 行：

```js
    // The multi-character baseline and its additive v7 upgrade only; older schemas are not migrated.
    if (version !== 6 && version !== 7) return notRun('db_schema_incompatible');
```

（P3-T10 用这个探针读真实库；不改的话 v7 库会被判 `db_schema_incompatible`。）

- [ ] **Step 7: 全量回归**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部通过，typecheck 无输出。如果还有其他测试断言 `user_version` 为 6，按第 5 步同样的方式改成 `LATEST` 或 7，并在提交说明里列出。

- [ ] **Step 8: 用备份库验证真实升级（只在执行机器上有 v6 库时做）**

```bash
cp "$MEMORY_DB_PATH" "$MEMORY_DB_PATH.bak-v6"
cd gateway && npx tsx -e "
import { openDatabase } from './src/memory/db.ts';
const db = openDatabase(process.env.MEMORY_DB_PATH + '.bak-v6', { busyTimeoutMs: 1000 });
console.log(JSON.stringify(db.prepare('PRAGMA user_version').get()), (db.prepare('SELECT count(*) AS n FROM owners').get() as { n: number }).n);
db.close();"; cd ..
```

Expected：输出 `{"user_version":7}` 和与升级前相同的 owner 数。只对 `.bak-v6` 副本操作，不碰正式库。没有 v6 库时跳过并在报告里写明「跳过：执行机器无 v6 库」。

- [ ] **Step 9: 提交**

```bash
git add gateway/src/memory/migrations.ts gateway/test/schema-v7.test.ts gateway/test/memory-store.test.ts docs/testing/plan3-multilingual-recall-probe.mjs
git commit -m "feat(memory): add schema v7 for the admin console

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
