import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { loadAdminConfig, type AdminConfig } from '../../src/admin/config.ts';
import type { ConfigAdminApi } from '../../src/admin/configApi.ts';
import { hashPassword } from '../../src/admin/password.ts';
import { createAdminServer } from '../../src/admin/server.ts';
import { createLogLevelControl, type LogLevelControl } from '../../src/log/levels.ts';
import { createLogger, type LogLine, type Logger } from '../../src/log/logger.ts';
import { openDatabase } from '../../src/memory/db.ts';
import { SqliteMemoryStore } from '../../src/memory/store.ts';
import { SessionManager } from '../../src/session/manager.ts';
import { SqlitePriceBook } from '../../src/usage/pricing.ts';

export const TEST_PASSWORD = 'correct horse battery staple';
// Fixed salt: one ~100 ms scrypt per test file instead of per boot.
const HASH = hashPassword(TEST_PASSWORD, Buffer.alloc(16, 9));
const ADMIN_JSON = fileURLToPath(new URL('../../config/admin.json', import.meta.url));

export interface AuthPair { cookie: string; csrf: string }
export interface AdminHarness {
  url: string;
  db: DatabaseSync;
  store: SqliteMemoryStore;
  manager: SessionManager;
  levels: LogLevelControl;
  logger: Logger;
  lines: LogLine[];
  config: AdminConfig;
  login(password?: string): Promise<AuthPair>;
  api(path: string, init?: { method?: string; body?: unknown; auth?: AuthPair; headers?: Record<string, string> }): Promise<Response>;
  close(): Promise<void>;
}

export interface BootAdminOptions {
  db?: DatabaseSync;
  manager?: SessionManager;
  staticDir?: string;
  now?: () => number;
  adapterName?: string;
  configAdmin?: ConfigAdminApi;
}

export async function bootAdmin(opts: BootAdminOptions = {}): Promise<AdminHarness> {
  const db = opts.db ?? openDatabase(':memory:', { busyTimeoutMs: 1000 });
  const store = new SqliteMemoryStore(db);
  const manager = opts.manager ?? new SessionManager(() => {
    throw new Error('admin tests create no sessions');
  });
  // Same clock as the server so override expiry follows fixed test times.
  const levels = createLogLevelControl('info', opts.now);
  const lines: LogLine[] = [];
  const logger = createLogger({ sinks: [{ write: (line) => lines.push(line) }], levels, strict: true });
  const config = loadAdminConfig(ADMIN_JSON);
  const server: Server = createAdminServer({
    db,
    store,
    manager,
    logger,
    levels,
    prices: new SqlitePriceBook(db, []),
    config,
    passwordHash: await HASH,
    adapterName: opts.adapterName ?? 'mock',
    staticDir: opts.staticDir ?? '/nonexistent-admin-dist',
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.configAdmin ? { configAdmin: opts.configAdmin } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const api: AdminHarness['api'] = (path, init = {}) => {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    // Browsers send Origin on writes; set it explicitly so tests do not depend on fetch defaults.
    if (method !== 'GET' && headers.origin === undefined) headers.origin = url;
    if (init.body !== undefined) headers['content-type'] ??= 'application/json';
    if (init.auth) {
      headers.cookie = init.auth.cookie;
      headers['x-csrf-token'] = init.auth.csrf;
    }
    return fetch(`${url}${path}`, {
      method,
      headers,
      ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
    });
  };

  const login: AdminHarness['login'] = async (password = TEST_PASSWORD) => {
    const res = await api('/admin/api/login', { method: 'POST', body: { password } });
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    const me = (await res.json()) as { csrfToken: string };
    return { cookie, csrf: me.csrfToken };
  };

  return {
    url, db, store, manager, levels, logger, lines, config, api, login,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
