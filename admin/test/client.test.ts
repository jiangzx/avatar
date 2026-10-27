import { describe, expect, it, vi } from 'vitest';
import { AdminApiError, buildUrl, createApiClient } from '../src/api/client.ts';
import { fakeFetch } from './helpers.tsx';

describe('buildUrl', () => {
  it('prefixes /admin/api and drops empty query values', () => {
    expect(buildUrl('/sessions', { oid: 'abc', cursor: null, character: '', mock: undefined, from: 0 })).toBe('/admin/api/sessions?oid=abc&from=0');
    expect(buildUrl('/me')).toBe('/admin/api/me');
  });
});

describe('createApiClient', () => {
  it('sends the CSRF header on writes only', async () => {
    const { fetch, calls } = fakeFetch({ 'GET /admin/api/owners': { items: [], nextCursor: null }, 'POST /admin/api/owners/abc/ban': () => ({ status: 204 }) });
    const client = createApiClient({ fetchImpl: fetch, csrfToken: () => 'csrf-9', onUnauthorized: () => {} });
    await client.get('/owners');
    await client.post('/owners/abc/ban');
    const get = new Headers(calls[0]!.init.headers);
    const post = new Headers(calls[1]!.init.headers);
    expect(get.get('x-csrf-token')).toBeNull();
    expect(post.get('x-csrf-token')).toBe('csrf-9');
    expect(calls[1]!.init.credentials).toBe('same-origin');
  });

  it('calls onUnauthorized on a 401 outside login', async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = fakeFetch({ 'GET /admin/api/overview': () => ({ status: 401, body: { error: 'unauthorized', message: '登录已过期，请重新登录。' } }) });
    const client = createApiClient({ fetchImpl: fetch, csrfToken: () => null, onUnauthorized });
    await expect(client.get('/overview')).rejects.toBeInstanceOf(AdminApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('treats a login 401 as a wrong password, not an expired session', async () => {
    const onUnauthorized = vi.fn();
    const { fetch } = fakeFetch({ 'POST /admin/api/login': () => ({ status: 401, body: {} }) });
    const client = createApiClient({ fetchImpl: fetch, csrfToken: () => null, onUnauthorized });
    const error = await client.post('/login', { password: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdminApiError);
    expect((error as AdminApiError).message).toBe('密码不对，请重新输入。');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('prefers the server message and code', async () => {
    const { fetch } = fakeFetch({ 'POST /admin/api/login': () => ({ status: 429, body: { error: 'login_locked', message: '密码错误次数太多，请 15 分钟后再试。' } }) });
    const client = createApiClient({ fetchImpl: fetch, csrfToken: () => null, onUnauthorized: () => {} });
    const error = (await client.post('/login', { password: 'x' }).catch((e: unknown) => e)) as AdminApiError;
    expect(error.status).toBe(429);
    expect(error.code).toBe('login_locked');
    expect(error.message).toBe('密码错误次数太多，请 15 分钟后再试。');
  });

  it('turns a network failure into a readable error', async () => {
    const failing = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const client = createApiClient({ fetchImpl: failing, csrfToken: () => null, onUnauthorized: () => {} });
    const error = (await client.get('/me').catch((e: unknown) => e)) as AdminApiError;
    expect(error.code).toBe('network');
    expect(error.message).toBe('连不上后台服务，请确认网关正在运行。');
  });

  it('returns undefined for 204', async () => {
    const { fetch } = fakeFetch({ 'POST /admin/api/logout': () => ({ status: 204 }) });
    const client = createApiClient({ fetchImpl: fetch, csrfToken: () => 'c', onUnauthorized: () => {} });
    await expect(client.post('/logout')).resolves.toBeUndefined();
  });
});
