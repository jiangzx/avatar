# P2-T7：主动档位、接受率与计数

**Spec：** 「三档主动程度」（偏好跨会话保存）、Q25（按角色 × 意图计接受/拒绝）、疲劳系数（今日已主动次数）、兜底句不重复（按 `(owner, agent)` 记住最近用过的句子）、Q19。

本任务只提供存取，P3 决策引擎使用。都不含对话内容：档位是枚举，意图类型是配置里的键名，句子用句组里的下标。

- 每日计数的 `day` 由调用方传入北京日期字符串 `YYYY-MM-DD`（P3 用会话时钟换算），store 不自己取时间。
- `recordFallbackLine` 只保留每个 `(owner, agent, key)` 最近 `keep` 条。

**Files:**
- Modify: `gateway/src/memory/store.ts`
- Test: `gateway/test/proactive-store.test.ts`

**Interfaces:**
- Consumes: P2-T1 `proactive_prefs`、`proactive_stats`、`proactive_daily`、`proactive_fallbacks`。
- Produces（冻结）：`ProactiveTier`、`getProactiveTier`、`setProactiveTier`、`recordProactiveOutcome`、`proactiveStats`、`incrementProactiveDaily`、`proactiveDaily`、`recentFallbackLines`、`recordFallbackLine`。

- [ ] **Step 1：写失败测试**

创建 `gateway/test/proactive-store.test.ts`：

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
  return { store, a, b };
}

describe('proactive store', () => {
  it('keeps one tier per character', () => {
    const { store, a, b } = setup();
    expect(store.getProactiveTier(a.ownerId, a.agentId)).toBeUndefined();
    store.setProactiveTier(a.ownerId, a.agentId, 'quiet', 1);
    store.setProactiveTier(a.ownerId, a.agentId, 'active', 2);
    expect(store.getProactiveTier(a.ownerId, a.agentId)).toBe('active');
    expect(store.getProactiveTier(a.ownerId, b.agentId)).toBeUndefined();
  });

  it('counts outcomes per intent kind', () => {
    const { store, a, b } = setup();
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'routine', 'accepted', 1);
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'routine', 'rejected', 2);
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'routine', 'accepted', 3);
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'thread_followup', 'rejected', 4);
    store.recordProactiveOutcome(a.ownerId, b.agentId, 'routine', 'accepted', 5);
    expect(store.proactiveStats(a.ownerId, a.agentId)).toEqual([
      { kind: 'routine', accepted: 2, rejected: 1 },
      { kind: 'thread_followup', accepted: 0, rejected: 1 },
    ]);
  });

  it('counts proactive lines per day', () => {
    const { store, a } = setup();
    expect(store.proactiveDaily(a.ownerId, a.agentId, '2026-11-02')).toBe(0);
    expect(store.incrementProactiveDaily(a.ownerId, a.agentId, '2026-11-02')).toBe(1);
    expect(store.incrementProactiveDaily(a.ownerId, a.agentId, '2026-11-02')).toBe(2);
    expect(store.incrementProactiveDaily(a.ownerId, a.agentId, '2026-11-03')).toBe(1);
    expect(store.proactiveDaily(a.ownerId, a.agentId, '2026-11-02')).toBe(2);
  });

  it('remembers the most recent fallback lines per key, newest first, up to keep', () => {
    const { store, a } = setup();
    store.recordFallbackLine(a.ownerId, a.agentId, 'checkin', 2, 10, 3);
    store.recordFallbackLine(a.ownerId, a.agentId, 'checkin', 0, 20, 3);
    store.recordFallbackLine(a.ownerId, a.agentId, 'checkin', 4, 30, 3);
    store.recordFallbackLine(a.ownerId, a.agentId, 'checkin', 1, 40, 3);
    store.recordFallbackLine(a.ownerId, a.agentId, 'checkin', 0, 50, 3); // reused: moves to the front
    store.recordFallbackLine(a.ownerId, a.agentId, 'rest', 3, 60, 3);
    expect(store.recentFallbackLines(a.ownerId, a.agentId, 'checkin', 10)).toEqual([0, 1, 4]);
    expect(store.recentFallbackLines(a.ownerId, a.agentId, 'checkin', 2)).toEqual([0, 1]);
    expect(store.recentFallbackLines(a.ownerId, a.agentId, 'rest', 10)).toEqual([3]);
  });

  it('ignores a foreign owner', () => {
    const { store, a } = setup();
    const other = seedOwner(store, 'h2');
    store.setProactiveTier(other.ownerId, a.agentId, 'quiet', 1);
    store.recordProactiveOutcome(other.ownerId, a.agentId, 'routine', 'accepted', 1);
    expect(store.incrementProactiveDaily(other.ownerId, a.agentId, '2026-11-02')).toBe(0);
    store.recordFallbackLine(other.ownerId, a.agentId, 'checkin', 1, 1, 3);
    expect(store.getProactiveTier(a.ownerId, a.agentId)).toBeUndefined();
    expect(store.proactiveStats(a.ownerId, a.agentId)).toEqual([]);
    expect(store.recentFallbackLines(a.ownerId, a.agentId, 'checkin', 10)).toEqual([]);
  });
});
```

- [ ] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/proactive-store.test.ts`
Expected: FAIL——方法不存在。

- [ ] **Step 3：实现**

`gateway/src/memory/store.ts`：

在 `ReflectionRecord` 后加：

```ts
export type ProactiveTier = 'quiet' | 'moderate' | 'active';
```

`MemoryStore` 接口加：

```ts
  /** Per-character proactivity tier the user chose by voice; undefined = the role default. */
  getProactiveTier(ownerId: string, agentId: string): ProactiveTier | undefined;
  setProactiveTier(ownerId: string, agentId: string, tier: ProactiveTier, now: number): void;
  /** Q25 counters per intent kind; content-free. */
  recordProactiveOutcome(ownerId: string, agentId: string, kind: string, outcome: 'accepted' | 'rejected', now: number): void;
  proactiveStats(ownerId: string, agentId: string): Array<{ kind: string; accepted: number; rejected: number }>;
  /** Proactive lines on one Beijing day (YYYY-MM-DD from the caller). Returns the new count; 0 when foreign. */
  incrementProactiveDaily(ownerId: string, agentId: string, day: string): number;
  proactiveDaily(ownerId: string, agentId: string, day: string): number;
  /** Indexes of recently used fallback lines for one key, newest first. */
  recentFallbackLines(ownerId: string, agentId: string, key: string, limit: number): number[];
  /** Records a used fallback line and keeps only the newest `keep` for that key. */
  recordFallbackLine(ownerId: string, agentId: string, key: string, line: number, now: number, keep: number): void;
```

`prepareStatements` 加（所有写入都用 `SELECT ... FROM agents WHERE id = ? AND owner_id = ?` 做同语句归属检查）：

```ts
    getTier: p('SELECT tier FROM proactive_prefs WHERE owner_id = ? AND agent_id = ?'),
    setTier: p(`INSERT INTO proactive_prefs (owner_id, agent_id, tier, updated_at)
      SELECT owner_id, id, ?, ? FROM agents WHERE id = ? AND owner_id = ?
      ON CONFLICT (owner_id, agent_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`),
    recordOutcome: p(`INSERT INTO proactive_stats (owner_id, agent_id, kind, accepted, rejected, updated_at)
      SELECT owner_id, id, ?, ?, ?, ? FROM agents WHERE id = ? AND owner_id = ?
      ON CONFLICT (owner_id, agent_id, kind) DO UPDATE SET
        accepted = accepted + excluded.accepted, rejected = rejected + excluded.rejected, updated_at = excluded.updated_at`),
    listStats: p('SELECT kind, accepted, rejected FROM proactive_stats WHERE owner_id = ? AND agent_id = ? ORDER BY kind'),
    bumpDaily: p(`INSERT INTO proactive_daily (owner_id, agent_id, day, count)
      SELECT owner_id, id, ?, 1 FROM agents WHERE id = ? AND owner_id = ?
      ON CONFLICT (owner_id, agent_id, day) DO UPDATE SET count = count + 1`),
    getDaily: p('SELECT count FROM proactive_daily WHERE owner_id = ? AND agent_id = ? AND day = ?'),
    recentFallbacks: p(`SELECT line FROM proactive_fallbacks WHERE owner_id = ? AND agent_id = ? AND fallback_key = ?
      ORDER BY used_at DESC, line LIMIT ?`),
    useFallback: p(`INSERT INTO proactive_fallbacks (owner_id, agent_id, fallback_key, line, used_at)
      SELECT owner_id, id, ?, ?, ? FROM agents WHERE id = ? AND owner_id = ?
      ON CONFLICT (owner_id, agent_id, fallback_key, line) DO UPDATE SET used_at = excluded.used_at`),
    trimFallbacks: p(`DELETE FROM proactive_fallbacks WHERE owner_id = ? AND agent_id = ? AND fallback_key = ?
      AND line NOT IN (SELECT line FROM proactive_fallbacks WHERE owner_id = ? AND agent_id = ? AND fallback_key = ?
        ORDER BY used_at DESC, line LIMIT ?)`),
```

`SqliteMemoryStore` 加：

```ts
  getProactiveTier(ownerId: string, agentId: string): ProactiveTier | undefined {
    const row = this.q.getTier.get(ownerId, agentId);
    return row ? (row.tier as ProactiveTier) : undefined;
  }

  setProactiveTier(ownerId: string, agentId: string, tier: ProactiveTier, now: number): void {
    this.q.setTier.run(tier, now, agentId, ownerId);
  }

  recordProactiveOutcome(ownerId: string, agentId: string, kind: string, outcome: 'accepted' | 'rejected', now: number): void {
    this.q.recordOutcome.run(kind, outcome === 'accepted' ? 1 : 0, outcome === 'rejected' ? 1 : 0, now, agentId, ownerId);
  }

  proactiveStats(ownerId: string, agentId: string): Array<{ kind: string; accepted: number; rejected: number }> {
    return this.q.listStats.all(ownerId, agentId).map((r) => ({ kind: r.kind as string, accepted: r.accepted as number, rejected: r.rejected as number }));
  }

  incrementProactiveDaily(ownerId: string, agentId: string, day: string): number {
    return this.tx<number>(() => {
      if (this.q.bumpDaily.run(day, agentId, ownerId).changes === 0) return 0;
      return this.proactiveDaily(ownerId, agentId, day);
    });
  }

  proactiveDaily(ownerId: string, agentId: string, day: string): number {
    return (this.q.getDaily.get(ownerId, agentId, day)?.count as number | undefined) ?? 0;
  }

  recentFallbackLines(ownerId: string, agentId: string, key: string, limit: number): number[] {
    return this.q.recentFallbacks.all(ownerId, agentId, key, limit).map((r) => r.line as number);
  }

  recordFallbackLine(ownerId: string, agentId: string, key: string, line: number, now: number, keep: number): void {
    this.tx(() => {
      if (this.q.useFallback.run(key, line, now, agentId, ownerId).changes === 0) return;
      this.q.trimFallbacks.run(ownerId, agentId, key, ownerId, agentId, key, keep);
    });
  }
```

- [ ] **Step 4：运行测试与 typecheck**

Run: `npm test -w gateway -- test/proactive-store.test.ts && npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add gateway/src/memory/store.ts gateway/test/proactive-store.test.ts
git commit -m "feat(memory): proactive tier, outcome counters, daily counts and fallback recency

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
