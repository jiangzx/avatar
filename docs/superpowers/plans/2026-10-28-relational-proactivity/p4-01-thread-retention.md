# P4-T1：事项按生命周期过期（替换 care 原话 7 天清空）

**Spec：** 「事项线」生命周期表（事件后 7 天过期、牵挂 14 天、计划 30 天；上限次数）、「隐私」（数据最小化）、Q10、Q24。

**问题（编写 P4 时发现）：** `gateway/src/index.ts` 的每日任务 `expireTranscripts` 末尾调用 `store.clearStaleCareQuotes(ownerId, now - affect.care.maxAgeDays * DAY)`，SQL 是 `UPDATE followups SET quote = NULL WHERE owner_id = ? AND quote IS NOT NULL AND created_at < ?`。P2 之后事项线就存在 `followups` 里，`listOpenThreads` 只列 `quote IS NOT NULL` 的行，所以**任何事项创建满 7 天（care 默认值）就会在当晚被清空原话、从此不会被回访**——牵挂（14 天内可提）、计划（3–7 天后才问，7 天边界上会丢）、提前一周以上说的事件都受影响。

**改法：** 每晚对每个 owner 的每个角色，关闭「再也不会被提起」的事项（`closeThread(…, 'expired')`，关闭即清空原话，审计行无内容）。判断与引擎 `threadUrgency` 的「不可提」条件一致，但只看「以后也不可能」：

| 类型 | 过期条件 |
|---|---|
| `event` | 提及次数 ≥ `event.maxMentions`，或 `now − dueAt > postDays` 天 |
| `concern` | 提及次数 ≥ `concern.maxMentions`，或 `now − createdAt > expireDays` 天 |
| `plan` | 提及次数 ≥ `plan.maxMentions`，或 `now − createdAt > maxDays` 天 |

`clearStaleCareQuotes` 在本任务删除（接口、实现、预编译语句、测试）。care 开场本身在 P4-T3 删除；P4-T1 与 T3 之间 care 开场仍会读 7 天内的原话，不受影响。

**Files:**
- Create: `gateway/src/session/proactive/lifecycle.ts`
- Modify: `gateway/src/index.ts`（每日任务）
- Modify: `gateway/src/memory/store.ts`（删除 `clearStaleCareQuotes`）
- Test: `gateway/test/thread-lifecycle.test.ts`（新建）；引用 `clearStaleCareQuotes` 的现有测试（`grep -rn clearStaleCareQuotes gateway/test`）改为删除对应用例

**Interfaces:**
- Consumes: P2 `ThreadRecord`、`MemoryStore.listAgents/listOpenThreads/closeThread`；P3-T1 `ProactivityConfig.threads`。
- Produces（冻结）：`threadExpired`、`expireThreads`。

- [x] **Step 1：写失败测试**

创建 `gateway/test/thread-lifecycle.test.ts`：

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryStore, ThreadRecord } from '../src/memory/store.ts';
import { loadProactivity } from '../src/session/proactive/config.ts';
import { expireThreads, threadExpired } from '../src/session/proactive/lifecycle.ts';

const cfg = loadProactivity(fileURLToPath(new URL('../config/proactivity.json', import.meta.url)));
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T03:00:00+08:00');
const thread = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: 't1', kind: 'concern', quote: '最近总睡不踏实。', dueAt: NOW, sensitive: false, mentionCount: 0,
  lastMentionedAt: null, createdAt: NOW - DAY, sourceSessionId: 's1', ...over,
});

describe('threadExpired', () => {
  it('keeps a concern for expireDays (14), not the old 7-day care window', () => {
    expect(threadExpired(thread({ createdAt: NOW - 8 * DAY }), NOW, cfg)).toBe(false);
    expect(threadExpired(thread({ createdAt: NOW - 15 * DAY }), NOW, cfg)).toBe(true);
    expect(threadExpired(thread({ mentionCount: cfg.threads.concern.maxMentions }), NOW, cfg)).toBe(true);
  });

  it('keeps an event said long before its date until postDays after it', () => {
    expect(threadExpired(thread({ kind: 'event', createdAt: NOW - 20 * DAY, dueAt: NOW + 2 * DAY }), NOW, cfg)).toBe(false);
    expect(threadExpired(thread({ kind: 'event', dueAt: NOW - 6 * DAY }), NOW, cfg)).toBe(false);
    expect(threadExpired(thread({ kind: 'event', dueAt: NOW - 8 * DAY }), NOW, cfg)).toBe(true);
    expect(threadExpired(thread({ kind: 'event', dueAt: NOW - DAY, mentionCount: cfg.threads.event.maxMentions }), NOW, cfg)).toBe(true);
  });

  it('keeps a plan until maxDays', () => {
    expect(threadExpired(thread({ kind: 'plan', createdAt: NOW - 7 * DAY }), NOW, cfg)).toBe(false);
    expect(threadExpired(thread({ kind: 'plan', createdAt: NOW - 8 * DAY }), NOW, cfg)).toBe(true);
    expect(threadExpired(thread({ kind: 'plan', createdAt: NOW - 4 * DAY, mentionCount: 1 }), NOW, cfg)).toBe(true);
  });
});

describe('expireThreads', () => {
  it('closes only expired threads, per agent, and survives one failing agent', () => {
    const closeThread = vi.fn(() => true);
    const store = {
      listAgents: vi.fn(() => [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]),
      listOpenThreads: vi.fn((_o: string, agentId: string) => {
        if (agentId === 'a2') throw new Error('sqlite_busy');
        return agentId === 'a1'
          ? [thread({ id: 'old', createdAt: NOW - 15 * DAY }), thread({ id: 'fresh' })]
          : [thread({ id: 'done', kind: 'plan', createdAt: NOW - 4 * DAY, mentionCount: 1 })];
      }),
      closeThread,
    } as unknown as MemoryStore;
    expect(expireThreads(store, 'o1', NOW, cfg)).toBe(2);
    expect(closeThread).toHaveBeenCalledWith('o1', 'old', 'expired', NOW);
    expect(closeThread).toHaveBeenCalledWith('o1', 'done', 'expired', NOW);
    expect(closeThread).not.toHaveBeenCalledWith('o1', 'fresh', 'expired', NOW);
  });
});
```

- [x] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/thread-lifecycle.test.ts`
Expected: FAIL——`lifecycle.ts` 不存在。

- [x] **Step 3：`lifecycle.ts`**

```ts
// Thread lifecycle retention (spec 事项线). A thread that can never be raised again is closed, which clears its quote.
import type { MemoryStore, ThreadRecord } from '../../memory/store.ts';
import type { ProactivityConfig } from './config.ts';

const DAY = 86_400_000;

export function threadExpired(thread: ThreadRecord, now: number, cfg: ProactivityConfig): boolean {
  const t = cfg.threads;
  if (thread.kind === 'event') return thread.mentionCount >= t.event.maxMentions || now - thread.dueAt > t.event.postDays * DAY;
  if (thread.kind === 'concern') return thread.mentionCount >= t.concern.maxMentions || now - thread.createdAt > t.concern.expireDays * DAY;
  return thread.mentionCount >= t.plan.maxMentions || now - thread.createdAt > t.plan.maxDays * DAY;
}

/** Daily job body for one owner. Returns how many threads were closed; one failing agent does not stop the rest. */
export function expireThreads(store: MemoryStore, ownerId: string, now: number, cfg: ProactivityConfig): number {
  let closed = 0;
  for (const agent of store.listAgents(ownerId)) {
    try {
      for (const thread of store.listOpenThreads(ownerId, agent.id)) {
        if (threadExpired(thread, now, cfg) && store.closeThread(ownerId, thread.id, 'expired', now)) closed += 1;
      }
    } catch {
      // The caller logs a content-free failure; the next night retries.
    }
  }
  return closed;
}
```

`expireThreads` 吞掉单个角色的异常，是为了一个角色读库失败不影响其他角色；整体失败仍由 `index.ts` 的 try/catch 记 `thread_retention_failed`。

- [x] **Step 4：每日任务**

`gateway/src/index.ts`：import `expireThreads`：

```ts
import { expireThreads } from './session/proactive/lifecycle.ts';
```

把 `expireTranscripts` 末尾的 care 段：

```ts
    // Quotes older than the care window can never be asked about; drop them even when care is off (data minimization).
    try {
      const cleared = store.clearStaleCareQuotes(ownerId, Date.now() - current.affect.care.maxAgeDays * DAY_MS);
      if (cleared > 0) log.info('care_quote_retention', { cleared });
    } catch {
      log.error('care_quote_retention_failed');
    }
```

改为：

```ts
    // Threads that can never be raised again are closed, which clears their quotes (data minimization).
    try {
      const closed = expireThreads(store, ownerId, Date.now(), current.proactivity);
      if (closed > 0) log.info('thread_retention', { closed });
    } catch {
      log.error('thread_retention_failed');
    }
```

- [x] **Step 5：删除 `clearStaleCareQuotes`**

`gateway/src/memory/store.ts`：删除接口里的 `clearStaleCareQuotes` 声明与注释、预编译语句 `clearStaleCareQuotes: p(…)`、实现方法。`grep -rn clearStaleCareQuotes gateway/` 应为空（测试里的用例一并删除；若某个测试同时断言了别的行为，只删 care 那几行）。

- [x] **Step 6：测试与提交**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS。

```bash
git add gateway/src/session/proactive/lifecycle.ts gateway/src/index.ts gateway/src/memory/store.ts gateway/test/thread-lifecycle.test.ts
git commit -m "fix(memory): expire threads by lifecycle instead of wiping quotes after seven days

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

（删过用例的测试文件按明确路径一并加入。）
