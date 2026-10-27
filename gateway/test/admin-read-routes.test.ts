import { afterEach, describe, expect, it } from 'vitest';
import { ownerShortId } from '../src/log/ownerId.ts';
import { openDatabase } from '../src/memory/db.ts';
import { OWNER_A, OWNER_B, S_A1, T, seedStandard } from './support/adminFixtures.ts';
import { bootAdmin, type AdminHarness } from './support/admin.ts';

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

describe('admin read routes', () => {
  it('require login', async () => {
    h = await bootAdmin();
    for (const path of ['/admin/api/overview', '/admin/api/owners', '/admin/api/sessions', '/admin/api/logs', '/admin/api/audit']) {
      expect((await h.api(path)).status).toBe(401);
    }
  });

  it('return the overview', async () => {
    const { h, auth } = await seeded();
    const res = await h.api('/admin/api/overview?range=today', { auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { brief: { owners: number }; adapter: string };
    expect(body.brief.owners).toBe(2);
    expect(body.adapter).toBe('mock');
  });

  it('reject unknown or malformed query parameters', async () => {
    const { h, auth } = await seeded();
    for (const path of [
      '/admin/api/overview?range=year',
      '/admin/api/overview?foo=1',
      '/admin/api/owners?limit=0',
      '/admin/api/sessions?oid=XYZ',
      '/admin/api/logs?level=trace',
      '/admin/api/logs?event=DROP%20TABLE',
      '/admin/api/audit?cursor=-1',
    ]) {
      const res = await h.api(path, { auth });
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('查询条件不正确。');
    }
  });

  it('serve owners, one owner and 404 for an unknown oid', async () => {
    const { h, auth } = await seeded();
    const list = await h.api('/admin/api/owners', { auth });
    const text = await list.text();
    expect(text).toContain(ownerShortId(OWNER_A));
    expect(text).not.toContain(OWNER_A);
    expect(text).not.toContain(OWNER_B);
    expect((await h.api(`/admin/api/owners/${ownerShortId(OWNER_A)}`, { auth })).status).toBe(200);
    const missing = await h.api('/admin/api/owners/000000000000', { auth });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { message: string }).message).toBe('没有找到这个用户。');
  });

  it('filter sessions by oid and return an empty page for an unknown oid', async () => {
    const { h, auth } = await seeded();
    const mine = (await (await h.api(`/admin/api/sessions?oid=${ownerShortId(OWNER_A)}`, { auth })).json()) as { items: Array<{ sid: string }> };
    expect(mine.items.map((s) => s.sid)).toEqual([S_A1]);
    const none = (await (await h.api('/admin/api/sessions?oid=000000000000', { auth })).json()) as { items: unknown[]; nextCursor: null };
    expect(none).toEqual({ items: [], nextCursor: null });
  });

  it('serve a timeline and 404 for an unknown session', async () => {
    const { h, auth } = await seeded();
    const tl = (await (await h.api(`/admin/api/sessions/${S_A1}/timeline`, { auth })).json()) as { items: unknown[]; firstAudioAlertMs: number };
    expect(tl.items).toHaveLength(5);
    expect(tl.firstAudioAlertMs).toBe(2000); // bootAdmin uses the shipped admin.json alerts
    expect((await h.api('/admin/api/sessions/99999999-0000-4000-8000-000000000000/timeline', { auth })).status).toBe(404);
  });

  it('serve logs and audit', async () => {
    const { h, auth } = await seeded();
    const logs = (await (await h.api(`/admin/api/logs?sid=${S_A1}&level=warn&from=0`, { auth })).json()) as { items: Array<{ event: string }> };
    expect(logs.items.map((l) => l.event)).toEqual(['upstream_error']);
    const audit = (await (await h.api('/admin/api/audit', { auth })).json()) as { items: Array<{ action: string }> };
    expect(audit.items.map((a) => a.action)).toEqual(['login_succeeded']);
  });
});
