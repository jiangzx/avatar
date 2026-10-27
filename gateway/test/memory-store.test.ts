import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { bigrams } from '../src/memory/bigram.ts';
import { openDatabase } from '../src/memory/db.ts';
import { BASELINE_VERSION, LEGACY_SCHEMA_ERROR, MIGRATIONS, migrate } from '../src/memory/migrations.ts';
import { ExtractIncompleteError, SqliteMemoryStore, type ExtractionChange } from '../src/memory/store.ts';
import { agentOf, seedOwner, type Who } from './helpers/memory.ts';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
const LATEST = BASELINE_VERSION + MIGRATIONS.length - 1;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = 24 * 60 * 60_000;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-memory-'));
  dirs.push(dir);
  return dir;
}

function open(path = ':memory:'): DatabaseSync {
  const db = openDatabase(path, { busyTimeoutMs: 1234 });
  dbs.push(db);
  return db;
}

function say(store: SqliteMemoryStore, who: Who, id: string, text: string, now: number, opts: { sessionId?: string; role?: 'user' | 'assistant' } = {}): void {
  store.insertMessage({ id, sessionId: opts.sessionId ?? 's1', ownerId: who.ownerId, agentId: who.agentId, role: opts.role ?? 'user', text, bigrams: bigrams(text), now });
}

function change(partial: Partial<ExtractionChange>): ExtractionChange {
  return { now: 10, messageIds: [], facts: [], notes: [], episodes: [], followups: [], ...partial };
}

const count = (db: DatabaseSync, sql: string, ...args: string[]): number => (db.prepare(sql).get(...args) as { n: number }).n;
const column = (db: DatabaseSync, sql: string, ...args: string[]): unknown[] => db.prepare(sql).all(...args).map((row) => Object.values(row as Record<string, unknown>)[0]);

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates an owner-only WAL database at the multi-character baseline', () => {
    const dir = tempDir();
    const path = join(dir, 'nested', 'memory.db');
    const db = open(path);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 1234 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: LATEST });
    seedOwner(new SqliteMemoryStore(db), 'h1'); // forces a WAL write
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('tightens a pre-existing file and keeps data across reopen', () => {
    const path = join(tempDir(), 'memory.db');
    writeFileSync(path, '', { mode: 0o644 });
    const first = open(path);
    const created = seedOwner(new SqliteMemoryStore(first), 'h1');
    first.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new SqliteMemoryStore(open(path));
    expect(again.findDevice('h1')).toEqual({ deviceId: created.deviceId, ownerId: created.ownerId });
  });

  it('refuses a database written by a newer gateway', () => {
    const path = join(tempDir(), 'memory.db');
    const db = open(path);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => openDatabase(path, { busyTimeoutMs: 100 })).toThrow(/newer/);
  });

  it.each([1, 2, 3, 4, 5])('refuses a pre-multi-character database file at v%i', (version) => {
    const path = join(tempDir(), 'memory.db');
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${version}`);
    raw.close();
    expect(() => openDatabase(path, { busyTimeoutMs: 100 })).toThrow(LEGACY_SCHEMA_ERROR);
  });
});

describe('migrate', () => {
  it('builds the v6 baseline tables (later steps only add)', () => {
    const db = open();
    expect(BASELINE_VERSION).toBe(6);
    expect(MIGRATIONS).toHaveLength(2);
    const tables = column(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables).toEqual(expect.arrayContaining([
      'owners', 'devices', 'agents', 'sessions', 'messages', 'messages_fts', 'profile_facts', 'agent_facts',
      'pinned_memories', 'relationship_notes', 'episodes', 'followups', 'memory_changes', 'meta',
    ]));
    expect(tables).not.toContain('user_facts');
    const columns = (table: string) => column(db, `SELECT name FROM pragma_table_info('${table}')`);
    expect(columns('owners')).toEqual(['id', 'created_at', 'last_seen_at', 'memory_consent', 'notified_at', 'memory_epoch', 'banned_at']);
    expect(columns('agents')).toEqual(['id', 'owner_id', 'character_id', 'created_at', 'memory_epoch']);
    for (const table of ['messages', 'agent_facts', 'pinned_memories', 'relationship_notes', 'episodes', 'followups']) {
      expect(columns(table)).toEqual(expect.arrayContaining(['owner_id', 'agent_id']));
    }
    expect(columns('memory_changes')).toEqual(expect.arrayContaining(['owner_id', 'agent_id']));
    expect(columns('profile_facts')).toEqual(expect.arrayContaining(['category', 'source_message_ids']));
    expect(columns('profile_facts')).not.toContain('agent_id');
    expect(columns('agent_facts')).toEqual(expect.arrayContaining(['sensitive', 'source_message_ids']));
    expect(columns('pinned_memories')).toEqual(expect.arrayContaining(['sensitive', 'source_session_id', 'source_message_id']));
    expect(columns('followups')).toEqual(expect.arrayContaining(['quote', 'sensitive', 'created_at']));
    expect(column(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")).toEqual(expect.arrayContaining([
      'messages_agent_created', 'messages_agent_pending', 'agent_facts_agent', 'pinned_memories_agent', 'profile_facts_owner',
    ]));
  });

  it('applies steps appended after the baseline in order and is idempotent', () => {
    const db = open();
    const steps = [...MIGRATIONS, 'CREATE TABLE plan_probe (id TEXT PRIMARY KEY) STRICT'];
    expect(migrate(db, steps)).toBe(8);
    expect(migrate(db, steps)).toBe(8);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
    expect(count(db, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'plan_probe'")).toBe(1);
  });

  it('rolls back a failing step and leaves the version unchanged', () => {
    const db = open();
    expect(() => migrate(db, [...MIGRATIONS, 'CREATE TABLE half_done (id TEXT) STRICT; NOT VALID SQL'])).toThrow();
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: LATEST });
    expect(count(db, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'half_done'")).toBe(0);
  });

  it.each([1, 2, 3, 4, 5])('rejects a v%i schema without touching it', (version) => {
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    db.exec(`PRAGMA user_version = ${version}`);
    expect(() => migrate(db)).toThrow(LEGACY_SCHEMA_ERROR);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: version });
    expect(count(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")).toBe(0);
  });
});

describe('identity rows', () => {
  it('creates owner and device only; each character gets its own agent on first use', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = store.createOwner({ tokenHash: 'h1', now: 5_000 });
    expect(Object.keys(created).sort()).toEqual(['deviceId', 'ownerId']);
    for (const id of Object.values(created)) expect(id).toMatch(UUID_V4);
    expect(store.getOwner(created.ownerId)).toEqual({
      id: created.ownerId, createdAt: 5_000, lastSeenAt: 5_000, memoryConsent: 'unknown', notifiedAt: null, memoryEpoch: 0,
    });
    expect(store.findDevice('h1')).toEqual({ deviceId: created.deviceId, ownerId: created.ownerId });
    expect(count(db, 'SELECT count(*) AS n FROM agents')).toBe(0);
    const nuan = store.ensureAgent(created.ownerId, 'xiaonuan', 6_000);
    expect(nuan).toEqual({ id: nuan.id, ownerId: created.ownerId, characterId: 'xiaonuan', memoryEpoch: 0 });
    expect(nuan.id).toMatch(UUID_V4);
    expect(store.ensureAgent(created.ownerId, 'xiaonuan', 7_000)).toEqual(nuan);
    const kai = store.ensureAgent(created.ownerId, 'xiaokai', 7_000);
    expect(kai.id).not.toBe(nuan.id);
    expect(count(db, 'SELECT count(*) AS n FROM agents')).toBe(2);
  });

  it('leaves nothing behind when a token hash is reused', () => {
    const store = new SqliteMemoryStore(open());
    store.createOwner({ tokenHash: 'h1', now: 1 });
    expect(() => store.createOwner({ tokenHash: 'h1', now: 2 })).toThrow(/UNIQUE/);
    expect(store.countOwners()).toBe(1);
  });

  it('scopes session writes to their agent', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    const b = seedOwner(store, 'hb');
    store.recordSessionStart('s-a', a.agentId, 10);
    store.recordSessionEnd('s-a', b.agentId, 20); // wrong agent: ignored
    expect(store.listSessions(a.ownerId)).toEqual([{ id: 's-a', agentId: a.agentId, startedAt: 10, endedAt: null }]);
    expect(store.listSessions(b.ownerId)).toEqual([]);
    store.recordSessionEnd('s-a', a.agentId, 30);
    expect(store.listSessions(a.ownerId)[0]?.endedAt).toBe(30);
  });

  it('closes sessions left open by a previous process', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    store.recordSessionStart('s-crash', a.agentId, 10);
    say(store, a, 'm-crash', '昨天去了公园', 11, { sessionId: 's-crash' });
    expect(store.recentUserMessages(a.ownerId, a.agentId, 10)).toEqual([]);
    expect(store.closeOpenSessions(20)).toBe(1);
    expect(store.recentUserMessages(a.ownerId, a.agentId, 10)).toEqual([{ text: '昨天去了公园' }]);
    expect(store.closeOpenSessions(30)).toBe(0);
  });

  it('touches device and owner last-seen times', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1_000);
    store.touchDevice(created.ownerId, created.deviceId, 9_000);
    expect(store.getOwner(created.ownerId)?.lastSeenAt).toBe(9_000);
    expect(db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(created.deviceId)).toEqual({ last_seen_at: 9_000 });
  });

  it('cascades an owner delete through devices, agents, sessions, messages and every memory table', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    const b = seedOwner(store, 'hb');
    store.recordSessionStart('s-a', a.agentId, 10);
    say(store, a, 'm1', '我喜欢喝茶', 11, { sessionId: 's-a' });
    store.writeExtraction(a.ownerId, a.agentId, change({
      messageIds: ['m1'],
      facts: [{ op: 'add', category: 'profile', text: '老家山东' }, { op: 'add', category: 'preference', text: '喜欢喝茶' }],
      notes: [{ op: 'add', text: '说话慢一点' }],
      episodes: [{ op: 'add', summary: '聊了喝茶' }],
      followups: [{ op: 'add', text: '问问喝茶', dueAt: 99 }],
    }));
    store.insertPinned({ id: 'pin-a', ownerId: a.ownerId, agentId: a.agentId, text: '孙子三月三号生日', sensitive: false, sourceSessionId: 's-a', sourceMessageId: 'm1', now: 12 });
    expect(store.deleteOwner(a.ownerId)).toBe(true);
    expect(store.deleteOwner(a.ownerId)).toBe(false);
    expect(store.findDevice('ha')).toBeUndefined();
    for (const table of ['devices', 'agents']) expect(count(db, `SELECT count(*) AS n FROM ${table}`)).toBe(1);
    for (const table of ['sessions', 'messages', 'profile_facts', 'agent_facts', 'pinned_memories', 'relationship_notes', 'episodes', 'followups', 'memory_changes']) {
      expect(count(db, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }
    expect(db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH '喝茶'`).all()).toEqual([]);
    expect(store.findDevice('hb')?.ownerId).toBe(b.ownerId);
  });

  it('counts owners for the registration caps', () => {
    const store = new SqliteMemoryStore(open());
    store.createOwner({ tokenHash: 'h1', now: 1_000 });
    store.createOwner({ tokenHash: 'h2', now: 2_000 });
    store.createOwner({ tokenHash: 'h3', now: 3_000 });
    expect(store.countOwners()).toBe(3);
    expect(store.countOwnersCreatedSince(2_000)).toBe(2);
  });

  it('deletes owners without any agent row past the cutoff, at most `limit` per call', () => {
    const store = new SqliteMemoryStore(open());
    const bare = ['h1', 'h2', 'h3'].map((tokenHash) => store.createOwner({ tokenHash, now: 100 }));
    const resolvedOnce = seedOwner(store, 'h4', 100); // agent row, never started a session
    const fresh = store.createOwner({ tokenHash: 'h5', now: 900 });
    expect(store.deleteOrphanOwners(500, 2)).toBe(2);
    expect(store.deleteOrphanOwners(500, 2)).toBe(1);
    expect(store.deleteOrphanOwners(500, 2)).toBe(0);
    expect(bare.map((o) => store.getOwner(o.ownerId))).toEqual([undefined, undefined, undefined]);
    expect(store.getOwner(resolvedOnce.ownerId)).toBeDefined();
    expect(store.getOwner(fresh.ownerId)).toBeDefined();
  });

  it('never treats an owner as orphaned after its memory is cleared', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha', 100);
    store.recordSessionStart('s1', a.agentId, 150);
    store.recordSessionEnd('s1', a.agentId, 160);
    store.clearAllMemory(a.ownerId);
    store.wipeOwnerMemory(a.ownerId);
    expect(store.deleteOrphanOwners(10 * DAY, 10)).toBe(0);
    expect(store.getOwner(a.ownerId)).toBeDefined();
    expect(store.findDevice('ha')?.ownerId).toBe(a.ownerId);
  });

  it('deletes messages older than the cutoff or excluded, and keeps facts and notes', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha', 1);
    const b = seedOwner(store, 'hb', 1);
    const now = 100 * DAY;
    const olderThan = now - 90 * DAY;
    say(store, a, 'old', 'old', olderThan - 1);
    say(store, a, 'fresh', 'fresh', olderThan, { role: 'assistant' });
    say(store, a, 'blank', 'blank', now);
    db.prepare(`UPDATE messages SET text = '', bigrams = '', excluded = 1 WHERE id = 'blank'`).run();
    say(store, b, 'other', 'other', 1);
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [{ op: 'add', category: 'addressing', text: 'kept-fact' }], notes: [{ op: 'add', text: 'kept-note' }] }));
    expect(store.deleteExpiredMessages(a.ownerId, olderThan, 10)).toBe(2);
    expect(column(db, 'SELECT id FROM messages WHERE owner_id = ? ORDER BY created_at, rowid', a.ownerId)).toEqual(['fresh']);
    expect(column(db, 'SELECT id FROM messages WHERE owner_id = ?', b.ownerId)).toEqual(['other']);
    expect(store.listProfileFacts(a.ownerId).map((row) => row.text)).toEqual(['kept-fact']);
    expect(store.memoryForExtract(a.ownerId, a.agentId).notes.map((note) => note.text)).toEqual(['kept-note']);
    expect(db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'old'`).all()).toEqual([]);
  });

  it('deletes at most limit matching messages for that owner', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    for (const id of ['m1', 'm2', 'm3']) say(store, a, id, id, 1);
    expect(store.deleteExpiredMessages(a.ownerId, 1_000, 2)).toBe(2);
    expect(count(db, 'SELECT count(*) AS n FROM messages')).toBe(1);
  });

  it('persists the kana backfill cursor in meta and pages after it', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h-kana-cursor');
    expect(store.kanaBackfillCursor()).toBe(0);
    store.insertMessage({ id: 'c1', sessionId: 's', ownerId: a.ownerId, agentId: a.agentId, role: 'user', text: 'ヨガ', bigrams: '', now: 1 });
    store.insertMessage({ id: 'c2', sessionId: 's', ownerId: a.ownerId, agentId: a.agentId, role: 'user', text: 'お茶', bigrams: '', now: 2 });
    expect(store.listMessagesForKanaBackfill(10, 0).map((row) => row.text)).toEqual(['ヨガ', 'お茶']);
    const first = store.listMessagesForKanaBackfill(1, 0);
    expect(store.listMessagesForKanaBackfill(10, first[0]!.rowid).map((row) => row.text)).toEqual(['お茶']);
    store.setKanaBackfillCursor(first[0]!.rowid);
    expect(store.kanaBackfillCursor()).toBe(first[0]!.rowid);
    store.setKanaBackfillCursor(0);
    expect(store.kanaBackfillCursor()).toBe(0);
  });

  it('inserts a message only when the agent belongs to that owner', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    const b = seedOwner(store, 'hb');
    store.insertMessage({ id: 'forged', sessionId: 's1', ownerId: b.ownerId, agentId: a.agentId, role: 'user', text: '王叔', bigrams: '王叔', now: 1 });
    store.insertMessage({ id: 'missing', sessionId: 's1', ownerId: 'missing', agentId: a.agentId, role: 'user', text: '王叔', bigrams: '王叔', now: 2 });
    expect(count(db, 'SELECT count(*) AS n FROM messages')).toBe(0);
    say(store, a, 'ok', '王叔', 3);
    expect(column(db, 'SELECT id FROM messages')).toEqual(['ok']);
  });
});

describe('first meeting and continuous use', () => {
  it('reports an ended session per agent only', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    const kai = agentOf(store, a.ownerId, 'xiaokai');
    expect(store.hasEndedSession(a.agentId)).toBe(false);
    store.recordSessionStart('s1', a.agentId, 10);
    expect(store.hasEndedSession(a.agentId)).toBe(false); // still open
    store.recordSessionEnd('s1', a.agentId, 20);
    expect(store.hasEndedSession(a.agentId)).toBe(true);
    expect(store.hasEndedSession(kai.agentId)).toBe(false);
    store.clearAgentMemory(a.ownerId, a.agentId);
    expect(store.hasEndedSession(a.agentId)).toBe(false); // cleared character meets the user again
  });

  it('walks back across every agent of the owner while gaps stay under gapMs', () => {
    const store = new SqliteMemoryStore(open());
    const gap = 10 * 60_000;
    const a = seedOwner(store, 'ha');
    const kai = agentOf(store, a.ownerId, 'xiaokai');
    const other = seedOwner(store, 'hb');
    const now = 10 * 3_600_000;
    expect(store.continuousSince(a.ownerId, now, gap)).toBe(now); // no sessions
    // 09:00-09:20 with xiaonuan, 09:25-09:50 with xiaokai (5 min gap), then now = 10:00 (10 min gap).
    store.recordSessionStart('s1', a.agentId, now - 60 * 60_000);
    store.recordSessionEnd('s1', a.agentId, now - 40 * 60_000);
    store.recordSessionStart('s2', kai.agentId, now - 35 * 60_000);
    store.recordSessionEnd('s2', kai.agentId, now - 10 * 60_000 + 1);
    store.recordSessionStart('s-other', other.agentId, now - 5 * 60_000);
    expect(store.continuousSince(a.ownerId, now, gap)).toBe(now - 60 * 60_000);
    expect(store.continuousSince(a.ownerId, now, 10 * 60_000 - 2)).toBe(now); // 10-min gap breaks a smaller window
    expect(store.continuousSince(a.ownerId, now, 5 * 60_000)).toBe(now);
  });

  it('counts an open session as running until now', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    store.recordSessionStart('s-open', a.agentId, 1_000);
    expect(store.continuousSince(a.ownerId, 5_000, 100)).toBe(1_000);
  });

  it('cuts offline time out of the continuous window after a crash close', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    store.recordSessionStart('s-crash', a.agentId, 1_000);
    say(store, a, 'm1', '昨天去了公园', 1_200, { sessionId: 's-crash' });
    say(store, a, 'm2', '又说了一句', 1_500, { sessionId: 's-crash' });
    store.recordSessionStart('s-empty', a.agentId, 2_000);
    expect(store.closeOpenSessions(10_000)).toBe(2);
    expect(store.listSessions(a.ownerId)).toEqual([
      { id: 's-crash', agentId: a.agentId, startedAt: 1_000, endedAt: 1_500 },
      { id: 's-empty', agentId: a.agentId, startedAt: 2_000, endedAt: 2_000 },
    ]);
    // Restart is far from the last message, so the crashed session is not continuous with now.
    expect(store.continuousSince(a.ownerId, 10_000, 1_000)).toBe(10_000);
    store.recordSessionStart('s-back', a.agentId, 10_000);
    expect(store.continuousSince(a.ownerId, 10_500, 1_000)).toBe(10_000);
  });

  it('does not let a later-starting shorter session hide one that ends later', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    const gap = 10 * 60_000;
    const now = 10 * 3_600_000;
    // 09:00–09:55, and 09:40–09:45. The short one starts later and ends earlier.
    store.recordSessionStart('s-long', a.agentId, now - 60 * 60_000);
    store.recordSessionEnd('s-long', a.agentId, now - 5 * 60_000);
    store.recordSessionStart('s-short', a.agentId, now - 20 * 60_000);
    store.recordSessionEnd('s-short', a.agentId, now - 15 * 60_000);
    expect(store.continuousSince(a.ownerId, now, gap)).toBe(now - 60 * 60_000);
  });
});

describe('epochs', () => {
  it('keeps one owner epoch and one epoch per agent', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    const kai = agentOf(store, a.ownerId, 'xiaokai');
    const b = seedOwner(store, 'hb');
    expect(store.memoryEpochs(a.ownerId, a.agentId)).toEqual({ owner: 0, agent: 0 });
    expect(store.bumpAgentEpoch(a.ownerId, a.agentId)).toBe(1);
    expect(store.memoryEpochs(a.ownerId, a.agentId)).toEqual({ owner: 0, agent: 1 });
    expect(store.memoryEpochs(a.ownerId, kai.agentId)).toEqual({ owner: 0, agent: 0 });
    expect(store.bumpOwnerEpoch(a.ownerId)).toBe(1);
    expect(store.memoryEpochs(a.ownerId, kai.agentId)).toEqual({ owner: 1, agent: 0 });
    expect(store.getOwner(a.ownerId)?.memoryEpoch).toBe(1);
    expect(store.memoryEpochs(b.ownerId, b.agentId)).toEqual({ owner: 0, agent: 0 });
    expect(store.memoryEpochs(b.ownerId, a.agentId)).toBeUndefined();
    expect(() => store.bumpAgentEpoch(b.ownerId, a.agentId)).toThrow('agent not found');
    expect(() => store.bumpOwnerEpoch('missing')).toThrow('owner not found');
  });
});

describe('fact layers', () => {
  it('routes addressing and profile to the shared table and everything else to this agent', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [
      { op: 'add', category: 'addressing', text: '称呼：王叔' },
      { op: 'add', category: 'profile', text: '老家山东' },
      { op: 'add', category: 'preference', text: '喜欢喝茶' },
      { op: 'add', category: 'person', text: '孙子下周来' },
      { op: 'add', category: 'health', text: '膝盖不太好', sensitive: false },
      { op: 'add', category: 'other', text: '每天早上散步' },
      { op: 'add', category: 'profile', text: '住在养老院三楼', sensitive: true },
      { op: 'add', category: 'misc', text: '不在白名单' },
    ] }));
    expect(store.listProfileFacts(a.ownerId)).toEqual([
      { id: expect.any(String), category: 'addressing', text: '称呼：王叔' },
      { id: expect.any(String), category: 'profile', text: '老家山东' },
    ]);
    expect(store.listAgentFacts(a.ownerId, a.agentId).map(({ category, text, sensitive }) => ({ category, text, sensitive }))).toEqual([
      { category: 'preference', text: '喜欢喝茶', sensitive: false },
      { category: 'person', text: '孙子下周来', sensitive: false },
      { category: 'health', text: '膝盖不太好', sensitive: true },
      { category: 'other', text: '每天早上散步', sensitive: false },
      { category: 'other', text: '住在养老院三楼', sensitive: true },
    ]);
    expect(count(db, "SELECT count(*) AS n FROM agent_facts WHERE text = '不在白名单'") + count(db, "SELECT count(*) AS n FROM profile_facts WHERE text = '不在白名单'")).toBe(0);
    expect(column(db, 'SELECT DISTINCT source_message_ids FROM agent_facts')).toEqual(['[]']);
  });

  it('keeps a single addressing row: a later name replaces the earlier one', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [{ op: 'add', category: 'addressing', text: '王叔', sourceMessageIds: ['m1'] }] }));
    const first = store.listProfileFacts(a.ownerId)[0]!;
    store.writeExtraction(a.ownerId, a.agentId, change({ now: 20, facts: [{ op: 'add', category: 'addressing', text: '老王', sourceMessageIds: ['m2'] }] }));
    expect(store.listProfileFacts(a.ownerId)).toEqual([{ id: first.id, category: 'addressing', text: '老王' }]);
    expect(store.deleteMemoryItem(a.ownerId, first.id)?.sourceMessageIds).toEqual(['m1', 'm2']);
  });

  it('moves a shared fact into this character when it becomes health or sensitive, and a private one into the shared layer', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [
      { op: 'add', category: 'profile', text: '退休前是医生' },
      { op: 'add', category: 'other', text: '老家在青岛' },
    ] }));
    const shared = store.listProfileFacts(a.ownerId)[0]!;
    const privateFact = store.listAgentFacts(a.ownerId, a.agentId)[0]!;
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [
      { op: 'update', id: shared.id, category: 'health', text: '有高血压' },
      { op: 'update', id: privateFact.id, category: 'profile' },
    ] }));
    expect(store.listProfileFacts(a.ownerId).map(({ category, text }) => ({ category, text }))).toEqual([{ category: 'profile', text: '老家在青岛' }]);
    expect(store.listAgentFacts(a.ownerId, a.agentId).map(({ category, text, sensitive }) => ({ category, text, sensitive }))).toEqual([
      { category: 'health', text: '有高血压', sensitive: true },
    ]);
  });

  it('unions source ids on update and parses them back on delete', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [{ op: 'add', category: 'preference', text: '喜欢喝茶', sourceMessageIds: ['m1', 'm1'] }] }));
    const fact = store.listAgentFacts(a.ownerId, a.agentId)[0]!;
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [{ op: 'update', id: fact.id, text: '喜欢喝绿茶', sourceMessageIds: ['m2', 'm1'] }] }));
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [{ op: 'update', id: fact.id, confidence: 0.5 }] }));
    expect(store.deleteMemoryItem(a.ownerId, fact.id)).toEqual({ kind: 'agent_fact', agentId: a.agentId, text: '喜欢喝绿茶', sourceMessageIds: ['m1', 'm2'] });
  });

  it('rejects a note for another agent and writes nothing from that batch', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    const kai = agentOf(store, a.ownerId, 'xiaokai');
    expect(() => store.immediate(() => store.writeExtraction(a.ownerId, a.agentId, change({
      facts: [{ op: 'add', category: 'preference', text: '喜欢喝茶' }],
      notes: [{ op: 'add', text: '说话慢一点', agentId: kai.agentId }],
    })))).toThrow(ExtractIncompleteError);
    expect(count(db, 'SELECT count(*) AS n FROM agent_facts')).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM relationship_notes')).toBe(0);
  });

  it('refuses an agent that belongs to another owner', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    const b = seedOwner(store, 'hb');
    expect(() => store.writeExtraction(b.ownerId, a.agentId, change({ facts: [{ op: 'add', category: 'preference', text: '越权' }] }))).toThrow(ExtractIncompleteError);
    expect(count(db, 'SELECT count(*) AS n FROM agent_facts')).toBe(0);
  });
});

describe('pinned memories and the settings name', () => {
  it('lists this agent pins newest first and ignores a foreign agent', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    const b = seedOwner(store, 'hb');
    store.insertPinned({ id: 'p1', ownerId: a.ownerId, agentId: a.agentId, text: '孙子三月三号生日', sensitive: false, sourceSessionId: 's1', sourceMessageId: 'm1', now: 10 });
    store.insertPinned({ id: 'p2', ownerId: a.ownerId, agentId: a.agentId, text: '每天吃降压药', sensitive: true, sourceSessionId: 's1', sourceMessageId: null, now: 20 });
    store.insertPinned({ id: 'p3', ownerId: b.ownerId, agentId: a.agentId, text: '越权', sensitive: false, sourceSessionId: 's1', sourceMessageId: null, now: 30 });
    expect(store.listPinned(a.ownerId, a.agentId)).toEqual([
      { id: 'p2', text: '每天吃降压药', sensitive: true, createdAt: 20 },
      { id: 'p1', text: '孙子三月三号生日', sensitive: false, createdAt: 10 },
    ]);
    expect(store.listPinned(b.ownerId, a.agentId)).toEqual([]);
  });

  it('stores the settings name as the single plain addressing row and keeps profile items', () => {
    const store = new SqliteMemoryStore(open());
    const a = seedOwner(store, 'ha');
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [
      { op: 'add', category: 'addressing', text: '王叔' },
      { op: 'add', category: 'profile', text: '老家山东' },
    ] }));
    store.setAddressing(a.ownerId, '老王', 50);
    store.setAddressing(a.ownerId, '王老师', 60);
    expect(store.listProfileFacts(a.ownerId).map(({ category, text }) => ({ category, text }))).toEqual([
      { category: 'addressing', text: '王老师' },
      { category: 'profile', text: '老家山东' },
    ]);
    const fresh = seedOwner(store, 'hb');
    store.setAddressing(fresh.ownerId, '李姨', 70);
    expect(store.listProfileFacts(fresh.ownerId).map((row) => row.text)).toEqual(['李姨']);
  });
});

describe('item and message deletion', () => {
  it('deletes one item of any kind, owner-scoped, and blanks its audit diff', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    const b = seedOwner(store, 'hb');
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [
      { op: 'add', category: 'profile', text: '老家山东', sourceMessageIds: ['m-p'] },
      { op: 'add', category: 'preference', text: '喜欢喝茶', sourceMessageIds: ['m-f'] },
    ] }));
    store.insertPinned({ id: 'pin', ownerId: a.ownerId, agentId: a.agentId, text: '孙子三月三号生日', sensitive: false, sourceSessionId: 's1', sourceMessageId: 'm-pin', now: 10 });
    const profileId = store.listProfileFacts(a.ownerId)[0]!.id;
    const factId = store.listAgentFacts(a.ownerId, a.agentId)[0]!.id;
    expect(store.deleteMemoryItem(b.ownerId, profileId)).toBeUndefined();
    expect(store.deleteMemoryItem(b.ownerId, 'pin')).toBeUndefined();
    expect(store.listProfileFacts(a.ownerId)).toHaveLength(1);
    expect(store.deleteMemoryItem(a.ownerId, profileId)).toEqual({ kind: 'profile', agentId: null, text: '老家山东', sourceMessageIds: ['m-p'] });
    expect(store.deleteMemoryItem(a.ownerId, factId)).toEqual({ kind: 'agent_fact', agentId: a.agentId, text: '喜欢喝茶', sourceMessageIds: ['m-f'] });
    expect(store.deleteMemoryItem(a.ownerId, 'pin')).toEqual({ kind: 'pinned', agentId: a.agentId, text: '孙子三月三号生日', sourceMessageIds: ['m-pin'] });
    expect(store.deleteMemoryItem(a.ownerId, 'pin')).toBeUndefined();
    expect(count(db, "SELECT count(*) AS n FROM memory_changes WHERE instr(diff, '老家') > 0 OR instr(diff, '喝茶') > 0")).toBe(0);
  });

  it('deletes messages by id for one agent or any agent, ignores dangling ids, and drops them from FTS', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    const kai = agentOf(store, a.ownerId, 'xiaokai');
    const b = seedOwner(store, 'hb');
    say(store, a, 'a1', '我老家在山东', 1);
    say(store, kai, 'k1', '我老家在山东呀', 2);
    say(store, b, 'b1', '我老家在山东', 3);
    expect(store.deleteMessagesByIds(a.ownerId, kai.agentId, ['a1', 'gone'])).toBe(0); // a1 is not xiaokai's
    expect(store.deleteMessagesByIds(a.ownerId, a.agentId, ['a1', 'gone', 'a1'])).toBe(1);
    expect(store.deleteMessagesByIds(a.ownerId, null, ['k1', 'b1'])).toBe(1); // b1 belongs to another owner
    expect(column(db, 'SELECT id FROM messages ORDER BY id')).toEqual(['b1']);
    expect(column(db, `SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH '"山东"'`)).toEqual(['b1']);
  });
});

describe('clearing memory', () => {
  function fill(store: SqliteMemoryStore, who: Who, tag: string, sessionId: string): void {
    store.recordSessionStart(sessionId, who.agentId, 10);
    store.recordSessionEnd(sessionId, who.agentId, 20);
    say(store, who, `m-${tag}`, `我喜欢${tag}`, 11, { sessionId });
    store.writeExtraction(who.ownerId, who.agentId, change({
      messageIds: [`m-${tag}`],
      facts: [{ op: 'add', category: 'preference', text: `喜欢${tag}` }],
      notes: [{ op: 'add', text: `备注${tag}` }],
      episodes: [{ op: 'add', summary: `聊${tag}` }],
      followups: [{ op: 'add', text: `问问${tag}`, dueAt: 99, quote: `我喜欢${tag}` }],
    }));
    store.insertPinned({ id: `pin-${tag}`, ownerId: who.ownerId, agentId: who.agentId, text: `记住${tag}`, sensitive: false, sourceSessionId: sessionId, sourceMessageId: `m-${tag}`, now: 12 });
  }

  const perAgent = (db: DatabaseSync, agentId: string) => Object.fromEntries(
    ['messages', 'agent_facts', 'pinned_memories', 'relationship_notes', 'episodes', 'followups', 'sessions'].map((table) => [
      table, count(db, `SELECT count(*) AS n FROM ${table} WHERE agent_id = ?`, agentId),
    ]),
  );

  it('clears one character and keeps its agent row, other characters, and the shared layer', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    const kai = agentOf(store, a.ownerId, 'xiaokai');
    fill(store, a, '喝茶', 's-a');
    fill(store, kai, '下棋', 's-k');
    store.setAddressing(a.ownerId, '王叔', 30);
    const kaiBefore = perAgent(db, kai.agentId);
    store.clearAgentMemory(a.ownerId, a.agentId);
    expect(perAgent(db, a.agentId)).toEqual({ messages: 0, agent_facts: 0, pinned_memories: 0, relationship_notes: 0, episodes: 0, followups: 0, sessions: 0 });
    expect(count(db, "SELECT count(*) AS n FROM memory_changes WHERE agent_id = ? AND diff != ''", a.agentId)).toBe(0);
    expect(perAgent(db, kai.agentId)).toEqual(kaiBefore);
    expect(store.ensureAgent(a.ownerId, 'xiaonuan', 99).id).toBe(a.agentId);
    expect(store.listProfileFacts(a.ownerId).map((row) => row.text)).toEqual(['王叔']);
  });

  it('clears the shared layer only', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    fill(store, a, '喝茶', 's-a');
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [{ op: 'add', category: 'profile', text: '老家山东' }] }));
    store.setAddressing(a.ownerId, '王叔', 30);
    store.clearProfile(a.ownerId);
    expect(store.listProfileFacts(a.ownerId)).toEqual([]);
    expect(count(db, "SELECT count(*) AS n FROM memory_changes WHERE table_name = 'profile_facts' AND diff != ''")).toBe(0);
    expect(store.listAgentFacts(a.ownerId, a.agentId)).toHaveLength(1);
  });

  it('clears everything but keeps owner, devices, agents, consent and the notice', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    const kai = agentOf(store, a.ownerId, 'xiaokai');
    store.markNotified(a.ownerId, 5);
    store.setConsent(a.ownerId, 'granted', 6);
    fill(store, a, '喝茶', 's-a');
    fill(store, kai, '下棋', 's-k');
    store.setAddressing(a.ownerId, '王叔', 30);
    store.clearAllMemory(a.ownerId);
    for (const agentId of [a.agentId, kai.agentId]) {
      expect(perAgent(db, agentId)).toEqual({ messages: 0, agent_facts: 0, pinned_memories: 0, relationship_notes: 0, episodes: 0, followups: 0, sessions: 0 });
    }
    expect(store.listProfileFacts(a.ownerId)).toEqual([]);
    expect(count(db, "SELECT count(*) AS n FROM memory_changes WHERE owner_id = ? AND diff != ''", a.ownerId)).toBe(0);
    expect(store.getOwner(a.ownerId)).toMatchObject({ memoryConsent: 'granted', notifiedAt: 5 });
    expect(count(db, 'SELECT count(*) AS n FROM agents WHERE owner_id = ?', a.ownerId)).toBe(2);
    expect(store.findDevice('ha')?.ownerId).toBe(a.ownerId);
  });

  it('wipes everything and records the decline (voice path)', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    const b = seedOwner(store, 'hb');
    fill(store, a, '喝茶', 's-a');
    fill(store, b, '下棋', 's-b');
    store.wipeOwnerMemory(a.ownerId);
    expect(perAgent(db, a.agentId)).toEqual({ messages: 0, agent_facts: 0, pinned_memories: 0, relationship_notes: 0, episodes: 0, followups: 0, sessions: 0 });
    expect(store.getOwner(a.ownerId)?.memoryConsent).toBe('declined');
    expect(perAgent(db, b.agentId).agent_facts).toBe(1);
  });
});

describe('forgetMatches scope', () => {
  it('forgets this character, its pins and the shared layer, never another character', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'ha');
    const kai = agentOf(store, a.ownerId, 'xiaokai');
    say(store, a, 'a1', '王叔喜欢喝茶', 1, { sessionId: 's-a' });
    say(store, kai, 'k1', '王叔喜欢喝茶', 2, { sessionId: 's-k' });
    for (const who of [a, kai]) {
      store.writeExtraction(who.ownerId, who.agentId, change({
        facts: [{ op: 'add', category: 'preference', text: '王叔喜欢喝茶' }],
        notes: [{ op: 'add', text: '王叔说话慢' }],
        followups: [{ op: 'add', text: '问问王叔', dueAt: 99 }],
      }));
      store.insertPinned({ id: `pin-${who.agentId}`, ownerId: who.ownerId, agentId: who.agentId, text: '王叔的孙子三月生日', sensitive: false, sourceSessionId: 's', sourceMessageId: null, now: 3 });
    }
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [{ op: 'add', category: 'profile', text: '王叔老家山东' }] }));
    const kaiBefore = { facts: store.listAgentFacts(a.ownerId, kai.agentId), pins: store.listPinned(a.ownerId, kai.agentId), memory: store.memoryForExtract(a.ownerId, kai.agentId) };

    const result = store.forgetMatches(a.ownerId, a.agentId, '王叔', '"王叔"', 's-a');

    expect(result).toEqual({ messages: 1, facts: 1, notes: 1, episodes: 0, followups: 1, pinned: 1, profile: 1 });
    expect(store.listProfileFacts(a.ownerId)).toEqual([]);
    expect(store.listAgentFacts(a.ownerId, a.agentId)).toEqual([]);
    expect(store.listPinned(a.ownerId, a.agentId)).toEqual([]);
    expect(store.listAgentFacts(a.ownerId, kai.agentId)).toEqual(kaiBefore.facts);
    expect(store.listPinned(a.ownerId, kai.agentId)).toEqual(kaiBefore.pins);
    expect(store.memoryForExtract(a.ownerId, kai.agentId).notes).toEqual(kaiBefore.memory.notes);
    expect(store.searchMessages(a.ownerId, kai.agentId, '"王叔"', 10)).toEqual([{ text: '王叔喜欢喝茶' }]);
    expect(store.searchMessages(a.ownerId, a.agentId, '"王叔"', 10)).toEqual([]);
  });
});

describe('care followups', () => {
  const WEEK = 7 * DAY;
  const NOW = 100 * DAY;

  /** One session (ended unless told otherwise) whose user line produced one followup through the extract write path. */
  function addFollowup(
    store: SqliteMemoryStore,
    who: Who,
    sessionId: string,
    input: { text: string; createdAt: number; quote?: string; sensitive?: boolean; ended?: boolean },
  ): void {
    store.recordSessionStart(sessionId, who.agentId, input.createdAt - 10);
    if (input.ended !== false) store.recordSessionEnd(sessionId, who.agentId, input.createdAt - 5);
    store.insertMessage({ id: `m-${sessionId}`, sessionId, ownerId: who.ownerId, agentId: who.agentId, role: 'user', text: input.quote ?? input.text, bigrams: '', now: input.createdAt - 8 });
    store.immediate(() => store.writeExtraction(who.ownerId, who.agentId, change({
      now: input.createdAt,
      messageIds: [`m-${sessionId}`],
      followups: [{
        op: 'add',
        text: input.text,
        dueAt: input.createdAt + DAY,
        ...(input.quote !== undefined ? { quote: input.quote } : {}),
        ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
      }],
    })));
  }

  const idOf = (db: DatabaseSync, text: string): string => (db.prepare('SELECT id FROM followups WHERE text = ?').get(text) as { id: string }).id;

  it('stores the quote as sensitive, stamps created_at, and keeps the quote out of the audit diff', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'care-write');
    addFollowup(store, a, 's-1', { text: '问问腰部复查', quote: '我明天去医院复查腰', createdAt: NOW });
    addFollowup(store, a, 's-2', { text: '问问旅行计划', createdAt: NOW + 1 });
    expect(db.prepare('SELECT text, quote, sensitive, created_at, agent_id FROM followups ORDER BY created_at').all()).toEqual([
      { text: '问问腰部复查', quote: '我明天去医院复查腰', sensitive: 1, created_at: NOW, agent_id: a.agentId },
      { text: '问问旅行计划', quote: null, sensitive: 0, created_at: NOW + 1, agent_id: a.agentId },
    ]);
    expect(db.prepare("SELECT diff FROM memory_changes WHERE table_name = 'followups' AND op = 'add' ORDER BY created_at").all())
      .toEqual([{ diff: '问问腰部复查' }, { diff: '问问旅行计划' }]);
  });

  it('picks the newest open quoted followup from an ended earlier session within maxAge', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'care-pick');
    const b = seedOwner(store, 'care-pick-other');
    addFollowup(store, a, 's-older', { text: 'older', quote: '我下周去看牙', createdAt: NOW - 3 * DAY });
    addFollowup(store, a, 's-newer', { text: 'newer', quote: '我明天去医院复查腰', createdAt: NOW - DAY });
    addFollowup(store, a, 's-expired', { text: 'expired', quote: '我要去爬山', createdAt: NOW - WEEK - 1 });
    addFollowup(store, a, 's-noquote', { text: 'noquote', createdAt: NOW - 100 });
    addFollowup(store, a, 's-open', { text: 'open', quote: '我晚上去散步', createdAt: NOW - 90, ended: false });
    addFollowup(store, a, 's-current', { text: 'current', quote: '我等会儿去买菜', createdAt: NOW - 80 });
    addFollowup(store, a, 's-closed', { text: 'closed', quote: '我中午去取药', createdAt: NOW - 70 });
    store.closeCareFollowup(a.ownerId, idOf(db, 'closed'), NOW - 60);
    addFollowup(store, b, 's-b', { text: 'other-owner', quote: '我明天去复查', createdAt: NOW - 50 });
    expect(store.careFollowup(a.ownerId, a.agentId, 's-current', NOW, WEEK)).toEqual({ id: idOf(db, 'newer'), quote: '我明天去医院复查腰', createdAt: NOW - DAY });
    expect(store.careFollowup(a.ownerId, a.agentId, 's-current', NOW, DAY - 1)).toBeUndefined();
  });

  it('closes once: done_at set, quote cleared, audit without the quote, owner-scoped', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'care-close');
    const b = seedOwner(store, 'care-close-other');
    addFollowup(store, a, 's-1', { text: '问问腰部复查', quote: '我明天去医院复查腰', createdAt: NOW - DAY });
    const id = idOf(db, '问问腰部复查');
    store.closeCareFollowup(b.ownerId, id, NOW);
    expect(store.careFollowup(a.ownerId, a.agentId, 's-now', NOW, WEEK)?.id).toBe(id);
    store.closeCareFollowup(a.ownerId, id, NOW);
    store.closeCareFollowup(a.ownerId, id, NOW + 1);
    expect(db.prepare('SELECT done_at, quote FROM followups WHERE id = ?').get(id)).toEqual({ done_at: NOW, quote: null });
    expect(db.prepare('SELECT op, diff, actor, agent_id FROM memory_changes WHERE row_id = ? ORDER BY created_at, rowid').all(id)).toEqual([
      { op: 'add', diff: '问问腰部复查', actor: 'extract', agent_id: a.agentId },
      { op: 'close', diff: '', actor: 'care', agent_id: a.agentId },
    ]);
    expect(store.careFollowup(a.ownerId, a.agentId, 's-now', NOW, WEEK)).toBeUndefined();
  });

  it('forgets a followup whose keyword appears only in its quote', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'care-forget');
    addFollowup(store, a, 's-1', { text: '问问复查结果', quote: '我下周二去医院复查膝盖', createdAt: NOW - DAY });
    expect(store.forgetMatches(a.ownerId, a.agentId, '膝盖', null, 's-now').followups).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM followups')).toBe(0);
  });

  it('clears quotes that aged out of the care window, keeps the followup, and stays owner-scoped', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'care-expire');
    const b = seedOwner(store, 'care-expire-other');
    addFollowup(store, a, 's-old', { text: 'old', quote: '我要去爬山', createdAt: NOW - WEEK - 1 });
    addFollowup(store, a, 's-fresh', { text: 'fresh', quote: '我明天去医院复查腰', createdAt: NOW - DAY });
    addFollowup(store, b, 's-b-old', { text: 'b-old', quote: '我下周去看牙', createdAt: NOW - WEEK - 1 });
    expect(store.clearStaleCareQuotes(a.ownerId, NOW - WEEK)).toBe(1);
    expect(db.prepare('SELECT text, quote FROM followups ORDER BY text').all()).toEqual([
      { text: 'b-old', quote: '我下周去看牙' },
      { text: 'fresh', quote: '我明天去医院复查腰' },
      { text: 'old', quote: null },
    ]);
    expect(store.clearStaleCareQuotes(a.ownerId, NOW - WEEK)).toBe(0);
  });
});
