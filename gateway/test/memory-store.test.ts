import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
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
});
