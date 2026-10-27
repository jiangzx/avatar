# P1-T4: SQLite 日志落库、`admin.json`、日志保留

**目标：** info 及以上日志批量写入 `log_events`（debug 只走 stdout）；新建 `gateway/config/admin.json`（`retention` 与 `logSink`）及其 zod schema；`index.ts` 创建进程唯一的 `LogLevelControl` 和根 `logger`（stdout + SQLite 两个 sink），并把日志保留清理挂到现有每日清理定时器上；退出时 flush。

**实现的 spec 章节：** 「架构 → 日志」输出与存储；「数据模型」保留清理一段；决策 Q27、Q35（日志 7 天）。

**前置：** P1-T2（`log_events` 表）、P1-T3（Logger 核心）已提交。开始前跑 `npm test -w gateway && npm run typecheck -w gateway`。

**Files:**
- Create: `gateway/config/admin.json`
- Create: `gateway/src/log/adminConfig.ts`
- Create: `gateway/src/log/sqliteSink.ts`
- Modify: `gateway/src/index.ts`（:1-28 import；:30-31 之后提前打开数据库并创建 logger；:85-87 删除原来的数据库打开两行；:229-244 退出时 flush；:291-300 清理定时器加日志保留）
- Modify: `gateway/.env.example`（加 `LOG_LEVEL`）
- Test: `gateway/test/admin-config.test.ts`、`gateway/test/log-sqlite-sink.test.ts`（新建）

**Interfaces:**
- Consumes（P1-T3）：`createLogger`、`LogLine`、`LogSink`、`createLogLevelControl`、`stdoutSink`；`GatewayConfig.logLevel`、`GatewayConfig.logStrict`。（P1-T2）`log_events` 表。
- Produces：
  - `gateway/src/log/adminConfig.ts`：
    ```ts
    export const AdminConfigSchema: z.ZodObject<...>; // { retention: { usageDays, logDays, auditDays }, logSink: { flushMs, maxBatch } }, strict
    export type AdminConfig = z.infer<typeof AdminConfigSchema>;
    export function loadAdminConfig(path: string): AdminConfig;
    ```
    P1-T9 给 schema 加 `usageSink`，P2-T1 把文件移到 `gateway/src/admin/config.ts` 并在这里保留 re-export（总览 C5）。
  - `gateway/src/log/sqliteSink.ts`：
    ```ts
    export interface SqliteLogSinkOptions { db: DatabaseSync; flushMs: number; maxBatch: number; onError?: (code: 'log_sink_write_failed' | 'log_sink_overflow') => void }
    export class SqliteLogSink implements LogSink { constructor(opts: SqliteLogSinkOptions); write(line: LogLine): void; flush(): void; close(): void }
    export function deleteLogsBefore(db: DatabaseSync, cutoff: number, limit: number): number;
    ```
  - `index.ts` 里的根 `logger` 和 `levels`：P1-T5 把它们注入 Session 和 SessionManager，P1-T6 注入其余模块，P2 注入后台。

## 设计要点

- **不在事务里开事务**：`write()` 从不同步 flush。批满时用 `setImmediate` 排队，定时 flush 用 `setTimeout`（`unref`）。`flush()` 发现 `db.isTransaction` 为真时改为下一轮再试，避免在 store 的事务中途 `BEGIN`。
- **队列上限**：积压超过 `maxBatch * 10` 条时丢弃新行并计数，下次 flush 时调用一次 `onError('log_sink_overflow')`。
- **失败不抛**：写库异常回滚并调用 `onError('log_sink_write_failed')`，这批丢弃。`index.ts` 的 `onError` 直接用 stdout sink 写一行 `error` 级别的同名事件（不能再经 logger，否则递归）。
- `log_events.oid` 存不带 `{E}` 的短 id；`fields` 存 `JSON.stringify(line.fields)`。
- 保留清理：每日一次，`ts < now - logDays*DAY`，按 `memory.json` 的 `retentionBatch`（200）分批删，批间 `setImmediate` 让出。
- 数据库提前到 `loadConfig()` 之后打开（不依赖角色和配置的加载），这样启动日志也能落库。

## Steps

- [ ] **Step 1: 写失败的 admin 配置测试**

新建 `gateway/test/admin-config.test.ts`：

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminConfigSchema, loadAdminConfig } from '../src/log/adminConfig.ts';

const shipped = fileURLToPath(new URL('../config/admin.json', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function file(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'admin-config-'));
  dirs.push(dir);
  const path = join(dir, 'admin.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

const valid = { retention: { usageDays: 180, logDays: 7, auditDays: 365 }, logSink: { flushMs: 1000, maxBatch: 200 } };

describe('admin config', () => {
  it('ships the agreed retention and sink values', () => {
    expect(loadAdminConfig(shipped)).toEqual(valid);
  });

  it('rejects unknown keys', () => {
    expect(() => loadAdminConfig(file({ ...valid, extra: 1 }))).toThrow();
    expect(() => loadAdminConfig(file({ ...valid, retention: { ...valid.retention, chatDays: 1 } }))).toThrow();
  });

  it('rejects out-of-range values', () => {
    expect(() => AdminConfigSchema.parse({ ...valid, retention: { ...valid.retention, logDays: 0 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, retention: { ...valid.retention, logDays: 91 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, logSink: { flushMs: 50, maxBatch: 200 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, logSink: { flushMs: 1000, maxBatch: 0 } })).toThrow();
    expect(() => AdminConfigSchema.parse({ ...valid, retention: { ...valid.retention, usageDays: 1.5 } })).toThrow();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm test -w gateway -- test/admin-config.test.ts`
Expected: FAIL，`Failed to resolve import "../src/log/adminConfig.ts"`。

- [ ] **Step 3: 实现配置文件和 schema**

新建 `gateway/config/admin.json`：

```json
{
  "retention": { "usageDays": 180, "logDays": 7, "auditDays": 365 },
  "logSink": { "flushMs": 1000, "maxBatch": 200 }
}
```

新建 `gateway/src/log/adminConfig.ts`：

```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const days = (max: number) => z.number().int().min(1).max(max);

/** gateway/config/admin.json. Later tasks extend this one schema (usageSink, session, login, alerts). */
export const AdminConfigSchema = z.object({
  retention: z.object({
    usageDays: days(3650),
    logDays: days(90),
    auditDays: days(3650),
  }).strict(),
  logSink: z.object({
    flushMs: z.number().int().min(100).max(60_000),
    maxBatch: z.number().int().min(1).max(5_000),
  }).strict(),
}).strict();

export type AdminConfig = z.infer<typeof AdminConfigSchema>;

export function loadAdminConfig(path: string): AdminConfig {
  return AdminConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `npm test -w gateway -- test/admin-config.test.ts`
Expected: PASS，3 个用例。

- [ ] **Step 5: 写失败的 SQLite sink 测试**

新建 `gateway/test/log-sqlite-sink.test.ts`：

```ts
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteLogSink, deleteLogsBefore } from '../src/log/sqliteSink.ts';
import type { LogLine } from '../src/log/logger.ts';

const dbs: DatabaseSync[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
});

function db(): DatabaseSync {
  const d = openDatabase(':memory:', { busyTimeoutMs: 100 });
  dbs.push(d);
  return d;
}

const line = (event: string, extra: Partial<LogLine> = {}): LogLine => ({ t: 1_000, level: 'info', event, binding: {}, fields: {}, ...extra });
const rows = (d: DatabaseSync) => d.prepare('SELECT ts, level, event, sid, oid, char, seq, job, fields FROM log_events ORDER BY id').all();

describe('SqliteLogSink', () => {
  it('writes info and above after the flush interval, with binding columns and JSON fields', async () => {
    const d = db();
    const sink = new SqliteLogSink({ db: d, flushMs: 1_000, maxBatch: 50 });
    sink.write(line('response_start', { binding: { sid: 's1', oid: 'abc123def456', char: 'xiaonuan', seq: 2 }, fields: { kind: 'reply' } }));
    sink.write(line('vad_edge', { level: 'debug' }));
    sink.write(line('adapter_error', { level: 'error', binding: { job: 'extract' }, fields: { code: 'qwen_error' } }));
    expect(rows(d)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rows(d)).toEqual([
      { ts: 1_000, level: 'info', event: 'response_start', sid: 's1', oid: 'abc123def456', char: 'xiaonuan', seq: 2, job: null, fields: '{"kind":"reply"}' },
      { ts: 1_000, level: 'error', event: 'adapter_error', sid: null, oid: null, char: null, seq: null, job: 'extract', fields: '{"code":"qwen_error"}' },
    ]);
  });

  it('flushes a full batch on the next tick, never synchronously', async () => {
    const d = db();
    const sink = new SqliteLogSink({ db: d, flushMs: 60_000, maxBatch: 2 });
    sink.write(line('a'));
    sink.write(line('b'));
    expect(rows(d)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(rows(d)).toHaveLength(2);
  });

  it('waits while the connection is inside another transaction', async () => {
    const d = db();
    const sink = new SqliteLogSink({ db: d, flushMs: 10, maxBatch: 50 });
    sink.write(line('a'));
    d.exec('BEGIN');
    await vi.advanceTimersByTimeAsync(10);
    expect(d.isTransaction).toBe(true);
    d.exec('COMMIT');
    await vi.advanceTimersByTimeAsync(10);
    expect(rows(d)).toHaveLength(1);
  });

  it('reports a failed write without throwing and drops that batch', async () => {
    const d = db();
    const errors: string[] = [];
    const sink = new SqliteLogSink({ db: d, flushMs: 10, maxBatch: 50, onError: (code) => errors.push(code) });
    d.exec('DROP TABLE log_events');
    sink.write(line('a'));
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toEqual(['log_sink_write_failed']);
    expect(d.isTransaction).toBe(false);
  });

  it('drops lines beyond ten batches of backlog and reports the overflow once', async () => {
    const d = db();
    const errors: string[] = [];
    const sink = new SqliteLogSink({ db: d, flushMs: 10, maxBatch: 1, onError: (code) => errors.push(code) });
    d.exec('BEGIN'); // hold every flush
    for (let i = 0; i < 15; i++) sink.write(line(`e${i}`));
    d.exec('COMMIT');
    await vi.advanceTimersByTimeAsync(10);
    expect(rows(d)).toHaveLength(10);
    expect(errors).toEqual(['log_sink_overflow']);
  });

  it('flushes on close and ignores later writes', () => {
    const d = db();
    const sink = new SqliteLogSink({ db: d, flushMs: 60_000, maxBatch: 50 });
    sink.write(line('a'));
    sink.close();
    sink.write(line('b'));
    expect(rows(d)).toHaveLength(1);
  });
});

describe('deleteLogsBefore', () => {
  it('deletes at most `limit` rows older than the cutoff and returns the count', () => {
    const d = db();
    const insert = d.prepare("INSERT INTO log_events (ts, level, event) VALUES (?, 'info', 'x')");
    for (const ts of [1, 2, 3, 10]) insert.run(ts);
    expect(deleteLogsBefore(d, 5, 2)).toBe(2);
    expect(deleteLogsBefore(d, 5, 2)).toBe(1);
    expect(deleteLogsBefore(d, 5, 2)).toBe(0);
    expect(d.prepare('SELECT ts FROM log_events').all()).toEqual([{ ts: 10 }]);
  });
});
```

- [ ] **Step 6: 运行，确认失败**

Run: `npm test -w gateway -- test/log-sqlite-sink.test.ts`
Expected: FAIL，`Failed to resolve import "../src/log/sqliteSink.ts"`。

- [ ] **Step 7: 实现 sink**

新建 `gateway/src/log/sqliteSink.ts`：

```ts
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { LogLine, LogSink } from './logger.ts';

export interface SqliteLogSinkOptions {
  db: DatabaseSync;
  flushMs: number;
  maxBatch: number;
  /** Called instead of logging (a sink must not log through the logger it serves). */
  onError?: (code: 'log_sink_write_failed' | 'log_sink_overflow') => void;
}

/** Batches info+ lines into log_events for the admin trace page. debug stays on stdout only. */
export class SqliteLogSink implements LogSink {
  private readonly insert: StatementSync;
  private queue: LogLine[] = [];
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  private dropped = 0;
  private closed = false;

  constructor(private readonly opts: SqliteLogSinkOptions) {
    this.insert = opts.db.prepare('INSERT INTO log_events (ts, level, event, sid, oid, char, seq, job, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  }

  write(line: LogLine): void {
    if (this.closed || line.level === 'debug') return;
    if (this.queue.length >= this.opts.maxBatch * 10) {
      this.dropped++;
      return;
    }
    this.queue.push(line);
    // Never flush synchronously: the caller may be inside a store transaction.
    if (this.queue.length >= this.opts.maxBatch) this.scheduleNow();
    else this.scheduleLater();
  }

  flush(): void {
    this.cancelTimers();
    if (this.opts.db.isTransaction) {
      this.scheduleLater();
      return;
    }
    if (this.dropped > 0) {
      this.dropped = 0;
      this.opts.onError?.('log_sink_overflow');
    }
    const batch = this.queue.splice(0, this.opts.maxBatch * 10);
    if (batch.length === 0) return;
    const { db } = this.opts;
    try {
      db.exec('BEGIN');
      for (const l of batch) {
        const b = l.binding;
        this.insert.run(l.t, l.level, l.event, b.sid ?? null, b.oid ?? null, b.char ?? null, b.seq ?? null, b.job ?? null, JSON.stringify(l.fields));
      }
      db.exec('COMMIT');
    } catch {
      if (db.isTransaction) db.exec('ROLLBACK');
      this.opts.onError?.('log_sink_write_failed');
    }
  }

  close(): void {
    this.flush();
    this.cancelTimers();
    this.closed = true;
  }

  private scheduleNow(): void {
    if (this.immediate) return;
    this.immediate = setImmediate(() => { this.immediate = null; this.flush(); });
  }

  private scheduleLater(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.opts.flushMs);
    this.timer.unref();
  }

  private cancelTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.immediate) clearImmediate(this.immediate);
    this.timer = null;
    this.immediate = null;
  }
}

/** One retention batch. Returns how many rows were deleted. */
export function deleteLogsBefore(db: DatabaseSync, cutoff: number, limit: number): number {
  const result = db.prepare('DELETE FROM log_events WHERE id IN (SELECT id FROM log_events WHERE ts < ? ORDER BY id LIMIT ?)').run(cutoff, limit);
  return Number(result.changes);
}
```

注意：`close()` 在数据库处于事务中时会把 flush 推迟到定时器；退出流程里在 `memoryDb.close()` 之前调用，此时没有事务。

- [ ] **Step 8: 运行，确认通过**

Run: `npm test -w gateway -- test/log-sqlite-sink.test.ts`
Expected: PASS，7 个用例。

- [ ] **Step 9: index 接线**

`gateway/src/index.ts`：

1. import 区加：

```ts
import { loadAdminConfig } from './log/adminConfig.ts';
import { createLogLevelControl } from './log/levels.ts';
import { createLogger } from './log/logger.ts';
import { SqliteLogSink, deleteLogsBefore } from './log/sqliteSink.ts';
import { stdoutSink } from './log/stdoutSink.ts';
```

2. 在 `const config = loadConfig();`（:31）之后插入，并**删除**原来 :85–87 的 `identityConfig` 和 `memoryDb` 两个声明（`store` 那一行保持在原处不动）：

```ts
const adminConfig = loadAdminConfig(`${root}config/admin.json`);
// Device identity (Plan B). MEMORY_DB_PATH unset = dev mode: no registration, no memory, bearers rejected.
const identityConfig = loadIdentityConfig(process.env, fileURLToPath(new URL('../..', import.meta.url)));
const memoryDb = identityConfig.memoryDbPath ? openDatabase(identityConfig.memoryDbPath, { busyTimeoutMs: identityConfig.busyTimeoutMs }) : null;
// One level control and one root logger per process; children carry sid/oid/char/seq/job.
const levels = createLogLevelControl(config.logLevel);
const stdout = stdoutSink();
const logSink = memoryDb
  ? new SqliteLogSink({
      db: memoryDb,
      flushMs: adminConfig.logSink.flushMs,
      maxBatch: adminConfig.logSink.maxBatch,
      onError: (code) => stdout.write({ t: Date.now(), level: 'error', event: code, binding: {}, fields: {} }),
    })
  : null;
const logger = createLogger({ sinks: logSink ? [stdout, logSink] : [stdout], levels, strict: config.logStrict });
logger.info('log_sink_ready', { db: logSink !== null, level: config.logLevel });
```

3. 退出流程 `finally` 里，`memoryDb.close()` 之前先关 sink：

```ts
    } finally {
      try {
        logSink?.close();
        if (memoryDb?.isOpen) memoryDb.close();
      } catch {
        log('memory_db_close_failed', {});
      }
      process.exit(0);
    }
```

4. 在 `expireTranscripts` 函数之后加日志保留函数，并在 `runCleanup` 里调用：

```ts
/** Admin trace logs: same daily timer, age from admin.json, batch size from memory.json. */
async function expireLogs(): Promise<void> {
  if (!memoryDb) return;
  const cutoff = Date.now() - adminConfig.retention.logDays * DAY_MS;
  for (;;) {
    let deleted: number;
    try {
      deleted = deleteLogsBefore(memoryDb, cutoff, memory.retentionBatch);
    } catch {
      logger.error('log_retention_failed');
      return;
    }
    if (deleted > 0) logger.info('log_retention_batch', { deleted });
    if (deleted < memory.retentionBatch) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
```

```ts
  const runCleanup = () => {
    registry.cleanupOrphans().catch(() => log('orphan_cleanup_failed', {}));
    void expireTranscripts().catch(() => log('memory_retention_failed', {}));
    void expireLogs().catch(() => logger.error('log_retention_failed'));
  };
```

（其余 `log(...)` 调用本任务不动，P1-T6 统一迁移。）

`gateway/.env.example` 在 `ALLOW_DEBUG_TEXT=1` 之前加：

```bash
# Log level: debug | info | warn | error (default info). The admin console can raise it for 30 minutes.
# LOG_LEVEL=info
```

- [ ] **Step 10: 类型检查与全量回归**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部通过，typecheck 无输出。

- [ ] **Step 11: 进程冒烟（Mock，临时库）**

```bash
rm -f /tmp/admin-p1t4.db*
cd gateway
APP_SECRET=p1t4-smoke-secret-0000 ADAPTER=mock PORT=8797 MEMORY_DB_PATH=/tmp/admin-p1t4.db node --import tsx src/index.ts > /tmp/admin-p1t4.log 2>&1 &
PID=$!; sleep 4; kill -TERM $PID; wait $PID
npx tsx -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/tmp/admin-p1t4.db');
console.log(JSON.stringify(db.prepare(\"SELECT level, event, fields FROM log_events WHERE event = 'log_sink_ready'\").all()));"
grep -c '"event":"log_sink_ready"' /tmp/admin-p1t4.log
cd ..
```

Expected：第一条输出 `[{"level":"info","event":"log_sink_ready","fields":"{\"db\":true}"}]`；`grep -c` 输出 `1`。`/tmp/admin-p1t4.log` 里每行都以 `{"t":` 开头。

- [ ] **Step 12: 提交**

```bash
git add gateway/config/admin.json gateway/src/log/adminConfig.ts gateway/src/log/sqliteSink.ts gateway/src/index.ts gateway/.env.example gateway/test/admin-config.test.ts gateway/test/log-sqlite-sink.test.ts
git commit -m "feat(gateway): store info logs in SQLite with retention

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
