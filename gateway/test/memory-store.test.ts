import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { MIGRATIONS, migrate } from '../src/memory/migrations.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

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

const owner = (store: SqliteMemoryStore, tokenHash: string, now = 1_000) =>
  store.createOwner({ tokenHash, roleId: 'elder-companion', styleId: 'grandchild', now });

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates an owner-only WAL database with busy timeout, foreign keys and the current schema', () => {
    const dir = tempDir();
    const path = join(dir, 'nested', 'memory.db');
    const db = open(path);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 1234 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    owner(new SqliteMemoryStore(db), 'h1'); // forces a WAL write
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('tightens a pre-existing file and keeps data across reopen', () => {
    const path = join(tempDir(), 'memory.db');
    writeFileSync(path, '', { mode: 0o644 });
    const first = open(path);
    const created = owner(new SqliteMemoryStore(first), 'h1');
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
});

describe('migrate', () => {
  it('applies appended steps in order and is idempotent', () => {
    const db = open();
    const steps = [...MIGRATIONS, 'CREATE TABLE plan_c_probe (id TEXT PRIMARY KEY) STRICT'];
    expect(migrate(db, steps)).toBe(steps.length);
    expect(migrate(db, steps)).toBe(steps.length);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'plan_c_probe'").get()).toEqual({ n: 1 });
  });

  it('rolls back a failing step and leaves the version unchanged', () => {
    const db = open();
    expect(() => migrate(db, [...MIGRATIONS, 'CREATE TABLE half_done (id TEXT) STRICT; NOT VALID SQL'])).toThrow();
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half_done'").get()).toEqual({ n: 0 });
  });
});

describe('SqliteMemoryStore', () => {
  it('creates owner, device and agent together with memory defaults', () => {
    const store = new SqliteMemoryStore(open());
    const created = owner(store, 'h1', 5_000);
    expect(store.getOwner(created.ownerId)).toEqual({
      id: created.ownerId, createdAt: 5_000, lastSeenAt: 5_000, memoryConsent: 'unknown', notifiedAt: null, onboardingStage: 0, memoryEpoch: 0,
    });
    expect(store.findDevice('h1')).toEqual({ deviceId: created.deviceId, ownerId: created.ownerId });
    expect(store.ensureAgent(created.ownerId, 'elder-companion', 'old-friend', 6_000))
      .toEqual({ id: created.agentId, ownerId: created.ownerId, roleId: 'elder-companion', styleId: 'grandchild' });
    expect(store.countOwners()).toBe(1);
  });

  it('uses UUIDs and leaves nothing behind when a token hash is reused', () => {
    const store = new SqliteMemoryStore(open());
    const created = owner(store, 'h1');
    for (const id of Object.values(created)) expect(id).toMatch(UUID_V4);
    expect(() => owner(store, 'h1')).toThrow(/UNIQUE/);
    expect(store.countOwners()).toBe(1);
  });

  it('creates a missing agent for another role exactly once', () => {
    const store = new SqliteMemoryStore(open());
    const created = owner(store, 'h1');
    const first = store.ensureAgent(created.ownerId, 'other-role', 'default', 2_000);
    const second = store.ensureAgent(created.ownerId, 'other-role', 'changed', 3_000);
    expect(second).toEqual(first);
    expect(first).toEqual({ id: first.id, ownerId: created.ownerId, roleId: 'other-role', styleId: 'default' });
    expect(first.id).not.toBe(created.agentId);
  });

  it('scopes agent and session writes to their owner', () => {
    const store = new SqliteMemoryStore(open());
    const a = owner(store, 'ha');
    const b = owner(store, 'hb');
    expect(store.setAgentStyle(b.ownerId, a.agentId, 'old-friend')).toBe(false);
    expect(store.setAgentStyle(a.ownerId, a.agentId, 'old-friend')).toBe(true);
    expect(store.ensureAgent(a.ownerId, 'elder-companion', 'grandchild', 1).styleId).toBe('old-friend');
    expect(store.ensureAgent(b.ownerId, 'elder-companion', 'grandchild', 1).styleId).toBe('grandchild');
    store.recordSessionStart('s-a', a.agentId, 10);
    store.recordSessionEnd('s-a', b.agentId, 20); // wrong agent: ignored
    expect(store.listSessions(a.ownerId)).toEqual([{ id: 's-a', agentId: a.agentId, startedAt: 10, endedAt: null }]);
    expect(store.listSessions(b.ownerId)).toEqual([]);
    store.recordSessionEnd('s-a', a.agentId, 30);
    expect(store.listSessions(a.ownerId)[0]?.endedAt).toBe(30);
  });

  it('closes sessions left open by a previous process', () => {
    const store = new SqliteMemoryStore(open());
    const a = owner(store, 'ha');
    store.recordSessionStart('s-crash', a.agentId, 10);
    store.insertMessage({ id: 'm-crash', sessionId: 's-crash', ownerId: a.ownerId, role: 'user', text: '昨天去了公园', bigrams: '', now: 11 });
    expect(store.recentUserMessages(a.ownerId, 10)).toEqual([]);
    expect(store.closeOpenSessions(20)).toBe(1);
    expect(store.recentUserMessages(a.ownerId, 10)).toEqual([{ text: '昨天去了公园' }]);
    expect(store.closeOpenSessions(30)).toBe(0);
  });

  it('reads the latest episode by ended session, scoped to both owner and agent', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = owner(store, 'ha');
    const b = owner(store, 'hb');
    const otherAgent = store.ensureAgent(a.ownerId, 'other-role', 'default', 2);
    const episode = (id: string, sessionId: string, who: typeof a, agentId: string, start: number, created: number, ended = true) => {
      store.recordSessionStart(sessionId, agentId, start);
      if (ended) store.recordSessionEnd(sessionId, agentId, start + 1);
      db.prepare('INSERT INTO episodes (id, session_id, owner_id, summary, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, sessionId, who.ownerId, id, created);
    };
    expect(store.latestEpisode(a.ownerId, a.agentId)).toBeUndefined();
    episode('recent', 's-recent', a, a.agentId, 20, 30);
    episode('late-old-extraction', 's-old', a, a.agentId, 10, 100);
    episode('active', 's-active', a, a.agentId, 40, 101, false);
    episode('other-owner', 's-b', b, b.agentId, 50, 102);
    episode('other-agent', 's-other', a, otherAgent.id, 60, 103);
    store.recordSessionStart('s-empty', a.agentId, 70);
    store.recordSessionEnd('s-empty', a.agentId, 71);
    expect(store.latestEpisode(a.ownerId, a.agentId)).toEqual({ summary: 'recent' });
    expect(store.latestEpisode(b.ownerId, a.agentId)).toBeUndefined();
    expect(store.latestEpisode(a.ownerId, b.agentId)).toBeUndefined();
    db.prepare('INSERT INTO episodes (id, session_id, owner_id, summary, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('recent-update', 's-recent', a.ownerId, 'latest-in-session', 31);
    expect(store.latestEpisode(a.ownerId, a.agentId)).toEqual({ summary: 'latest-in-session' });
    db.prepare('DELETE FROM episodes WHERE owner_id = ?').run(a.ownerId);
    expect(store.latestEpisode(a.ownerId, a.agentId)).toBeUndefined();
  });

  it('touches device and owner last-seen times', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = owner(store, 'h1', 1_000);
    store.touchDevice(created.ownerId, created.deviceId, 9_000);
    expect(store.getOwner(created.ownerId)?.lastSeenAt).toBe(9_000);
    expect(db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(created.deviceId)).toEqual({ last_seen_at: 9_000 });
  });

  it('deletes an owner with its devices, agents and sessions', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = owner(store, 'ha');
    const b = owner(store, 'hb');
    store.recordSessionStart('s-a', a.agentId, 10);
    expect(store.deleteOwner(a.ownerId)).toBe(true);
    expect(store.deleteOwner(a.ownerId)).toBe(false);
    expect(store.findDevice('ha')).toBeUndefined();
    expect(db.prepare('SELECT (SELECT count(*) FROM devices) AS d, (SELECT count(*) FROM agents) AS a, (SELECT count(*) FROM sessions) AS s').get())
      .toEqual({ d: 1, a: 1, s: 0 });
    expect(store.findDevice('hb')?.ownerId).toBe(b.ownerId);
  });

  it('counts owners for the registration caps', () => {
    const store = new SqliteMemoryStore(open());
    owner(store, 'h1', 1_000);
    owner(store, 'h2', 2_000);
    owner(store, 'h3', 3_000);
    expect(store.countOwners()).toBe(3);
    expect(store.countOwnersCreatedSince(2_000)).toBe(2);
  });

  it('deletes only never-connected owners older than the cutoff, at most `limit` per call', () => {
    const store = new SqliteMemoryStore(open());
    const old = [owner(store, 'h1', 100), owner(store, 'h2', 100), owner(store, 'h3', 100)];
    const connected = owner(store, 'h4', 100);
    store.recordSessionStart('s4', connected.agentId, 150);
    const fresh = owner(store, 'h5', 900);
    expect(store.deleteOrphanOwners(500, 2)).toBe(2);
    expect(store.deleteOrphanOwners(500, 2)).toBe(1);
    expect(store.deleteOrphanOwners(500, 2)).toBe(0);
    expect(old.map((o) => store.getOwner(o.ownerId))).toEqual([undefined, undefined, undefined]);
    expect(store.getOwner(connected.ownerId)).toBeDefined();
    expect(store.getOwner(fresh.ownerId)).toBeDefined();
  });

  it('deletes messages older than 90 days or marked excluded, and keeps facts and notes', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = owner(store, 'ha', 1);
    const b = owner(store, 'hb', 1);
    const dayMs = 24 * 60 * 60_000;
    const now = 100 * dayMs;
    const olderThan = now - 90 * dayMs;
    store.insertMessage({ id: 'old', sessionId: 's', ownerId: a.ownerId, role: 'user', text: 'old', bigrams: 'old', now: olderThan - 1 });
    store.insertMessage({ id: 'fresh', sessionId: 's', ownerId: a.ownerId, role: 'assistant', text: 'fresh', bigrams: 'new', now: olderThan });
    store.insertMessage({ id: 'blank', sessionId: 's', ownerId: a.ownerId, role: 'user', text: 'blank', bigrams: 'blank', now: now });
    db.prepare(`UPDATE messages SET text = '', bigrams = '', excluded = 1 WHERE id = 'blank'`).run();
    store.insertMessage({ id: 'other', sessionId: 's', ownerId: b.ownerId, role: 'user', text: 'other', bigrams: 'other', now: 1 });
    db.prepare(
      `INSERT INTO user_facts (id, owner_id, category, text, confidence, updated_at)
       VALUES ('f-old', ?, 'addressing', 'kept-fact', 1, 1)`,
    ).run(a.ownerId);
    db.prepare(
      `INSERT INTO relationship_notes (id, agent_id, owner_id, kind, text, updated_at)
       VALUES ('n-old', ?, ?, 'preference', 'kept-note', 1)`,
    ).run(a.agentId, a.ownerId);

    expect(store.deleteExpiredMessages(a.ownerId, olderThan, 10)).toBe(2);
    expect(db.prepare('SELECT id FROM messages WHERE owner_id = ? ORDER BY created_at, rowid').all(a.ownerId)).toEqual([{ id: 'fresh' }]);
    expect(db.prepare('SELECT id FROM messages WHERE owner_id = ?').all(b.ownerId)).toEqual([{ id: 'other' }]);
    expect(store.listFacts(a.ownerId)).toEqual([{ category: 'addressing', text: 'kept-fact' }]);
    expect(store.listNotes(a.ownerId, a.agentId)).toEqual([{ text: 'kept-note' }]);
    expect(db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'old'`).all()).toEqual([]);
  });

  it('deletes at most limit matching messages for that owner', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = owner(store, 'ha');
    for (const id of ['m1', 'm2', 'm3']) {
      store.insertMessage({ id, sessionId: 's', ownerId: a.ownerId, role: 'user', text: id, bigrams: '', now: 1 });
    }
    expect(store.deleteExpiredMessages(a.ownerId, 1_000, 2)).toBe(2);
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 });
  });
});

describe('memory tables', () => {
  it('reaches schema version 4, finds a message by bigram, and cascades with the owner', () => {
    const db = open();
    expect(MIGRATIONS).toHaveLength(4);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('messages_owner_created', 'messages_owner_pending') ORDER BY name").all())
      .toEqual([{ name: 'messages_owner_created' }, { name: 'messages_owner_pending' }]);
    const created = owner(new SqliteMemoryStore(db), 'h-mem');

    db.prepare(
      `INSERT INTO messages (id, session_id, owner_id, role, text, bigrams, created_at)
       VALUES ('m1', 's1', ?, 'user', 'sample', '膝盖', 10)`,
    ).run(created.ownerId);
    expect(db.prepare(`SELECT id FROM messages WHERE rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH '膝盖')`).get())
      .toEqual({ id: 'm1' });
    db.prepare(`DELETE FROM messages WHERE id = 'm1'`).run();
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH '膝盖'`).all()).toEqual([]);

    db.prepare(
      `INSERT INTO messages (id, session_id, owner_id, role, text, bigrams, created_at)
       VALUES ('m2', 's1', ?, 'assistant', 'sample', '王叔', 11)`,
    ).run(created.ownerId);
    expect(db.prepare(`SELECT id FROM messages WHERE rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH '王叔')`).get())
      .toEqual({ id: 'm2' });
    db.prepare(`UPDATE messages SET text = '', bigrams = '', excluded = 1 WHERE id = 'm2'`).run();
    expect(db.prepare(`SELECT text, bigrams, excluded FROM messages WHERE id = 'm2'`).get())
      .toEqual({ text: '', bigrams: '', excluded: 1 });
    expect(db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH '王叔'`).all()).toEqual([]);

    db.prepare(
      `INSERT INTO messages (id, session_id, owner_id, role, text, bigrams, created_at)
       VALUES ('m3', 's1', ?, 'user', 'sample', 'hello', 12)`,
    ).run(created.ownerId);
    db.prepare(
      `INSERT INTO user_facts (id, owner_id, category, text, confidence, updated_at)
       VALUES ('f1', ?, 'addressing', 'sample', 0.9, 12)`,
    ).run(created.ownerId);
    db.prepare(
      `INSERT INTO relationship_notes (id, agent_id, owner_id, kind, text, updated_at)
       VALUES ('n1', ?, ?, 'preference', 'sample', 12)`,
    ).run(created.agentId, created.ownerId);
    db.prepare(
      `INSERT INTO episodes (id, session_id, owner_id, summary, created_at)
       VALUES ('e1', 's1', ?, 'sample', 12)`,
    ).run(created.ownerId);
    db.prepare(
      `INSERT INTO followups (id, owner_id, text, due_at) VALUES ('u1', ?, 'sample', 99)`,
    ).run(created.ownerId);
    db.prepare(
      `INSERT INTO memory_changes (id, owner_id, table_name, row_id, op, diff, actor, created_at)
       VALUES ('c1', ?, 'messages', 'm3', 'insert', '{}', 'system', 12)`,
    ).run(created.ownerId);

    db.prepare('DELETE FROM owners WHERE id = ?').run(created.ownerId);
    expect(db.prepare(
      `SELECT
         (SELECT count(*) FROM messages) AS messages,
         (SELECT count(*) FROM user_facts) AS facts,
         (SELECT count(*) FROM relationship_notes) AS notes,
         (SELECT count(*) FROM episodes) AS episodes,
         (SELECT count(*) FROM followups) AS followups,
         (SELECT count(*) FROM memory_changes) AS changes`,
    ).get()).toEqual({ messages: 0, facts: 0, notes: 0, episodes: 0, followups: 0, changes: 0 });
    expect(db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'hello'`).all()).toEqual([]);
  });

  it('upgrades a version-1 database to the current version without reapplying step 0', () => {
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    db.exec('PRAGMA foreign_keys = ON');
    expect(migrate(db, MIGRATIONS.slice(0, 1))).toBe(1);
    db.prepare('INSERT INTO owners (id, created_at, last_seen_at) VALUES (?, ?, ?)').run('owner-v1', 1, 1);
    expect(migrate(db)).toBe(4);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
    expect(db.prepare('SELECT id FROM owners WHERE id = ?').get('owner-v1')).toEqual({ id: 'owner-v1' });
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get()).toEqual({ n: 1 });
  });

  it('persists the kana backfill cursor in meta and pages after it', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = owner(store, 'h-kana-cursor');
    expect(store.kanaBackfillCursor()).toBe(0);
    store.insertMessage({ id: 'c1', sessionId: 's', ownerId: created.ownerId, role: 'user', text: 'ヨガ', bigrams: '', now: 1 });
    store.insertMessage({ id: 'c2', sessionId: 's', ownerId: created.ownerId, role: 'user', text: 'お茶', bigrams: '', now: 2 });

    expect(store.listMessagesForKanaBackfill(10, 0).map((row) => row.text)).toEqual(['ヨガ', 'お茶']);
    const first = store.listMessagesForKanaBackfill(1, 0);
    expect(first.map((row) => row.text)).toEqual(['ヨガ']);
    expect(store.listMessagesForKanaBackfill(10, first[0]!.rowid).map((row) => row.text)).toEqual(['お茶']);

    store.setKanaBackfillCursor(first[0]!.rowid);
    expect(store.kanaBackfillCursor()).toBe(first[0]!.rowid);
    store.setKanaBackfillCursor(0);
    expect(store.kanaBackfillCursor()).toBe(0);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'kana_backfill_cursor'").get()).toEqual({ value: '0' });
  });
});
