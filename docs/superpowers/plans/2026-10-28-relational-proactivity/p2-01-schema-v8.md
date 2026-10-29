# P2-T1：迁移 v8 与引用删除

**Spec：** 「事项线」「情绪轨迹」「反思」「隐私、数据与删除」、Q10、Q19、Q24。

**设计取舍（编写计划时定，已记入 spec 修订记录）：**
- 事项线不新建表，而是在 `followups` 上加列。现有抽取、care、语音「忘掉」、清空角色、删 owner 的路径都已经覆盖 `followups`，演进比替换风险小。**有 `quote` 且 `done_at IS NULL` 的行就是事项线**；没有 `quote` 的行仍是普通跟进（模型摘要），不参与主动回访。
- 「删原话 → 删依据它的事项与反思」用消息表上的触发器实现：消息被删除、或被屏蔽（`excluded` 由 0 变 1，语音「忘掉」就是这样）时，删除 `followups.source_message_ids` 或 `reflections.evidence_message_ids` 引用它的行。这样设置页删除、语音忘掉、保留期过期、清空角色几条路径一次覆盖。
- 清空某角色记忆时清掉反思、情绪摘要、接受率、每日计数、最近兜底句；**保留主动档位**（`proactive_prefs`，属于用户设置，与 `memory_consent` 同类）。删 owner 时全部级联。

**Files:**
- Modify: `gateway/src/memory/migrations.ts`（追加第 3 步，v8）
- Modify: `gateway/src/memory/store.ts`（`ForgetResult.reflections`；`clearAgentMemory`、`forgetMatches` 覆盖新表）
- Modify: `gateway/test/schema-v7.test.ts`、`gateway/test/memory-store.test.ts`、`gateway/test/memory-isolation.test.ts`（版本与 `ForgetResult` 断言）
- Modify: `docs/testing/plan3-multilingual-recall-probe.mjs`（`--real-db` 接受的版本）
- Create: `gateway/test/schema-v8.test.ts`

**Interfaces:**
- Consumes: 现有 `migrate`、`MIGRATIONS`、`BASELINE_VERSION`、`SqliteMemoryStore`、`seedOwner`（`test/helpers/memory.ts`）。
- Produces: `user_version = 8`；表与列见下；`ForgetResult` 增加 `reflections: number`。后续任务按这里的列名写 SQL。

- [ ] **Step 1：写失败测试**

创建 `gateway/test/schema-v8.test.ts`：

```ts
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_VERSION, MIGRATIONS, migrate } from '../src/memory/migrations.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { agentOf, seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

function rawDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys = ON');
  dbs.push(db);
  return db;
}
function storeDb(): { db: DatabaseSync; store: SqliteMemoryStore } {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  return { db, store: new SqliteMemoryStore(db) };
}

const columns = (db: DatabaseSync, table: string): string[] =>
  db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => (row as { name: string }).name);
const names = (db: DatabaseSync, type: 'table' | 'index' | 'trigger'): string[] =>
  db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type).map((row) => (row as { name: string }).name);
const count = (db: DatabaseSync, sql: string, ...args: (string | number)[]): number => (db.prepare(sql).get(...args) as { n: number }).n;

function message(db: DatabaseSync, w: { ownerId: string; agentId: string }, id: string, text: string, session = 's1'): void {
  db.prepare(`INSERT INTO messages (id, session_id, owner_id, agent_id, role, text, bigrams, created_at)
    VALUES (?, ?, ?, ?, 'user', ?, '', 1)`).run(id, session, w.ownerId, w.agentId, text);
}
function thread(db: DatabaseSync, w: { ownerId: string; agentId: string }, id: string, quote: string | null, sources: string[]): void {
  db.prepare(`INSERT INTO followups (id, owner_id, agent_id, text, due_at, source_session_id, quote, sensitive, created_at, source_message_ids)
    VALUES (?, ?, ?, 'summary', 9, 's1', ?, 1, 1, ?)`).run(id, w.ownerId, w.agentId, quote, JSON.stringify(sources));
}
function reflection(db: DatabaseSync, w: { ownerId: string; agentId: string }, id: string, text: string, evidence: string[]): void {
  db.prepare(`INSERT INTO reflections (id, owner_id, agent_id, text, evidence_message_ids, session_id, created_at)
    VALUES (?, ?, ?, ?, ?, 's1', 1)`).run(id, w.ownerId, w.agentId, text, JSON.stringify(evidence));
}

describe('schema v8', () => {
  it('is the latest version', () => {
    expect(BASELINE_VERSION + MIGRATIONS.length - 1).toBe(8);
    expect(migrate(rawDb())).toBe(8);
  });

  it('turns followups into threads and adds the proactivity tables and citation triggers', () => {
    const db = rawDb();
    migrate(db);
    expect(columns(db, 'followups')).toEqual([
      'id', 'owner_id', 'agent_id', 'text', 'due_at', 'done_at', 'source_session_id', 'quote', 'sensitive', 'created_at',
      'kind', 'source_message_ids', 'mention_count', 'last_mentioned_at', 'close_reason',
    ]);
    expect(columns(db, 'reflections')).toEqual(['id', 'owner_id', 'agent_id', 'text', 'evidence_message_ids', 'session_id', 'created_at']);
    expect(columns(db, 'mood_summaries')).toEqual([
      'id', 'owner_id', 'agent_id', 'session_id', 'dominant', 'peak_intensity', 'end_emotion', 'end_intensity', 'end_trend', 'crisis', 'created_at',
    ]);
    expect(columns(db, 'proactive_prefs')).toEqual(['owner_id', 'agent_id', 'tier', 'updated_at']);
    expect(columns(db, 'proactive_stats')).toEqual(['owner_id', 'agent_id', 'kind', 'accepted', 'rejected', 'updated_at']);
    expect(columns(db, 'proactive_daily')).toEqual(['owner_id', 'agent_id', 'day', 'count']);
    expect(columns(db, 'proactive_fallbacks')).toEqual(['owner_id', 'agent_id', 'fallback_key', 'line', 'used_at']);
    expect(names(db, 'index')).toEqual(expect.arrayContaining(['reflections_agent', 'mood_summaries_agent']));
    expect(names(db, 'trigger')).toEqual(expect.arrayContaining(['messages_cite_ad', 'messages_cite_au']));
  });

  it('upgrades a v7 database, defaults kind to concern and links quotes to their user line', () => {
    const db = rawDb();
    expect(migrate(db, MIGRATIONS.slice(0, 2))).toBe(7);
    db.prepare('INSERT INTO owners (id, created_at, last_seen_at) VALUES (?, 1, 1)').run('o7');
    db.prepare('INSERT INTO agents (id, owner_id, character_id, created_at) VALUES (?, ?, ?, 1)').run('a7', 'o7', 'xiaonuan');
    db.prepare("INSERT INTO messages (id, session_id, owner_id, agent_id, role, text, bigrams, created_at) VALUES ('m1', 's7', 'o7', 'a7', 'user', '我明天要去医院复查腰，有点担心。', '', 1)").run();
    db.prepare("INSERT INTO messages (id, session_id, owner_id, agent_id, role, text, bigrams, created_at) VALUES ('m2', 's7', 'o7', 'a7', 'assistant', '我明天要去医院复查腰', '', 2)").run();
    db.prepare(`INSERT INTO followups (id, owner_id, agent_id, text, due_at, source_session_id, quote, sensitive, created_at)
      VALUES ('f1', 'o7', 'a7', '问问复查', 9, 's7', '我明天要去医院复查腰', 1, 3), ('f2', 'o7', 'a7', '接着聊', 9, 's7', NULL, 0, 3)`).run();
    expect(migrate(db)).toBe(8);
    const rows = db.prepare('SELECT id, kind, source_message_ids AS src, mention_count AS mentions FROM followups ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'f1', kind: 'concern', src: '["m1"]', mentions: 0 },
      { id: 'f2', kind: 'concern', src: '[]', mentions: 0 },
    ]);
  });

  it('drops threads and reflections whose cited user line is deleted or blanked', () => {
    const { db, store } = storeDb();
    const w = seedOwner(store, 'h1');
    message(db, w, 'm1', '我明天要去医院复查腰');
    message(db, w, 'm2', '最近总是一个人吃午饭');
    message(db, w, 'm3', '今天天气不错');
    thread(db, w, 't1', '我明天要去医院复查腰', ['m1']);
    thread(db, w, 't2', '最近总是一个人吃午饭', ['m2']);
    thread(db, w, 't3', null, []);
    reflection(db, w, 'r1', '常一个人吃饭', ['m2', 'm3']);
    reflection(db, w, 'r2', '腰不好', ['m1']);
    store.deleteMessagesByIds(w.ownerId, w.agentId, ['m1']);
    expect(db.prepare('SELECT id FROM followups ORDER BY id').all()).toEqual([{ id: 't2' }, { id: 't3' }]);
    expect(db.prepare('SELECT id FROM reflections ORDER BY id').all()).toEqual([{ id: 'r1' }]);
    // Voice forget blanks the line (excluded 0 -> 1) instead of deleting it.
    db.prepare("UPDATE messages SET text = '', bigrams = '', excluded = 1 WHERE id = 'm3'").run();
    expect(db.prepare('SELECT id FROM reflections').all()).toEqual([]);
    expect(db.prepare('SELECT id FROM followups ORDER BY id').all()).toEqual([{ id: 't2' }, { id: 't3' }]);
  });

  it('clears one character’s derived memory but keeps its proactive tier and other characters', () => {
    const { db, store } = storeDb();
    const a = seedOwner(store, 'h1');
    const b = agentOf(store, a.ownerId, 'xiaokai');
    for (const w of [a, b]) {
      reflection(db, w, `r-${w.agentId}`, '常一个人吃饭', []);
      db.prepare(`INSERT INTO mood_summaries (id, owner_id, agent_id, session_id, dominant, peak_intensity, end_emotion, end_intensity, end_trend, crisis, created_at)
        VALUES (?, ?, ?, 's1', 'sad', 2, 'sad', 2, 'flat', 0, 1)`).run(`m-${w.agentId}`, w.ownerId, w.agentId);
      db.prepare("INSERT INTO proactive_prefs (owner_id, agent_id, tier, updated_at) VALUES (?, ?, 'quiet', 1)").run(w.ownerId, w.agentId);
      db.prepare("INSERT INTO proactive_stats (owner_id, agent_id, kind, accepted, rejected, updated_at) VALUES (?, ?, 'routine', 1, 0, 1)").run(w.ownerId, w.agentId);
      db.prepare("INSERT INTO proactive_daily (owner_id, agent_id, day, count) VALUES (?, ?, '2026-11-02', 2)").run(w.ownerId, w.agentId);
      db.prepare("INSERT INTO proactive_fallbacks (owner_id, agent_id, fallback_key, line, used_at) VALUES (?, ?, 'checkin', 0, 1)").run(w.ownerId, w.agentId);
    }
    store.clearAgentMemory(a.ownerId, a.agentId);
    for (const table of ['reflections', 'mood_summaries', 'proactive_stats', 'proactive_daily', 'proactive_fallbacks']) {
      expect(count(db, `SELECT count(*) AS n FROM ${table} WHERE agent_id = ?`, a.agentId), table).toBe(0);
      expect(count(db, `SELECT count(*) AS n FROM ${table} WHERE agent_id = ?`, b.agentId), table).toBe(1);
    }
    expect(count(db, 'SELECT count(*) AS n FROM proactive_prefs WHERE agent_id = ?', a.agentId)).toBe(1);
    // Deleting the owner cascades to every new table.
    store.deleteOwner(a.ownerId);
    for (const table of ['reflections', 'mood_summaries', 'proactive_prefs', 'proactive_stats', 'proactive_daily', 'proactive_fallbacks']) {
      expect(count(db, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }
  });

  it('voice forget deletes this agent’s matching reflections only', () => {
    const { db, store } = storeDb();
    const a = seedOwner(store, 'h1');
    const b = agentOf(store, a.ownerId, 'xiaokai');
    reflection(db, a, 'ra', '每周三女儿会来', []);
    reflection(db, b, 'rb', '每周三女儿会来', []);
    const result = store.forgetMatches(a.ownerId, a.agentId, '女儿', null, 's-now');
    expect(result.reflections).toBe(1);
    expect(db.prepare('SELECT id FROM reflections').all()).toEqual([{ id: 'rb' }]);
  });
});
```

- [ ] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/schema-v8.test.ts`
Expected: FAIL——最新版本仍是 7，新表不存在。

- [ ] **Step 3：追加迁移 v8**

`gateway/src/memory/migrations.ts`：文件头注释里补一句 `step 2 (v8) evolves followups into threads and adds the relational proactivity tables (spec 2026-10-28).`，并在 `MIGRATIONS` 数组末尾（v7 那段字符串之后）追加：

```ts
  `
  -- v8: relational proactivity (spec 2026-10-28-relational-proactivity-design.md). Additive only.
  -- A followup with a quote and no done_at is a thread (event / concern / plan).
  ALTER TABLE followups ADD COLUMN kind TEXT NOT NULL DEFAULT 'concern' CHECK (kind IN ('event', 'concern', 'plan'));
  ALTER TABLE followups ADD COLUMN source_message_ids TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE followups ADD COLUMN mention_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE followups ADD COLUMN last_mentioned_at INTEGER;
  ALTER TABLE followups ADD COLUMN close_reason TEXT;
  -- Best effort: link each existing quote to the user line it was copied from.
  UPDATE followups SET source_message_ids = COALESCE((
    SELECT json_group_array(m.id) FROM messages m
    WHERE m.owner_id = followups.owner_id AND m.agent_id = followups.agent_id
      AND m.session_id = followups.source_session_id AND m.role = 'user' AND m.excluded = 0
      AND instr(m.text, followups.quote) > 0
  ), '[]') WHERE quote IS NOT NULL;
  -- Decision-layer inferences; never spoken, never in prompts (pitfall #4).
  CREATE TABLE reflections (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    evidence_message_ids TEXT NOT NULL,
    session_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX reflections_agent ON reflections (agent_id, created_at);
  -- One row per session with affect cards; labels only.
  CREATE TABLE mood_summaries (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    dominant TEXT NOT NULL CHECK (dominant IN ('neutral', 'happy', 'sad', 'love')),
    peak_intensity INTEGER NOT NULL CHECK (peak_intensity BETWEEN 1 AND 3),
    end_emotion TEXT NOT NULL CHECK (end_emotion IN ('neutral', 'happy', 'sad', 'love')),
    end_intensity INTEGER NOT NULL CHECK (end_intensity BETWEEN 1 AND 3),
    end_trend TEXT NOT NULL CHECK (end_trend IN ('better', 'worse', 'flat')),
    crisis INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX mood_summaries_agent ON mood_summaries (agent_id, created_at);
  CREATE TABLE proactive_prefs (
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    tier TEXT NOT NULL CHECK (tier IN ('quiet', 'moderate', 'active')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, agent_id)
  ) STRICT;
  CREATE TABLE proactive_stats (
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, agent_id, kind)
  ) STRICT;
  CREATE TABLE proactive_daily (
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, agent_id, day)
  ) STRICT;
  CREATE TABLE proactive_fallbacks (
    owner_id TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    fallback_key TEXT NOT NULL,
    line INTEGER NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, agent_id, fallback_key, line)
  ) STRICT;
  -- Deleting or blanking a user line drops the threads and reflections that cite it (spec Q24).
  CREATE TRIGGER messages_cite_ad AFTER DELETE ON messages BEGIN
    DELETE FROM followups WHERE owner_id = old.owner_id
      AND EXISTS (SELECT 1 FROM json_each(followups.source_message_ids) WHERE value = old.id);
    DELETE FROM reflections WHERE owner_id = old.owner_id
      AND EXISTS (SELECT 1 FROM json_each(reflections.evidence_message_ids) WHERE value = old.id);
  END;
  CREATE TRIGGER messages_cite_au AFTER UPDATE OF excluded ON messages WHEN new.excluded = 1 AND old.excluded = 0 BEGIN
    DELETE FROM followups WHERE owner_id = new.owner_id
      AND EXISTS (SELECT 1 FROM json_each(followups.source_message_ids) WHERE value = new.id);
    DELETE FROM reflections WHERE owner_id = new.owner_id
      AND EXISTS (SELECT 1 FROM json_each(reflections.evidence_message_ids) WHERE value = new.id);
  END;
  `,
```

- [ ] **Step 4：store 覆盖新表**

`gateway/src/memory/store.ts`：

1. `ForgetResult` 在 `profile` 之后加：

```ts
  /** This agent's reflections whose text contains the query. */
  reflections: number;
```

2. `prepareStatements` 里 `deleteAllFollowups` 那一行后面加：

```ts
    deleteAllReflections: p('DELETE FROM reflections WHERE owner_id = ? AND agent_id = ?'),
    deleteAllMoods: p('DELETE FROM mood_summaries WHERE owner_id = ? AND agent_id = ?'),
    deleteAllProactiveStats: p('DELETE FROM proactive_stats WHERE owner_id = ? AND agent_id = ?'),
    deleteAllProactiveDaily: p('DELETE FROM proactive_daily WHERE owner_id = ? AND agent_id = ?'),
    deleteAllProactiveFallbacks: p('DELETE FROM proactive_fallbacks WHERE owner_id = ? AND agent_id = ?'),
    deleteReflectionsInstr: p('DELETE FROM reflections WHERE owner_id = ? AND agent_id = ? AND instr(text, ?) > 0'),
```

3. `clearAgentMemory` 中 `this.q.deleteAllFollowups.run(ownerId, agentId);` 后面加（`proactive_prefs` 不清，见本任务开头的取舍）：

```ts
      this.q.deleteAllReflections.run(ownerId, agentId);
      this.q.deleteAllMoods.run(ownerId, agentId);
      this.q.deleteAllProactiveStats.run(ownerId, agentId);
      this.q.deleteAllProactiveDaily.run(ownerId, agentId);
      this.q.deleteAllProactiveFallbacks.run(ownerId, agentId);
```

4. `forgetMatches` 中 `const followups = ...` 后面加 `const reflections = Number(this.q.deleteReflectionsInstr.run(ownerId, agentId, query).changes);`，返回值改为 `{ messages, facts, notes, episodes, followups, pinned, profile, reflections }`。接口注释 `Voice forget: this agent's facts, pins, notes, episodes and followups` 改为 `... episodes, followups and reflections`。

- [ ] **Step 5：同步旧断言与召回探针**

- `gateway/test/schema-v7.test.ts`：
  - 删除 `it('is the latest version', ...)` 整个用例（v8 测试接管）。
  - 第 30 行 `expect(migrate(db)).toBe(7);` 改为 `expect(migrate(db, MIGRATIONS.slice(0, 2))).toBe(7);`（只验证 v7 的表与列）。
  - `upgrades a v6 database in place and keeps its rows` 用例：它在迁移后 `new SqliteMemoryStore(db)`，而 store 会预编译 v8 的语句，所以这里迁移到最新：第 62 行附近的 `expect(migrate(db)).toBe(7);` 改为 `expect(migrate(db)).toBe(8);`，下一行的 `{ user_version: 7 }` 改为 `{ user_version: 8 }`。
- `gateway/test/memory-store.test.ts`：
  - 第 93 行 `expect(MIGRATIONS).toHaveLength(2);` 改为 `toHaveLength(3)`。
  - 第 120–123 行（追加一步的用例）：`toBe(8)` 两处与 `{ user_version: 8 }` 改为 `LATEST + 1`（该文件已有 `LATEST` 常量）。
- `gateway/test/memory-store.test.ts` 第 688 行与 `gateway/test/memory-isolation.test.ts` 第 112 行的 `toEqual({... profile: N })` 末尾加 `, reflections: 0`。
- `docs/testing/plan3-multilingual-recall-probe.mjs` 第 416 行附近：

```js
    // The store prepares v8 statements: the real DB must be migrated to v8 first (P2-T9 migrates a copy).
    if (version !== 8) return notRun('db_schema_incompatible');
```

  并把文件头第 17 行注释里的 `(user_version 6) or its additive v7 upgrade` 改为 `migrated to user_version 8`。

- [ ] **Step 6：运行测试**

Run: `npm test -w gateway -- test/schema-v8.test.ts test/schema-v7.test.ts test/memory-store.test.ts test/memory-isolation.test.ts`
Expected: PASS。

- [ ] **Step 7：全量与 typecheck**

Run: `npm test -w gateway && npm run typecheck -w gateway && node --import tsx docs/testing/plan3-multilingual-recall-probe.mjs --temp`
Expected：全部通过（`--temp` 用临时库，走完整迁移，不受版本判断影响）。

- [ ] **Step 8：提交**

```bash
git add gateway/src/memory/migrations.ts gateway/src/memory/store.ts gateway/test/schema-v8.test.ts gateway/test/schema-v7.test.ts \
  gateway/test/memory-store.test.ts gateway/test/memory-isolation.test.ts docs/testing/plan3-multilingual-recall-probe.mjs
git commit -m "feat(memory): schema v8 with threads, proactivity tables and citation deletes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
