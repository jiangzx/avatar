# Task 3: 抽取按角色运行、分类白名单与来源编号（Q36）

**目标：** 抽取 worker 的任务键改为 `(ownerId, agentId)`（队列仍按 owner 串行），一次只处理一个角色的待抽取消息；`user_facts` 的 category 改为白名单校验，不在白名单里的 op 丢弃并计数、不让整批失败；称呼只存纯名字；抽取输入给用户行加 `u1..uN` 编号，模型在 `sources` 里标出依据，网关校验后映射成消息 id 存进 `source_message_ids`。抽取提示词增加 `profile` 类和 `sources` 规则。

**实现的 spec 章节：** 技术设计第 5 节「抽取队列」「writeExtraction」「epoch」「抽取提示词」「来源标注（Q36）」；产品设计「记忆分层」（`profile` 的定义、健康永不进共享层）；测试与验收「隔离测试：抽取」「逐条删除连带原话」里属于抽取的部分（来源校验、缺 `sources` 不失败、水位推进、并集）。

**前置：** Task 2 已完成（store 的 `listPendingMessages(ownerId, agentId)`、`memoryForExtract(ownerId, agentId)`、`writeExtraction(ownerId, agentId, change)`、`memoryEpochs`、`agentsPendingExtraction`、`FactChange.sourceMessageIds`、两层 epoch 的 `applyExtractOps`）。

**高风险区提醒：** 本任务改的是抽取（「记忆与回忆：已踩过的坑」第 10 条）。编号只用于追溯来源，**不改变「只以用户原话为依据」**：抽取输入仍然只含用户行（`worker.ts:109`），助手回复只推进水位；健康事实仍然强制 `sensitive`。改完必须跑 gateway 全量测试和 typecheck；真实抽取探针（A6）在 Task 17 跑。

## Files

- Modify（整体替换）: `gateway/src/memory/extract.ts`（Task 2 之后约 180 行）
- Modify: `gateway/src/memory/snapshot.ts`（新增导出 `ADDRESSING_MAX_CHARS`、`plainAddressing`；`renderMemoryViews` 给纯名字加称呼标签，当前 :71-92）
- Modify: `gateway/src/memory/worker.ts`（入口改为 `enqueue(ownerId, agentId, reason, language?)`，旧的通用排队改名 `schedule`；`run` 和 `renderInput` 加编号与来源映射；`withExtraction` 带 agent）
- Modify: `gateway/src/session/session.ts`（构造器里的 `onQuietRest`，当前 :320-338；用户 final 后的按轮抽取，当前 :1113-1120）
- Modify: `gateway/src/index.ts`（启动补抽，Task 2 改过的 :286-289）
- Modify: `gateway/roles/_shared/zh/extract.md`、`gateway/roles/_shared/ja/extract.md`、`gateway/roles/_shared/en/extract.md`（各 41 行）
- Test: `gateway/test/extract.test.ts`（新增用例 + 一处类型修正）
- Test: `gateway/test/worker.test.ts`（入口改名 + 新增按角色抽取用例）
- Test: `gateway/test/snapshot.test.ts`（新增纯名字用例）
- Test（适配）: `gateway/test/memory-tools.test.ts`、`gateway/test/session.test.ts`、`gateway/test/memory-acceptance.test.ts`

## Interfaces

- Consumes（Task 2，`gateway/src/memory/store.ts`）：
  ```ts
  listPendingMessages(ownerId: string, agentId: string): PendingMessage[];
  agentsPendingExtraction(): Array<{ ownerId: string; agentId: string }>;
  memoryForExtract(ownerId: string, agentId: string): ExtractMemory;
  writeExtraction(ownerId: string, agentId: string, change: ExtractionChange): void;
  memoryEpochs(ownerId: string, agentId: string): { owner: number; agent: number } | undefined;
  // FactChange add/update carry sourceMessageIds?: readonly string[]; the store unions them on update.
  ```
  以及 Task 2 的 `applyExtractOps(store, ownerId, agentId, epochsAtStart, ops, messageIds)`（本任务把 `ops` 的类型放宽为 `readonly ResolvedOp[]`，签名其余不变）。
- Produces（与总览 C3 一致）：
  - `MemoryWorker.enqueue(ownerId: string, agentId: string, reason: ExtractReason, language?: Language): Promise<void>`，队列仍按 owner 串行。`MemoryExtractor` 接口改为只有这个方法。`language` 是可选的第 4 个参数（会话按当前语言抽取，现有行为），见文末「与总览的出入」。
  - 抽取输入的用户行带 `[u1]`…`[uN]` 前缀，只在本次运行内有效，网关映射回 `PendingMessage.id`。
  - `user_facts` op：category 用 `z.enum(['addressing','profile','preference','person','health','other'])`；`sources: z.array(z.string().max(8)).max(20).optional()`，缺省按 `[]` 处理。
  - `addressing`/`profile` 写入 `profile_facts`，addressing 只存纯名字；其余写入本 agent 的 `agent_facts`；`safety` 不在抽取白名单里，只能由 writer 写入。
  - epoch：开始时读 `memoryEpochs`，写入前在同一事务里复核两层（复核逻辑已在 Task 2 的 `applyExtractOps` 里，本任务补 worker 级测试）。
- 本任务额外导出（后续任务可以依赖）：
  - `extract.ts`：`EXTRACT_CATEGORIES`、`parseExtractBatch(raw): ExtractBatch`、`resolveFactSources(ops, refs)`、`normalizeAddressingOps(ops, addressingIds?)`、`type ResolvedOp`；`parseExtractOps(raw)` 保留（= `parseExtractBatch(raw).ops`）。
  - `snapshot.ts`：`ADDRESSING_MAX_CHARS = 20`（与 spec 第 7 节 `PUT /memory/addressing` 的 `string(1..20)` 一致，Task 11 复用）、`plainAddressing(text): string`。

## 调用方适配

| 调用方 | 断在哪里 | 最小适配（行为等价） |
|---|---|---|
| `src/session/session.ts` 构造器 `onQuietRest`（当前 :337） | `extractOwner` 删除 | 读出 `ctx.agentId`；条件改为 `extractor && ownerId && agentId`；调用 `extractor.enqueue(ownerId, agentId, 'silence', this.language)` |
| `src/session/session.ts` 按轮抽取（当前 :1115-1120） | 同上 | 同上，`'turns'` |
| `src/memory/worker.ts` `withExtraction` | 同上 | 要求 `ctx.ownerId && ctx.agentId`，调用 `enqueue(..., 'session_end', ctx.language)` |
| `src/index.ts` 启动补抽 | `extractOwner` 删除 | 遍历 `agentsPendingExtraction()`，逐个 `enqueue(ownerId, agentId, 'startup')`（同一 owner 仍然串行） |
| `test/worker.test.ts` 的 `queued.enqueue('owner-a', async () => …)`（:42、:47、:269） | 通用排队改名 | 改为 `queued.schedule(...)` |
| `test/worker.test.ts`、`test/memory-tools.test.ts` 的 `.extractOwner(x.ownerId, …)` | 入口改名 | 改为 `.enqueue(x.ownerId, x.agentId, …)` |
| `test/worker.test.ts:276-287` 的假 worker | 接口改了 | 改成 `enqueue` 并带 agentId，见 Step 3 |
| `test/session.test.ts:1480,1496` 的假 worker | 接口改了 | `worker: { enqueue: async (_ownerId, _agentId, reason, language) => … }` |
| `test/extract.test.ts:231` | `category` 现在是枚举，`'preference'` 推断成 `string` 不再可赋值 | 改为 `category: 'preference' as const` |
| `test/memory-acceptance.test.ts` 两处称呼期望 | 称呼现在存纯名字 | `'称呼：王叔'` → `'王叔'`（只改读取 `factRows` 的两处；快照里渲染出来的仍是 `称呼：王叔`） |

## Steps

- [x] **Step 1: 写失败的解析与映射测试**

在 `gateway/test/extract.test.ts` 顶部把 extract 的 import 改为：

```ts
import {
  applyExtractOps, loadExtractPrompt, normalizeAddressingOps, parseExtractBatch, parseExtractOps, resolveFactSources, vetFollowupQuotes,
} from '../src/memory/extract.ts';
```

把 :231 的 `const fact = { op: 'add' as const, table: 'user_facts' as const, category: 'preference', text: '喜欢喝茶' };` 改为 `category: 'preference' as const`。

在 `describe('parseExtractOps', ...)`（:35-46）之后加入：

```ts
describe('parseExtractBatch', () => {
  it('drops user_facts ops outside the category whitelist without failing the batch', () => {
    const batch = parseExtractBatch({ ops: [
      { op: 'add', table: 'user_facts', category: 'safety', text: '想写安全类' },
      { op: 'add', table: 'user_facts', category: 'misc', text: '不在白名单' },
      { op: 'add', table: 'user_facts', text: '没有分类' },
      { op: 'update', table: 'user_facts', id: 'f1', category: 'secret', text: '改成怪分类' },
      { op: 'update', table: 'user_facts', id: 'f2', text: '只改文字', sources: ['u1'] },
      { op: 'add', table: 'user_facts', category: 'profile', text: '老家山东', sources: ['u1'] },
      { op: 'remove', table: 'user_facts', id: 'f3' },
    ] });
    expect(batch.droppedCategory).toBe(4);
    expect(batch.ops).toEqual([
      { op: 'update', table: 'user_facts', id: 'f2', text: '只改文字', sources: ['u1'] },
      { op: 'add', table: 'user_facts', category: 'profile', text: '老家山东', sources: ['u1'] },
      { op: 'remove', table: 'user_facts', id: 'f3' },
    ]);
  });

  it('accepts every whitelisted category', () => {
    const categories = ['addressing', 'profile', 'preference', 'person', 'health', 'other'];
    const batch = parseExtractBatch({ ops: categories.map((category) => ({ op: 'add', table: 'user_facts', category, text: category, sources: ['u1'] })) });
    expect(batch.droppedCategory).toBe(0);
    expect(batch.ops.map((op) => (op as { category: string }).category)).toEqual(categories);
  });

  it('treats missing or malformed sources as empty and keeps the op', () => {
    const batch = parseExtractBatch({ ops: [
      { op: 'add', table: 'user_facts', category: 'preference', text: '没有来源' },
      { op: 'add', table: 'user_facts', category: 'preference', text: '来源是字符串', sources: 'u1' },
      { op: 'add', table: 'user_facts', category: 'preference', text: '来源太长', sources: ['u1234567890'] },
      { op: 'add', table: 'user_facts', category: 'preference', text: '来源太多', sources: Array.from({ length: 21 }, (_, i) => `u${i + 1}`) },
      { op: 'add', table: 'user_facts', category: 'preference', text: '来源有数字', sources: [1] },
      { op: 'add', table: 'user_facts', category: 'preference', text: '来源正常', sources: ['u1', 'u2'] },
    ] });
    expect(batch.missingSources).toBe(1);
    expect(batch.invalidSources).toBe(4);
    expect(batch.ops).toHaveLength(6);
    expect(batch.ops.map((op) => (op as { sources?: string[] }).sources)).toEqual([undefined, undefined, undefined, undefined, undefined, ['u1', 'u2']]);
  });

  it('still rejects a malformed op, bad JSON and more than 40 ops', () => {
    expect(() => parseExtractBatch({ ops: [{ table: 'user_facts', category: 'preference', text: '没有 op' }] })).toThrow();
    expect(() => parseExtractBatch({ ops: [{ op: 'add', table: 'episodes' }] })).toThrow();
    expect(() => parseExtractBatch('{')).toThrow();
    expect(() => parseExtractBatch({ ops: Array.from({ length: 41 }, () => ({ op: 'remove', table: 'user_facts', id: 'f' })) })).toThrow();
  });

  it('keeps parseExtractOps as the ops of the batch', () => {
    expect(parseExtractOps('```json\n{"ops":[{"op":"add","table":"user_facts","category":"other","text":"每天散步","sources":["u1"]}]}\n```'))
      .toEqual([{ op: 'add', table: 'user_facts', category: 'other', text: '每天散步', sources: ['u1'] }]);
  });
});

describe('resolveFactSources', () => {
  const refs = new Map([['u1', 'm-1'], ['u2', 'm-2']]);

  it('maps refs of this run to message ids, drops unknown refs, and dedupes', () => {
    const resolved = resolveFactSources([
      { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sources: ['u2', 'u9', 'u2', 'm-1', 'u1'] },
      { op: 'update', table: 'user_facts', id: 'f1', text: '新文字' },
      { op: 'remove', table: 'user_facts', id: 'f2' },
      { op: 'add', table: 'episodes', summary: '聊天' },
    ], refs);
    expect(resolved.droppedSources).toBe(2);
    expect(resolved.ops).toEqual([
      { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sourceMessageIds: ['m-2', 'm-1'] },
      { op: 'update', table: 'user_facts', id: 'f1', text: '新文字', sourceMessageIds: [] },
      { op: 'remove', table: 'user_facts', id: 'f2' },
      { op: 'add', table: 'episodes', summary: '聊天' },
    ]);
  });
});

describe('normalizeAddressingOps', () => {
  it('stores names without the stored label, drops empty or overlong names, and follows updates to the name row', () => {
    const result = normalizeAddressingOps([
      { op: 'add', table: 'user_facts', category: 'addressing', text: '称呼：王叔' },
      { op: 'add', table: 'user_facts', category: 'addressing', text: 'Address as: Hanako' },
      { op: 'add', table: 'user_facts', category: 'addressing', text: '呼び方：' },
      { op: 'add', table: 'user_facts', category: 'addressing', text: `称呼：${'名'.repeat(21)}` },
      { op: 'update', table: 'user_facts', id: 'addr-1', text: '呼び方：ハナ' },
      { op: 'update', table: 'user_facts', id: 'pref-1', text: '称呼：不是名字行' },
      { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶' },
    ], new Set(['addr-1']));
    expect(result.droppedAddressing).toBe(2);
    expect(result.ops).toEqual([
      { op: 'add', table: 'user_facts', category: 'addressing', text: '王叔' },
      { op: 'add', table: 'user_facts', category: 'addressing', text: 'Hanako' },
      { op: 'update', table: 'user_facts', id: 'addr-1', text: 'ハナ' },
      { op: 'update', table: 'user_facts', id: 'pref-1', text: '称呼：不是名字行' },
      { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶' },
    ]);
  });
});
```

在 `describe('extract prompt care rules', ...)` 之后加入：

```ts
describe('extract prompt layers and sources', () => {
  it('teaches the profile category, the whitelist and per-run sources in every language', () => {
    const roles = fileURLToPath(new URL('../roles', import.meta.url));
    const zh = loadExtractPrompt();
    const ja = loadExtractPrompt(join(roles, '_shared', 'ja', 'extract.md'), 'ja');
    const en = loadExtractPrompt(join(roles, '_shared', 'en', 'extract.md'), 'en');
    expect(zh).toContain('addressing、profile、preference、person、health、other');
    expect(ja).toContain('addressing、profile、preference、person、health、other');
    expect(en).toContain('addressing, profile, preference, person, health, other');
    for (const prompt of [zh, ja, en]) {
      expect(prompt).toContain('sources');
      expect(prompt).toContain('[u1]');
      expect(prompt).toContain('"sources":["u1"]');
    }
    expect(zh).toContain('健康信息永远不用 profile');
    expect(zh).toContain('编号只用来标出处');
    expect(ja).toContain('決して profile にせず');
    expect(ja).toContain('出どころを示すためだけ');
    expect(en).toContain('Never use profile for health');
    expect(en).toContain('only mark where a fact came from');
  });
});
```

- [x] **Step 2: 写失败的 snapshot 用例**

在 `gateway/test/snapshot.test.ts` 的 `describe('renderMemoryViews', ...)` 末尾加入：

```ts
  it('labels a plain stored name in the session language', () => {
    const zh = renderMemoryViews({ addressing: ['王叔'], facts: [], tail: [], maxChars: 600, labels: PROMPT_LABELS.zh, rules: zhRules });
    expect(zh.full).toBe('称呼：王叔');
    expect(zh.greeting).toBe('称呼：王叔');
    const en = renderMemoryViews({
      addressing: ['王叔'], facts: [], tail: [], maxChars: 600,
      labels: PROMPT_LABELS.en, rules: { addressingPatterns: i18n.memory.en.addressingPatterns, evidence: i18n.evidence },
    });
    expect(en.full).toBe('Address as: 王叔');
  });
```

并在文件顶部的 snapshot import 里加上 `plainAddressing`，在文件末尾加入：

```ts
describe('plainAddressing', () => {
  it('strips any stored addressing label and folds the name to one line', () => {
    expect(plainAddressing('称呼：王叔')).toBe('王叔');
    expect(plainAddressing('呼び方：花子')).toBe('花子');
    expect(plainAddressing('Address as: Hanako')).toBe('Hanako');
    expect(plainAddressing('  老王 \n')).toBe('老王');
    expect(plainAddressing('称呼：')).toBe('称呼：');
  });
});
```

（只有标签没有名字时正则不匹配，原样返回；`normalizeAddressingOps` 把以 `：`/`:` 结尾的结果当作空名字丢弃，所以 Step 1 里的 `'呼び方：'` 计入 `droppedAddressing`。）

- [x] **Step 3: 写失败的 worker 用例**

先在 `gateway/test/worker.test.ts` 做入口改名（这些是适配，不是新行为）：

```bash
cd gateway
perl -pi -e "s/queued\.enqueue\('owner-a', async/queued.schedule('owner-a', async/g" test/worker.test.ts
perl -pi -e 's/\.extractOwner\((\w+)\.ownerId, /.enqueue($1.ownerId, $1.agentId, /g' test/worker.test.ts test/memory-tools.test.ts
cd ..
grep -n "extractOwner\|queued.enqueue('owner-a'" gateway/test/worker.test.ts gateway/test/memory-tools.test.ts   # only the fake at worker.test.ts:280 should remain
```

把 `it('passes the session context language to session-end extraction', ...)`（:276-287）替换为：

```ts
  it('passes the session context agent and language to session-end extraction', () => {
    const seen: Array<{ ownerId: string; agentId: string; reason: string; language?: string }> = [];
    const base = { started() {}, ended() {}, extract() {} };
    const fake = {
      enqueue: async (ownerId: string, agentId: string, reason: string, language?: string) => {
        seen.push({ ownerId, agentId, reason, language });
      },
    };
    const lifecycle = withExtraction(base, fake as unknown as MemoryWorker);
    lifecycle.extract?.('s1', { ownerId: 'owner-1', agentId: 'agent-1', language: 'ja' } as SessionContext, 'client_end');
    lifecycle.extract?.('s2', { ownerId: 'owner-1', language: 'ja' } as SessionContext, 'client_end');
    expect(seen).toEqual([{ ownerId: 'owner-1', agentId: 'agent-1', reason: 'session_end', language: 'ja' }]);
  });
```

把 Task 2 在 `worker.test.ts` 顶部加的 `import { factRows, seedOwner } from './helpers/memory.ts';` 换成：

```ts
import { agentOf, factRows, seedOwner, type Who } from './helpers/memory.ts';
```

在文件末尾加入新的 describe：

```ts
describe('per-character extraction', () => {
  function say(store: SqliteMemoryStore, who: Who, id: string, text: string, now: number, role: 'user' | 'assistant' = 'user'): void {
    store.insertMessage({ id, sessionId: 's1', ownerId: who.ownerId, agentId: who.agentId, role, text, bigrams: '', now });
  }
  const sourcesOf = (db: DatabaseSync, text: string): string[] => {
    const row = db.prepare(
      'SELECT source_message_ids AS ids FROM agent_facts WHERE text = ? UNION ALL SELECT source_message_ids AS ids FROM profile_facts WHERE text = ?',
    ).get(text, text) as { ids: string } | undefined;
    if (!row) throw new Error(`no fact: ${text}`);
    return JSON.parse(row.ids) as string[];
  };
  const extractedFlag = (db: DatabaseSync, id: string) => (db.prepare('SELECT extracted FROM messages WHERE id = ?').get(id) as { extracted: number }).extracted;
  const logged = (writes: string[], event: string) => writes
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);

  it('numbers user lines u1..uN and stores the cited message ids', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    say(store, a, 'm1', '我老家在山东', 2);
    say(store, a, 'm2', '山东是好地方', 3, 'assistant');
    say(store, a, 'm3', '我喜欢喝茶', 4);
    let seen = '';
    const client: TextModelClient = {
      complete: async (input) => {
        seen = input.user;
        return JSON.stringify({ ops: [
          { op: 'add', table: 'user_facts', category: 'profile', text: '老家山东', sources: ['u1'] },
          { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sources: ['u2', 'u2'] },
        ] });
      },
    };
    await worker(store, client).enqueue(a.ownerId, a.agentId, 'session_end');
    expect(seen).toContain('[u1] 用户：我老家在山东');
    expect(seen).toContain('[u2] 用户：我喜欢喝茶');
    expect(seen).not.toContain('山东是好地方');
    expect(sourcesOf(db, '老家山东')).toEqual(['m1']);
    expect(sourcesOf(db, '喜欢喝茶')).toEqual(['m3']);
    expect(store.listProfileFacts(a.ownerId).map((row) => row.text)).toEqual(['老家山东']);
  });

  it('keeps a fact without sources and still advances the watermark', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    say(store, a, 'm1', '我喜欢喝茶', 2);
    const client: TextModelClient = {
      complete: async () => JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶' }] }),
    };
    await worker(store, client).enqueue(a.ownerId, a.agentId, 'turns');
    expect(factRows(store, a.ownerId, a.agentId)).toEqual([{ category: 'preference', text: '喜欢喝茶' }]);
    expect(sourcesOf(db, '喜欢喝茶')).toEqual([]);
    expect(extractedFlag(db, 'm1')).toBe(1);
  });

  it('drops refs outside this run, removes malformed sources, and logs only counts', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    say(store, a, 'm1', '我喜欢喝茶', 2);
    say(store, a, 'm2', '我每天散步', 3);
    const client: TextModelClient = {
      complete: async () => JSON.stringify({ ops: [
        { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sources: ['u1', 'u9', 'm-other', 'u0'] },
        { op: 'add', table: 'user_facts', category: 'other', text: '每天散步', sources: 'u2' },
        { op: 'add', table: 'user_facts', category: 'misc', text: '怪分类' },
      ] }),
    };
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    await worker(store, client).enqueue(a.ownerId, a.agentId, 'session_end');
    spy.mockRestore();
    expect(sourcesOf(db, '喜欢喝茶')).toEqual(['m1']);
    expect(sourcesOf(db, '每天散步')).toEqual([]);
    expect(factRows(store, a.ownerId, a.agentId).map((row) => row.text)).toEqual(['喜欢喝茶', '每天散步']);
    expect(extractedFlag(db, 'm1')).toBe(1);
    expect(extractedFlag(db, 'm2')).toBe(1);
    expect(logged(writes, 'memory_extract')).toEqual([expect.objectContaining({
      result: 'applied', ops: 2, droppedCategory: 1, missingSources: 0, invalidSources: 1, droppedSources: 3, droppedAddressing: 0,
    })]);
    const out = writes.join('');
    for (const text of ['喜欢喝茶', '每天散步', '怪分类', '我喜欢喝茶']) expect(out).not.toContain(text);
  });

  it('unions sources when a later run updates the same fact', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    say(store, a, 'm1', '我喜欢喝茶', 2);
    await worker(store, {
      complete: async () => JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sources: ['u1'] }] }),
    }).enqueue(a.ownerId, a.agentId, 'turns');
    say(store, a, 'm2', '我现在更喜欢绿茶', 3);
    await worker(store, {
      complete: async () => {
        const id = store.listAgentFacts(a.ownerId, a.agentId)[0]!.id;
        return JSON.stringify({ ops: [{ op: 'update', table: 'user_facts', id, text: '喜欢喝绿茶', sources: ['u1'] }] });
      },
    }).enqueue(a.ownerId, a.agentId, 'turns');
    expect(sourcesOf(db, '喜欢喝绿茶')).toEqual(['m1', 'm2']);
  });

  it('stores the name as a plain shared row, drops an overlong one, and keeps health private', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    const kai = agentOf(store, a.ownerId, 'xiaokai');
    say(store, a, 'm1', '叫我王叔就行，我有高血压，退休前是老师', 2);
    await worker(store, {
      complete: async () => JSON.stringify({ ops: [
        { op: 'add', table: 'user_facts', category: 'addressing', text: '称呼：王叔', sources: ['u1'] },
        { op: 'add', table: 'user_facts', category: 'addressing', text: `称呼：${'名'.repeat(21)}`, sources: ['u1'] },
        { op: 'add', table: 'user_facts', category: 'profile', text: '退休前是老师', sources: ['u1'] },
        { op: 'add', table: 'user_facts', category: 'health', text: '有高血压', sensitive: false, sources: ['u1'] },
      ] }),
    }).enqueue(a.ownerId, a.agentId, 'session_end');
    expect(store.listProfileFacts(kai.ownerId).map(({ category, text }) => ({ category, text }))).toEqual([
      { category: 'addressing', text: '王叔' },
      { category: 'profile', text: '退休前是老师' },
    ]);
    expect(store.listAgentFacts(a.ownerId, a.agentId).map(({ category, text, sensitive }) => ({ category, text, sensitive }))).toEqual([
      { category: 'health', text: '有高血压', sensitive: true },
    ]);
    expect(store.listAgentFacts(kai.ownerId, kai.agentId)).toEqual([]);
  });

  it('extracts one character at a time: A lines and private memory never reach B', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    const b = agentOf(store, a.ownerId, 'xiaokai');
    say(store, a, 'a1', '我喜欢喝茶', 2);
    say(store, b, 'b1', '我爱下棋', 3);
    store.writeExtraction(a.ownerId, a.agentId, {
      now: 4, messageIds: [], notes: [], episodes: [], followups: [],
      facts: [{ op: 'add', category: 'preference', text: 'A的私有偏好' }, { op: 'add', category: 'profile', text: '老家山东' }],
    });
    const privateA = store.listAgentFacts(a.ownerId, a.agentId)[0]!.id;
    let seen = '';
    await worker(store, {
      complete: async (input) => {
        seen = input.user;
        return JSON.stringify({ ops: [
          { op: 'add', table: 'user_facts', category: 'preference', text: '爱下棋', sources: ['u1'] },
          { op: 'remove', table: 'user_facts', id: privateA },
        ] });
      },
    }).enqueue(b.ownerId, b.agentId, 'session_end');
    expect(seen).toContain('[u1] 用户：我爱下棋');
    expect(seen).not.toContain('我喜欢喝茶');
    expect(seen).not.toContain('A的私有偏好');
    expect(seen).toContain('老家山东');
    expect(store.listAgentFacts(b.ownerId, b.agentId).map((row) => row.text)).toEqual(['爱下棋']);
    expect(sourcesOf(db, '爱下棋')).toEqual(['b1']);
    expect(store.listAgentFacts(a.ownerId, a.agentId).map((row) => row.text)).toEqual(['A的私有偏好']);
    expect(extractedFlag(db, 'a1')).toBe(0);
    expect(extractedFlag(db, 'b1')).toBe(1);
  });

  it('drops a result when this agent epoch moves during the model call, but not for another agent', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    const b = agentOf(store, a.ownerId, 'xiaokai');
    say(store, a, 'a1', '我喜欢喝茶', 2);
    const addTea = JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sources: ['u1'] }] });
    await worker(store, { complete: async () => { store.bumpAgentEpoch(a.ownerId, a.agentId); return addTea; } }).enqueue(a.ownerId, a.agentId, 'turns');
    expect(store.listAgentFacts(a.ownerId, a.agentId)).toEqual([]);
    expect(extractedFlag(db, 'a1')).toBe(0);
    await worker(store, { complete: async () => { store.bumpAgentEpoch(b.ownerId, b.agentId); return addTea; } }).enqueue(a.ownerId, a.agentId, 'turns');
    expect(store.listAgentFacts(a.ownerId, a.agentId).map((row) => row.text)).toEqual(['喜欢喝茶']);
    expect(extractedFlag(db, 'a1')).toBe(1);
  });

  it('runs jobs of one owner strictly in order across characters', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    const b = agentOf(store, a.ownerId, 'xiaokai');
    say(store, a, 'a1', '我喜欢喝茶', 2);
    say(store, b, 'b1', '我爱下棋', 3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const queued = worker(store, {
      complete: async (input) => {
        const who = input.user.includes('我喜欢喝茶') ? 'a' : 'b';
        order.push(`${who}-start`);
        if (who === 'a') await gate;
        order.push(`${who}-done`);
        return '{"ops":[]}';
      },
    });
    const first = queued.enqueue(a.ownerId, a.agentId, 'turns');
    const second = queued.enqueue(b.ownerId, b.agentId, 'turns');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['a-start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-done', 'b-start', 'b-done']);
  });
});
```

`test/session.test.ts` 的两个假 worker（:1480、:1496）改为：

```ts
      worker: { enqueue: async (_ownerId, _agentId, reason) => { reasons.push(reason); } },
```

```ts
      worker: { enqueue: async (_ownerId, _agentId, reason, language) => { seen.push({ reason, language }); } },
```

- [x] **Step 4: 跑测试，确认失败**

```bash
npm test -w gateway -- test/extract.test.ts test/snapshot.test.ts test/worker.test.ts
```

预期：`parseExtractBatch` / `resolveFactSources` / `normalizeAddressingOps` / `plainAddressing` 不是导出（`is not a function` 或 import 报错）；`worker.enqueue` 的签名不对（`queued.schedule is not a function`）；`[u1]` 前缀不存在；`labels a plain stored name` 得到 `王叔` 而不是 `称呼：王叔`。

- [x] **Step 5: 在 `snapshot.ts` 加纯名字工具，并给纯名字加标签**

在 `gateway/src/memory/snapshot.ts` 的 `STORED_ADDRESSING`（当前 :100）之后加入：

```ts
/** Longest stored name; matches PUT /memory/addressing text(1..20) in spec §7. */
export const ADDRESSING_MAX_CHARS = 20;

/**
 * Plain name from a stored or extracted addressing line: drops a "称呼：/呼び方：/Address as:" label and folds
 * it to one trimmed line. A bare label with no name stays as it is; callers treat that as not a name.
 */
export function plainAddressing(text: string): string {
  const line = oneLine(text);
  return STORED_ADDRESSING.exec(line)?.[1]?.trim() ?? line;
}

/** Stored names are plain since Task 3: label them, but keep legacy labelled or self-introduction text as before. */
function labelledName(text: string, labels: PromptLabels, patterns: readonly RegExp[]): string {
  const line = oneLine(text);
  if (STORED_ADDRESSING.test(line) || patterns.some((pattern) => pattern.test(line))) return line;
  return `${labels.addressing}${labels.separator}${line}`;
}
```

在 `renderMemoryViews`（当前 :71-92）里，把

```ts
  const nameFacts = input.addressing.filter(Boolean).map((text) => ({ category: 'addressing', text }));
```

改为

```ts
  const labels = input.labels ?? PROMPT_LABELS.zh;
  const patterns = input.rules?.addressingPatterns ?? [];
  const nameFacts = input.addressing.filter(Boolean).map((text) => ({ category: 'addressing', text: labelledName(text, labels, patterns) }));
```

（`STORED_ADDRESSING` 没有 `g` 标志，`addressingPatterns` 由 `compilePattern` 用 `'iu'` 编译，`test()` 没有 `lastIndex` 副作用。）

- [x] **Step 6: 整体替换 `gateway/src/memory/extract.ts`**

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Language } from '@anyidea/protocol';
import { z } from 'zod';
import type { SafetyRules } from '../config.ts';
import { isMemoryEvidence, type EvidenceRules } from './evidence.ts';
import { normalizeForMatch } from './grounding.ts';
import { scanText } from './scan.ts';
import { ADDRESSING_MAX_CHARS, plainAddressing } from './snapshot.ts';
import { ExtractIncompleteError, type MemoryStore } from './store.ts';
export type { TextModelClient } from './textClient.ts';

const Id = z.string().min(1).max(80);
const Text = z.string().min(1).max(300);
const Confidence = z.number().min(0).max(1).optional();

/** Categories the extractor may write (spec 记忆分层). `safety` is writer-only. */
export const EXTRACT_CATEGORIES = ['addressing', 'profile', 'preference', 'person', 'health', 'other'] as const;
const Category = z.enum(EXTRACT_CATEGORIES);
/** Q36 per-run refs (u1..uN). parseExtractBatch removes malformed values first, so this never fails a batch. */
const Sources = z.array(z.string().max(8)).max(20);

const FactAdd = z.object({
  op: z.literal('add'),
  table: z.literal('user_facts'),
  category: Category,
  text: Text,
  sensitive: z.boolean().optional(),
  confidence: Confidence,
  sources: Sources.optional(),
});
const FactUpdate = z.object({
  op: z.literal('update'),
  table: z.literal('user_facts'),
  id: Id,
  category: Category.optional(),
  text: Text.optional(),
  sensitive: z.boolean().optional(),
  confidence: Confidence,
  sources: Sources.optional(),
});
const FactRemove = z.object({ op: z.literal('remove'), table: z.literal('user_facts'), id: Id });

const NoteAdd = z.object({
  op: z.literal('add'),
  table: z.literal('relationship_notes'),
  text: Text,
  kind: z.string().min(1).max(32).optional(),
  agentId: Id.optional(),
});
const NoteUpdate = z.object({
  op: z.literal('update'),
  table: z.literal('relationship_notes'),
  id: Id,
  text: Text.optional(),
  kind: z.string().min(1).max(32).optional(),
});
const NoteRemove = z.object({ op: z.literal('remove'), table: z.literal('relationship_notes'), id: Id });

const EpisodeAdd = z.object({
  op: z.literal('add'),
  table: z.literal('episodes'),
  summary: Text,
  mood: z.string().min(1).max(32).optional(),
});
const EpisodeUpdate = z.object({
  op: z.literal('update'),
  table: z.literal('episodes'),
  id: Id,
  summary: Text.optional(),
  mood: z.string().min(1).max(32).nullable().optional(),
});
const EpisodeRemove = z.object({ op: z.literal('remove'), table: z.literal('episodes'), id: Id });

const FollowupAdd = z.object({
  op: z.literal('add'),
  table: z.literal('followups'),
  text: Text,
  dueAt: z.number().int().positive(),
  /** Verbatim user words. Length and evidence are checked by vetFollowupQuotes, so a long quote never fails the batch here. */
  quote: z.string().max(2_000).optional(),
  sensitive: z.boolean().optional(),
});
// Unknown keys are stripped (zod default): update can never change or re-flag a quote, and a stray key does not fail the batch.
const FollowupUpdate = z.object({
  op: z.literal('update'),
  table: z.literal('followups'),
  id: Id,
  text: Text.optional(),
  dueAt: z.number().int().positive().optional(),
});
const FollowupRemove = z.object({ op: z.literal('remove'), table: z.literal('followups'), id: Id });

const OpSchema = z.union([
  FactAdd, FactUpdate, FactRemove,
  NoteAdd, NoteUpdate, NoteRemove,
  EpisodeAdd, EpisodeUpdate, EpisodeRemove,
  FollowupAdd, FollowupUpdate, FollowupRemove,
]);
const Envelope = z.object({ ops: z.array(z.unknown()).max(40) });

export type ExtractOp = z.infer<typeof OpSchema>;
/** An op after its `sources` refs were mapped to this batch's message ids. */
export type ResolvedOp = ExtractOp & { sourceMessageIds?: readonly string[] };

export interface ExtractBatch {
  ops: ExtractOp[];
  /** user_facts add/update ops whose category is outside EXTRACT_CATEGORIES (dropped). */
  droppedCategory: number;
  /** user_facts add/update ops without `sources` (kept, no source). */
  missingSources: number;
  /** user_facts add/update ops whose `sources` was malformed (kept, sources removed). */
  invalidSources: number;
}

export interface QuoteRules {
  /** care.quoteMaxChars from gateway/config/affect.json. */
  maxChars: number;
  safety: SafetyRules;
  evidence: EvidenceRules;
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCategory = (value: unknown): boolean => typeof value === 'string' && (EXTRACT_CATEGORIES as readonly string[]).includes(value);

/**
 * Parses one model reply. A user_facts op with a category outside the whitelist is dropped and counted;
 * missing or malformed `sources` count as "no source" (Q36). Any other malformed op still fails the batch,
 * and the worker then leaves the watermark where it was.
 */
export function parseExtractBatch(raw: unknown): ExtractBatch {
  const value = typeof raw === 'string' ? JSON.parse(unwrapFence(raw)) : raw;
  const { ops: items } = Envelope.parse(Array.isArray(value) ? { ops: value } : value);
  let droppedCategory = 0;
  let missingSources = 0;
  let invalidSources = 0;
  const kept: unknown[] = [];
  for (const item of items) {
    if (!isObject(item) || item.table !== 'user_facts' || (item.op !== 'add' && item.op !== 'update')) {
      kept.push(item);
      continue;
    }
    if ((item.op === 'add' || item.category !== undefined) && !isCategory(item.category)) {
      droppedCategory++;
      continue;
    }
    if (item.sources === undefined) {
      missingSources++;
      kept.push(item);
    } else if (!Sources.safeParse(item.sources).success) {
      invalidSources++;
      const { sources: _malformed, ...rest } = item;
      kept.push(rest);
    } else {
      kept.push(item);
    }
  }
  return { ops: z.array(OpSchema).parse(kept), droppedCategory, missingSources, invalidSources };
}

/** Zod. Throws on malformed JSON or a malformed op. */
export function parseExtractOps(raw: unknown): ExtractOp[] {
  return parseExtractBatch(raw).ops;
}

/**
 * Q36: maps this run's refs to message ids. Only refs rendered in this run exist in `refs`, so ids of other
 * runs, other agents, or invented values are dropped and counted. Every user_facts add/update gets a list.
 */
export function resolveFactSources(ops: readonly ExtractOp[], refs: ReadonlyMap<string, string>): { ops: ResolvedOp[]; droppedSources: number } {
  let droppedSources = 0;
  const resolved = ops.map((op): ResolvedOp => {
    if (op.table !== 'user_facts' || op.op === 'remove') return op;
    const { sources, ...rest } = op;
    const ids: string[] = [];
    for (const ref of sources ?? []) {
      const id = refs.get(ref);
      if (id === undefined) droppedSources++;
      else if (!ids.includes(id)) ids.push(id);
    }
    return { ...rest, sourceMessageIds: ids };
  });
  return { ops: resolved, droppedSources };
}

/**
 * The shared addressing row stores a plain name (spec §4). Applies to addressing adds/updates and to updates
 * of an existing addressing row (`addressingIds`) that do not restate the category. Empty or overlong names drop.
 */
export function normalizeAddressingOps(ops: readonly ExtractOp[], addressingIds: ReadonlySet<string> = new Set()): { ops: ExtractOp[]; droppedAddressing: number } {
  let droppedAddressing = 0;
  const kept: ExtractOp[] = [];
  for (const op of ops) {
    if (op.table !== 'user_facts' || op.op === 'remove' || op.text === undefined) {
      kept.push(op);
      continue;
    }
    const namesUser = op.category === 'addressing' || (op.op === 'update' && op.category === undefined && addressingIds.has(op.id));
    if (!namesUser) {
      kept.push(op);
      continue;
    }
    const name = plainAddressing(op.text);
    // A bare label ("呼び方：") is not a name.
    if (!name || /[：:]$/u.test(name) || [...name].length > ADDRESSING_MAX_CHARS) {
      droppedAddressing++;
      continue;
    }
    kept.push({ ...op, text: name });
  }
  return { ops: kept, droppedAddressing };
}

/**
 * High-risk care contract (roadmap "记忆与回忆：已踩过的坑" #1, #10): a followup keeps its quote only
 * when the quote is a verbatim slice of one user statement in this batch. Otherwise the quote is
 * dropped and the row is still written. No rules = every quote is dropped.
 */
export function vetFollowupQuotes(ops: readonly ExtractOp[], userLines: readonly string[], rules: QuoteRules | undefined): ExtractOp[] {
  return ops.map((op) => {
    if (op.table !== 'followups' || op.op !== 'add' || op.quote === undefined) return op;
    const { quote: raw, ...rest } = op;
    const quote = (raw ?? '').trim();
    return rules && quoteAllowed(quote, userLines, rules) ? { ...rest, quote } : rest;
  });
}

function quoteAllowed(quote: string, userLines: readonly string[], rules: QuoteRules): boolean {
  if (!quote || [...quote].length > rules.maxChars) return false;
  if (scanText(quote, rules.safety) === 'reject' || !isMemoryEvidence(quote, rules.evidence)) return false;
  const key = normalizeForMatch(quote);
  if (!key) return false;
  // The source line must itself be a statement: a slice of a question or a denial is not evidence.
  return userLines.some((line) => normalizeForMatch(line).includes(key)
    && isMemoryEvidence(line, rules.evidence)
    && scanText(line, rules.safety) !== 'reject');
}

export function loadExtractPrompt(
  path = fileURLToPath(new URL('../../roles/_shared/zh/extract.md', import.meta.url)),
  language: Language = 'zh',
): string {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error(`empty_extract_prompt:${language}`);
  return text;
}

/**
 * Re-reads both epochs inside the write transaction. Any mismatch writes nothing.
 * Applied ops and extracted=1 on the consumed message ids commit together.
 * An op that cannot be stored rolls the whole batch back.
 */
export function applyExtractOps(
  store: MemoryStore,
  ownerId: string,
  agentId: string,
  epochsAtStart: { owner: number; agent: number },
  ops: readonly ResolvedOp[],
  messageIds: readonly string[],
): 'applied' | 'stale' | 'incomplete' {
  try {
    return store.immediate(() => {
      const current = store.memoryEpochs(ownerId, agentId);
      if (!current || current.owner !== epochsAtStart.owner || current.agent !== epochsAtStart.agent) return 'stale';
      store.writeExtraction(ownerId, agentId, {
        now: Date.now(),
        messageIds,
        facts: ops.filter((op) => op.table === 'user_facts'),
        notes: ops.filter((op) => op.table === 'relationship_notes'),
        episodes: ops.filter((op) => op.table === 'episodes'),
        followups: ops.filter((op) => op.table === 'followups'),
      });
      return 'applied';
    });
  } catch (error) {
    if (error instanceof ExtractIncompleteError) return 'incomplete';
    throw error;
  }
}

function unwrapFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}
```

- [x] **Step 7: 改 `worker.ts`**

import 行（当前 :10）改为：

```ts
import {
  applyExtractOps, normalizeAddressingOps, parseExtractBatch, resolveFactSources, vetFollowupQuotes,
  type ExtractBatch, type QuoteRules, type TextModelClient,
} from './extract.ts';
```

`MemoryExtractor`（当前 :15-17）改为：

```ts
export interface MemoryExtractor {
  /** Queues extraction of one agent's pending messages behind this owner's current work; settles when it finishes. */
  enqueue(ownerId: string, agentId: string, reason: ExtractReason, language?: Language): Promise<void>;
}
```

类注释和通用排队方法（当前 :38-69）改为（只改名，逻辑不变）：

```ts
/** One queue per owner. Jobs never overlap; a later job starts only after the earlier one settles. Each extract job handles one agent. */
export class MemoryWorker implements MemoryExtractor {
```

```ts
  /** Queues `job` behind this owner's current work. Returns an id for waitForJob. */
  schedule(ownerId: string, job: () => Promise<void>): string {
```

（方法体与原来的 `enqueue(ownerId, job)` 完全相同。）

把 Task 2 的 `extractOwner` 整个替换为：

```ts
  /** Extracts this agent's pending messages. The returned promise settles when that job finishes. */
  enqueue(ownerId: string, agentId: string, reason: ExtractReason, language?: Language): Promise<void> {
    return new Promise((resolve) => {
      this.schedule(ownerId, async () => {
        try {
          await this.run(ownerId, agentId, reason, language);
        } finally {
          resolve();
        }
      });
    });
  }
```

`run` 从 `const labels = ...` 那一行开始到方法结束，替换为：

```ts
    const labels = this.opts.labels?.[chosen] ?? DEFAULT_I18N.memory[chosen].extractLabels;
    const memory = this.opts.store.memoryForExtract(ownerId, agentId);
    // Q36: u1..uN are valid for this run only and map back to this agent's message ids.
    const refs = new Map(users.map((row, index) => [`u${index + 1}`, row.id] as const));
    const user = renderInput(memory, users, this.contextMaxChars, { reason, now }, labels);
    const result = await runWithPolicy('extract', this.opts.policy, (signal) => this.opts.client.complete({
      system: systemPrompt,
      user,
      maxTokens: this.opts.maxTokens,
      signal,
    }), {
      classify: (error) => {
        const code = errorCodeOf(error);
        // Rate limits and request timeouts are transient; other 4xx (bad auth/request) are not.
        if (['extract_http_408', 'extract_http_425', 'extract_http_429'].includes(code)) return 'retryable';
        if (code.startsWith('extract_http_4') || code === 'extract_invalid_response' || code === 'extract_invalid_json') return 'fatal';
        return 'retryable';
      },
    });
    if (!result.ok) {
      log('memory_extract_failed', { reason, code: result.code });
      return;
    }
    let batch: ExtractBatch;
    try {
      batch = parseExtractBatch(result.value);
    } catch {
      log('memory_extract_failed', { reason, code: 'extract_parse' });
      return;
    }
    const addressingIds = new Set(memory.facts.filter((fact) => fact.category === 'addressing').map((fact) => fact.id));
    const named = normalizeAddressingOps(batch.ops, addressingIds);
    // Quotes must be verbatim user statements from the lines the model saw; anything else loses its quote.
    const vetted = vetFollowupQuotes(named.ops, users.map((row) => row.text), this.opts.quote);
    const sourced = resolveFactSources(vetted, refs);
    const applied = applyExtractOps(this.opts.store, ownerId, agentId, epochs, sourced.ops, consumed.map((row) => row.id));
    // Counts only: never the text of an op, a source line, or a name.
    const counts = {
      droppedCategory: batch.droppedCategory,
      missingSources: batch.missingSources,
      invalidSources: batch.invalidSources,
      droppedSources: sourced.droppedSources,
      droppedAddressing: named.droppedAddressing,
    };
    if (applied === 'incomplete') {
      log('memory_extract_failed', { reason, code: 'extract_incomplete', ops: batch.ops.length, messages: consumed.length, ...counts });
      return;
    }
    log('memory_extract', { reason, result: applied, ops: batch.ops.length, messages: consumed.length, ...counts });
  }
```

`withExtraction`（当前 :164-174）改为：

```ts
/** Session end enqueues extraction and does not wait, so the next resolve can still read the tail. */
export function withExtraction(base: SessionLifecycle, worker: MemoryWorker): SessionLifecycle {
  return {
    started: (sessionId, ctx) => base.started(sessionId, ctx),
    ended: (sessionId, ctx, reason) => base.ended(sessionId, ctx, reason),
    extract: (_sessionId, ctx: SessionContext) => {
      if (!ctx.ownerId || !ctx.agentId) return;
      void worker.enqueue(ctx.ownerId, ctx.agentId, 'session_end', ctx.language);
    },
  };
}
```

`renderInput` 里的 `dialogue`（当前 :208）改为：

```ts
  // [uN] refs are per run; the model cites them in `sources` (Q36). Only user lines are rendered.
  const dialogue = messages.map((row, index) => `[u${index + 1}] ${labels.user}${labels.separator}${row.text}`);
```

- [x] **Step 8: 改 `session.ts` 和 `index.ts` 的调用**

`gateway/src/session/session.ts` 构造器里（当前 :320-338），在 `const ownerId = ctx.ownerId;` 之后加一行 `const agentId = ctx.agentId;`，并把

```ts
        ...(extractor && ownerId ? { onQuietRest: () => { void extractor.extractOwner(ownerId, 'silence', this.language); } } : {}),
```

改为

```ts
        ...(extractor && ownerId && agentId ? { onQuietRest: () => { void extractor.enqueue(ownerId, agentId, 'silence', this.language); } } : {}),
```

用户 final 之后的按轮抽取（当前 :1113-1120）改为：

```ts
    const extractor = this.deps.worker;
    const ownerId = this.context.ownerId;
    const agentId = this.context.agentId;
    if (extractor && ownerId && agentId) {
      this.userTurns += 1;
      const every = this.deps.extractEveryUserTurns ?? 10;
      if (this.userTurns % every === 0) void extractor.enqueue(ownerId, agentId, 'turns', this.language);
    }
```

`gateway/src/index.ts` 的启动补抽（Task 2 写的那三行）改为：

```ts
if (worker && store) {
  // Same-owner jobs still run one after another; each job handles one character.
  for (const { ownerId, agentId } of store.agentsPendingExtraction()) void worker.enqueue(ownerId, agentId, 'startup');
}
```

- [x] **Step 9: 改三份抽取提示词**

`gateway/roles/_shared/zh/extract.md`：

第 10 行改为：

```
- user_facts：必填 category、text、sources；可选 sensitive（布尔值）、confidence（0 到 1 的数值）。sources 的规则见下文。
```

第 15 行里的 `user_facts 可更新 category、text、sensitive、confidence；` 改为 `user_facts 可更新 category、text、sensitive、confidence，并且必须带 sources；`（该行其余文字不变）。

第 22 行改为：

```
{"ops":[{"op":"add","table":"user_facts","category":"preference","text":"用户偏好的陈述","sensitive":false,"confidence":0.9,"sources":["u1"]}]}
```

第 34 行（`- update 和 remove 的 id 只能使用输入里已有的 id，不要编造。`）之后插入一行：

```
- 「新增对话」里每条「用户：」前面的 [u1]、[u2]……是本轮的消息编号。user_facts 的 add 和 update 都要带 sources，列出这条事实依据的用户发言编号，例如 ["u1"] 或 ["u2","u3"]。只能用本轮出现过的编号，不要编造，不要写其它 id。编号只用来标出处，不改变上面的规则：事实仍然只能来自「用户：」原话。
```

原第 35 行（`- 用户的姓名、姓氏、希望被叫的称呼用 category addressing……其它用 other。`）整行替换为：

```
- category 只能是 addressing、profile、preference、person、health、other。用户的姓名、姓氏、希望被叫的称呼用 addressing，写成「称呼：<称呼>」，只写称呼本身，不要归入 person 或 other。用户亲口说的、关于自己的稳定基本信息用 profile：家乡和居住城市、家里有哪些人、退休前的工作。健康信息永远不用 profile，一律用 health。偏好用 preference。用户提到的其他人身上的具体事件用 person。其它用 other。
```

`gateway/roles/_shared/ja/extract.md`：

第 10 行改为：

```
- user_facts：category、text、sources が必須。sensitive（真偽値）、confidence（0 から 1 の数値）は任意。sources の規則は下に書きます。
```

第 15 行里的 `user_facts は category、text、sensitive、confidence を更新できます。` 改为 `user_facts は category、text、sensitive、confidence を更新でき、sources も必ず入れてください。`

第 22 行改为：

```
{"ops":[{"op":"add","table":"user_facts","category":"preference","text":"ユーザーが好むと述べた内容","sensitive":false,"confidence":0.9,"sources":["u1"]}]}
```

第 34 行之后插入：

```
- 「新しい会話」の各「ユーザー：」の前にある [u1]、[u2]…は今回のメッセージ番号です。user_facts の add と update には必ず sources を入れ、その事実の根拠になったユーザー発言の番号を並べてください（例：["u1"]、["u2","u3"]）。今回出てきた番号だけを使い、でっち上げたり、ほかの id を書いたりしないでください。番号は出どころを示すためだけのもので、上の規則は変わりません。事実は今までどおり「ユーザー：」の原文だけから取ります。
```

原第 35 行整行替换为：

```
- category は addressing、profile、preference、person、health、other のどれかです。ユーザーの姓名、名字、希望する呼び方は addressing を使い、「呼び方：<呼び方>」と書き、呼び方そのものだけを書いてください。person や other に入れないでください。ユーザーが自分で話した、自分についての変わりにくい基本情報（出身地と住んでいる町、家族構成、退職前の仕事）は profile を使います。健康のことは決して profile にせず、必ず health を使います。好みは preference を使います。ユーザーが話したほかの人の具体的な出来事は person を使います。それ以外は other を使います。
```

`gateway/roles/_shared/en/extract.md`：

第 10 行改为：

```
- user_facts: category, text, and sources are required; sensitive (boolean) and confidence (a number from 0 to 1) are optional. See the rules below for sources.
```

第 15 行里的 `user_facts can update category, text, sensitive, confidence.` 改为 `user_facts can update category, text, sensitive, confidence, and must include sources.`

第 22 行改为：

```
{"ops":[{"op":"add","table":"user_facts","category":"preference","text":"A statement of what the user prefers","sensitive":false,"confidence":0.9,"sources":["u1"]}]}
```

第 34 行之后插入：

```
- In the new conversation, the [u1], [u2], ... before each "User:" line is this batch's message number. Every user_facts add and update must include sources: the numbers of the user lines the fact is based on, for example ["u1"] or ["u2","u3"]. Use only numbers that appear in this batch; never invent one or write any other id. The numbers only mark where a fact came from; the rules above do not change: facts still come only from "User:" lines.
```

原第 35 行整行替换为：

```
- category is one of addressing, profile, preference, person, health, other. Use addressing for the user's name, surname, or preferred form of address, written as "Address as: <name>" with the name only; do not put it under person or other. Use profile for stable basics the user said about themselves: hometown and the city they live in, who is in their family, their work before retirement. Never use profile for health; health always uses health. Use preference for likes. Use person for specific events about other people the user mentions. Use other for the rest.
```

- [x] **Step 10: 适配 `memory-acceptance.test.ts` 的称呼期望**

两处读取 `factRows` 的期望改为纯名字：

```ts
    expect(factRows(store, ownerId, agentId)).toEqual(expect.arrayContaining([
      { category: 'addressing', text: '王叔' },
      { category: 'preference', text: '喜欢喝茶' },
    ]));
```

```ts
    expect(factRows(store, ownerId, agentId).map((fact) => fact.text)).toContain('王叔');
```

（快照断言 `toContain('称呼：王叔')` 不改：纯名字由 `labelledName` 渲染成 `称呼：王叔`。）

- [x] **Step 11: 跑目标测试，确认通过**

```bash
npm test -w gateway -- test/extract.test.ts test/snapshot.test.ts test/worker.test.ts test/memory-tools.test.ts test/memory-acceptance.test.ts test/session.test.ts
```

预期：全部通过。

- [x] **Step 12: 跑全量测试和 typecheck**

```bash
npm run typecheck -w gateway
npm test -w gateway
grep -rn "extractOwner" gateway/src gateway/test   # expect no hits
```

预期：typecheck 退出码 0；全量通过；`extractOwner` 没有残留。

- [x] **Step 13: 提交**

```bash
git add gateway/src/memory/extract.ts gateway/src/memory/snapshot.ts gateway/src/memory/worker.ts gateway/src/session/session.ts gateway/src/index.ts gateway/roles/_shared/zh/extract.md gateway/roles/_shared/ja/extract.md gateway/roles/_shared/en/extract.md gateway/test/extract.test.ts gateway/test/snapshot.test.ts gateway/test/worker.test.ts gateway/test/memory-tools.test.ts gateway/test/session.test.ts gateway/test/memory-acceptance.test.ts
git commit -m "$(cat <<'EOF'
feat(memory): extract per character with a category whitelist and cited sources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

## 验收清单

- [x] 抽取任务键是 `(ownerId, agentId)`：B 的任务看不到 A 的原话和 A 的私有记忆（能看到共享层），写不进 A 的表，A 的消息水位不动；同一 owner 的任务严格串行。
- [x] category 白名单：`safety`、未知类、缺 category 的 add 被丢弃并计数，同批其他 op 照常写入，水位照常推进。
- [x] Q36：用户行带 `[u1]..[uN]`；合法编号映射为消息 id 存储；缺 `sources` 不让整批失败、事实照写、水位推进；越界/非本次/编造的编号丢弃并计数；`sources` 形状不对时按空处理；update 时并集。
- [x] 称呼只存纯名字（去掉 `称呼：`/`呼び方：`/`Address as:`）；空名字或超过 20 字的称呼 op 丢弃；快照里仍渲染成 `称呼：<名字>`，`greetingName()` 不受影响。
- [x] 健康事实只进本角色私有层且 `sensitive`；`profile` 进共享层。
- [x] Agent epoch 在模型调用期间变化 → stale，不写入、不推进水位；别的角色的 epoch 变化不影响。
- [x] 日志只有计数（`droppedCategory`、`missingSources`、`invalidSources`、`droppedSources`、`droppedAddressing`），没有任何文本。
- [x] 三份 `extract.md` 都有 `profile` 定义、白名单、`sources` 规则和「编号只用来标出处」的说明；原有的证据规则和关怀规则文字保留（`extract.test.ts` 的旧断言仍然通过）。

全量命令（仓库根目录）：

```bash
npm test -w protocol && npm run typecheck -w protocol
npm test -w gateway && npm run typecheck -w gateway
```

## 与总览的出入（交给协调者）

1. C3 写的是 `enqueue(ownerId, agentId, reason)`。会话要按当前语言抽取（现有行为，`session.test.ts` 有测试），所以本任务加了可选的第 4 个参数 `language?: Language`。原来的通用 `enqueue(ownerId, job)` 改名为 `schedule`，以免和 C3 的名字冲突。
2. 两层 epoch 的复核逻辑在 Task 2 的 `applyExtractOps` 里已经实现（Task 2 删除 `memoryEpoch` 时必须同时换掉调用方）；本任务只补 worker 级测试。
