import { afterEach, describe, expect, it } from 'vitest';
import { ownerShortId } from '../src/log/ownerId.ts';
import { openDatabase } from '../src/memory/db.ts';
import { OWNER_A, T, seedStandard } from './support/adminFixtures.ts';
import { bootAdmin, type AdminHarness } from './support/admin.ts';

const OA = ownerShortId(OWNER_A);
let h: AdminHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function seeded() {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  seedStandard(db);
  h = await bootAdmin({ db, now: () => T });
  return { h, auth: await h.login() };
}

describe('log level', () => {
  it('starts at the base level with no overrides', async () => {
    const { h, auth } = await seeded();
    expect(await (await h.api('/admin/api/log-level', { auth })).json()).toEqual({ global: 'info', overrides: [] });
  });

  it('turns on debug for one owner for the configured time, then resets', async () => {
    const { h, auth } = await seeded();
    const res = await h.api('/admin/api/log-level', { method: 'POST', auth, body: { scope: 'owner', oid: OA, level: 'debug' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      global: 'info',
      overrides: [{ scope: 'owner', oid: OA, level: 'debug', until: T + h.config.logLevelOverrideMs }],
    });
    expect(h.levels.levelFor(OA)).toBe('debug');
    expect(h.levels.levelFor(undefined)).toBe('info');
    const reset = await h.api('/admin/api/log-level', { method: 'POST', auth, body: { scope: 'owner', oid: OA, level: 'reset' } });
    expect(((await reset.json()) as { overrides: unknown[] }).overrides).toEqual([]);
    const rows = h.db.prepare("SELECT target, detail FROM admin_audit WHERE action = 'log_level_changed' ORDER BY id").all() as Array<{ target: string; detail: string }>;
    expect(rows.map((r) => [r.target, JSON.parse(r.detail)])).toEqual([
      [OA, { scope: 'owner', level: 'debug', minutes: h.config.logLevelOverrideMs / 60_000 }],
      [OA, { scope: 'owner', level: 'reset', minutes: 0 }],
    ]);
  });

  it('changes the global level', async () => {
    const { h, auth } = await seeded();
    const body = (await (await h.api('/admin/api/log-level', { method: 'POST', auth, body: { scope: 'global', level: 'debug' } })).json()) as { global: string };
    expect(body.global).toBe('debug');
    expect(h.levels.levelFor(undefined)).toBe('debug');
  });

  it('validates scope and oid', async () => {
    const { h, auth } = await seeded();
    const post = (body: unknown) => h.api('/admin/api/log-level', { method: 'POST', auth, body });
    expect((await post({ scope: 'owner', level: 'debug' })).status).toBe(400);
    expect((await post({ scope: 'global', oid: OA, level: 'debug' })).status).toBe(400);
    expect((await post({ scope: 'owner', oid: OA, level: 'trace' })).status).toBe(400);
    expect((await post({ scope: 'owner', oid: '000000000000', level: 'debug' })).status).toBe(404);
  });
});
