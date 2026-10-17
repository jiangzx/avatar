import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceRegistry, type IdentityLimits } from '../src/identity/registry.ts';
import { hashToken, newDeviceToken, shortHash } from '../src/identity/tokens.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { DEFAULT_ROLE, fixedRoleCatalog, type RoleCatalog } from '../src/roles/catalog.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';

const director = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
} satisfies DirectorConfig;

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 9, 17);
let now = BASE;
const dbs: DatabaseSync[] = [];

function setup(limits: Partial<IdentityLimits> = {}, roles: RoleCatalog = fixedRoleCatalog('P', director), db?: DatabaseSync) {
  const database = db ?? openDatabase(':memory:', { busyTimeoutMs: 1000 });
  if (!db) dbs.push(database);
  const store = new SqliteMemoryStore(database);
  const registry = new DeviceRegistry({
    store, roles, now: () => now,
    limits: { maxOwners: 10, dailyCap: 10, orphanOwnerDays: 7, orphanCleanupBatch: 2, ...limits },
  });
  return { db: database, store, registry };
}

function register(registry: DeviceRegistry, style?: string): string {
  const r = registry.register(style);
  if (!r.ok) throw new Error(r.error);
  return r.deviceToken;
}

function ctxOf(registry: DeviceRegistry, token: string): SessionContext {
  const r = registry.resolve(token);
  if (!r.ok) throw new Error('unresolved');
  return r.ctx;
}

afterEach(() => {
  now = BASE;
  for (const db of dbs.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe('identity tokens', () => {
  it('makes 32-byte base64url tokens, SHA-256 hashes and short log hashes', () => {
    const a = newDeviceToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newDeviceToken()).not.toBe(a);
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(shortHash('agent-1')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('DeviceRegistry', () => {
  it('stores only the token hash', () => {
    const { db, registry } = setup();
    const token = register(registry);
    expect(db.prepare('SELECT token_hash FROM devices').all()).toEqual([{ token_hash: hashToken(token) }]);
    expect(JSON.stringify(db.prepare('SELECT * FROM devices').all())).not.toContain(token);
  });

  it('resolves dev, unknown and registered bearers', () => {
    const { store, registry } = setup();
    expect(registry.resolve(undefined)).toEqual({ ok: true, ctx: { roleId: DEFAULT_ROLE, styleId: 'grandchild', voice: undefined } });
    expect(registry.resolve(newDeviceToken())).toEqual({ ok: false });
    const token = register(registry, 'old-friend');
    const device = store.findDevice(hashToken(token))!;
    const ctx = ctxOf(registry, token);
    expect(ctx).toEqual({ ownerId: device.ownerId, agentId: ctx.agentId, roleId: DEFAULT_ROLE, styleId: 'old-friend', voice: undefined });
    expect(ctx.agentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('updates last-seen on resolve', () => {
    const { store, registry } = setup();
    const token = register(registry);
    now = BASE + 5_000;
    const ctx = ctxOf(registry, token);
    expect(store.getOwner(ctx.ownerId!)?.lastSeenAt).toBe(BASE + 5_000);
  });

  it('keeps two owners isolated', () => {
    const { store, registry } = setup();
    const a = register(registry);
    const b = register(registry);
    const ca = ctxOf(registry, a);
    const cb = ctxOf(registry, b);
    expect(ca.ownerId).not.toBe(cb.ownerId);
    expect(ca.agentId).not.toBe(cb.agentId);
    expect(registry.setStyle(a, 'old-friend')).toBe('ok');
    expect(ctxOf(registry, a).styleId).toBe('old-friend');
    expect(ctxOf(registry, b).styleId).toBe('grandchild');
    registry.lifecycle.started('s-a', ca);
    expect(store.listSessions(ca.ownerId!)).toHaveLength(1);
    expect(store.listSessions(cb.ownerId!)).toHaveLength(0);
    expect(registry.deleteOwner(ca.ownerId!)).toBe(true);
    expect(registry.resolve(a)).toEqual({ ok: false });
    expect(registry.resolve(b).ok).toBe(true);
  });

  it('rejects unknown styles and unknown bearers when changing style', () => {
    const { registry } = setup();
    expect(registry.register('pirate')).toEqual({ ok: false, error: 'unknown_style' });
    const token = register(registry);
    expect(registry.setStyle(token, 'pirate')).toBe('unknown_style');
    expect(registry.setStyle(newDeviceToken(), 'old-friend')).toBe('unauthorized');
  });

  it('enforces MAX_OWNERS', () => {
    const { registry } = setup({ maxOwners: 2 });
    register(registry);
    register(registry);
    expect(registry.register(undefined)).toEqual({ ok: false, error: 'owner_capacity' });
  });

  it('enforces a rolling 24 h registration cap', () => {
    const { registry } = setup({ dailyCap: 1 });
    register(registry);
    expect(registry.register(undefined)).toEqual({ ok: false, error: 'register_daily_cap' });
    now = BASE + DAY;
    expect(registry.register(undefined).ok).toBe(true);
  });

  it('falls back to the default style when the stored one left the catalog', () => {
    const { db, registry } = setup();
    const token = register(registry, 'old-friend');
    const narrowed: RoleCatalog = { ...fixedRoleCatalog('P', director), hasStyle: (_r, s) => s === 'grandchild' };
    const { registry: later } = setup({}, narrowed, db);
    expect(ctxOf(later, token).styleId).toBe('grandchild');
  });

  it('records sessions only for owned contexts', () => {
    const { store, registry } = setup();
    const ctx = ctxOf(registry, register(registry));
    registry.lifecycle.started('s-dev', { roleId: DEFAULT_ROLE, styleId: 'grandchild' });
    registry.lifecycle.started('s1', ctx);
    now = BASE + 9_000;
    registry.lifecycle.ended('s1', ctx, 'client_end');
    expect(store.listSessions(ctx.ownerId!)).toEqual([{ id: 's1', agentId: ctx.agentId, startedAt: BASE, endedAt: BASE + 9_000 }]);
  });

  it('cleans up only never-connected owners past the cutoff, in batches', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { registry } = setup({ orphanOwnerDays: 7, orphanCleanupBatch: 2 });
    now = BASE - 8 * DAY;
    const orphans = [register(registry), register(registry), register(registry)];
    const connected = register(registry);
    registry.lifecycle.started('s-c', ctxOf(registry, connected));
    now = BASE;
    const fresh = register(registry);
    expect(await registry.cleanupOrphans()).toBe(3);
    for (const t of orphans) expect(registry.resolve(t)).toEqual({ ok: false });
    expect(registry.resolve(connected).ok).toBe(true);
    expect(registry.resolve(fresh).ok).toBe(true);
  });

  it('never logs tokens, token hashes, owner ids or full agent ids', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { registry } = setup();
    const token = register(registry);
    const ctx = ctxOf(registry, token);
    registry.setStyle(token, 'old-friend');
    registry.resolve(newDeviceToken());
    const out = write.mock.calls.map((c) => String(c[0])).join('');
    for (const secret of [token, hashToken(token), ctx.ownerId!, ctx.agentId!]) expect(out).not.toContain(secret);
    expect(out).toContain(shortHash(ctx.agentId!));
    expect(out).toContain('device_registered');
    expect(out).toContain('device_unknown');
  });
});
