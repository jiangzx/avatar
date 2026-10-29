import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { bootAdmin, type AdminHarness, type AuthPair } from './support/admin.ts';
import { buildConfigAdmin } from './support/configAdmin.ts';

const FIRST = 'pacing:restReminder.firstAfterMs';
let db: DatabaseSync;
let h: AdminHarness;
let auth: AuthPair;

beforeEach(async () => {
  db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  const { api } = buildConfigAdmin(db, { activeSessions: () => 1 });
  h = await bootAdmin({ db, configAdmin: api });
  auth = await h.login();
});
afterEach(async () => { await h.close(); });

const json = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> });

describe('config routes', () => {
  it('requires login', async () => {
    expect((await h.api('/admin/api/config/scenes')).status).toBe(401);
  });

  it('reads scenes and one scene', async () => {
    const overview = await json(await h.api('/admin/api/config/scenes', { auth }));
    expect(overview.status).toBe(200);
    expect((overview.body.scenes as unknown[]).length).toBe(7);
    const scene = await json(await h.api('/admin/api/config/scenes/pacing', { auth }));
    expect(scene.body.id).toBe('pacing');
    expect(await json(await h.api('/admin/api/config/scenes/nope', { auth }))).toEqual({ status: 404, body: { error: 'scene_not_found', message: '没有这个设置分组。' } });
  });

  it('checks CSRF on writes', async () => {
    const res = await h.api('/admin/api/config/preview', { method: 'POST', body: { baseVersion: 0, changes: [], resets: [] }, headers: { cookie: auth.cookie } });
    expect(res.status).toBe(403);
  });

  it('previews, publishes with audit, pages versions and diffs', async () => {
    const draft = { baseVersion: 0, changes: [{ key: FIRST, value: 90 }], resets: [] };
    const preview = await json(await h.api('/admin/api/config/preview', { method: 'POST', body: draft, auth }));
    expect(preview.body).toMatchObject({ ok: true, requiresConfirm: false, activeSessions: 1 });
    const published = await json(await h.api('/admin/api/config/publish', { method: 'POST', body: draft, auth }));
    expect(published.body).toMatchObject({ id: 1, kind: 'publish', active: true });
    const page = await json(await h.api('/admin/api/config/versions?limit=5', { auth }));
    expect((page.body.items as Array<{ id: number }>).map((v) => v.id)).toEqual([1]);
    expect((await h.api('/admin/api/config/versions/1/diff', { auth })).status).toBe(200);
    const audit = db.prepare("SELECT action FROM admin_audit WHERE action = 'config_published'").all();
    expect(audit).toHaveLength(1);
  });

  it('returns config_invalid with issues and refuses stale drafts', async () => {
    const invalid = await json(await h.api('/admin/api/config/publish', { method: 'POST', auth, body: { baseVersion: 0, resets: [], changes: [
      { key: 'character:xiaonuan.enabled', value: false },
      { key: 'character:xiaokai.enabled', value: false },
      { key: 'character:xiaoxin.enabled', value: false },
    ] } }));
    expect(invalid).toEqual({ status: 400, body: { error: 'config_invalid', message: '有几项设置没通过检查。', issues: [{ key: null, message: '至少要留一个角色开着。' }] } });
    const stale = await h.api('/admin/api/config/preview', { method: 'POST', auth, body: { baseVersion: 7, changes: [{ key: FIRST, value: 90 }], resets: [] } });
    expect(stale.status).toBe(409);
  });

  it('rejects malformed bodies and queries', async () => {
    const bad = { status: 400, body: { error: 'bad_request', message: '请求格式不对。' } };
    expect(await json(await h.api('/admin/api/config/preview', { method: 'POST', auth, body: { baseVersion: -1, changes: [], resets: [] } }))).toEqual(bad);
    expect(await json(await h.api('/admin/api/config/preview', { method: 'POST', auth, body: { baseVersion: 0, changes: [{ key: 'a', value: { x: 1 } }], resets: [] } }))).toEqual(bad);
    expect(await json(await h.api('/admin/api/config/reset', { method: 'POST', auth, body: { keys: [], baseVersion: 0 } }))).toEqual(bad);
    expect(await json(await h.api('/admin/api/secrets/DASHSCOPE_API_KEY', { method: 'PUT', auth, body: { value: 'x'.repeat(600) } }))).toEqual(bad);
    expect(await json(await h.api('/admin/api/pricing', { method: 'POST', auth, body: { model: 'qwen-plus' } }))).toEqual(bad);
    expect(await json(await h.api('/admin/api/config/versions?limit=1000', { auth }))).toEqual(bad);
  });

  it('serves keys and prices', async () => {
    const list = await json(await h.api('/admin/api/secrets', { auth }));
    expect(list.status).toBe(200);
    const put = await json(await h.api('/admin/api/secrets/DASHSCOPE_API_KEY', { method: 'PUT', auth, body: { value: 'sk-test-abcdefghijklmnop1234' } }));
    expect(put.body).toMatchObject({ source: 'admin', last4: '1234' });
    const reveal = await json(await h.api('/admin/api/secrets/DASHSCOPE_API_KEY/reveal', { method: 'POST', auth, body: {} }));
    expect(reveal.body).toEqual({ name: 'DASHSCOPE_API_KEY', value: 'sk-test-abcdefghijklmnop1234' });
    const pricing = await json(await h.api('/admin/api/pricing', { auth }));
    expect(Array.isArray(pricing.body.prices)).toBe(true);
    expect(pricing.body.unpricedModels).toEqual([]);
  });
});
