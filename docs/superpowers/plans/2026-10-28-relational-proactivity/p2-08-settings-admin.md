# P2-T8：设置页接口、protocol 与后台条数

**Spec：** Q24（新增的事项、反思结论、情绪摘要在设置页可查看、可删除；后台只显示条数）、「隐私、数据与删除」。

**设计取舍（编写计划时定，需在 P2 完成汇报里请用户确认）：** protocol 只做**增量、可选**字段，现有 App 解析时会忽略未知字段（`app/lib/memory/memory_overview.dart` 只读 `character`、`pinned`、`facts`），所以本任务不改 `app/`；App 端展示与删除按钮另立 App 计划。网关从本任务起总是返回这三个字段。

- 事项项的 `text` 是用户原话（`quote`），这是用户自己的话，展示给本人没有问题；只列未关闭、有原话的事项。
- 反思项的 `text` 是推断句；情绪项不带文字，只给日期（北京）、主导情绪与最高强度，文案由 App 决定。
- 删除：事项按 `source_message_ids` 删来源原话，没有来源（迁移前的旧行）走现有「忘掉式」匹配兜底；反思按依据 id 删来源原话（与删事实的 Q35/Q36 规则一致，避免下次又被提炼出来）；情绪项没有来源，**不做**兜底匹配（标签词可能误匹配到别的话）。
- 后台 `memoryItems` 加上未关闭事项与反思的条数，不显示内容。

**Files:**
- Modify: `protocol/src/memoryApi.ts`、`protocol/src/index.ts`
- Modify: `gateway/src/memory/store.ts`（`DeletedItem.kind`、`deleteMemoryItem` 三个分支）
- Modify: `gateway/src/identity/memoryService.ts`
- Modify: `gateway/src/admin/queries.ts`
- Test: `gateway/test/memory-service.test.ts`、`gateway/test/admin-queries.test.ts`

**Interfaces:**
- Consumes: P2-T3 `listOpenThreads`；P2-T4 `listMoodSummaries`；P2-T6 `listReflections`；P2-T1 表。
- Produces（冻结）：`MemoryThreadItem`、`MemoryMoodItem`、`MemoryOverview.characters[i].threads? / reflections? / moods?`；`DeletedItem.kind` 增加 `'thread' | 'reflection' | 'mood'`。

- [ ] **Step 1：写失败测试（设置页）**

`gateway/test/memory-service.test.ts`：

1. 第 85–91 行三处 `toEqual` 的期望对象末尾补 `threads: [], reflections: [], moods: []`，例如：

```ts
    expect(view.characters[1]).toEqual({ character: 'xiaokai', pinned: [], facts: [], threads: [], reflections: [], moods: [] });
```

2. 文件末尾加：

```ts
describe('settings view of relational memory', () => {
  function threadRow(s: Seed, id: string, quote: string | null, kind: string, sources: string[], doneAt: number | null = null): void {
    s.db.prepare(`INSERT INTO followups (id, owner_id, agent_id, text, due_at, done_at, source_session_id, quote, sensitive, created_at, kind, source_message_ids)
      VALUES (?, ?, ?, 'summary', 9, ?, 's0', ?, 1, 10, ?, ?)`).run(id, s.ownerId, s.a, doneAt, quote, kind, JSON.stringify(sources));
  }
  function userLine(s: Seed, id: string, text: string): void {
    s.store.insertMessage({ id, sessionId: 's0', ownerId: s.ownerId, agentId: s.a, role: 'user', text, bigrams: bigrams(text), now: 5 });
  }

  it('lists open threads, reflections and moods per character', () => {
    const s = seed();
    threadRow(s, 't1', '我后天去复查', 'event', []);
    threadRow(s, 'plain', null, 'concern', []);
    threadRow(s, 'closed', '想学太极', 'plan', [], 20);
    s.store.insertReflections(s.ownerId, s.a, 's0', [{ text: '常一个人吃午饭', evidenceMessageIds: [] }], 30);
    s.store.recordMoodSummary(s.ownerId, s.a, { sessionId: 's0', dominant: 'sad', peakIntensity: 2, endEmotion: 'sad', endIntensity: 1, endTrend: 'flat', crisis: false }, Date.parse('2026-11-02T23:30:00+08:00'));
    const view = s.service.overview(s.ownerId);
    expect(view.characters[0]).toMatchObject({
      threads: [{ id: 't1', text: '我后天去复查', kind: 'event', sensitive: true }],
      reflections: [{ id: expect.any(String), text: '常一个人吃午饭' }],
      moods: [{ id: expect.any(String), day: '2026-11-02', emotion: 'sad', peak: 2 }],
    });
  });

  it('deletes a thread with its source line, a reflection with its evidence, and a mood without touching any line', () => {
    const s = seed();
    userLine(s, 'm1', '我后天去复查腰');
    userLine(s, 'm2', '中午都是我一个人吃饭');
    userLine(s, 'm3', '今天心里有点闷');
    threadRow(s, 't1', '我后天去复查腰', 'event', ['m1']);
    s.store.insertReflections(s.ownerId, s.a, 's0', [{ text: '常一个人吃午饭', evidenceMessageIds: ['m2'] }], 30);
    s.store.recordMoodSummary(s.ownerId, s.a, { sessionId: 's0', dominant: 'sad', peakIntensity: 2, endEmotion: 'sad', endIntensity: 1, endTrend: 'flat', crisis: false }, 40);
    const reflectionId = s.store.listReflections(s.ownerId, s.a, 1)[0]!.id;
    const moodId = s.store.listMoodSummaries(s.ownerId, s.a, 1)[0]!.id;
    const lines = () => s.db.prepare('SELECT id FROM messages ORDER BY id').all().map((r) => (r as { id: string }).id);

    expect(s.service.deleteItem(s.ownerId, 't1')).toBe(true);
    expect(lines()).toEqual(['m2', 'm3']);
    expect(s.service.deleteItem(s.ownerId, reflectionId)).toBe(true);
    expect(lines()).toEqual(['m3']);
    expect(s.service.deleteItem(s.ownerId, moodId)).toBe(true);
    expect(lines()).toEqual(['m3']);
    const view = s.service.overview(s.ownerId);
    expect(view.characters[0]).toMatchObject({ threads: [], reflections: [], moods: [] });
    // Another owner cannot delete them.
    threadRow(s, 't2', '我腿疼', 'concern', []);
    expect(s.service.deleteItem(s.other, 't2')).toBe(false);
  });
});
```

- [ ] **Step 2：写失败测试（后台条数）**

`gateway/test/admin-queries.test.ts` 的 `describe('owners', ...)` 内加：

```ts
  it('counts open threads and reflections as memory items, never their text', () => {
    seedStandard(db);
    db.prepare(`INSERT INTO followups (id, owner_id, agent_id, text, due_at, source_session_id, quote, sensitive, created_at)
      VALUES ('t-open', ?, ?, 'x', 1, 's', '我后天复查', 1, 1), ('t-plain', ?, ?, 'x', 1, 's', NULL, 0, 1)`).run(OWNER_A, AGENT_A, OWNER_A, AGENT_A);
    db.prepare(`INSERT INTO reflections (id, owner_id, agent_id, text, evidence_message_ids, session_id, created_at)
      VALUES ('r1', ?, ?, '常一个人吃午饭', '[]', 's', 1)`).run(OWNER_A, AGENT_A);
    const page = q.owners({ includeMock: false, offset: 0, limit: 50 });
    expect(page.items.find((o) => o.oid === OA)!.memoryItems).toBe(6);
    expect(q.owner(OA, false)!.characters[0]!.memoryItems).toBe(5);
    expect(JSON.stringify(page)).not.toContain('复查');
  });
```

（基线：`seedStandard` 下 OWNER_A 为 4、其 xiaonuan 角色为 3，见同文件已有断言；本用例加 1 条事项 + 1 条反思。）

- [ ] **Step 3：运行，确认失败**

Run: `npm test -w gateway -- test/memory-service.test.ts test/admin-queries.test.ts`
Expected: FAIL。

- [ ] **Step 4：protocol**

`protocol/src/memoryApi.ts`：在 `MemoryPinnedItem` 后加：

```ts
/** An open thread: the user's own words about something not yet settled (spec 2026-10-28). */
export interface MemoryThreadItem extends MemoryItem {
  kind: 'event' | 'concern' | 'plan';
  sensitive: boolean;
}

/** One session's mood, labels only; the App owns the wording. day = YYYY-MM-DD Asia/Shanghai. */
export interface MemoryMoodItem {
  id: string;
  day: string;
  emotion: 'neutral' | 'happy' | 'sad' | 'love';
  peak: 1 | 2 | 3;
}
```

`MemoryOverview.characters` 的元素类型改为：

```ts
  characters: Array<{
    character: CharacterId;
    pinned: MemoryPinnedItem[];
    facts: MemoryFactItem[];
    /** Added 2026-10-28; optional so older clients and fixtures stay valid. The gateway always sends them. */
    threads?: MemoryThreadItem[];
    reflections?: MemoryItem[];
    moods?: MemoryMoodItem[];
  }>;
```

`protocol/src/index.ts` 第 4 行的导出列表加 `MemoryMoodItem, MemoryThreadItem`（按字母序插入）。

- [ ] **Step 5：store 删除分支**

`gateway/src/memory/store.ts`：

`DeletedItem` 改为：

```ts
export interface DeletedItem { kind: 'profile' | 'agent_fact' | 'pinned' | 'thread' | 'reflection' | 'mood'; agentId: string | null; text: string; sourceMessageIds: string[] }
```

`prepareStatements` 加：

```ts
    getThreadById: p('SELECT agent_id, quote, text, source_message_ids FROM followups WHERE id = ? AND owner_id = ? AND quote IS NOT NULL AND done_at IS NULL'),
    deleteFollowupById: p('DELETE FROM followups WHERE id = ? AND owner_id = ?'),
    getReflectionById: p('SELECT agent_id, text, evidence_message_ids FROM reflections WHERE id = ? AND owner_id = ?'),
    deleteReflectionById: p('DELETE FROM reflections WHERE id = ? AND owner_id = ?'),
    getMoodById: p('SELECT agent_id FROM mood_summaries WHERE id = ? AND owner_id = ?'),
    deleteMoodById: p('DELETE FROM mood_summaries WHERE id = ? AND owner_id = ?'),
```

`deleteMemoryItem` 中，`const pin = ...` 那个 `if (pin) {...}` 之后、`return undefined;` 之前加：

```ts
      const thread = this.q.getThreadById.get(itemId, ownerId);
      if (thread) {
        this.q.deleteFollowupById.run(itemId, ownerId);
        this.forgetRow(ownerId, thread.agent_id as string, 'followups', itemId, now);
        return { kind: 'thread', agentId: thread.agent_id as string, text: thread.quote as string, sourceMessageIds: parseIds(thread.source_message_ids) };
      }
      const reflection = this.q.getReflectionById.get(itemId, ownerId);
      if (reflection) {
        this.q.deleteReflectionById.run(itemId, ownerId);
        this.forgetRow(ownerId, reflection.agent_id as string, 'reflections', itemId, now);
        return { kind: 'reflection', agentId: reflection.agent_id as string, text: reflection.text as string, sourceMessageIds: parseIds(reflection.evidence_message_ids) };
      }
      const mood = this.q.getMoodById.get(itemId, ownerId);
      if (mood) {
        this.q.deleteMoodById.run(itemId, ownerId);
        this.forgetRow(ownerId, mood.agent_id as string, 'mood_summaries', itemId, now);
        return { kind: 'mood', agentId: mood.agent_id as string, text: '', sourceMessageIds: [] };
      }
```

并把方法上方接口注释 `Deletes one profile, agent fact or pinned row` 改为 `Deletes one profile, agent fact, pinned, thread, reflection or mood row`。

- [ ] **Step 6：设置页服务**

`gateway/src/identity/memoryService.ts`：

`TABLE_OF` 加三项：

```ts
  thread: 'followups',
  reflection: 'reflections',
  mood: 'mood_summaries',
```

`deleteSources` 开头加：

```ts
    // A mood row has no source line; a fallback match on label words could hit unrelated lines.
    if (item.kind === 'mood') return { deleted: 0, fallback: false };
```

`overview` 里：未见过的角色返回 `{ character, pinned: [], facts: [], threads: [], reflections: [], moods: [] }`；见过的角色在 `facts` 后加：

```ts
            threads: store.listOpenThreads(ownerId, agent.id).map((row) => ({ id: row.id, text: row.quote, kind: row.kind, sensitive: row.sensitive })),
            reflections: store.listReflections(ownerId, agent.id, MAX_LISTED).map((row) => ({ id: row.id, text: row.text })),
            moods: store.listMoodSummaries(ownerId, agent.id, MAX_LISTED).map((row) => ({
              id: row.id, day: shanghaiDay(row.createdAt), emotion: row.dominant, peak: row.peakIntensity,
            })),
```

并在文件顶部常量区加：

```ts
/** Newest rows listed per character for reflections and moods; threads are few and all listed. */
const MAX_LISTED = 50;

const shanghaiDay = (at: number): string => new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
```

- [ ] **Step 7：后台条数**

`gateway/src/admin/queries.ts`：

`owners` 查询里 `memoryItems` 的表达式改为：

```sql
      (SELECT COUNT(*) FROM profile_facts f WHERE f.owner_id = o.id)
        + (SELECT COUNT(*) FROM agent_facts f WHERE f.owner_id = o.id)
        + (SELECT COUNT(*) FROM pinned_memories p WHERE p.owner_id = o.id)
        + (SELECT COUNT(*) FROM followups t WHERE t.owner_id = o.id AND t.quote IS NOT NULL AND t.done_at IS NULL)
        + (SELECT COUNT(*) FROM reflections r WHERE r.owner_id = o.id) AS memoryItems,
```

`ownerCharacters` 查询里改为：

```sql
      (SELECT COUNT(*) FROM agent_facts f WHERE f.agent_id = a.id) + (SELECT COUNT(*) FROM pinned_memories p WHERE p.agent_id = a.id)
        + (SELECT COUNT(*) FROM followups t WHERE t.agent_id = a.id AND t.quote IS NOT NULL AND t.done_at IS NULL)
        + (SELECT COUNT(*) FROM reflections r WHERE r.agent_id = a.id) AS memoryItems,
```

（这两段是模板字符串里的 SQL，只替换 `memoryItems` 表达式本身，其余不动。）

- [ ] **Step 8：运行测试**

Run: `npm test -w gateway -- test/memory-service.test.ts test/admin-queries.test.ts && npm test -w protocol && npm run typecheck -w protocol && npm run typecheck -w gateway`
Expected: PASS。

- [ ] **Step 9：App 与后台不受影响**

```bash
npm test -w admin && npm run typecheck -w admin
(cd app && flutter test test/memory_api_test.dart test/companion_settings_page_test.dart)
```

Expected：通过（admin 不使用 `MemoryOverview`；App 解析忽略新字段）。本机没有 Flutter 时记入 `docs/blockers.md` 并在报告中列为跳过。

- [ ] **Step 10：提交**

```bash
git add protocol/src/memoryApi.ts protocol/src/index.ts gateway/src/memory/store.ts gateway/src/identity/memoryService.ts gateway/src/admin/queries.ts \
  gateway/test/memory-service.test.ts gateway/test/admin-queries.test.ts
git commit -m "feat(memory): list and delete threads, reflections and moods in settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
