import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleLogPurge } from '../src/admin/ownerActions.ts';
import { createLogLevelControl } from '../src/log/levels.ts';
import { createLogger } from '../src/log/logger.ts';
import { ownerShortId } from '../src/log/ownerId.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqlitePriceBook } from '../src/usage/pricing.ts';
import { SqliteUsageRecorder } from '../src/usage/recorder.ts';
import { AGENT_A, OWNER_A, OWNER_B, T, insertLog, seedStandard } from './support/adminFixtures.ts';
import { bootAdmin, type AdminHarness } from './support/admin.ts';

const OA = ownerShortId(OWNER_A);
const OB = ownerShortId(OWNER_B);
let h: AdminHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  vi.restoreAllMocks();
});

async function seeded() {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  seedStandard(db);
  insertLog(db, { ts: T - 10_000, level: 'info', event: 'session_created', oid: OA });
  insertLog(db, { ts: T - 10_000, level: 'info', event: 'session_created', oid: OB });
  h = await bootAdmin({ db, now: () => T });
  return { h, auth: await h.login() };
}

const audit = (harness: AdminHarness) =>
  harness.db.prepare("SELECT action, target, detail FROM admin_audit WHERE action <> 'login_succeeded' ORDER BY id").all() as Array<{ action: string; target: string | null; detail: string }>;

describe('ban and unban', () => {
  it('bans, ends live sessions, and unbans', async () => {
    const { h, auth } = await seeded();
    const endOwner = vi.spyOn(h.manager, 'endOwner');
    expect((await h.api(`/admin/api/owners/${OA}/ban`, { method: 'POST', auth })).status).toBe(204);
    expect(h.store.isOwnerBanned(OWNER_A)).toBe(true);
    expect(endOwner).toHaveBeenCalledWith(OWNER_A, 'owner_banned', { code: 'owner_banned', closeDelayMs: 250 });
    const listed = (await (await h.api('/admin/api/owners', { auth })).json()) as { items: Array<{ oid: string; banned: boolean }> };
    expect(listed.items.find((o) => o.oid === OA)?.banned).toBe(true);
    expect((await h.api(`/admin/api/owners/${OA}/unban`, { method: 'POST', auth })).status).toBe(204);
    expect(h.store.isOwnerBanned(OWNER_A)).toBe(false);
    expect(audit(h)).toEqual([
      { action: 'owner_banned', target: OA, detail: '{"sessionsEnded":0}' },
      { action: 'owner_unbanned', target: OA, detail: '{}' },
    ]);
  });

  it('404s for an unknown oid and requires csrf', async () => {
    const { h, auth } = await seeded();
    expect((await h.api('/admin/api/owners/000000000000/ban', { method: 'POST', auth })).status).toBe(404);
    expect((await h.api(`/admin/api/owners/${OA}/ban`, { method: 'POST', headers: { cookie: auth.cookie } })).status).toBe(403);
    expect(h.store.isOwnerBanned(OWNER_A)).toBe(false);
  });
});

describe('proactive daily reset', () => {
  it('clears today\'s count for every character and audits it', async () => {
    const { h, auth } = await seeded();
    const bAgent = h.db.prepare('SELECT id FROM agents WHERE owner_id = ? LIMIT 1').get(OWNER_B) as { id: string };
    h.db.prepare('INSERT INTO proactive_daily (owner_id, agent_id, day, count) VALUES (?, ?, ?, ?)').run(OWNER_A, AGENT_A, '2026-10-27', 9);
    h.db.prepare('INSERT INTO proactive_daily (owner_id, agent_id, day, count) VALUES (?, ?, ?, ?)').run(OWNER_B, bAgent.id, '2026-10-27', 3);
    expect((await h.api(`/admin/api/owners/${OA}/proactive-daily/reset`, { method: 'POST', auth })).status).toBe(204);
    const row = h.db.prepare('SELECT COUNT(*) AS n FROM proactive_daily WHERE owner_id = ? AND day = ?').get(OWNER_A, '2026-10-27') as { n: number };
    expect(row.n).toBe(0);
    const other = h.db.prepare('SELECT count FROM proactive_daily WHERE owner_id = ? AND day = ?').get(OWNER_B, '2026-10-27') as { count: number };
    expect(other.count).toBe(3);
    expect(audit(h)).toEqual([{ action: 'proactive_daily_reset', target: OA, detail: '{"day":"2026-10-27","rows":1}' }]);
  });

  it('404s for an unknown oid and requires csrf', async () => {
    const { h, auth } = await seeded();
    expect((await h.api('/admin/api/owners/000000000000/proactive-daily/reset', { method: 'POST', auth })).status).toBe(404);
    expect((await h.api(`/admin/api/owners/${OA}/proactive-daily/reset`, { method: 'POST', headers: { cookie: auth.cookie } })).status).toBe(403);
  });
});

describe('delete', () => {
  it('requires the oid as confirmation', async () => {
    const { h, auth } = await seeded();
    for (const body of [undefined, {}, { confirm: OB }, { confirm: `${OA} ` }]) {
      const res = await h.api(`/admin/api/owners/${OA}`, { method: 'DELETE', auth, ...(body ? { body } : {}) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('请输入要删除的用户编号来确认。');
    }
    expect(h.store.getOwner(OWNER_A)).toBeDefined();
  });

  it('deletes the owner with usage and logs, keeps the audit row', async () => {
    const { h, auth } = await seeded();
    const endOwner = vi.spyOn(h.manager, 'endOwner');
    expect((await h.api(`/admin/api/owners/${OA}`, { method: 'DELETE', auth, body: { confirm: OA } })).status).toBe(204);
    expect(endOwner).toHaveBeenCalledWith(OWNER_A, 'owner_deleted');
    expect(h.store.getOwner(OWNER_A)).toBeUndefined();
    const count = (sql: string, ...args: string[]) => (h.db.prepare(sql).get(...args) as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM usage_events WHERE owner_id = ?', OWNER_A)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM usage_events WHERE owner_id = ?', OWNER_B)).toBeGreaterThan(0);
    expect(count('SELECT COUNT(*) AS n FROM log_events WHERE oid = ?', OA)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM log_events WHERE oid = ?', OB)).toBe(1);
    expect(audit(h)).toEqual([{ action: 'owner_deleted', target: OA, detail: '{"sessionsEnded":0}' }]);
    expect((await h.api(`/admin/api/owners/${OA}`, { auth })).status).toBe(404);
  });

  it('purges log lines that land after the delete', async () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    const logger = createLogger({ sinks: [], levels: createLogLevelControl('info'), strict: true });
    scheduleLogPurge(db, OA, 10, logger);
    insertLog(db, { ts: 1, level: 'info', event: 'session_destroyed', oid: OA });
    await new Promise((r) => setTimeout(r, 30));
    expect((db.prepare('SELECT COUNT(*) AS n FROM log_events').get() as { n: number }).n).toBe(0);
  });

  it('a buffered usage row of the deleted owner does not break the recorder', async () => {
    const { h, auth } = await seeded();
    const recorder = new SqliteUsageRecorder({ db: h.db, prices: new SqlitePriceBook(h.db, []), logger: h.logger, flushMs: 60_000, maxBatch: 100 });
    const base = { kind: 'memory_extract' as const, adapter: 'text' as const, model: 'qwen-plus', usage: { inputTokens: 1, outputTokens: 1 } };
    recorder.record({ ...base, attribution: { ownerId: OWNER_A, agentId: AGENT_A, sessionId: null, characterId: null }, ts: T });
    recorder.record({ ...base, attribution: { ownerId: OWNER_B, agentId: null, sessionId: null, characterId: null }, ts: T + 1 });
    expect((await h.api(`/admin/api/owners/${OA}`, { method: 'DELETE', auth, body: { confirm: OA } })).status).toBe(204);
    expect(() => recorder.flush()).not.toThrow();
    const rows = h.db.prepare('SELECT owner_id FROM usage_events WHERE ts >= ?').all(T) as Array<{ owner_id: string }>;
    expect(rows.map((r) => r.owner_id)).toEqual([OWNER_B]);
    recorder.close();
  });
});
