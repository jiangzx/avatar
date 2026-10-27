import { afterEach, describe, expect, it } from 'vitest';
import { bootAdmin, TEST_PASSWORD, type AdminHarness } from './support/admin.ts';

let h: AdminHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const COOKIE = /^admin_sid=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=43200$/;
const auditActions = (harness: AdminHarness) =>
  (harness.db.prepare('SELECT action FROM admin_audit ORDER BY id').all() as Array<{ action: string }>).map((r) => r.action);

describe('admin server', () => {
  it('rejects unauthenticated API calls with security headers', async () => {
    h = await bootAdmin();
    const res = await h.api('/admin/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated', message: '请先登录。' });
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    // Ant Design injects runtime <style> tags (CSS-in-JS).
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 404 for unknown API paths', async () => {
    h = await bootAdmin();
    expect((await h.api('/admin/api/nope')).status).toBe(404);
  });

  it('logs in, issues a strict cookie and returns the csrf token', async () => {
    h = await bootAdmin();
    const res = await h.api('/admin/api/login', { method: 'POST', body: { password: TEST_PASSWORD } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(COOKIE);
    const body = (await res.json()) as { actor: string; csrfToken: string; idleExpiresAt: number };
    expect(body.actor).toBe('admin');
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const me = await h.api('/admin/api/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { csrfToken: string }).csrfToken).toBe(body.csrfToken);
    expect(auditActions(h)).toEqual(['login_succeeded']);
  });

  it('rejects a wrong password and never stores it', async () => {
    h = await bootAdmin();
    const res = await h.api('/admin/api/login', { method: 'POST', body: { password: 'wrong-password-123' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad_password', message: '密码不对，请重试。' });
    const rows = h.db.prepare('SELECT action, actor, detail FROM admin_audit').all() as Array<{ action: string; actor: string; detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('login_failed');
    expect(rows[0]!.actor).toBe('anonymous');
    expect(rows[0]!.detail).not.toContain('wrong-password');
    expect(rows[0]!.detail).not.toContain('127.0.0.1');
  });

  it('rotates the session id on every login', async () => {
    h = await bootAdmin();
    const first = await h.login();
    const second = await h.api('/admin/api/login', { method: 'POST', body: { password: TEST_PASSWORD }, headers: { cookie: first.cookie } });
    const secondCookie = second.headers.get('set-cookie')!.split(';')[0]!;
    expect(secondCookie).not.toBe(first.cookie);
    expect((await h.api('/admin/api/me', { headers: { cookie: first.cookie } })).status).toBe(401);
    expect((await h.api('/admin/api/me', { headers: { cookie: secondCookie } })).status).toBe(200);
  });

  it('requires the csrf token for writes and logs out', async () => {
    h = await bootAdmin();
    const auth = await h.login();
    const noCsrf = await h.api('/admin/api/logout', { method: 'POST', headers: { cookie: auth.cookie } });
    expect(noCsrf.status).toBe(403);
    expect(((await noCsrf.json()) as { error: string }).error).toBe('csrf');
    const out = await h.api('/admin/api/logout', { method: 'POST', auth });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await h.api('/admin/api/me', { headers: { cookie: auth.cookie } })).status).toBe(401);
    expect(auditActions(h)).toEqual(['login_succeeded', 'logout']);
  });

  it('refuses cross-origin writes, including login', async () => {
    h = await bootAdmin();
    const res = await h.api('/admin/api/login', { method: 'POST', body: { password: TEST_PASSWORD }, headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    const site = await h.api('/admin/api/login', { method: 'POST', body: { password: TEST_PASSWORD }, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(site.status).toBe(403);
  });

  it('rejects non-JSON bodies', async () => {
    h = await bootAdmin();
    const res = await h.api('/admin/api/login', { method: 'POST', body: `password=${TEST_PASSWORD}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.status).toBe(400);
  });

  it('locks login after repeated failures, even with the right password', async () => {
    h = await bootAdmin();
    for (let i = 0; i < h.config.login.maxFailures; i++) {
      expect((await h.api('/admin/api/login', { method: 'POST', body: { password: `wrong-${i}-xxxxxxxx` } })).status).toBe(401);
    }
    const locked = await h.api('/admin/api/login', { method: 'POST', body: { password: TEST_PASSWORD } });
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe(String(h.config.login.lockMs / 1000));
    expect(((await locked.json()) as { message: string }).message).toBe(`尝试次数太多，请 ${h.config.login.lockMs / 60_000} 分钟后再试。`);
  });

  it('expires the session after the idle limit', async () => {
    let t = 1_000_000;
    h = await bootAdmin({ now: () => t });
    const auth = await h.login();
    t += h.config.session.idleMs;
    expect((await h.api('/admin/api/me', { headers: { cookie: auth.cookie } })).status).toBe(401);
  });

  it('answers 405 for non-GET outside the API', async () => {
    h = await bootAdmin();
    expect((await h.api('/index.html', { method: 'POST' })).status).toBe(405);
  });
});
