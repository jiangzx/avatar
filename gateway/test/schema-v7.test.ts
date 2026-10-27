import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_VERSION, MIGRATIONS, migrate } from '../src/memory/migrations.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

function rawDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys = ON');
  dbs.push(db);
  return db;
}

const columns = (db: DatabaseSync, table: string): string[] =>
  db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => (row as { name: string }).name);
const names = (db: DatabaseSync, type: 'table' | 'index'): string[] =>
  db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type).map((row) => (row as { name: string }).name);
const count = (db: DatabaseSync, sql: string, ...args: (string | number)[]): number => (db.prepare(sql).get(...args) as { n: number }).n;

describe('schema v7', () => {
  it('is the latest version', () => {
    expect(BASELINE_VERSION + MIGRATIONS.length - 1).toBe(7);
  });

  it('creates every admin and observability table with its columns and indexes', () => {
    const db = rawDb();
    expect(migrate(db)).toBe(7);
    expect(names(db, 'table')).toEqual(expect.arrayContaining(['usage_events', 'price_entries', 'log_events', 'config_versions', 'secrets', 'admin_audit']));
    expect(columns(db, 'usage_events')).toEqual([
      'id', 'ts', 'owner_id', 'agent_id', 'session_id', 'character_id', 'kind', 'adapter', 'model',
      'input_text_tokens', 'input_audio_tokens', 'output_text_tokens', 'output_audio_tokens', 'cached_tokens',
      'input_tokens', 'output_tokens', 'first_audio_ms', 'gen_ms', 'error_code', 'estimated', 'price_id', 'cost_micro_yuan',
    ]);
    expect(columns(db, 'price_entries')).toEqual([
      'id', 'model', 'effective_from', 'input_text', 'input_audio', 'output_text', 'output_audio', 'cached', 'source', 'checked_at', 'created_at', 'actor',
    ]);
    expect(columns(db, 'log_events')).toEqual(['id', 'ts', 'level', 'event', 'sid', 'oid', 'char', 'seq', 'job', 'fields']);
    expect(columns(db, 'config_versions')).toEqual(['id', 'created_at', 'base_version', 'overlay', 'note', 'actor', 'kind']);
    expect(columns(db, 'secrets')).toEqual(['name', 'ciphertext', 'iv', 'tag', 'last4', 'updated_at', 'actor']);
    expect(columns(db, 'admin_audit')).toEqual(['id', 'ts', 'actor', 'action', 'target', 'detail']);
    expect(columns(db, 'sessions')).toEqual(expect.arrayContaining(['end_reason', 'adapter']));
    expect(columns(db, 'owners')).toEqual(expect.arrayContaining(['banned_at']));
    expect(names(db, 'index')).toEqual(expect.arrayContaining([
      'usage_events_owner_ts', 'usage_events_ts', 'usage_events_session', 'log_events_sid', 'log_events_oid', 'log_events_ts', 'admin_audit_ts',
    ]));
  });

  it('upgrades a v6 database in place and keeps its rows', () => {
    const db = rawDb();
    expect(migrate(db, [MIGRATIONS[0]!])).toBe(6);
    // Seed the v6 shape directly: the store prepares statements that need the v7 columns and tables.
    const ownerId = 'owner-v6';
    const deviceId = 'device-v6';
    const agentId = 'agent-v6';
    db.prepare('INSERT INTO owners (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(ownerId, 1_000, 1_000);
    db.prepare('INSERT INTO devices (id, owner_id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(deviceId, ownerId, 'h-v6', 1_000, 1_000);
    db.prepare('INSERT INTO agents (id, owner_id, character_id, created_at) VALUES (?, ?, ?, ?)').run(agentId, ownerId, 'xiaonuan', 1_000);
    db.prepare('INSERT INTO sessions (id, agent_id, started_at) VALUES (?, ?, ?)').run('s-v6', agentId, 2_000);
    expect(migrate(db)).toBe(7);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    expect(new SqliteMemoryStore(db).findDevice('h-v6')).toEqual({ deviceId, ownerId });
    expect(db.prepare('SELECT end_reason, adapter FROM sessions WHERE id = ?').get('s-v6')).toEqual({ end_reason: null, adapter: null });
    expect(db.prepare('SELECT banned_at FROM owners WHERE id = ?').get(ownerId)).toEqual({ banned_at: null });
  });

  it('cascades usage rows with their owner but keeps system rows and log rows', () => {
    const db = rawDb();
    migrate(db);
    const store = new SqliteMemoryStore(db);
    const owner = seedOwner(store, 'h-cascade');
    const insert = db.prepare('INSERT INTO usage_events (ts, owner_id, kind, adapter, model) VALUES (?, ?, ?, ?, ?)');
    insert.run(1, owner.ownerId, 'realtime_reply', 'qwen', 'm');
    insert.run(2, null, 'memory_extract', 'text', 'm');
    db.prepare("INSERT INTO log_events (ts, level, event, oid) VALUES (1, 'info', 'x', 'abc123def456')").run();
    expect(store.deleteOwner(owner.ownerId)).toBe(true);
    expect(count(db, 'SELECT count(*) AS n FROM usage_events WHERE owner_id IS NOT NULL')).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM usage_events WHERE owner_id IS NULL')).toBe(1);
    // log_events has no FK on purpose: P1-T10 deletes them by ownerShortId.
    expect(count(db, 'SELECT count(*) AS n FROM log_events')).toBe(1);
  });

  it('defaults estimated to 0 and log fields to an empty object', () => {
    const db = rawDb();
    migrate(db);
    db.prepare("INSERT INTO usage_events (ts, kind, adapter, model) VALUES (1, 'summarize', 'text', 'qwen-flash')").run();
    db.prepare("INSERT INTO log_events (ts, level, event) VALUES (1, 'info', 'x')").run();
    expect(db.prepare('SELECT estimated, cost_micro_yuan FROM usage_events').get()).toEqual({ estimated: 0, cost_micro_yuan: null });
    expect(db.prepare('SELECT fields FROM log_events').get()).toEqual({ fields: '{}' });
  });

  it('accepts only the three config version kinds', () => {
    const db = rawDb();
    migrate(db);
    const insert = db.prepare("INSERT INTO config_versions (created_at, overlay, actor, kind) VALUES (1, '{}', 'admin', ?)");
    for (const kind of ['publish', 'rollback', 'reset']) insert.run(kind);
    expect(() => insert.run('edit')).toThrow(/CHECK/);
  });
});
