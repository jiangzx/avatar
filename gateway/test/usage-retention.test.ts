import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { purgeExpiredUsage } from '../src/usage/retention.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

describe('purgeExpiredUsage', () => {
  it('deletes rows older than the cutoff in bounded batches', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(db);
    const insert = db.prepare("INSERT INTO usage_events (ts, kind, adapter, model) VALUES (?, 'summarize', 'text', 'qwen-flash')");
    for (const ts of [1, 2, 3, 4, 100]) insert.run(ts);
    expect(purgeExpiredUsage(db, 50, 3)).toBe(3);
    expect(purgeExpiredUsage(db, 50, 3)).toBe(1);
    expect(purgeExpiredUsage(db, 50, 3)).toBe(0);
    expect((db.prepare('SELECT ts FROM usage_events').all() as Array<{ ts: number }>).map((r) => r.ts)).toEqual([100]);
  });
});
