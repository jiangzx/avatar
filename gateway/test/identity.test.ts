import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterId } from '@anyidea/protocol';
import { DeviceRegistry, type IdentityLimits } from '../src/identity/registry.ts';
import { hashToken, newDeviceToken, shortHash } from '../src/identity/tokens.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { fixedRoleCatalog, type RoleCatalog } from '../src/roles/catalog.ts';
import { shippedCharacters } from './support/shipped.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';

const director = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
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
    store, roles, characters: shippedCharacters(), now: () => now,
    continuityGapMs: 600_000,
    limits: { maxOwners: 10, dailyCap: 10, orphanOwnerDays: 7, orphanCleanupBatch: 2, ...limits },
  });
  return { db: database, store, registry };
}

function register(registry: DeviceRegistry): string {
  const r = registry.register();
  if (!r.ok) throw new Error(r.error);
  return r.deviceToken;
}

function ctxOf(registry: DeviceRegistry, token: string, characterId: CharacterId = 'xiaonuan'): SessionContext {
  const r = registry.resolve(token, characterId);
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
    expect(registry.resolve(undefined, 'xiaonuan')).toEqual({ ok: true, ctx: { characterId: 'xiaonuan', language: 'zh', firstMeet: true }, noticePending: false });
    expect(registry.resolve(newDeviceToken(), 'xiaonuan')).toEqual({ ok: false });
    const token = register(registry);
    const device = store.findDevice(hashToken(token))!;
    const resolved = registry.resolve(token, 'xiaonuan');
    expect(resolved.ok && resolved.noticePending).toBe(true);
    store.markNotified(device.ownerId, 2_000);
    expect(registry.resolve(token, 'xiaonuan')).toMatchObject({ ok: true, noticePending: false });
    const ctx = ctxOf(registry, token);
    expect(ctx).toMatchObject({ ownerId: device.ownerId, agentId: ctx.agentId, characterId: 'xiaonuan', language: 'zh', firstMeet: true });
    expect(ctx.agentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not ask for the memory notice after consent is declined', () => {
    const { store, registry } = setup();
    const token = register(registry);
    const ctx = ctxOf(registry, token);
    store.setConsent(ctx.ownerId!, 'declined', BASE);
    expect(registry.resolve(token, 'xiaonuan')).toMatchObject({ ok: true, noticePending: false });
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
    registry.lifecycle.started('s-a', ca);
    expect(store.listSessions(ca.ownerId!)).toHaveLength(1);
    expect(store.listSessions(cb.ownerId!)).toHaveLength(0);
    expect(registry.deleteOwner(ca.ownerId!)).toBe(true);
    expect(registry.resolve(a, 'xiaonuan')).toEqual({ ok: false });
    expect(registry.resolve(b, 'xiaonuan').ok).toBe(true);
  });

  it('enforces MAX_OWNERS', () => {
    const { registry } = setup({ maxOwners: 2 });
    register(registry);
    register(registry);
    expect(registry.register()).toEqual({ ok: false, error: 'owner_capacity' });
  });

  it('enforces a rolling 24 h registration cap', () => {
    const { registry } = setup({ dailyCap: 1 });
    register(registry);
    expect(registry.register()).toEqual({ ok: false, error: 'register_daily_cap' });
    now = BASE + DAY;
    expect(registry.register().ok).toBe(true);
  });

  it('records sessions only for owned contexts', () => {
    const { store, registry } = setup();
    const ctx = ctxOf(registry, register(registry));
    registry.lifecycle.started('s-dev', { characterId: 'xiaonuan', firstMeet: true });
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
    for (const t of orphans) expect(registry.resolve(t, 'xiaonuan')).toEqual({ ok: false });
    expect(registry.resolve(connected, 'xiaonuan').ok).toBe(true);
    expect(registry.resolve(fresh, 'xiaonuan').ok).toBe(true);
  });

  it('includes this owner’s fact and unextracted tail on the second resolve', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { db, registry } = setup();
    const token = register(registry);
    const otherToken = register(registry);
    const first = ctxOf(registry, token);
    const other = ctxOf(registry, otherToken);
    if (!first.ownerId || !first.agentId || !other.ownerId || !other.agentId) throw new Error('unresolved');
    registry.lifecycle.started('s1', first);
    registry.lifecycle.ended('s1', first, 'client_end');
    expect(first.memorySnapshot).toBeUndefined();
    expect(registry.resolve(undefined, 'xiaonuan')).toEqual({ ok: true, ctx: { characterId: 'xiaonuan', language: 'zh', firstMeet: true }, noticePending: false });

    db.prepare(`INSERT INTO agent_facts (id, owner_id, agent_id, category, text, sensitive, confidence, updated_at) VALUES (?, ?, ?, 'preference', '喜欢喝茶', 0, 0.8, 1)`).run(`pref-${first.ownerId}`, first.ownerId, first.agentId);
    db.prepare(`INSERT INTO profile_facts (id, owner_id, category, text, confidence, updated_at) VALUES (?, ?, 'addressing', '称呼：王叔', 0.9, 2)`).run(`addr-${first.ownerId}`, first.ownerId);
    db.prepare(`INSERT INTO profile_facts (id, owner_id, category, text, confidence, updated_at) VALUES (?, ?, 'addressing', '称呼：李姨', 0.9, 1)`).run(`addr-${other.ownerId}`, other.ownerId);
    db.prepare(`INSERT INTO agent_facts (id, owner_id, agent_id, category, text, sensitive, confidence, updated_at) VALUES (?, ?, ?, 'health', '膝盖不太好', 1, 0.9, 4)`).run(`health-${first.ownerId}`, first.ownerId, first.agentId);
    db.prepare(`INSERT INTO messages (id, session_id, owner_id, agent_id, role, text, bigrams, created_at) VALUES ('m-tail', 's1', ?, ?, 'user', '昨天去了公园', '', 10)`).run(first.ownerId, first.agentId);
    db.prepare(`INSERT INTO messages (id, session_id, owner_id, agent_id, role, text, bigrams, created_at) VALUES ('m-assistant-tail', 's1', ?, ?, 'assistant', '助手不该进尾部', '', 13)`).run(first.ownerId, first.agentId);
    db.prepare(`INSERT INTO messages (id, session_id, owner_id, agent_id, role, text, bigrams, extracted, created_at) VALUES ('m-done', 's1', ?, ?, 'assistant', '已经抽过', '', 1, 11)`).run(first.ownerId, first.agentId);
    db.prepare(`INSERT INTO messages (id, session_id, owner_id, agent_id, role, text, bigrams, excluded, created_at) VALUES ('m-drop', 's1', ?, ?, 'user', '不要这条', '', 1, 12)`).run(first.ownerId, first.agentId);
    db.prepare(`INSERT INTO relationship_notes (id, agent_id, owner_id, kind, text, updated_at) VALUES ('note-a', ?, ?, 'tone', '说话慢一点', 3)`).run(first.agentId, first.ownerId);
    db.prepare(`INSERT INTO relationship_notes (id, agent_id, owner_id, kind, text, updated_at) VALUES ('note-b', ?, ?, 'tone', '别人的备注', 3)`).run(other.agentId, other.ownerId);

    const second = ctxOf(registry, token);
    expect(second.memorySnapshot).toContain('称呼：王叔');
    expect(second.memorySnapshot).toContain('喜欢喝茶');
    expect(second.memorySnapshot).toContain('用户：昨天去了公园');
    expect(second.memorySnapshot).not.toContain('说话慢一点');
    expect(second.memorySnapshot).not.toContain('膝盖不太好');
    expect(second.memorySnapshot).not.toContain('称呼：李姨');
    expect(second.memorySnapshot).not.toContain('别人的备注');
    expect(second.memorySnapshot).not.toContain('已经抽过');
    expect(second.memorySnapshot).not.toContain('不要这条');
    expect(second.memorySnapshot).not.toContain('助手不该进尾部');
    expect(second.memorySnapshot!.indexOf('称呼：王叔')).toBeLessThan(second.memorySnapshot!.indexOf('喜欢喝茶'));
    expect(second.memorySnapshot!.indexOf('喜欢喝茶')).toBeLessThan(second.memorySnapshot!.indexOf('用户：昨天去了公园'));

    // Greetings keep the name but never the tail or sensitive memory.
    expect(second.greetingMemorySnapshot).toContain('称呼：王叔');
    expect(second.greetingMemorySnapshot).toContain('喜欢喝茶');
    expect(second.greetingMemorySnapshot).not.toContain('用户：昨天去了公园');
    expect(second.greetingMemorySnapshot).not.toContain('膝盖不太好');

    // Proactive lines get interests only: no name, no notes, no tail, and no sensitive memory.
    expect(second.proactiveMemorySnapshot).toContain('喜欢喝茶');
    expect(second.proactiveMemorySnapshot).not.toContain('称呼：王叔');
    expect(second.proactiveMemorySnapshot).not.toContain('说话慢一点');
    expect(second.proactiveMemorySnapshot).not.toContain('昨天去了公园');
    expect(second.proactiveMemorySnapshot).not.toContain('膝盖不太好');

    const otherSnapshot = ctxOf(registry, otherToken).memorySnapshot;
    expect(otherSnapshot).toContain('称呼：李姨');
    expect(otherSnapshot).not.toContain('王叔');
    expect(otherSnapshot).not.toContain('昨天去了公园');
    expect(otherSnapshot).not.toContain('说话慢一点');

    const out = write.mock.calls.map((c) => String(c[0])).join('');
    expect(out).not.toContain('王叔');
    expect(out).not.toContain('昨天去了公园');
    expect(out).not.toContain('喜欢喝茶');
  });

  it('never logs tokens, token hashes, owner ids or full agent ids', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { registry } = setup();
    const token = register(registry);
    const ctx = ctxOf(registry, token);
    registry.resolve(newDeviceToken(), 'xiaonuan');
    const out = write.mock.calls.map((c) => String(c[0])).join('');
    for (const secret of [token, hashToken(token), ctx.ownerId!, ctx.agentId!]) expect(out).not.toContain(secret);
    expect(out).toContain(shortHash(ctx.agentId!));
    expect(out).toContain('device_registered');
    expect(out).toContain('device_unknown');
  });

  it('puts every pin into pinnedMemory and only open pins into the greeting and proactive views', () => {
    const { store, registry } = setup();
    const token = register(registry);
    const first = ctxOf(registry, token);
    if (!first.ownerId || !first.agentId) throw new Error('unresolved');
    store.insertPinned({ id: 'pin-open', ownerId: first.ownerId, agentId: first.agentId, text: '孙子三月三号生日', sensitive: false, sourceSessionId: 's0', sourceMessageId: null, now: BASE });
    store.insertPinned({ id: 'pin-health', ownerId: first.ownerId, agentId: first.agentId, text: '每天吃降压药', sensitive: true, sourceSessionId: 's0', sourceMessageId: null, now: BASE + 1 });
    store.writeExtraction(first.ownerId, first.agentId, {
      now: BASE, messageIds: [], notes: [], episodes: [], followups: [],
      facts: [{ op: 'add', category: 'addressing', text: '王叔' }, { op: 'add', category: 'profile', text: '老家山东' }, { op: 'add', category: 'health', text: '膝盖不好' }],
    });
    const ctx = ctxOf(registry, token);
    expect(ctx.pinnedMemory).toBe('用户让你记住：每天吃降压药\n用户让你记住：孙子三月三号生日');
    expect(ctx.memorySnapshot).toBe('称呼：王叔\n基本情况：老家山东');
    expect(ctx.greetingMemorySnapshot).toBe('称呼：王叔\n基本情况：老家山东\n用户让你记住：孙子三月三号生日');
    expect(ctx.proactiveMemorySnapshot).toBe('基本情况：老家山东\n用户让你记住：孙子三月三号生日');
    expect(ctx.greetingHasTopic).toBe(true);
  });

  it('registers without a style and creates agents only per character on resolve', () => {
    const { db, registry } = setup();
    const token = register(registry);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 0 });
    ctxOf(registry, token, 'xiaokai');
    ctxOf(registry, token, 'xiaokai');
    expect(db.prepare('SELECT character_id FROM agents').all()).toEqual([{ character_id: 'xiaokai' }]);
  });

  it('marks the first meeting per character, not per owner', () => {
    const { registry } = setup();
    const token = register(registry);
    const nuan = ctxOf(registry, token, 'xiaonuan');
    expect(nuan).toMatchObject({ characterId: 'xiaonuan', language: 'zh', firstMeet: true });
    registry.lifecycle.started('s1', nuan);
    registry.lifecycle.ended('s1', nuan, 'client_end');
    expect(ctxOf(registry, token, 'xiaonuan').firstMeet).toBe(false);
    const kai = ctxOf(registry, token, 'xiaokai');
    expect(kai.firstMeet).toBe(true);
    expect(kai.ownerId).toBe(nuan.ownerId);
    expect(kai.agentId).not.toBe(nuan.agentId);
    expect('roleId' in kai || 'styleId' in kai || 'voice' in kai).toBe(false);
  });
});
