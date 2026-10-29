# P4-T6：`humanConnection` 周上限

**Spec：** 意图类型表（`human_connection`：context、话题聊干，**有周上限**）、Q6（定期引导联系家人朋友，必须基于用户提过的原话）、总览 P3 取舍第 10 条、P4 取舍第 9 条。

**做法：** 不加表、不加列。`proactive_stats` 每次记录某个意图的接受 / 拒绝时都会更新 `updated_at`，而主动开口后最晚到下一句主动开口或会话结束就会记结果，所以 `humanConnection` 那一行的 `updated_at` 约等于「上次引导联系家人」的时间。运行时预取时读它；本会话里说过一次就用本会话的开始出声时间。距上次不足 `humanConnection.minIntervalDays`（基线 7 天）时，不提供家人原话（`has.family = false`），引擎自然不会选 `humanConnection`。

**Files:**
- Modify: `gateway/src/memory/store.ts`（`proactiveLastAt`）
- Modify: `gateway/src/session/proactive/config.ts`、`gateway/config/proactivity.json`（`humanConnection.minIntervalDays`）
- Modify: `gateway/src/session/proactive/runtime.ts`
- Test: `gateway/test/proactive-store.test.ts`、`gateway/test/proactive-runtime.test.ts`；三个测试文件里的 `fakeStore` 补 `proactiveLastAt: vi.fn(() => null)`（`proactive-runtime`、`proactive-session`、`proactive-opening`）

**Interfaces:**
- Consumes: P2 `proactive_stats` 表；P3 运行时。
- Produces（冻结）：`MemoryStore.proactiveLastAt(ownerId, agentId, kind): number | null`；`ProactivityConfig.humanConnection.minIntervalDays`。

- [x] **Step 1：写失败测试**

`gateway/test/proactive-store.test.ts` 的 `describe('proactive store')` 里加：

```ts
  it('reads when an intent kind last had an outcome', () => {
    const { store, a, b } = setup();
    expect(store.proactiveLastAt(a.ownerId, a.agentId, 'humanConnection')).toBeNull();
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'humanConnection', 'accepted', 5);
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'humanConnection', 'rejected', 9);
    expect(store.proactiveLastAt(a.ownerId, a.agentId, 'humanConnection')).toBe(9);
    expect(store.proactiveLastAt(a.ownerId, b.agentId, 'humanConnection')).toBeNull();
  });
```

`gateway/test/proactive-runtime.test.ts`：`fakeStore` 默认项加 `proactiveLastAt: vi.fn((): number | null => null),`，并在 `describe('silenceLine')` 里加：

```ts
  it('nudges toward family at most once per minIntervalDays', () => {
    const family = { recentUserMessages: vi.fn(() => [{ text: '闺女在深圳工作，一年也就回来一两趟。' }]) };
    const recent = fakeStore({ ...family, proactiveLastAt: vi.fn(() => AFTERNOON - 3 * DAY) });
    expect(setup({ store: recent, topics: [] }).runtime.silenceLine(input({ hadContent: false }))).toEqual({ quiet: true });
    const old = fakeStore({ ...family, proactiveLastAt: vi.fn(() => AFTERNOON - 8 * DAY) });
    expect(requestOf(setup({ store: old, topics: [] }).runtime.silenceLine(input({ hadContent: false })))!.instruction).toContain('闺女');
  });
```

（`hadContent: false`、没有话题卡、下午：唯一可能的候选就是 `humanConnection`，被挡住就安静。）

- [x] **Step 2：运行，确认失败**

Run: `npm test -w gateway -- test/proactive-store.test.ts test/proactive-runtime.test.ts`
Expected: FAIL——`proactiveLastAt` 不存在；3 天前引导过仍会再引导。

- [x] **Step 3：存储**

`gateway/src/memory/store.ts`：接口在 `proactiveStats` 之后加：

```ts
  /** When this intent kind last had an outcome recorded (≈ last spoken); null when never. */
  proactiveLastAt(ownerId: string, agentId: string, kind: string): number | null;
```

预编译语句（放在 `listStats` 旁）：

```ts
    lastOutcome: p('SELECT updated_at FROM proactive_stats WHERE owner_id = ? AND agent_id = ? AND kind = ?'),
```

实现：

```ts
  proactiveLastAt(ownerId: string, agentId: string, kind: string): number | null {
    return (this.q.lastOutcome.get(ownerId, agentId, kind)?.updated_at as number | undefined) ?? null;
  }
```

- [x] **Step 4：配置**

`gateway/src/session/proactive/config.ts`：`humanConnection: z.object({ lowRelevance: Pct }).strict()` 改为 `humanConnection: z.object({ lowRelevance: Pct, minIntervalDays: Days(1, 30) }).strict()`。`gateway/config/proactivity.json`：`"humanConnection": { "lowRelevance": 70, "minIntervalDays": 7 }`。

- [x] **Step 5：运行时**

`gateway/src/session/proactive/runtime.ts`：

1. 字段 `private lastHumanAt: number | null = null;`，常量 `const DAY = 86_400_000;`（若文件里还没有）。
2. `ensureLoaded` 的 try 块末尾加 `this.lastHumanAt = store.proactiveLastAt(ownerId, agentId, 'humanConnection');`。
3. `familyLine` 开头加：

```ts
    const last = this.lastHumanAt;
    if (last !== null && this.deps.now() - last < this.deps.cfg.humanConnection.minIntervalDays * DAY) return undefined;
```

4. `onLineStarted` 里 `if (isScored(kind)) {` 块内加 `if (kind === 'humanConnection') this.lastHumanAt = now;`。

- [x] **Step 6：测试与提交**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: PASS（另外两个测试文件的 `fakeStore` 补了 `proactiveLastAt` 之后）。

```bash
git add gateway/src/memory/store.ts gateway/src/session/proactive/config.ts gateway/config/proactivity.json gateway/src/session/proactive/runtime.ts \
  gateway/test/proactive-store.test.ts gateway/test/proactive-runtime.test.ts gateway/test/proactive-session.test.ts gateway/test/proactive-opening.test.ts
git commit -m "feat(proactive): weekly cap on family nudges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
