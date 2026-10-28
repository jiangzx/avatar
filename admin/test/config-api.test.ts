import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client.ts';
import { adminApi } from '../src/api/endpoints.ts';
import { fakeFetch } from './helpers.tsx';

describe('config endpoints', () => {
  it('maps calls to plan 3 routes and sends CSRF on PUT', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /admin/api/config/scenes/pacing': { id: 'pacing' },
      'POST /admin/api/config/preview': { ok: true },
      'GET /admin/api/config/versions': { items: [], nextCursor: null },
      'PUT /admin/api/secrets/DASHSCOPE_API_KEY': { name: 'DASHSCOPE_API_KEY' },
      'GET /admin/api/pricing': { prices: [], unpricedModels: [] },
    });
    const api = adminApi(createApiClient({ fetchImpl: fetch, csrfToken: () => 'csrf-9', onUnauthorized: () => {} }));
    await api.configScene('pacing');
    await api.configPreview({ baseVersion: 3, changes: [{ key: 'k', value: 1 }], resets: [] });
    await api.configVersions(12);
    await api.putSecret('DASHSCOPE_API_KEY', 'sk-test-12345678');
    await api.pricing();
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
      'GET /admin/api/config/scenes/pacing',
      'POST /admin/api/config/preview',
      'GET /admin/api/config/versions?before=12&limit=20',
      'PUT /admin/api/secrets/DASHSCOPE_API_KEY',
      'GET /admin/api/pricing',
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ baseVersion: 3, changes: [{ key: 'k', value: 1 }], resets: [] });
    const put = calls[3]!;
    expect(new Headers(put.init.headers).get('x-csrf-token')).toBe('csrf-9');
    expect(JSON.parse(String(put.init.body))).toEqual({ value: 'sk-test-12345678' });
  });
});
