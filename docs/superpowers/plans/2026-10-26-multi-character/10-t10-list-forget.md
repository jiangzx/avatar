# Task 10: 「你都记得我什么」（list_memory）与忘掉 / 回忆的作用域

**目标：**
- 新增 `list_memory`：按「钉住（新的在前）→ 共享层 `profile` → 本角色非敏感事实」的顺序，用模板拼出最多 `listMaxItems` 条，走 grounded 播报路径，不经过文本模型。称呼不念、不计数；健康类不念，只附一句提示。
- `forget_memory` 的匹配范围固定为「本角色私有 + 本角色钉住 + 共享层」，绝不碰其他角色；命中共享层时 bump owner epoch，否则 bump 本角色的 agent epoch。
- `recall_memory` 只查本角色的原话。
- 补齐隔离测试。

**实现的 spec 章节：** 「语音能力 → 查看：`list_memory`」「忘掉：`forget_memory`」；技术设计 §5（作用域表、epoch）、§6（`list_memory`、`forget_memory` / `recall_memory`）、§10（`list.*`）；「安全与隐私」（健康类不念出来，日志不记记忆列表）；「测试与验收 → 隔离测试」；附录 B（list 文案）。

**前置：** Task 9 已完成（`ToolContext.characterId` / `turn` / `memoryGate`、`NO_TURN`、`ToolRegistryOptions` 的默认值写法、`oneLine`）。C2 的 `forgetMatches(ownerId, agentId, ...)` 已由 Task 2 改成「本 agent 私有表 + `pinned_memories` + `profile_facts`」，消息只动本 agent 的；`recall.ts` 的 store 调用已由 Task 2 补上 `agentId`。

> `recall_memory` 和 `forget_memory` 属于「记忆与回忆」高风险区。本任务不改召回的证据规则、包装和检索逻辑，只收紧作用域和 epoch。改前读 `docs/project/roadmap.md`「记忆与回忆：已踩过的坑」1–12；改后跑全量测试、typecheck，以及 Task 17 的真实记忆库召回探针（本任务只要求前两项，探针在 Task 17 跑，报告里写明）。

## Files

- Create: `gateway/src/session/tools/list.ts` — `listTool`
- Create: `gateway/test/list-forget-scope.test.ts`
- Modify: `gateway/src/session/tools/forget.ts`（当前 `:9-49`：作用域与 epoch）
- Modify: `gateway/src/session/tools/recall.ts`（当前 `:118-160` `recall()`：只核对作用域，确认三个 store 调用都传 `ctx.agentId`）
- Modify: `gateway/src/session/tools/registry.ts`（注册 `listTool`；`ToolRegistryOptions.listMaxItems`）
- Modify: `gateway/src/session/session.ts`（`SessionDeps.listMaxItems`；`toolsFor()` 传入）
- Modify: `gateway/src/i18n/types.ts`（新增 `ListCopy`，`MemoryCopy.list`）
- Modify: `gateway/src/i18n/load.ts`（`MemoryFileSchema.list`，`loadMemoryCopy`）
- Modify: `gateway/config/i18n/zh/memory.json`、`ja/memory.json`、`en/memory.json`（新增 `list`）
- Modify: `gateway/src/index.ts`（Session deps：`listMaxItems`）
- Modify（调用方适配）：`gateway/test/memory-tools.test.ts`（forget 相关用例的 epoch 断言，见下表）

## Interfaces

**Consumes**
- C2：`listPinned(ownerId, agentId): PinnedRow[]`（新的在前）；`listProfileFacts(ownerId): ProfileFactRow[]`；`listAgentFacts(ownerId, agentId): AgentFactRow[]`（含敏感项，调用方过滤）；`forgetMatches(ownerId, agentId, query, match, sessionId, triggerText?)`；`bumpOwnerEpoch(ownerId)`；`bumpAgentEpoch(ownerId, agentId)`；`memoryEpochs(ownerId, agentId)`；`recentUserMessages` / `searchMessages` / `searchMessagesLike`（都带 `agentId`）。
- C4：`MemoryBudgetConfig.listMaxItems: number`。
- C9（Task 9）：`ToolContext`（含 `characterId`、`turn`、`memoryGate`）、`NO_TURN`。

**Produces**
- C9：`gateway/src/session/tools/list.ts` 的 `listTool`，工具名 `list_memory`，无参数；在 `tools/registry.ts` 注册。
- i18n：`config/i18n/<lang>/memory.json` 的 `list` 块。
- 私有辅助（非冻结）：`ListCopy`、`ListOptions`、`ToolRegistryOptions.listMaxItems`、`SessionDeps.listMaxItems`。

## 设计要点

1. **list 的数据来源全部是作用域内的 store 读取**：`listPinned(ownerId, agentId)`、`listProfileFacts(ownerId)` 里 `category === 'profile'` 的行、`listAgentFacts(ownerId, agentId)` 里 `!sensitive` 的行。`ownerId` / `agentId` 只来自 `ToolContext`（服务端 `SessionContext`）。
2. **顺序与上限**：钉住非敏感项（store 已按新的在前）→ profile → 本角色非敏感事实。按单行化后的文本去重，取前 `listMaxItems` 条。称呼（`category === 'addressing'`）不进列表、不计数。原话和 episodes 不读。
3. **健康提示**：存在敏感的钉住项，或 `category === 'health'` 的本角色事实时，在末尾附 `list.sensitiveHint`。只有健康项、没有可念的条目时，只播 `sensitiveHint`。什么都没有时播 `list.emptyText`。
4. **模板**：`introText + items.join(itemJoiner) + itemEnd + (hint ? sensitiveHint : '')`，整体 trim。每条先去掉尾部句读，避免「。；」叠在一起。`itemEnd` 是 spec 键表之外新增的一个键（中文「。」、英文「. 」），原因是英文需要句号和空格，不能写死在代码里。
5. **播报路径**：返回 `{ ok: true, spokenText, spokenFound }`，不带 `text`、不带 `confirmText`。Session 走 Task 9 之后的 grounded 路径（Seeduplex 直接 TTS，Qwen「请直接说下面这句话，不要改写：」），不会退回 `toolContinueText`。
6. **forget 的 epoch**：在调用 `forgetMatches` 之前判断是否会命中共享层（`listProfileFacts(ownerId)` 里有 `text.includes(query)` 的行，和 store 的 `instr(text, ?) > 0` 一致），命中就 `bumpOwnerEpoch`，否则 `bumpAgentEpoch(ownerId, agentId)`。先 bump 再删，与 `runAfterEpochBump` 的原意一致：进行中的抽取在写入事务里复核 epoch 后判为过期。不改 `ForgetResult` 的形状（C2 没冻结它），判断 0 命中用 `Object.values(result)` 求和。
7. **forget 原话只删当前角色的**：由 Task 2 的 `forgetMatches` 保证。本任务用隔离测试锁住这一点。spec 明确要求语音「忘掉」和设置页删除共享条目的原话范围**有意不同**，不要「统一」。
8. **recall**：Task 2 已把 `recentUserMessages(ownerId, 12)` 等改成带 `agentId`。本任务把开头的可用性检查改成同时要求 `ctx.agentId`，去掉 Task 2 可能留下的 `ctx.agentId ?? ...` / `!` 兜底，并补隔离测试。证据规则、FTS 50 条候选、包装逻辑一律不动。
9. **日志**：list 不打自己的日志，只有 Session 现有的 `tool_invoked{name, ok}`。记忆条目一律不进日志。

## 调用方适配

| 位置 | 断在哪 | 修法 |
|---|---|---|
| `test/memory-tools.test.ts` 的 forget 用例（当前 `:398-450`、`:593-662`，Task 2 之后行号会漂） | Task 2 适配后可能断言了 `bumpOwnerEpoch` 被调用（forget 原来 bump owner epoch） | 私有命中改为断言 `memoryEpochs(ownerId, agentId).agent` 加一、`owner` 不变；命中共享层的用例断言 `owner` 加一。用 `grep -n "Epoch" gateway/test/memory-tools.test.ts` 定位 |
| `src/session/tools/consent.ts` | 不受影响 | 继续用 Task 2 留下的 `runAfterEpochBump`（bump owner epoch），不改 |
| `test/memory-tools.test.ts` 的 `ctxFor` | Task 9 已加 `characterId` / `turn` / `memoryGate` | 无需再改 |

## Steps

- [x] **Step 1: 写 list 文案配置的失败测试**

`gateway/test/list-forget-scope.test.ts`（先放配置用例，后面的步骤追加）：

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@anyidea/protocol';
import { loadI18n } from '../src/i18n/load.ts';

const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));

describe('list copy', () => {
  it('ships the appendix B zh copy', () => {
    const list = i18n.memory.zh.list;
    expect(list.introText).toBe('我记得这些：');
    expect(list.itemJoiner).toBe('；');
    expect(list.itemEnd).toBe('。');
    expect(list.sensitiveHint).toBe('还有些身体方面的事，在设置里能看到。');
    expect(list.emptyText).toBe('我这儿还没记下什么，您慢慢跟我说。');
  });

  it('has every list field in every language and names no character', () => {
    for (const language of LANGUAGES) {
      const list = i18n.memory[language].list;
      for (const text of [list.introText, list.itemJoiner, list.itemEnd, list.sensitiveHint, list.emptyText, list.toolDescription]) {
        expect(text.length).toBeGreaterThan(0);
      }
      for (const name of ['小暖', '小凯', '小欣', 'Xiaonuan', 'Xiaokai', 'Xiaoxin']) expect(list.toolDescription).not.toContain(name);
    }
  });
});
```

运行：

```bash
npm test -w gateway -- test/list-forget-scope.test.ts
```

Expected：FAIL（`i18n.memory.zh.list` 是 undefined）。

- [x] **Step 2: 实现 list 文案的类型、校验和配置**

`gateway/src/i18n/types.ts`，在 `PinCopy` 下面加：

```ts
/** list_memory template copy (spec 附录 B). */
export interface ListCopy {
  introText: string;
  itemJoiner: string;
  /** Closes the item run before an optional hint ("。" / ". "). */
  itemEnd: string;
  sensitiveHint: string;
  emptyText: string;
  toolDescription: string;
}
```

`MemoryCopy` 里 `pin: PinCopy;` 下面加 `list: ListCopy;`。

`gateway/src/i18n/load.ts`：`MemoryFileSchema` 的 `pin: ...` 后面加：

```ts
  list: z.object({
    introText: z.string().min(1).max(40),
    itemJoiner: z.string().min(1).max(4),
    itemEnd: z.string().min(1).max(4),
    sensitiveHint: z.string().min(1).max(80),
    emptyText: z.string().min(1).max(80),
    toolDescription: z.string().min(1),
  }).strict(),
```

`loadMemoryCopy` 的返回对象里 `pin: raw.pin,` 下面加 `list: raw.list,`。

`gateway/config/i18n/zh/memory.json`（`pin` 块之后）：

```json
  "list": {
    "introText": "我记得这些：",
    "itemJoiner": "；",
    "itemEnd": "。",
    "sensitiveHint": "还有些身体方面的事，在设置里能看到。",
    "emptyText": "我这儿还没记下什么，您慢慢跟我说。",
    "toolDescription": "用户问你都记得他什么时调用。不要自己列举或猜测，网关会把记得的内容念出来。调用后只说网关给的那一句。"
  },
```

`gateway/config/i18n/ja/memory.json`：

```json
  "list": {
    "introText": "覚えていることはこちらです：",
    "itemJoiner": "。",
    "itemEnd": "。",
    "sensitiveHint": "ほかにも体のことがありますが、設定で見られます。",
    "emptyText": "まだ何も覚えていません。ゆっくり話してくださいね。",
    "toolDescription": "ユーザーが自分について何を覚えているか聞いたときに呼びます。自分で並べたり推測したりしないでください。ゲートウェイが覚えている内容を読み上げます。呼んだあとは、ゲートウェイが返す一文だけを言ってください。"
  },
```

`gateway/config/i18n/en/memory.json`：

```json
  "list": {
    "introText": "Here's what I remember: ",
    "itemJoiner": "; ",
    "itemEnd": ". ",
    "sensitiveHint": "There are also some health notes you can see in Settings.",
    "emptyText": "I haven't noted anything yet. Take your time and tell me.",
    "toolDescription": "Call when the user asks what you remember about them. Do not list or guess yourself; the gateway reads out what is remembered. After calling, say only the line the gateway returns."
  },
```

运行：

```bash
npm test -w gateway -- test/list-forget-scope.test.ts test/i18n.test.ts
```

Expected：PASS。

- [x] **Step 3: 写 list / forget / recall 作用域的失败测试**

在 `gateway/test/list-forget-scope.test.ts` 追加（import 合并到文件头）：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';
import type { CharacterId } from '@anyidea/protocol';
import { bigrams } from '../src/memory/bigram.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { ActionRouter } from '../src/session/actions.ts';
import { ConversationLedger } from '../src/session/ledger.ts';
import { createToolRegistry, type ToolContext } from '../src/session/tools/registry.ts';
import { NO_TURN } from '../src/session/turnAccess.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

/** One owner who has met two characters. */
function seed() {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  const store = new SqliteMemoryStore(db);
  const { ownerId } = store.createOwner({ tokenHash: `h-scope-${dbs.length}`, now: 1 });
  const a = store.ensureAgent(ownerId, 'xiaonuan', 1);
  const b = store.ensureAgent(ownerId, 'xiaokai', 1);
  store.markNotified(ownerId, 2);
  return { db, store, ownerId, a: a.id, b: b.id };
}
type Seed = ReturnType<typeof seed>;

function agentFact(s: Seed, agentId: string, id: string, category: string, text: string, sensitive = false): void {
  s.db.prepare(
    `INSERT INTO agent_facts (id, owner_id, agent_id, category, text, sensitive, confidence, source_session_id, source_message_ids, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 's0', '[]', 10)`,
  ).run(id, s.ownerId, agentId, category, text, sensitive ? 1 : 0);
}

function profileFact(s: Seed, id: string, category: 'addressing' | 'profile', text: string): void {
  s.db.prepare(
    `INSERT INTO profile_facts (id, owner_id, category, text, confidence, source_session_id, source_message_ids, updated_at)
     VALUES (?, ?, ?, ?, 1, 's0', '[]', 10)`,
  ).run(id, s.ownerId, category, text);
}

function pin(s: Seed, agentId: string, id: string, text: string, now: number, sensitive = false): void {
  s.store.insertPinned({ id, ownerId: s.ownerId, agentId, text, sensitive, sourceSessionId: 's0', sourceMessageId: null, now });
}

/** A user line in its own ended session of that agent, so recent recall can see it. */
function say(s: Seed, agentId: string, id: string, text: string, now: number): void {
  const sessionId = `ended-${id}`;
  s.store.recordSessionStart(sessionId, agentId, 1);
  s.store.insertMessage({ id, sessionId, ownerId: s.ownerId, agentId, role: 'user', text, bigrams: bigrams(text), now });
  s.store.recordSessionEnd(sessionId, agentId, 100);
}

function ctx(s: Seed, agentId: string, characterId: CharacterId, ledger = new ConversationLedger()): ToolContext {
  return {
    ownerId: s.ownerId,
    agentId,
    characterId,
    sessionId: 'live-1',
    store: s.store,
    ledger,
    actions: new ActionRouter(),
    now: 50_000,
    turn: NO_TURN,
    memoryGate: () => 'ok',
  };
}

function registry(language: 'zh' | 'ja' | 'en' = 'zh', listMaxItems = 5) {
  return createToolRegistry({
    language,
    memory: i18n.memory[language],
    evidence: i18n.evidence,
    recentQueries: i18n.recentQueries,
    recallPrompt: 'FIXTURE RECALL',
    safety: i18n.safety,
    clipChars: 80,
    phraseTimeoutMs: 1_500,
    listMaxItems,
  });
}

const zh = i18n.memory.zh;
const messageRow = (s: Seed, id: string) => s.db.prepare('SELECT text, excluded FROM messages WHERE id = ?').get(id) as { text: string; excluded: number };

describe('list_memory', () => {
  it('reads pinned (newest first), then profile, then non-sensitive facts; skips the name; adds the health hint', async () => {
    const s = seed();
    profileFact(s, 'addr', 'addressing', '王叔');
    profileFact(s, 'home', 'profile', '家在青岛');
    pin(s, s.a, 'p-old', '我女儿叫小芳', 10);
    pin(s, s.a, 'p-new', '下周三去复查', 20);
    pin(s, s.a, 'p-health', '我有高血压', 30, true);
    agentFact(s, s.a, 'f-tea', 'preference', '喜欢喝茶。');
    agentFact(s, s.a, 'f-knee', 'health', '膝盖不好', true);
    const out = await registry().handle('list_memory', {}, ctx(s, s.a, 'xiaonuan'));
    expect(out).toEqual({
      ok: true,
      spokenText: '我记得这些：下周三去复查；我女儿叫小芳；家在青岛；喜欢喝茶。还有些身体方面的事，在设置里能看到。',
      spokenFound: true,
    });
    expect(out.spokenText).not.toContain('王叔');
    expect(out.spokenText).not.toContain('高血压');
    expect(out.spokenText).not.toContain('膝盖');
  });

  it('caps at listMaxItems, and the name does not count', async () => {
    const s = seed();
    profileFact(s, 'addr', 'addressing', '王叔');
    for (let i = 1; i <= 6; i++) pin(s, s.a, `p${i}`, `第${i}件事`, i);
    const out = await registry('zh', 5).handle('list_memory', {}, ctx(s, s.a, 'xiaonuan'));
    expect(out.spokenText).toBe('我记得这些：第6件事；第5件事；第4件事；第3件事；第2件事。');
  });

  it('speaks the empty line with nothing remembered, and only the hint with only health items', async () => {
    const s = seed();
    profileFact(s, 'addr', 'addressing', '王叔');
    await expect(registry().handle('list_memory', {}, ctx(s, s.a, 'xiaonuan')))
      .resolves.toEqual({ ok: true, spokenText: zh.list.emptyText, spokenFound: false });
    agentFact(s, s.a, 'f-knee', 'health', '膝盖不好', true);
    await expect(registry().handle('list_memory', {}, ctx(s, s.a, 'xiaonuan')))
      .resolves.toEqual({ ok: true, spokenText: zh.list.sensitiveHint, spokenFound: true });
  });

  it('never lists another character’s pinned or private facts, but does list the shared profile', async () => {
    const s = seed();
    profileFact(s, 'home', 'profile', '家在青岛');
    pin(s, s.a, 'p-a', '我女儿叫小芳', 10);
    agentFact(s, s.a, 'f-a', 'preference', '喜欢喝茶');
    pin(s, s.b, 'p-b', '周末去钓鱼', 10);
    const out = await registry().handle('list_memory', {}, ctx(s, s.b, 'xiaokai'));
    expect(out.spokenText).toBe('我记得这些：周末去钓鱼；家在青岛。');
  });

  it('uses the ja and en templates', async () => {
    const s = seed();
    pin(s, s.a, 'p1', 'my daughter is Hana', 10);
    agentFact(s, s.a, 'f1', 'preference', 'likes green tea.');
    await expect(registry('en').handle('list_memory', {}, ctx(s, s.a, 'xiaonuan'))).resolves.toMatchObject({
      spokenText: "Here's what I remember: my daughter is Hana; likes green tea.",
    });
    await expect(registry('ja').handle('list_memory', {}, ctx(s, s.a, 'xiaonuan'))).resolves.toMatchObject({
      spokenText: '覚えていることはこちらです：my daughter is Hana。likes green tea。',
    });
  });

  it('takes no arguments and reports a missing store', async () => {
    const s = seed();
    const spec = registry().specs().find((item) => item.name === 'list_memory');
    expect(spec).toEqual({ name: 'list_memory', description: zh.list.toolDescription, parameters: { type: 'object', properties: {} } });
    await expect(registry().handle('list_memory', { extra: 1 }, ctx(s, s.a, 'xiaonuan'))).resolves.toEqual({ ok: false, error: 'invalid_args' });
    const { agentId: _agentId, ...noAgent } = ctx(s, s.a, 'xiaonuan');
    await expect(registry().handle('list_memory', {}, noAgent)).resolves.toEqual({ ok: false, error: 'memory_unavailable' });
  });
});

describe('forget_memory scope', () => {
  it('never touches another character’s private facts, pins, or lines; bumps only the caller’s agent epoch', async () => {
    const s = seed();
    agentFact(s, s.a, 'f-a', 'preference', '喜欢喝龙井');
    pin(s, s.a, 'p-a', '喜欢喝龙井的事', 10);
    say(s, s.a, 'm-a', '我喜欢喝龙井', 20);
    const before = s.store.memoryEpochs(s.ownerId, s.b)!;
    const beforeA = s.store.memoryEpochs(s.ownerId, s.a)!;
    const out = await registry().handle('forget_memory', { query: '龙井' }, ctx(s, s.b, 'xiaokai'));
    expect(out).toEqual({ ok: false, error: 'not_found' });
    expect(s.store.listAgentFacts(s.ownerId, s.a).map((row) => row.id)).toEqual(['f-a']);
    expect(s.store.listPinned(s.ownerId, s.a).map((row) => row.id)).toEqual(['p-a']);
    expect(messageRow(s, 'm-a')).toEqual({ text: '我喜欢喝龙井', excluded: 0 });
    expect(s.store.memoryEpochs(s.ownerId, s.b)).toEqual({ owner: before.owner, agent: before.agent + 1 });
    expect(s.store.memoryEpochs(s.ownerId, s.a)).toEqual(beforeA);
  });

  it('forgets the caller’s pin with an agent epoch bump only', async () => {
    const s = seed();
    pin(s, s.b, 'p-b', '周末去钓鱼', 10);
    const before = s.store.memoryEpochs(s.ownerId, s.b)!;
    const beforeA = s.store.memoryEpochs(s.ownerId, s.a)!;
    const out = await registry().handle('forget_memory', { query: '钓鱼' }, ctx(s, s.b, 'xiaokai'));
    expect(out).toMatchObject({ ok: true, rebuild: 'forget', confirmText: zh.forgetConfirmText });
    expect(s.store.listPinned(s.ownerId, s.b)).toEqual([]);
    expect(s.store.memoryEpochs(s.ownerId, s.b)).toEqual({ owner: before.owner, agent: before.agent + 1 });
    expect(s.store.memoryEpochs(s.ownerId, s.a)).toEqual(beforeA);
  });

  it('forgets a shared profile fact for everyone with an owner epoch bump, but only blanks the caller’s own lines', async () => {
    const s = seed();
    profileFact(s, 'home', 'profile', '家在青岛');
    say(s, s.a, 'm-a', '我家在青岛', 20);
    say(s, s.b, 'm-b', '我家在青岛', 30);
    const before = s.store.memoryEpochs(s.ownerId, s.b)!;
    const ledger = new ConversationLedger();
    ledger.addUser('我家在青岛', 40);
    const out = await registry().handle('forget_memory', { query: '青岛' }, ctx(s, s.b, 'xiaokai', ledger));
    expect(out).toMatchObject({ ok: true, rebuild: 'forget' });
    expect(s.store.listProfileFacts(s.ownerId)).toEqual([]);
    expect(s.store.memoryEpochs(s.ownerId, s.b)!.owner).toBe(before.owner + 1);
    expect(messageRow(s, 'm-b').excluded).toBe(1);
    // Voice forget is said in front of one character: other characters' lines stay (spec, on purpose).
    expect(messageRow(s, 'm-a')).toEqual({ text: '我家在青岛', excluded: 0 });
    expect(ledger.recent.map((entry) => entry.text)).not.toContain('我家在青岛');
  });

  it('reports memory_unavailable without an agent', async () => {
    const s = seed();
    const { agentId: _agentId, ...noAgent } = ctx(s, s.a, 'xiaonuan');
    await expect(registry().handle('forget_memory', { query: '青岛' }, noAgent)).resolves.toEqual({ ok: false, error: 'memory_unavailable' });
  });
});

describe('recall_memory scope', () => {
  it('finds only the caller’s own lines (FTS, LIKE, and vague recent)', async () => {
    const s = seed();
    say(s, s.a, 'm-a1', '我一直想看恐怖片', 20);
    say(s, s.a, 'm-a2', '茶', 21);
    say(s, s.b, 'm-b1', '我周末去钓鱼了', 30);
    const fromB = (query: string) => registry().handle('recall_memory', { query }, ctx(s, s.b, 'xiaokai'));
    await expect(fromB('恐怖片')).resolves.toMatchObject({ spokenText: zh.recall.emptyText, spokenFound: false });
    await expect(fromB('茶')).resolves.toMatchObject({ spokenText: zh.recall.emptyText, spokenFound: false });
    const recent = await fromB('上次聊过什么');
    expect(recent.spokenText).toContain('我周末去钓鱼了');
    expect(recent.spokenText).not.toContain('恐怖片');
    const fromA = await registry().handle('recall_memory', { query: '恐怖片' }, ctx(s, s.a, 'xiaonuan'));
    expect(fromA.spokenText).toContain('我一直想看恐怖片');
  });

  it('reports memory_unavailable without an agent', async () => {
    const s = seed();
    const { agentId: _agentId, ...noAgent } = ctx(s, s.a, 'xiaonuan');
    await expect(registry().handle('recall_memory', { query: '恐怖片' }, noAgent)).resolves.toEqual({ ok: false, error: 'memory_unavailable' });
  });
});
```

- [x] **Step 4: 运行，确认失败**

```bash
npm test -w gateway -- test/list-forget-scope.test.ts
```

Expected：
- `list_memory` 用例 FAIL（`unknown_tool`）；
- forget 的 epoch 断言 FAIL（Task 2 适配后 forget 仍 bump owner epoch，或者用的是 `runAfterEpochBump`）；
- `memory_unavailable without an agent` 的 forget / recall 用例可能 FAIL（取决于 Task 2 的兜底写法）；
- recall 隔离用例应已 PASS（Task 2 已改 store 作用域），作为回归保护。

- [x] **Step 5: 实现 `list.ts` 并注册**

`gateway/src/session/tools/list.ts`：

```ts
import { z } from 'zod';
import type { ListCopy } from '../../i18n/types.ts';
import { oneLine } from '../../memory/userText.ts';
import type { ToolContext, ToolHandler, ToolOutcome } from './registry.ts';

/** No arguments: what to read is decided by the server-side scope only. */
const ListSchema = z.object({}).strict();

export interface ListOptions {
  copy: ListCopy;
  /** gateway/config/memory.json listMaxItems. */
  maxItems: number;
}

/** Trailing sentence punctuation would double up with the joiner. */
function bare(text: string): string {
  return oneLine(text).replace(/[\s。．.!！?？；;，,、]+$/u, '');
}

/** Template only, never a text model: zero room for invented memories (spec 语音能力). */
export function listTool(options: ListOptions): ToolHandler {
  const { copy } = options;
  return {
    spec: {
      name: 'list_memory',
      description: copy.toolDescription,
      parameters: { type: 'object', properties: {} },
    },
    async handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      if (!ListSchema.safeParse(args ?? {}).success) return { ok: false, error: 'invalid_args' };
      const { store, ownerId, agentId } = ctx;
      if (!store || !ownerId || !agentId) return { ok: false, error: 'memory_unavailable' };
      const pinned = store.listPinned(ownerId, agentId);
      const profile = store.listProfileFacts(ownerId).filter((row) => row.category === 'profile');
      const facts = store.listAgentFacts(ownerId, agentId);
      const candidates = [
        ...pinned.filter((row) => !row.sensitive).map((row) => row.text),
        ...profile.map((row) => row.text),
        ...facts.filter((row) => !row.sensitive).map((row) => row.text),
      ].map(bare).filter((text) => text.length > 0);
      const items = [...new Set(candidates)].slice(0, options.maxItems);
      // Health stays off the speaker (others in the room); the settings page shows it.
      const hasHealth = pinned.some((row) => row.sensitive) || facts.some((row) => row.category === 'health');
      if (items.length === 0) {
        return hasHealth
          ? { ok: true, spokenText: copy.sensitiveHint, spokenFound: true }
          : { ok: true, spokenText: copy.emptyText, spokenFound: false };
      }
      const body = `${copy.introText}${items.join(copy.itemJoiner)}${copy.itemEnd}${hasHealth ? copy.sensitiveHint : ''}`;
      return { ok: true, spokenText: body.trim(), spokenFound: true };
    },
  };
}
```

`gateway/src/session/tools/registry.ts`：

1. `import { listTool } from './list.ts';`
2. `ToolRegistryOptions` 末尾加：

```ts
  /** list_memory cap; omitted = gateway/config/memory.json listMaxItems. */
  listMaxItems?: number;
```

3. 工具数组里 `pinTool(...)` 之后加：

```ts
    listTool({
      copy: options.memory.list,
      maxItems: options.listMaxItems ?? MEMORY_DEFAULTS.listMaxItems,
    }),
```

4. 类注释改为 `/** Recall, forget, pin, list, consent, perform_action, and weather. Unknown names do not throw. */`。

`gateway/src/session/session.ts`：

- `SessionDeps` 的 `pin?` 下面加：

```ts
  /** list_memory cap (gateway/config/memory.json). Omitted in tests: the registry reads that file. */
  listMaxItems?: number;
```

- `toolsFor()` 的 `createToolRegistry({...})` 参数里加 `listMaxItems: this.deps.listMaxItems,`。

`gateway/src/index.ts` 的 `new Session({...})` 参数里，Task 9 加的 `pin: ...` 下面加：

```ts
      listMaxItems: memory.listMaxItems,
```

- [x] **Step 6: 改 forget 的作用域与 epoch**

`gateway/src/session/tools/forget.ts`：`forgetTool` 的 `handle` 整体替换为下面的版本（`ForgetSchema`、spec 部分、`runAfterEpochBump` 保持不变，`runAfterEpochBump` 留给 `consent.ts`）：

```ts
    async handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      const parsed = ForgetSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: 'invalid_args' };
      const { store, ownerId, agentId } = ctx;
      if (!store || !ownerId || !agentId) return { ok: false, error: 'memory_unavailable' };
      const query = parsed.data.query;
      // Bump first so an in-flight extraction goes stale (spec §5). A shared hit affects every
      // character's view, so it bumps the owner epoch; a private hit only this agent's.
      const shared = store.listProfileFacts(ownerId).some((row) => row.text.includes(query));
      if (shared) store.bumpOwnerEpoch(ownerId);
      else store.bumpAgentEpoch(ownerId, agentId);
      // Scope: this agent's private rows and pins, plus the shared layer; lines of this agent only.
      const deleted = store.forgetMatches(ownerId, agentId, query, ftsMatch(query, 'all'), ctx.sessionId, ctx.triggerText);
      ctx.ledger.forget(query, ctx.triggerText);
      const total = Object.values(deleted).reduce((sum: number, count) => sum + Number(count), 0);
      // Do not confirm a delete that matched nothing; the model must not claim success.
      if (total === 0) return { ok: false, error: 'not_found' };
      return { ok: true, rebuild: 'forget', confirmText };
    },
```

文件头的 `import type { MemoryStore } from '../../memory/store.ts';` 仍被 `runAfterEpochBump` 使用，保留。

- [x] **Step 7: 收紧 recall 的可用性检查**

`gateway/src/session/tools/recall.ts` 的 `recall()`：

1. `if (!ctx.store || !ctx.ownerId) return { ok: false, error: 'memory_unavailable' };` 改为：

```ts
  const { store, ownerId, agentId } = ctx;
  // Scope keys come only from the server-side session (spec §5); no agent, no recall.
  if (!store || !ownerId || !agentId) return { ok: false, error: 'memory_unavailable' };
```

2. 函数里三处 store 调用改用这三个局部变量（如果 Task 2 写成 `ctx.agentId!` 或 `ctx.agentId ?? ''`，一并替换）：

```ts
    const recent = store.recentUserMessages(ownerId, agentId, 12)
```

```ts
  const rows = match
    ? store.searchMessages(ownerId, agentId, match, 50)
    : [...searchText].length === 1
      ? store.searchMessagesLike(ownerId, agentId, `%${escapeLike(searchText)}%`, 50)
      : [];
```

其余代码（证据过滤、`sameUtterance`、包装、`outcome`）一律不动。

```bash
grep -n "ctx.store\|ctx.ownerId\|ctx.agentId" gateway/src/session/tools/recall.ts
```

Expected：只剩解构那一行用到 `ctx.store` / `ctx.ownerId` / `ctx.agentId`（`ctx.textClient`、`ctx.triggerText` 照旧）。

- [x] **Step 8: 运行，确认通过；适配旧用例**

```bash
npm test -w gateway -- test/list-forget-scope.test.ts test/memory-tools.test.ts test/multilingual.test.ts
```

Expected：`list-forget-scope.test.ts` 全部 PASS。如果 `memory-tools.test.ts` 里 forget 的 epoch 断言因为「私有命中不再 bump owner epoch」失败，按「调用方适配」一节改成 `memoryEpochs(...).agent` 的断言。改完重跑，全部 PASS。

```bash
npm test -w gateway && npm run typecheck -w gateway
```

Expected：全量 PASS，typecheck 0 错误。

- [x] **Step 9: 提交**

```bash
git add gateway/src/session/tools/list.ts gateway/src/session/tools/forget.ts gateway/src/session/tools/recall.ts \
  gateway/src/session/tools/registry.ts gateway/src/session/session.ts gateway/src/index.ts \
  gateway/src/i18n/types.ts gateway/src/i18n/load.ts \
  gateway/config/i18n/zh/memory.json gateway/config/i18n/ja/memory.json gateway/config/i18n/en/memory.json \
  gateway/test/list-forget-scope.test.ts gateway/test/memory-tools.test.ts
git commit -m "feat(memory): list what a character remembers and scope forget and recall

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收清单

- [x] `list_memory` 的顺序是钉住（新的在前）→ profile → 本角色非敏感事实；最多 `listMaxItems` 条；称呼不念、不计数；原话和 episodes 不读。
- [x] 有健康类（敏感钉住或 health 事实）时只附 `sensitiveHint`，不念内容；什么都没有时播 `emptyText`。
- [x] `list_memory` 只用模板，结果走 grounded `spokenText`（Task 9 的会话路径），不带 `confirmText`。
- [x] 隔离：从角色 B 发起的 list / forget / recall 都碰不到角色 A 的钉住、私有事实和原话；共享 profile 两边都看得到。
- [x] 忘掉命中共享层：profile 行删除，owner epoch 加一；只 blank 当前角色的原话，其他角色的原话保留。
- [x] 忘掉只命中私有或钉住：agent epoch 加一，owner epoch 不变。
- [x] 日志里没有记忆条目。
- [x] 全量命令通过：

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
```

- [x] 报告里写明：召回作用域已改，真实记忆库召回探针（「上次聊到哪儿了 / 上次聊过电影吗 / 我说过喜欢喝茶吗」）按 AGENTS.md 要求在 Task 17 跑；如果本机有 `DASHSCOPE_API_KEY` 和真实库，本任务也可以先跑一次并记录结果。
