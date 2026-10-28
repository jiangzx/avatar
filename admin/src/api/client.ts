import type { AdminError } from '@anyidea/protocol';

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface ApiClient {
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string, body?: unknown): Promise<T>;
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  csrfToken: () => string | null;
  onUnauthorized: () => void;
}

const NETWORK_MESSAGE = '连不上后台服务，请确认网关正在运行。';
const LOGIN_FAILED_MESSAGE = '密码不对，请重新输入。';
const DEFAULT_MESSAGE = '后台出错了，请稍后再试。';
const STATUS_MESSAGES: Record<number, string> = {
  401: '登录已过期，请重新登录。',
  403: '没有权限做这个操作。',
  404: '找不到要查看的内容，可能已被删除。',
  409: '数据已在别处更新，请刷新后再试。',
  429: '操作太频繁，请稍后再试。',
};

export function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return `/admin/api${path}${qs ? `?${qs}` : ''}`;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  // Wrap the global so it is never called with a foreign `this`.
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function send<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, query?: Query, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') {
      const token = options.csrfToken();
      if (token) headers['x-csrf-token'] = token;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetchImpl(buildUrl(path, query), {
        method,
        headers,
        credentials: 'same-origin',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AdminApiError(0, 'network', NETWORK_MESSAGE);
    }
    const isLogin = path === '/login';
    if (response.status === 401 && !isLogin) options.onUnauthorized();
    if (!response.ok) {
      let payload: Partial<AdminError> = {};
      try {
        payload = (await response.json()) as Partial<AdminError>;
      } catch {
        // Non-JSON error body: fall back to the status message.
      }
      const fallback = isLogin && response.status === 401 ? LOGIN_FAILED_MESSAGE : STATUS_MESSAGES[response.status] ?? DEFAULT_MESSAGE;
      throw new AdminApiError(response.status, payload.error ?? `http_${response.status}`, payload.message || fallback);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    get: (path, query) => send('GET', path, query),
    post: (path, body) => send('POST', path, undefined, body ?? {}),
    put: (path, body) => send('PUT', path, undefined, body ?? {}),
    del: (path, body) => send('DELETE', path, undefined, body),
  };
}
