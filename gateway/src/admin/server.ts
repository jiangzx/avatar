import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { LogLevelControl } from '../log/levels.ts';
import type { Logger } from '../log/logger.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { SessionManager } from '../session/manager.ts';
import type { SqlitePriceBook } from '../usage/pricing.ts';
import { AdminAudit } from './audit.ts';
import type { AdminConfig } from './config.ts';
import { ADMIN_COOKIE, readCookie } from './cookies.ts';
import { applySecurityHeaders, readJsonBody, sameOrigin, sendError } from './http.ts';
import { LoginGuard } from './loginGuard.ts';
import { AdminQueries } from './queries.ts';
import { authRoutes } from './routes/auth.ts';
import { readRoutes } from './routes/read.ts';
import type { AdminRoute, AdminServices, RouteContext } from './routes/types.ts';
import { AdminSessionStore, csrfMatches, type AdminSession } from './sessions.ts';
import { serveStatic } from './static.ts';

export const ADMIN_ACTOR = 'admin';
const DEFAULT_BODY_LIMIT = 16 * 1024;

export interface AdminDeps {
  db: DatabaseSync;
  store: MemoryStore;
  manager: SessionManager;
  logger: Logger;
  levels: LogLevelControl;
  prices: SqlitePriceBook;
  config: AdminConfig;
  passwordHash: string;
  adapterName: string;
  staticDir: string;
  now?: () => number;
}

export function createAdminServer(deps: AdminDeps): Server {
  const now = deps.now ?? Date.now;
  const services: AdminServices = {
    sessions: new AdminSessionStore({ ...deps.config.session, now }),
    guard: new LoginGuard({ ...deps.config.login, now }),
    audit: new AdminAudit(deps.db, deps.logger, now),
    queries: new AdminQueries(deps.db, now),
    now,
  };
  // Later tasks append their route groups here.
  const routes: readonly AdminRoute[] = [...authRoutes(), ...readRoutes()];
  return createServer((req, res) => {
    handle(req, res, deps, services, routes).catch(() => {
      deps.logger.error('admin_http_error', { route: 'unmatched' });
      if (!res.headersSent) sendError(res, 500, 'internal', '服务出错了，请稍后再试。');
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: AdminDeps, services: AdminServices, routes: readonly AdminRoute[]): Promise<void> {
  applySecurityHeaders(res);
  const url = new URL(req.url ?? '/', 'http://admin.local');
  if (url.pathname.startsWith('/admin/api/')) {
    await handleApi(req, res, url, deps, services, routes);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(req, res, deps.staticDir, url.pathname);
    return;
  }
  sendError(res, 405, 'method_not_allowed', '不支持这个操作。');
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: AdminDeps, services: AdminServices, routes: readonly AdminRoute[]): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const method = req.method ?? 'GET';
  let params: string[] = [];
  const route = routes.find((r) => {
    if (r.method !== method) return false;
    const match = r.path.exec(url.pathname);
    if (!match) return false;
    params = match.slice(1);
    return true;
  });
  if (!route) {
    sendError(res, 404, 'not_found', '没有这个接口。');
    return;
  }
  if (method !== 'GET' && !sameOrigin(req)) {
    sendError(res, 403, 'csrf', '页面已过期，请刷新后再试。');
    return;
  }
  let session: AdminSession | null = null;
  if (route.auth) {
    session = services.sessions.get(readCookie(req.headers.cookie, ADMIN_COOKIE) ?? '');
    if (!session) {
      sendError(res, 401, 'unauthenticated', '请先登录。');
      return;
    }
    if (method !== 'GET' && !csrfMatches(session, req.headers['x-csrf-token'])) {
      sendError(res, 403, 'csrf', '页面已过期，请刷新后再试。');
      return;
    }
  }
  const ctx: RouteContext = {
    req, res, url, params, session, deps, services,
    body: () => readJsonBody(req, route.bodyLimit ?? DEFAULT_BODY_LIMIT),
  };
  try {
    await route.handle(ctx);
  } catch {
    deps.logger.error('admin_http_error', { route: route.name });
    if (!res.headersSent) sendError(res, 500, 'internal', '服务出错了，请稍后再试。');
  }
}
