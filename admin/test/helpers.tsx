import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import type { AdminMe } from '@anyidea/protocol';
import { AuthProvider } from '../src/auth/AuthContext.tsx';
import { ViewOptionsProvider } from '../src/layout/ViewOptions.tsx';
import { adminTheme } from '../src/theme.ts';

export const ME: AdminMe = { actor: 'admin', csrfToken: 'csrf-test-1', idleExpiresAt: 1_900_000_000_000 };

export interface FakeResponse { status?: number; body?: unknown }
export type Handler = (url: URL, init: RequestInit) => FakeResponse | Promise<FakeResponse>;
export interface FakeCall { method: string; url: URL; init: RequestInit }

/**
 * Keys are "<METHOD> <pathname>", e.g. "GET /admin/api/overview".
 * A plain value is returned as a 200 JSON body; a function decides status and body.
 * "GET /admin/api/me" defaults to ME.
 */
export function fakeFetch(handlers: Record<string, Handler | FakeResponse['body']>): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, url, init });
    const key = `${method} ${url.pathname}`;
    const handler = key in handlers ? handlers[key] : key === 'GET /admin/api/me' ? ME : undefined;
    if (handler === undefined) return json(404, { error: 'not_found', message: '找不到要查看的内容，可能已被删除。' });
    const result = typeof handler === 'function' ? await (handler as Handler)(url, init) : { body: handler };
    if (result.status === 204) return new Response(null, { status: 204 });
    return json(result.status ?? 200, result.body ?? {});
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function renderWithProviders(ui: ReactElement, fetchImpl: typeof fetch) {
  return render(
    <ConfigProvider theme={adminTheme} button={{ autoInsertSpace: false }}>
      <AntApp>
        <AuthProvider fetchImpl={fetchImpl}>
          <ViewOptionsProvider>{ui}</ViewOptionsProvider>
        </AuthProvider>
      </AntApp>
    </ConfigProvider>,
  );
}
