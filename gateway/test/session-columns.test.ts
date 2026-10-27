import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ownerShortId } from '../src/log/ownerId.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];

function open(): DatabaseSync {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
});

const session = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT ended_at, end_reason, adapter FROM sessions WHERE id = ?').get(id) as { ended_at: number | null; end_reason: string | null; adapter: string | null };

describe('session columns', () => {
  it('stores the adapter at start and the reason at end', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const who = seedOwner(store, 'h1', 1);
    store.recordSessionStart('s1', who.agentId, 10, 'qwen');
    expect(session(db, 's1')).toEqual({ ended_at: null, end_reason: null, adapter: 'qwen' });
    store.recordSessionEnd('s1', who.agentId, 20, 'client_end');
    expect(session(db, 's1')).toEqual({ ended_at: 20, end_reason: 'client_end', adapter: 'qwen' });
    // A second end does not overwrite the first.
    store.recordSessionEnd('s1', who.agentId, 30, 'shutdown');
    expect(session(db, 's1')).toEqual({ ended_at: 20, end_reason: 'client_end', adapter: 'qwen' });
  });

  it('keeps the old call shape working with NULL columns', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const who = seedOwner(store, 'h1', 1);
    store.recordSessionStart('s1', who.agentId, 10);
    store.recordSessionEnd('s1', who.agentId, 20);
    expect(session(db, 's1')).toEqual({ ended_at: 20, end_reason: null, adapter: null });
  });

  it('marks sessions closed at startup as process_restart', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const who = seedOwner(store, 'h1', 1);
    store.recordSessionStart('open', who.agentId, 10, 'mock');
    store.recordSessionStart('done', who.agentId, 11, 'mock');
    store.recordSessionEnd('done', who.agentId, 12, 'client_end');
    expect(store.closeOpenSessions(99)).toBe(1);
    expect(session(db, 'open')).toMatchObject({ end_reason: 'process_restart' });
    expect(session(db, 'done')).toMatchObject({ end_reason: 'client_end' });
  });
});

describe('owner deletion and logs', () => {
  const insertLog = (db: DatabaseSync, oid: string | null) =>
    db.prepare("INSERT INTO log_events (ts, level, event, oid) VALUES (1, 'info', 'x', ?)").run(oid);
  const logOids = (db: DatabaseSync) =>
    (db.prepare('SELECT oid FROM log_events ORDER BY id').all() as Array<{ oid: string | null }>).map((r) => r.oid);

  it('deletes the owner log lines by short id and keeps everyone else', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha', 1);
    const b = seedOwner(store, 'hb', 1);
    insertLog(db, ownerShortId(a.ownerId));
    insertLog(db, ownerShortId(b.ownerId));
    insertLog(db, null);
    expect(store.deleteOwner(a.ownerId)).toBe(true);
    expect(logOids(db)).toEqual([ownerShortId(b.ownerId), null]);
  });

  it('leaves logs alone when the owner does not exist', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    insertLog(db, ownerShortId('missing-owner'));
    expect(store.deleteOwner('missing-owner')).toBe(false);
    expect(logOids(db)).toEqual([ownerShortId('missing-owner')]);
  });

  it('deletes orphan owners together with their log lines', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const orphan = store.createOwner({ tokenHash: 'ho', now: 1 });
    insertLog(db, ownerShortId(orphan.ownerId));
    expect(store.deleteOrphanOwners(1_000, 10)).toBe(1);
    expect(logOids(db)).toEqual([]);
  });
});
