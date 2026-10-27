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

  it('close defers the flush while a transaction is open instead of discarding', async () => {
    const d = db();
    const sink = new SqliteLogSink({ db: d, flushMs: 10, maxBatch: 50 });
    d.exec('BEGIN');
    sink.write(line('a'));
    sink.close();
    d.exec('COMMIT');
    await vi.advanceTimersByTimeAsync(10);
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
