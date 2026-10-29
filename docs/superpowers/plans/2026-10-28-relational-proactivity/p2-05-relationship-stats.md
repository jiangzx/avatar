# P2-T5：关系画像（从会话记录推导）

**Spec：** 「关系画像」（已改为从 `sessions` 即时推导，不另建表）、Q9、Q19。

P3 的熟悉度档位与作息问候要用：首次见面时间、已结束会话数、累计分钟、活跃天数（北京日期）、上次会话时间、24 小时作息直方图（按会话开始时间，北京时间）。只统计**已结束**的会话；正在进行的不算。清空角色记忆会删掉该角色的会话记录，画像随之归零。

**Files:**
- Modify: `gateway/src/memory/store.ts`
- Test: `gateway/test/relationship-stats.test.ts`

**Interfaces:**
- Consumes: 现有 `sessions` 表、`recordSessionStart` / `recordSessionEnd`。
- Produces（冻结）：`RelationshipStats`、`relationshipStats(ownerId, agentId)`、`relationshipStatsOf(rows)`（纯函数，导出供 P3 测试复用）。

- [ ] **Step 1：写失败测试**

创建 `gateway/test/relationship-stats.test.ts`：

```ts
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore, relationshipStatsOf } from '../src/memory/store.ts';
import { agentOf, seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });
const at = (iso: string) => Date.parse(iso);

describe('relationshipStatsOf', () => {
  it('is empty with no sessions', () => {
    expect(relationshipStatsOf([])).toEqual({
      firstMetAt: null, sessions: 0, totalMinutes: 0, activeDays: 0, lastSessionAt: null, hourHistogram: Array(24).fill(0),
    });
  });
});

describe('relationshipStats', () => {
  it('counts this agent’s ended sessions in Asia/Shanghai time', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(db);
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1');
    const b = agentOf(store, a.ownerId, 'xiaokai');
    const session = (id: string, agentId: string, start: string, end: string | null) => {
      store.recordSessionStart(id, agentId, at(start));
      if (end) store.recordSessionEnd(id, agentId, at(end));
    };
    session('s1', a.agentId, '2026-11-02T09:10:00+08:00', '2026-11-02T09:40:00+08:00');
    session('s2', a.agentId, '2026-11-02T20:00:00+08:00', '2026-11-02T20:30:00+08:00');
    // 00:05 Beijing is still the previous UTC day: the day and hour must use Beijing time.
    session('s3', a.agentId, '2026-11-04T00:05:00+08:00', '2026-11-04T00:20:00+08:00');
    session('open', a.agentId, '2026-11-05T10:00:00+08:00', null);
    session('other', b.agentId, '2026-11-01T10:00:00+08:00', '2026-11-01T11:00:00+08:00');
    const stats = store.relationshipStats(a.ownerId, a.agentId);
    const hours = Array(24).fill(0);
    hours[9] = 1; hours[20] = 1; hours[0] = 1;
    expect(stats).toEqual({
      firstMetAt: at('2026-11-02T09:10:00+08:00'),
      sessions: 3,
      totalMinutes: 75,
      activeDays: 2,
      lastSessionAt: at('2026-11-04T00:05:00+08:00'),
      hourHistogram: hours,
    });
    // A foreign owner sees nothing.
    const other = seedOwner(store, 'h2');
    expect(store.relationshipStats(other.ownerId, a.agentId).sessions).toBe(0);
  });
});
```

- [ ] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/relationship-stats.test.ts`
Expected: FAIL——函数不存在。

- [ ] **Step 3：实现**

`gateway/src/memory/store.ts`：

在 `MoodSummaryRecord` 下面加：

```ts
/** Derived from ended sessions (spec 关系画像); nothing is stored. Day and hour use Asia/Shanghai. */
export interface RelationshipStats {
  firstMetAt: number | null;
  sessions: number;
  totalMinutes: number;
  activeDays: number;
  lastSessionAt: number | null;
  /** 24 buckets of session starts by Beijing hour. */
  hourHistogram: number[];
}

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** Pure fold over ended sessions sorted by start. */
export function relationshipStatsOf(rows: ReadonlyArray<{ startedAt: number; endedAt: number }>): RelationshipStats {
  const hourHistogram = Array.from({ length: 24 }, () => 0);
  const days = new Set<string>();
  let ms = 0;
  for (const row of rows) {
    const local = new Date(row.startedAt + SHANGHAI_OFFSET_MS);
    const hour = local.getUTCHours();
    hourHistogram[hour] = (hourHistogram[hour] ?? 0) + 1;
    days.add(local.toISOString().slice(0, 10));
    ms += Math.max(0, row.endedAt - row.startedAt);
  }
  return {
    firstMetAt: rows[0]?.startedAt ?? null,
    sessions: rows.length,
    totalMinutes: Math.round(ms / 60_000),
    activeDays: days.size,
    lastSessionAt: rows.at(-1)?.startedAt ?? null,
    hourHistogram,
  };
}
```

`MemoryStore` 接口加：

```ts
  /** Familiarity inputs from this agent's ended sessions. */
  relationshipStats(ownerId: string, agentId: string): RelationshipStats;
```

`prepareStatements` 加：

```ts
    relationshipSessions: p(`SELECT s.started_at, s.ended_at FROM sessions s JOIN agents a ON a.id = s.agent_id
      WHERE a.owner_id = ? AND s.agent_id = ? AND s.ended_at IS NOT NULL ORDER BY s.started_at, s.id`),
```

`SqliteMemoryStore` 加：

```ts
  relationshipStats(ownerId: string, agentId: string): RelationshipStats {
    return relationshipStatsOf(this.q.relationshipSessions.all(ownerId, agentId).map((r) => ({
      startedAt: r.started_at as number,
      endedAt: r.ended_at as number,
    })));
  }
```

- [ ] **Step 4：运行测试与 typecheck**

Run: `npm test -w gateway -- test/relationship-stats.test.ts && npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add gateway/src/memory/store.ts gateway/test/relationship-stats.test.ts
git commit -m "feat(memory): derive relationship stats from ended sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
