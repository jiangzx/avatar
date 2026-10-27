# P1-T9: `UsageRecorder` 落库与归属接线

**目标：** 实现 `SqliteUsageRecorder`：按价格表定格费用，批量写 `usage_events`。把它接到 realtime 回复（每条回复一行）、会话内的文本调用（affect、沉默规划、care、recall 包装）、记忆抽取、摘要器。eval 和脚本因为不传 recorder，结构上不计入。

**实现的 spec 章节：** 「架构 / 用量记录」整节；决策 Q8、Q22、Q36。

**前置：** P1-T2（`usage_events` 表）、P1-T3（Logger）、P1-T4（`gateway/src/log/adminConfig.ts` 与 `gateway/config/admin.json`）、P1-T7（`TokenUsage`、`usage/types.ts`、`withUsageTag`、Mock `emitUsage`）、P1-T8（`PriceBook`、`costMicroYuan`、`hasUsageDetails`）。P1-T6 已把 `index.ts` 改为注入根 logger。开始前跑 `npm test -w gateway && npm run typecheck -w gateway` 确认全绿。

**行号说明：** P1-T5、P1-T6 改过 `session.ts`、`worker.ts`、`index.ts`，下文行号是 2026-10-27 的位置，执行时按符号名定位。`index.ts` 里根 logger 与 admin 配置的变量名以 P1-T4、P1-T6 实际写入的为准（下文写作 `logger`、`adminConfig`）。

**Files:**
- Create: `gateway/src/usage/recorder.ts`
- Modify: `gateway/src/log/adminConfig.ts`（`AdminConfigSchema` 加 `usageSink`）
- Modify: `gateway/config/admin.json`（加 `usageSink`）
- Modify: `gateway/src/session/metrics.ts:5-17, 89-105`（`ReplyMetrics.usage`）
- Modify: `gateway/src/session/session.ts`（import :21；`SessionDeps` :79-96；构造函数 affect :368-372；`planProactiveLine` :683-693；`finalize` :1103-1110；工具调用 :1240-1243；`startCareOpening` :1691-1694）
- Modify: `gateway/src/memory/worker.ts:135-139`（抽取调用带 `UsageTag`）
- Modify: `gateway/src/index.ts`（创建 `SqlitePriceBook`、`SqliteUsageRecorder`；接到文本客户端、摘要器、会话、Mock；关机 flush）
- Test: `gateway/test/usage-recorder.test.ts`（新建）
- Test: `gateway/test/usage-scope.test.ts`（新建）
- Test: `gateway/test/metrics.test.ts:17-20, 35`（期望里加 `usage`）
- Test: `gateway/test/session.test.ts`（追加 2 个用例）
- Test: `gateway/test/worker.test.ts`（追加 1 个用例）

**Interfaces:**
- Consumes：
  - C1 `usage_events` 列（逐列写入）。
  - C2 `Logger`（只用 `warn`）。
  - C3 `UsageRecord`、`UsageRecorder`、`UsageTag`、`UsageAttribution`、`PriceBook`、`costMicroYuan`；P1-T8 的 `hasUsageDetails(usage): boolean`；P1-T7 的 `withUsageTag(client, tag)`、`MockOptions.emitUsage`、`QwenTextClientOptions.recorder`、`QwenSummarizerOptions.{recorder, tag}`。
- Produces：
  - C3 逐字：
    ```ts
    export class SqliteUsageRecorder implements UsageRecorder {
      constructor(opts: { db: DatabaseSync; prices: PriceBook; logger: Logger; flushMs: number; maxBatch: number; now?: () => number });
      close(): void; // flush + stop timer
    }
    ```
  - `SessionDeps` 新增：`usage?: UsageRecorder`；`usageSource?: { adapter: 'qwen' | 'mock'; model: string }`（两者都有才记 realtime 回复；Seeduplex 不传 `usageSource`，所以不计）。
  - `ReplyMetrics` 新增 `usage: TokenUsage | null`（`metricFields` 不变，日志仍只有两个总数）。
  - `admin.json` 新增 `"usageSink": { "flushMs": 1000, "maxBatch": 100 }`。

## 写入规则

| 列 | 取值 |
|---|---|
| `ts` | `record.ts ?? now()` |
| `owner_id`、`agent_id`、`session_id`、`character_id` | `record.attribution` 原样（null = 系统） |
| `kind`、`adapter`、`model` | `record` 原样 |
| `input_text_tokens` … `cached_tokens` | `usage` 对应字段，缺失写 NULL |
| `input_tokens`、`output_tokens` | `usage.inputTokens`、`usage.outputTokens`；`usage` 为 null 时 NULL |
| `first_audio_ms`、`gen_ms`、`error_code` | `record` 原样，缺失写 NULL |
| `estimated` | `usage` 非 null 且（`usage.estimated` 为 true 或 `!hasUsageDetails(usage)`）时为 1，否则 0 |
| `price_id`、`cost_micro_yuan` | `usage` 非 null 且 `prices.priceFor(model, ts)` 有值时写价格 id 与 `costMicroYuan`；否则都为 NULL（「未定价」或失败调用） |

- 批量：队列满 `maxBatch` 立即 flush；另有 `setInterval(flushMs)`，`unref()`。
- 一批写入失败（例如 owner 在 flush 前被删、外键失败）时回滚，再逐行写入，只丢失败的行，记 `logger.warn('usage_write_failed', { rows: <丢弃行数> })`。
- flush 时如果数据库正处于其他事务中（`db.isTransaction`），本次跳过，留给下次。
- `record()` 永不抛错；计价出错时记 `usage_record_failed { kind }` 并丢弃这一行。
- 不记录任何文本。

## Steps

- [ ] **Step 1: 写失败的 recorder 测试**

新建 `gateway/test/usage-recorder.test.ts`：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger, LogFields } from '../src/log/logger.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { SqlitePriceBook, loadPricingBaseline } from '../src/usage/pricing.ts';
import { SqliteUsageRecorder } from '../src/usage/recorder.ts';
import type { UsageRecord } from '../src/usage/types.ts';
import { seedOwner } from './helpers/memory.ts';

const JAN_2 = 1767196800000 + 86_400_000;
const baseline = loadPricingBaseline(fileURLToPath(new URL('../config/pricing.json', import.meta.url)));
const dbs: DatabaseSync[] = [];
const recorders: SqliteUsageRecorder[] = [];

function open(): DatabaseSync {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  return db;
}

function stubLogger(): Logger & { warns: Array<[string, LogFields | undefined]> } {
  const warns: Array<[string, LogFields | undefined]> = [];
  const logger: Logger & { warns: typeof warns } = {
    warns,
    debug: () => {}, info: () => {}, error: () => {},
    warn: (event, fields) => { warns.push([event, fields]); },
    child: () => logger,
  };
  return logger;
}

function setup(maxBatch = 100) {
  const db = open();
  const store = new SqliteMemoryStore(db);
  const who = seedOwner(store, 'h1', 1);
  const logger = stubLogger();
  const recorder = new SqliteUsageRecorder({ db, prices: new SqlitePriceBook(db, baseline), logger, flushMs: 1000, maxBatch, now: () => JAN_2 });
  recorders.push(recorder);
  const rows = () => db.prepare('SELECT * FROM usage_events ORDER BY id').all() as Array<Record<string, unknown>>;
  return { db, store, who, logger, recorder, rows };
}

afterEach(() => {
  for (const r of recorders.splice(0)) r.close();
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  vi.useRealTimers();
});

const attribution = (who: { ownerId: string; agentId: string }) => ({ ownerId: who.ownerId, agentId: who.agentId, sessionId: 's1', characterId: 'xiaonuan' });

describe('SqliteUsageRecorder', () => {
  it('writes one priced row per call on flush', () => {
    const s = setup();
    s.recorder.record({
      kind: 'realtime_reply', adapter: 'qwen', model: 'qwen3.8-omni-flash-realtime', attribution: attribution(s.who),
      usage: { inputTokens: 300, outputTokens: 90, inputTextTokens: 260, inputAudioTokens: 40, outputTextTokens: 15, outputAudioTokens: 75 },
      firstAudioMs: 900, genMs: 1500, errorCode: null,
    });
    expect(s.rows()).toHaveLength(0);
    s.recorder.flush();
    expect(s.rows()).toEqual([expect.objectContaining({
      ts: JAN_2, owner_id: s.who.ownerId, agent_id: s.who.agentId, session_id: 's1', character_id: 'xiaonuan',
      kind: 'realtime_reply', adapter: 'qwen', model: 'qwen3.8-omni-flash-realtime',
      input_text_tokens: 260, input_audio_tokens: 40, output_text_tokens: 15, output_audio_tokens: 75, cached_tokens: null,
      input_tokens: 300, output_tokens: 90, first_audio_ms: 900, gen_ms: 1500, error_code: null,
      estimated: 0, price_id: `qwen3.8-omni-flash-realtime@1767196800000`, cost_micro_yuan: 1598,
    })]);
  });

  it('marks totals-only and synthetic usage as estimated, and leaves unknown models unpriced', () => {
    const s = setup();
    const base = { kind: 'realtime_reply', attribution: attribution(s.who) } as const;
    s.recorder.record({ ...base, adapter: 'qwen', model: 'qwen3.8-omni-flash-realtime', usage: { inputTokens: 1000, outputTokens: 100 } });
    s.recorder.record({ ...base, adapter: 'mock', model: 'mock', usage: { inputTokens: 5, outputTokens: 7, inputTextTokens: 5, outputTextTokens: 3, outputAudioTokens: 4, estimated: true } });
    s.recorder.flush();
    const [totals, mock] = s.rows();
    expect(totals).toMatchObject({ estimated: 1, cost_micro_yuan: 1950, input_text_tokens: null });
    expect(mock).toMatchObject({ estimated: 1, price_id: null, cost_micro_yuan: null, output_audio_tokens: 4 });
  });

  it('records failed text calls without tokens or cost', () => {
    const s = setup();
    s.recorder.record({ kind: 'memory_extract', adapter: 'text', model: 'qwen-plus', usage: null, errorCode: 'extract_http_429', genMs: 12,
      attribution: { ownerId: s.who.ownerId, agentId: s.who.agentId, sessionId: null, characterId: null } });
    s.recorder.flush();
    expect(s.rows()[0]).toMatchObject({ input_tokens: null, output_tokens: null, estimated: 0, price_id: null, cost_micro_yuan: null, error_code: 'extract_http_429', session_id: null });
  });

  it('accepts system rows with no owner', () => {
    const s = setup();
    s.recorder.record({ kind: 'summarize', adapter: 'text', model: 'qwen-flash', usage: { inputTokens: 10, outputTokens: 2, inputTextTokens: 10, outputTextTokens: 2 },
      attribution: { ownerId: null, agentId: null, sessionId: null, characterId: null } });
    s.recorder.flush();
    expect(s.rows()[0]).toMatchObject({ owner_id: null, cost_micro_yuan: 5 }); // 10*0.15 + 2*1.5 = 1.5 + 3 = 4.5 → 5
  });

  it('flushes when the batch is full and on the timer', () => {
    vi.useFakeTimers();
    const s = setup(2);
    const r: UsageRecord = { kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: attribution(s.who) };
    s.recorder.record(r);
    expect(s.rows()).toHaveLength(0);
    s.recorder.record(r);
    expect(s.rows()).toHaveLength(2);
    s.recorder.record(r);
    vi.advanceTimersByTime(1000);
    expect(s.rows()).toHaveLength(3);
  });

  it('keeps good rows when one row breaks the foreign key', () => {
    const s = setup();
    s.recorder.record({ kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: attribution(s.who) });
    s.recorder.record({ kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: { ownerId: 'ghost-owner', agentId: null, sessionId: null, characterId: null } });
    s.recorder.flush();
    expect(s.rows().map((row) => row.owner_id)).toEqual([s.who.ownerId]);
    expect(s.logger.warns).toEqual([['usage_write_failed', { rows: 1 }]]);
  });

  it('deletes usage rows with their owner', () => {
    const s = setup();
    s.recorder.record({ kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: attribution(s.who) });
    s.recorder.flush();
    expect(s.store.deleteOwner(s.who.ownerId)).toBe(true);
    expect(s.rows()).toHaveLength(0);
  });

  it('flushes on close and ignores records after close', () => {
    const s = setup();
    s.recorder.record({ kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: attribution(s.who) });
    s.recorder.close();
    expect(s.rows()).toHaveLength(1);
    s.recorder.record({ kind: 'care', adapter: 'text', model: 'qwen-plus', usage: null, attribution: attribution(s.who) });
    s.recorder.flush();
    expect(s.rows()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -w gateway -- test/usage-recorder.test.ts`
Expected: FAIL，`../src/usage/recorder.ts` 不存在。

- [ ] **Step 3: 实现 recorder**

新建 `gateway/src/usage/recorder.ts`：

```ts
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Logger } from '../log/logger.ts';
import { costMicroYuan, hasUsageDetails, type PriceBook } from './pricing.ts';
import type { UsageRecord, UsageRecorder } from './types.ts';

type Cell = string | number | null;

const INSERT = `INSERT INTO usage_events (
  ts, owner_id, agent_id, session_id, character_id, kind, adapter, model,
  input_text_tokens, input_audio_tokens, output_text_tokens, output_audio_tokens, cached_tokens,
  input_tokens, output_tokens, first_audio_ms, gen_ms, error_code, estimated, price_id, cost_micro_yuan
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export interface SqliteUsageRecorderOptions {
  db: DatabaseSync;
  prices: PriceBook;
  logger: Logger;
  flushMs: number;
  maxBatch: number;
  now?: () => number;
}

/** Batches usage rows off the audio path. Cost is fixed at write time with the price in effect then. */
export class SqliteUsageRecorder implements UsageRecorder {
  private queue: Cell[][] = [];
  private closed = false;
  private readonly insert: StatementSync;
  private readonly timer: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly opts: SqliteUsageRecorderOptions) {
    this.now = opts.now ?? Date.now;
    this.insert = opts.db.prepare(INSERT);
    this.timer = setInterval(() => this.flush(), opts.flushMs);
    this.timer.unref();
  }

  record(record: UsageRecord): void {
    if (this.closed) return;
    try {
      this.queue.push(this.toRow(record));
    } catch {
      this.opts.logger.warn('usage_record_failed', { kind: record.kind });
      return;
    }
    if (this.queue.length >= this.opts.maxBatch) this.flush();
  }

  flush(): void {
    const { db } = this.opts;
    // Another writer holds a transaction in this tick; try again on the next flush.
    if (this.queue.length === 0 || db.isTransaction) return;
    const rows = this.queue.splice(0);
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const row of rows) this.insert.run(...row);
      db.exec('COMMIT');
      return;
    } catch {
      if (db.isTransaction) db.exec('ROLLBACK');
    }
    // One bad row (e.g. its owner was just deleted) must not drop the rest.
    let dropped = 0;
    for (const row of rows) {
      try { this.insert.run(...row); } catch { dropped++; }
    }
    if (dropped > 0) this.opts.logger.warn('usage_write_failed', { rows: dropped });
  }

  close(): void {
    clearInterval(this.timer);
    this.flush();
    this.closed = true;
  }

  private toRow(r: UsageRecord): Cell[] {
    const ts = r.ts ?? this.now();
    const u = r.usage;
    const price = u ? this.opts.prices.priceFor(r.model, ts) : null;
    const estimated = u !== null && (u.estimated === true || !hasUsageDetails(u)) ? 1 : 0;
    const a = r.attribution;
    return [
      ts, a.ownerId, a.agentId, a.sessionId, a.characterId, r.kind, r.adapter, r.model,
      u?.inputTextTokens ?? null, u?.inputAudioTokens ?? null, u?.outputTextTokens ?? null, u?.outputAudioTokens ?? null, u?.cachedTokens ?? null,
      u?.inputTokens ?? null, u?.outputTokens ?? null,
      r.firstAudioMs ?? null, r.genMs ?? null, r.errorCode ?? null,
      estimated, price && u ? price.id : null, price && u ? costMicroYuan(price, u) : null,
    ];
  }
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -w gateway -- test/usage-recorder.test.ts`
Expected: PASS（8 个用例）。`'deletes usage rows with their owner'` 依赖 `PRAGMA foreign_keys = ON`（`gateway/src/memory/db.ts:27` 已开启）和 C1 的 `ON DELETE CASCADE`。

- [ ] **Step 5: `admin.json` 加 `usageSink`**

打开 `gateway/src/log/adminConfig.ts`（P1-T4 建）。在 `AdminConfigSchema` 的对象里、紧跟 `logSink` 那一项之后加一项 `usageSink`，**复用 `logSink` 的同一个子 schema**（P1-T4 里它是 `{ flushMs, maxBatch }` 两个正整数，变量名以文件为准）。例如 P1-T4 写的是 `logSink: SinkSchema,`，就加：

```ts
  usageSink: SinkSchema,
```

`gateway/config/admin.json` 在 `logSink` 之后加：

```json
  "usageSink": { "flushMs": 1000, "maxBatch": 100 },
```

在 P1-T4 的 admin 配置测试文件里（P1-T4 新建的那个，名字以实际为准）追加一个用例：

```ts
  it('ships the usage sink settings', () => {
    const config = AdminConfigSchema.parse(JSON.parse(readFileSync(fileURLToPath(new URL('../config/admin.json', import.meta.url)), 'utf8')));
    expect(config.usageSink).toEqual({ flushMs: 1000, maxBatch: 100 });
  });
```

（文件顶部缺 `readFileSync` / `fileURLToPath` import 时补上。）

Run: `npm test -w gateway -- <P1-T4 的 admin 配置测试文件>`
Expected: PASS。

- [ ] **Step 6: `ReplyMetrics` 带上完整用量（先改测试）**

`gateway/test/metrics.test.ts:17-20` 的期望改为：

```ts
    expect(m.finish(1, 'ended')).toEqual({
      seq: 1, kind: 'reply', outcome: 'ended', speechToFirstAudioMs: 600, vadToFirstAudioMs: 800, genMs: 1000,
      inputTokens: 300, outputTokens: 40, toolCalls: 1, replyChars: 12, errorCode: null,
      usage: { inputTokens: 300, outputTokens: 40 },
    });
```

`gateway/test/metrics.test.ts:35` 的 `metricFields({...})` 实参末尾加 `usage: null`（期望不变：日志字段不包含 usage）。

Run: `npm test -w gateway -- test/metrics.test.ts`
Expected: FAIL，`finish` 返回值没有 `usage`。

`gateway/src/session/metrics.ts`：`ReplyMetrics` 接口（:5-17）在 `errorCode` 后加：

```ts
  /** Full provider usage for billing (P1-T9); logs keep only the two totals. */
  usage: TokenUsage | null;
```

`finish()` 返回对象（:94-104）在 `errorCode: o.errorCode,` 后加：

```ts
      usage: o.usage,
```

Run: `npm test -w gateway -- test/metrics.test.ts test/logReport.test.ts test/harness.test.ts`
Expected: PASS。

- [ ] **Step 7: 写失败的会话用量测试**

在 `gateway/test/session.test.ts` 顶部 import 区加：

```ts
import type { UsageRecord, UsageRecorder } from '../src/usage/types.ts';
```

在 `it('reports content-free metrics for every finalized reply', ...)` 用例之后追加：

```ts
  it('records one usage row per finalized reply with the session attribution', async () => {
    const rows: UsageRecord[] = [];
    const usage: UsageRecorder = { record: (r) => { rows.push(r); }, flush: () => {} };
    const s = setup({ usage, usageSource: { adapter: 'mock', model: 'mock' } }, ownedCtx, 'usage-session');
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000);
    s.mocks[0]!.emit('responseUsage', 'mock-1', { inputTokens: 10, outputTokens: 5, outputAudioTokens: 4 });
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    s.session.handleClientMessage({ type: 'debug.userText', text: '跟我挥挥手' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    const attribution = { ownerId: 'owner-1', agentId: 'agent-1', sessionId: 'usage-session', characterId: 'xiaonuan' };
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'realtime_reply', adapter: 'mock', model: 'mock', attribution, usage: { inputTokens: 10, outputTokens: 5, outputAudioTokens: 4 }, errorCode: null }),
      expect.objectContaining({ kind: 'realtime_reply', attribution, usage: null }),
    ]);
    s.session.end();
  });

  it('records nothing without a usage source', async () => {
    const rows: UsageRecord[] = [];
    const usage: UsageRecorder = { record: (r) => { rows.push(r); }, flush: () => {} };
    const s = setup({ usage }, ownedCtx, 'no-source');
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    expect(rows).toEqual([]);
    s.session.end();
  });
```

在 affect 相关用例（`'analyzes non-light finals with the affect prompt and skips light ones'`）之后追加：

```ts
  it('bills affect calls to the session that made them', async () => {
    const tags: unknown[] = [];
    const client: TextModelClient = { complete: async (input) => { tags.push(input.usage); return sadCard; } };
    const s = setup({ textClient: client, affect: affectConfig }, ownedCtx, 'affect-usage');
    s.mocks[0]!.emit('userTranscript', '今天腰有点疼，心里也闷', true);
    await vi.advanceTimersByTimeAsync(10);
    expect(tags).toEqual([{ kind: 'affect', attribution: { ownerId: 'owner-1', agentId: 'agent-1', sessionId: 'affect-usage', characterId: 'xiaonuan' } }]);
    s.session.end();
  });
```

Run: `npm test -w gateway -- test/session.test.ts`
Expected: FAIL：第一个新用例 `rows` 为空；affect 用例 `tags` 为 `[undefined]`。（第二个用例此时会 PASS，这是预期的。）

- [ ] **Step 8: Session 接线**

`gateway/src/session/session.ts`：

1. :21 `import type { TextModelClient } from '../memory/textClient.ts';` 改为：

```ts
import { withUsageTag, type TextModelClient } from '../memory/textClient.ts';
import type { UsageAttribution, UsageKind, UsageRecorder } from '../usage/types.ts';
```

2. `SessionDeps` 中 `onReplyMetrics` 那一项之后加：

```ts
  /** Usage sink for realtime replies. Unset in eval and most tests, so nothing is billed there. */
  usage?: UsageRecorder;
  /** Adapter and model billed for realtime replies. Seeduplex passes none: its usage is not counted. */
  usageSource?: { adapter: 'qwen' | 'mock'; model: string };
```

3. 构造函数里 `AffectTracker` 的 `client: deps.textClient,`（:370）改为：

```ts
          client: withUsageTag(deps.textClient, { kind: 'affect', attribution: this.usageAttribution() }),
```

（该处在 `deps.textClient && affectConfig?.enabled ? ... : null` 的真分支里，`deps.textClient` 已收窄为非空。若 TS 报可能为 undefined，在三元条件前加 `const affectClient = deps.textClient;`，条件与此处都改用 `affectClient`。）

4. `planProactiveLine` 中 `const client = this.deps.textClient;`（:685）改为：

```ts
    const client = this.textFor('silence_plan');
```

5. 工具调用 `this.toolsFor(this.language).handle(name, args, {` 之前（:1238 附近，`const triggerText = ...` 之后）加一行：

```ts
    const recallClient = this.textFor('recall_wrap');
```

并把该调用参数里的 `...(this.deps.textClient ? { textClient: this.deps.textClient } : {}),` 改为：

```ts
      ...(recallClient ? { textClient: recallClient } : {}),
```

6. `startCareOpening` 中 `const client = this.deps.textClient;`（:1694）改为：

```ts
    const client = this.textFor('care');
```

7. `finalize` 中：

```ts
    if (m) {
      log('reply_metrics', metricFields(m));
      this.deps.onReplyMetrics?.(m);
    }
```

在 `this.deps.onReplyMetrics?.(m);` 之后加一行 `this.recordReplyUsage(m);`（第一行日志调用保持 P1-T5 改后的写法不动）。

8. 在 `planProactiveLine` 方法之前加三个私有方法：

```ts
  /** Billing identity for this session's model calls. */
  private usageAttribution(): UsageAttribution {
    return { ownerId: this.context.ownerId ?? null, agentId: this.context.agentId ?? null, sessionId: this.sessionId, characterId: this.context.characterId };
  }

  /** The shared text client, tagged so its calls are billed to this session. */
  private textFor(kind: UsageKind): TextModelClient | undefined {
    const client = this.deps.textClient;
    return client ? withUsageTag(client, { kind, attribution: this.usageAttribution() }) : undefined;
  }

  /** One usage row per finalized reply; interrupted replies keep whatever usage the model reported. */
  private recordReplyUsage(m: ReplyMetrics): void {
    const { usage, usageSource } = this.deps;
    if (!usage || !usageSource) return;
    usage.record({
      kind: 'realtime_reply',
      adapter: usageSource.adapter,
      model: usageSource.model,
      usage: m.usage,
      attribution: this.usageAttribution(),
      firstAudioMs: m.speechToFirstAudioMs ?? m.vadToFirstAudioMs,
      genMs: m.genMs,
      errorCode: m.errorCode,
    });
  }
```

注意：`usageAttribution()` 在构造函数里被调用时，`this.context` 已在构造函数第一段赋值（:317），`this.sessionId` 是参数属性，二者都已可用。

Run: `npm test -w gateway -- test/session.test.ts`
Expected: PASS（含全部旧用例）。

- [ ] **Step 9: 记忆抽取带 `UsageTag`（先写测试）**

在 `gateway/test/worker.test.ts` 的 `describe('MemoryWorker queue', ...)` 末尾追加：

```ts
  it('bills extraction to the owner and agent of the job', async () => {
    const store = new SqliteMemoryStore(open());
    const created = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '今天想喝茶', bigrams: '', now: 2 });
    const tags: unknown[] = [];
    const client: TextModelClient = { complete: async (input) => { tags.push(input.usage); return '{"ops":[]}'; } };
    await worker(store, client).enqueue(created.ownerId, created.agentId, 'session_end');
    expect(tags).toEqual([{ kind: 'memory_extract', attribution: { ownerId: created.ownerId, agentId: created.agentId, sessionId: null, characterId: null } }]);
  });
```

Run: `npm test -w gateway -- test/worker.test.ts`
Expected: FAIL，`tags` 为 `[undefined]`。

`gateway/src/memory/worker.ts:135-139` 的调用：

```ts
    const result = await runWithPolicy('extract', this.opts.policy, (signal) => this.opts.client.complete({
      system: systemPrompt,
      user,
      maxTokens: this.opts.maxTokens,
      signal,
    }), {
```

改为：

```ts
    const result = await runWithPolicy('extract', this.opts.policy, (signal) => this.opts.client.complete({
      system: systemPrompt,
      user,
      maxTokens: this.opts.maxTokens,
      signal,
      // Character is not known here; admin queries join agents for it.
      usage: { kind: 'memory_extract', attribution: { ownerId, agentId, sessionId: null, characterId: null } },
    }), {
```

Run: `npm test -w gateway -- test/worker.test.ts`
Expected: PASS。

- [ ] **Step 10: 写「eval 与脚本不计入」的守护测试**

新建 `gateway/test/usage-scope.test.ts`：

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = (dir: string) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f));

describe('usage scope', () => {
  it('eval code and scripts never wire a usage recorder', () => {
    for (const file of [...files('src/eval'), ...files('scripts')]) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source, file).not.toMatch(/SqliteUsageRecorder|recorder\s*:|usageSource\s*:/);
    }
  });

  it('only index.ts constructs the recorder', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (rel.endsWith('.ts') && readFileSync(join(root, rel), 'utf8').includes('new SqliteUsageRecorder(')) offenders.push(rel);
      }
    };
    walk('src');
    expect(offenders).toEqual(['src/index.ts']);
  });
});
```

Run: `npm test -w gateway -- test/usage-scope.test.ts`
Expected: 第一个 PASS；第二个 FAIL（`index.ts` 还没有构造 recorder，`offenders` 为空）。

- [ ] **Step 11: `index.ts` 接线**

`gateway/src/index.ts`：

1. import 区加：

```ts
import { SqlitePriceBook, loadPricingBaseline } from './usage/pricing.ts';
import { SqliteUsageRecorder } from './usage/recorder.ts';
```

2. 紧跟 `const store = memoryDb ? new SqliteMemoryStore(memoryDb) : null;` 之后加：

```ts
// Validated at every start, even without a DB, so a bad price file fails fast.
const pricingBaseline = loadPricingBaseline(`${root}config/pricing.json`);
const prices = memoryDb ? new SqlitePriceBook(memoryDb, pricingBaseline) : null;
const usage = memoryDb && prices
  ? new SqliteUsageRecorder({ db: memoryDb, prices, logger, flushMs: adminConfig.usageSink.flushMs, maxBatch: adminConfig.usageSink.maxBatch })
  : null;
// Seeduplex is not counted (spec Q9/Q14).
const usageSource = config.adapter === 'qwen'
  ? { adapter: 'qwen' as const, model: config.qwenModel }
  : config.adapter === 'mock' ? { adapter: 'mock' as const, model: 'mock' } : null;
```

（`logger`、`adminConfig` 用 P1-T4/P1-T6 在本文件里定义的变量；若它们定义在 `memoryDb` 之后，把上面这段移到它们之后。）

3. `new QwenTextClient({ ... model: memory.extractModel ?? 'qwen-plus', })` 的参数对象末尾加：

```ts
      ...(usage ? { recorder: usage } : {}),
```

4. `SessionManager` 工厂里：
   - `new MockAdapter({ script: ..., speech, speechThreshold: config.mockSpeechThreshold, paceFactor: config.mockPaceFactor })` 的参数对象末尾加 `emitUsage: usage !== null`。
   - `new QwenSummarizer({ apiKey: config.qwenApiKey!, endpoint: config.summarizerEndpoint, model: config.summarizerModel })` 改为：

```ts
        ? new QwenSummarizer({
            apiKey: config.qwenApiKey!,
            endpoint: config.summarizerEndpoint,
            model: config.summarizerModel,
            ...(usage ? { recorder: usage, tag: { kind: 'summarize' as const, attribution: { ownerId: ctx.ownerId ?? null, agentId: ctx.agentId ?? null, sessionId, characterId: ctx.characterId } } } : {}),
          })
```

   - `new Session({ ... })` 的参数对象里、`...(config.adapter !== 'mock' && textClient ? { textClient } : {}),` 之后加：

```ts
      ...(usage && usageSource ? { usage, usageSource } : {}),
```

5. `shutdown` 的 `finally` 块里、`if (memoryDb?.isOpen) memoryDb.close();` 所在 `try` 之前加：

```ts
      try {
        usage?.close();
      } catch {
        logger.warn('usage_close_failed', {});
      }
```

Run: `npm test -w gateway -- test/usage-scope.test.ts`
Expected: PASS。

- [ ] **Step 12: 全量回归与类型检查**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部 PASS。若 harness / eval 相关测试因 `ReplyMetrics.usage` 报类型错误，在其构造的 `ReplyMetrics` 字面量里加 `usage: null`，不改行为。

- [ ] **Step 13: 提交**

```bash
git add gateway/src/usage/recorder.ts gateway/src/log/adminConfig.ts gateway/config/admin.json \
  gateway/src/session/metrics.ts gateway/src/session/session.ts gateway/src/memory/worker.ts gateway/src/index.ts \
  gateway/test/usage-recorder.test.ts gateway/test/usage-scope.test.ts gateway/test/metrics.test.ts \
  gateway/test/session.test.ts gateway/test/worker.test.ts
# plus the P1-T4 admin config test file edited in Step 5, by its exact path
git commit -m "feat(gateway): record per-call usage with cost

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 验收

- `usage_events` 每次调用一行，费用在写入时定格；未定价与失败调用费用为 NULL。
- realtime 回复、affect、沉默规划、care、recall 包装、记忆抽取、摘要都带正确归属；Seeduplex 与 eval 不计入。
- 写库批量进行，不在音频热路径同步写；关机时 flush。
- 守护测试保证 recorder 只在 `index.ts` 构造、eval 与脚本不接 recorder。
