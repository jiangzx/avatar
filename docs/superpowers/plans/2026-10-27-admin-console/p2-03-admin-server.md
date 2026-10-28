# P2-T3: 后台 HTTP 服务、路由表、静态托管、审计与接线

**目标：** 建立后台端口上的 HTTP 服务：安全响应头、`/admin/api` 路由表（默认要求登录，写操作校验同源和 CSRF）、登录 / 登出 / 当前会话三个接口、`admin/dist` 静态托管（路径约束 + 扩展名白名单 + SPA 回退）、审计写入与 1 年保留，并在 `index.ts` 中按 C7 的条件启动（只绑 127.0.0.1）。

**实现的 spec 章节：** Q5、Q6；「后台 HTTP API」鉴权与审计段；「安全复核卡」授权、高风险操作、日志三行。

**前置：** P2-T1、P2-T2 完成。计划 1 已在 `gateway/src/index.ts` 定义这些顶层变量（P1-T4、P1-T9）：`adminConfig`（`loadAdminConfig(...)`）、`memoryDb`、`levels`（`createLogLevelControl(...)`）、`logger`（`createLogger(...)`）、`prices`（`SqlitePriceBook | null`，只在有 `memoryDb` 时非空）、`usage`（`SqliteUsageRecorder | null`）。下文直接使用这些名字。

**Files:**
- Create: `gateway/src/admin/http.ts`（响应、请求体、安全头、同源检查）
- Create: `gateway/src/admin/static.ts`
- Create: `gateway/src/admin/audit.ts`
- Create: `gateway/src/admin/routes/types.ts`
- Create: `gateway/src/admin/routes/auth.ts`
- Create: `gateway/src/admin/server.ts`
- Modify: `gateway/src/index.ts`（启动后台、关停、审计保留）
- Create: `gateway/test/support/admin.ts`（测试启动器，P2-T4、P2-T5 复用）
- Test: `gateway/test/admin-server.test.ts`、`gateway/test/admin-static.test.ts`、`gateway/test/admin-audit.test.ts`（均新建）

**Interfaces:**
- Consumes：`AdminConfig`、`loadAdminEnv`（P2-T1）；`verifyPassword`（P2-T1）；`AdminSessionStore`、`csrfMatches`、`LoginGuard`、`readCookie`、`sessionCookie`、`clearedSessionCookie`、`ADMIN_COOKIE`（P2-T2）；`Logger`、`LogFields`、`LogLevelControl`、`guardFields`（C2）；`SqlitePriceBook`（C3）；`MemoryStore`、`SessionManager`；`shortHash`（`gateway/src/identity/tokens.ts`）；`AdminMe`、`AdminError`（C6）。
- Produces：
  ```ts
  // gateway/src/admin/server.ts — 总览 C7 逐字
  export interface AdminDeps { db; store; manager; logger; levels; prices; config; passwordHash; adapterName; staticDir; now? }
  export function createAdminServer(deps: AdminDeps): Server;
  export const ADMIN_ACTOR = 'admin';

  // gateway/src/admin/routes/types.ts
  export interface AdminServices { sessions: AdminSessionStore; guard: LoginGuard; audit: AdminAudit; now: () => number }
  export interface RouteContext {
    req: IncomingMessage; res: ServerResponse; url: URL; params: readonly string[];
    session: AdminSession | null;     // non-null on auth routes
    deps: AdminDeps; services: AdminServices;
    body(): Promise<unknown>;         // JSON within route.bodyLimit; null when missing/invalid/too large/not JSON
  }
  export interface AdminRoute {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: RegExp;                     // anchored; capture groups -> params
    name: string;                     // content-free, used in logs
    auth: boolean;
    bodyLimit?: number;               // bytes, default 16 KiB
    handle(ctx: RouteContext): Promise<void> | void;
  }

  // gateway/src/admin/http.ts
  export const ADMIN_CSP: string;
  export function applySecurityHeaders(res: ServerResponse): void;
  export function sendJson(res: ServerResponse, status: number, body: unknown): void;
  export function sendError(res: ServerResponse, status: number, error: string, message: string): void; // AdminError
  export function sendNoContent(res: ServerResponse): void;
  export function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown>;
  export function sameOrigin(req: IncomingMessage): boolean;

  // gateway/src/admin/audit.ts
  export type AdminAuditAction = 'login_succeeded' | 'login_failed' | 'logout' | 'config_published' | 'config_rolled_back' | 'config_reset'
    | 'secret_updated' | 'secret_revealed' | 'price_added' | 'owner_banned' | 'owner_unbanned' | 'owner_deleted' | 'log_level_changed';
  export interface AdminAuditEntry { actor: string; action: AdminAuditAction; target?: string | null; detail?: LogFields }
  export class AdminAudit { constructor(db: DatabaseSync, logger: Logger, now?: () => number); record(entry: AdminAuditEntry): void }
  export function expireAdminAudit(db: DatabaseSync, olderThan: number): number;

  // gateway/src/admin/static.ts
  export const STATIC_TYPES: Readonly<Record<string, string>>;
  export function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, urlPath: string): Promise<void>;
  ```
- 后续任务把自己的路由数组加进 `server.ts` 的 `routes` 列表（P2-T4 `readRoutes()`、P2-T5 `ownerRoutes()`、P3 追加）。

## 设计说明

- **请求顺序**：先写安全头 → `/admin/api/*` 走路由表 → 其余 `GET/HEAD` 走静态 → 其它方法 405。
- **API 路由**：找不到路由 404；**非 GET 一律先做同源检查**（`Origin` 存在时必须与 `Host` 同源，`Sec-Fetch-Site` 存在时必须是 `same-origin` 或 `none`），登录接口也不例外（防登录 CSRF）；`auth: true` 的路由要有效 Cookie 会话，非 GET 还要 `x-csrf-token` 匹配。所有 API 响应 `Cache-Control: no-store`。
- **请求体**：只接受 `content-type: application/json`，超过 `bodyLimit` 或解析失败返回 null，由路由用 zod 判定 400。
- **安全头**（所有响应）：`Content-Security-Policy`（见 `ADMIN_CSP`）、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Resource-Policy: same-origin`、`Permissions-Policy: camera=(), microphone=(), geolocation=()`。CSP 的 `style-src` 带 `'unsafe-inline'`：Ant Design 用 CSS-in-JS 运行时注入 `<style>`；脚本仍只允许 `'self'`。不发 HSTS（回环地址走 http，由反向代理负责）。
- **静态托管**：`decodeURIComponent` 失败或含 `\0` → 400；`path.normalize` 后去掉开头的斜杠，`path.resolve(root, rel)` 必须等于 root 或以 `root + sep` 开头；无扩展名的路径回退到 `index.html`（SPA 路由）；扩展名不在白名单 → 404；`lstat` 是符号链接或不是普通文件 → 404。`assets/` 下的文件带内容哈希，缓存一年 `immutable`；其余（含 `index.html`）`no-store`。`index.html` 不存在时 503，正文提示先构建前端。
- **来源地址**只取 `req.socket.remoteAddress`，不信任 `X-Forwarded-For`（后台只绑 127.0.0.1）。审计里的来源记 `shortHash`（8 位），不记原始地址。
- **审计**写入前对 `detail` 跑 `guardFields(action, detail, false)`：被拒的字段丢弃并记 `admin_audit_field_rejected {action, count}`。写库失败记 `admin_audit_failed {action}`（error），不抛出：这时动作已经完成，抛出只会让管理员误以为没做成。
- **未知异常**统一 500 `{ error: 'internal', message: '服务出错了，请稍后再试。' }`，日志 `admin_http_error {route}`。

## Steps

- [x] **Step 1: 写测试启动器**

新建 `gateway/test/support/admin.ts`：

```ts
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { loadAdminConfig, type AdminConfig } from '../../src/admin/config.ts';
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
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
```

- [x] **Step 2: 写失败的服务测试**

新建 `gateway/test/admin-server.test.ts`：

```ts
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
```

- [x] **Step 3: 写失败的静态与审计测试**

新建 `gateway/test/admin-static.test.ts`：

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootAdmin, type AdminHarness } from './support/admin.ts';

let dist = '';
let outside = '';
let h: AdminHarness | null = null;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'admin-static-'));
  dist = join(base, 'dist');
  outside = join(base, 'outside');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>后台</title>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dist, 'notes.txt'), 'not allowed');
  writeFileSync(join(outside, 'secret.js'), 'secret');
  symlinkSync(join(outside, 'secret.js'), join(dist, 'assets', 'link.js'));
});
afterAll(() => rmSync(join(dist, '..'), { recursive: true, force: true }));
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('admin static files', () => {
  it('serves index.html for / and for client routes', async () => {
    h = await bootAdmin({ staticDir: dist });
    for (const path of ['/', '/users', '/config/pacing']) {
      const res = await h.api(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toContain('后台');
    }
  });

  it('serves hashed assets with long cache', async () => {
    h = await bootAdmin({ staticDir: dist });
    const res = await h.api('/assets/app-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('refuses traversal, symlinks, unknown extensions and missing files', async () => {
    h = await bootAdmin({ staticDir: dist });
    expect((await h.api('/assets/..%2f..%2foutside%2fsecret.js')).status).toBe(404);
    expect((await h.api('/assets/link.js')).status).toBe(404);
    expect((await h.api('/notes.txt')).status).toBe(404);
    expect((await h.api('/assets/missing.js')).status).toBe(404);
    expect((await h.api('/%E0%A4%A')).status).toBe(400);
  });

  it('explains when the frontend is not built', async () => {
    h = await bootAdmin({ staticDir: join(dist, 'missing') });
    const res = await h.api('/');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('npm run build -w admin');
  });
});
```

新建 `gateway/test/admin-audit.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { AdminAudit, expireAdminAudit } from '../src/admin/audit.ts';
import { createLogLevelControl } from '../src/log/levels.ts';
import { createLogger, type LogLine } from '../src/log/logger.ts';
import { openDatabase } from '../src/memory/db.ts';

function setup(now = 5_000) {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  const lines: LogLine[] = [];
  const logger = createLogger({ sinks: [{ write: (l) => lines.push(l) }], levels: createLogLevelControl('info'), strict: false });
  return { db, lines, audit: new AdminAudit(db, logger, () => now) };
}

describe('AdminAudit', () => {
  it('writes one content-free row and one log line', () => {
    const { db, lines, audit } = setup();
    audit.record({ actor: 'admin', action: 'owner_banned', target: 'abcdef012345', detail: { sessionsEnded: 1 } });
    expect(db.prepare('SELECT ts, actor, action, target, detail FROM admin_audit').all()).toEqual([
      { ts: 5_000, actor: 'admin', action: 'owner_banned', target: 'abcdef012345', detail: '{"sessionsEnded":1}' },
    ]);
    expect(lines.map((l) => [l.event, l.fields.action])).toContainEqual(['admin_audit', 'owner_banned']);
  });

  it('drops banned detail fields and says so', () => {
    const { db, lines, audit } = setup();
    audit.record({ actor: 'admin', action: 'config_published', detail: { promptText: 'secret words', changed: 2 } });
    const row = db.prepare('SELECT detail FROM admin_audit').get() as { detail: string };
    expect(JSON.parse(row.detail)).toEqual({ changed: 2 });
    expect(lines.some((l) => l.event === 'admin_audit_field_rejected' && l.fields.count === 1)).toBe(true);
  });

  it('expires rows older than the cutoff', () => {
    const { db } = setup();
    const insert = db.prepare("INSERT INTO admin_audit (ts, actor, action, target, detail) VALUES (?, 'admin', 'logout', NULL, '{}')");
    insert.run(100);
    insert.run(200);
    insert.run(300);
    expect(expireAdminAudit(db, 250)).toBe(2);
    expect((db.prepare('SELECT ts FROM admin_audit').all() as Array<{ ts: number }>).map((r) => r.ts)).toEqual([300]);
  });
});
```

- [x] **Step 4: 跑测试确认失败**

Run: `npm test -w gateway -- test/admin-server.test.ts test/admin-static.test.ts test/admin-audit.test.ts`
Expected: FAIL，`Cannot find module '../../src/admin/server.ts'`、`'../src/admin/audit.ts'`。

- [x] **Step 5: 实现 `http.ts`**

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminError } from '@anyidea/protocol';

export const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Ant Design injects runtime <style> tags (CSS-in-JS).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', ADMIN_CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, error: string, message: string): void {
  sendJson(res, status, { error, message } satisfies AdminError);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204).end();
}

/** JSON only. Returns null for a missing, non-JSON, oversized or unparsable body. */
export function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json(;|$)/i.test(type)) {
    req.resume();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Browser writes must come from this origin. Non-browser clients send neither header. */
export function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false; // includes "null"
  }
}
```

- [x] **Step 6: 实现 `audit.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import { guardFields } from '../log/fieldGuard.ts';
import type { LogFields, Logger } from '../log/logger.ts';

export type AdminAuditAction =
  | 'login_succeeded' | 'login_failed' | 'logout'
  | 'config_published' | 'config_rolled_back' | 'config_reset'
  | 'secret_updated' | 'secret_revealed' | 'price_added'
  | 'owner_banned' | 'owner_unbanned' | 'owner_deleted' | 'log_level_changed';

export interface AdminAuditEntry { actor: string; action: AdminAuditAction; target?: string | null; detail?: LogFields }

/** Content-free audit trail. Kept for auditDays; owner deletion does not remove it (spec Q35). */
export class AdminAudit {
  private readonly insert;

  constructor(db: DatabaseSync, private readonly logger: Logger, private readonly now: () => number = Date.now) {
    this.insert = db.prepare('INSERT INTO admin_audit (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)');
  }

  record(entry: AdminAuditEntry): void {
    const { fields, rejected } = guardFields(entry.action, entry.detail ?? {}, false);
    if (rejected.length > 0) this.logger.warn('admin_audit_field_rejected', { action: entry.action, count: rejected.length });
    try {
      this.insert.run(this.now(), entry.actor, entry.action, entry.target ?? null, JSON.stringify(fields));
    } catch {
      // The action already happened; say so loudly instead of failing the request.
      this.logger.error('admin_audit_failed', { action: entry.action });
      return;
    }
    this.logger.info('admin_audit', { action: entry.action });
  }
}

export function expireAdminAudit(db: DatabaseSync, olderThan: number): number {
  return Number(db.prepare('DELETE FROM admin_audit WHERE ts < ?').run(olderThan).changes);
}
```

- [x] **Step 7: 实现 `static.ts`**

```ts
import { lstat, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';

export const STATIC_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(text);
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, urlPath: string): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return plain(res, 400, '地址不正确。');
  }
  if (decoded.includes('\0')) return plain(res, 400, '地址不正确。');
  const base = resolve(root);
  let rel = normalize(decoded).replace(/^[/\\]+/, '');
  // Client-side routes have no extension: hand them the SPA shell.
  if (rel === '' || extname(rel) === '') rel = 'index.html';
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) return plain(res, 404, '没有这个页面。');
  const type = STATIC_TYPES[extname(abs).toLowerCase()];
  if (!type) return plain(res, 404, '没有这个页面。');
  let info;
  try {
    info = await lstat(abs);
  } catch {
    if (rel === 'index.html') return plain(res, 503, '后台前端还没有构建，请先运行 npm run build -w admin。');
    return plain(res, 404, '没有这个页面。');
  }
  // Untrusted symlinks could point outside the root.
  if (info.isSymbolicLink() || !info.isFile()) return plain(res, 404, '没有这个页面。');
  const body = await readFile(abs);
  const immutable = rel.startsWith(`assets${sep}`) || rel.startsWith('assets/');
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
```

- [x] **Step 8: 实现路由类型与登录路由**

新建 `gateway/src/admin/routes/types.ts`：

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminAudit } from '../audit.ts';
import type { LoginGuard } from '../loginGuard.ts';
import type { AdminDeps } from '../server.ts';
import type { AdminSession, AdminSessionStore } from '../sessions.ts';

export interface AdminServices { sessions: AdminSessionStore; guard: LoginGuard; audit: AdminAudit; now: () => number }

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: readonly string[];
  session: AdminSession | null;
  deps: AdminDeps;
  services: AdminServices;
  body(): Promise<unknown>;
}

export interface AdminRoute {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: RegExp;
  name: string;
  auth: boolean;
  bodyLimit?: number;
  handle(ctx: RouteContext): Promise<void> | void;
}
```

新建 `gateway/src/admin/routes/auth.ts`：

```ts
import type { AdminMe } from '@anyidea/protocol';
import { z } from 'zod';
import { shortHash } from '../../identity/tokens.ts';
import { ADMIN_COOKIE, clearedSessionCookie, readCookie, sessionCookie } from '../cookies.ts';
import { sendError, sendJson, sendNoContent } from '../http.ts';
import { verifyPassword } from '../password.ts';
import { ADMIN_ACTOR } from '../server.ts';
import type { AdminSession } from '../sessions.ts';
import type { AdminRoute, RouteContext } from './types.ts';

const LoginSchema = z.object({ password: z.string().min(1).max(256) }).strict();

function me(ctx: RouteContext, session: AdminSession): AdminMe {
  return { actor: session.actor, csrfToken: session.csrfToken, idleExpiresAt: ctx.services.sessions.idleExpiresAt(session) };
}

async function login(ctx: RouteContext): Promise<void> {
  const { guard, sessions, audit } = ctx.services;
  const source = ctx.req.socket.remoteAddress ?? 'unknown';
  const check = guard.check(source);
  if (!check.allowed) {
    ctx.res.setHeader('Retry-After', String(Math.ceil(check.retryAfterMs / 1000)));
    sendError(ctx.res, 429, 'login_locked', `尝试次数太多，请 ${Math.ceil(check.retryAfterMs / 60_000)} 分钟后再试。`);
    return;
  }
  const parsed = LoginSchema.safeParse(await ctx.body());
  if (!parsed.success) {
    sendError(ctx.res, 400, 'bad_request', '请输入密码。');
    return;
  }
  if (!(await verifyPassword(parsed.data.password, ctx.deps.passwordHash))) {
    guard.fail(source);
    audit.record({ actor: 'anonymous', action: 'login_failed', detail: { source: shortHash(source) } });
    sendError(ctx.res, 401, 'bad_password', '密码不对，请重试。');
    return;
  }
  guard.succeed(source);
  // Never reuse a presented id (session fixation): drop it and issue a fresh one.
  const presented = readCookie(ctx.req.headers.cookie, ADMIN_COOKIE);
  if (presented) sessions.destroy(presented);
  const session = sessions.create(ADMIN_ACTOR);
  ctx.res.setHeader('Set-Cookie', sessionCookie(session.id, ctx.deps.config.session.absoluteMs));
  audit.record({ actor: ADMIN_ACTOR, action: 'login_succeeded', detail: { source: shortHash(source) } });
  sendJson(ctx.res, 200, me(ctx, session));
}

export function authRoutes(): AdminRoute[] {
  return [
    { method: 'POST', path: /^\/admin\/api\/login$/, name: 'login', auth: false, bodyLimit: 1024, handle: login },
    { method: 'GET', path: /^\/admin\/api\/me$/, name: 'me', auth: true, handle: (ctx) => sendJson(ctx.res, 200, me(ctx, ctx.session!)) },
    {
      method: 'POST', path: /^\/admin\/api\/logout$/, name: 'logout', auth: true,
      handle: (ctx) => {
        ctx.services.sessions.destroy(ctx.session!.id);
        ctx.res.setHeader('Set-Cookie', clearedSessionCookie());
        ctx.services.audit.record({ actor: ctx.session!.actor, action: 'logout' });
        sendNoContent(ctx.res);
      },
    },
  ];
}
```

- [x] **Step 9: 实现 `server.ts`**

```ts
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
import { authRoutes } from './routes/auth.ts';
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
    now,
  };
  // Later tasks append their route groups here.
  const routes: readonly AdminRoute[] = [...authRoutes()];
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
```

注意 `routes/auth.ts` 从 `server.ts` 引 `ADMIN_ACTOR`，`server.ts` 又引 `authRoutes`：这是值的循环引用。`ADMIN_ACTOR` 只在请求处理时读取（不在模块初始化时），ESM 下安全；如果 typecheck 或运行报 TDZ 错误，把 `ADMIN_ACTOR` 移到 `gateway/src/admin/actor.ts` 并从 `server.ts` re-export。

- [x] **Step 10: 跑测试确认通过**

Run: `npm test -w gateway -- test/admin-server.test.ts test/admin-static.test.ts test/admin-audit.test.ts`
Expected: PASS（11 + 4 + 3 项）。

- [x] **Step 11: 接线 `index.ts`**

在 `gateway/src/index.ts` 顶部 import 区追加：

```ts
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { expireAdminAudit } from './admin/audit.ts';
import { loadAdminEnv } from './admin/config.ts';
import { createAdminServer } from './admin/server.ts';
```

在 `server.listen(config.port, ...)` 之后追加：

```ts
// Admin console: same process (single DB writer), loopback only. Opt-in via ADMIN_PORT.
const adminEnv = loadAdminEnv(process.env);
let adminServer: Server | null = null;
if (!adminEnv.enabled) {
  logger.info('admin_disabled', { reason: adminEnv.reason });
} else if (!memoryDb || !store || !prices) {
  logger.info('admin_disabled', { reason: 'memory_db_unset' });
} else {
  adminServer = createAdminServer({
    db: memoryDb,
    store,
    manager,
    logger,
    levels,
    prices,
    config: adminConfig,
    passwordHash: adminEnv.passwordHash,
    adapterName: config.adapter,
    staticDir: resolve(root, '..', 'admin', 'dist'),
  });
  adminServer.listen(adminEnv.port, '127.0.0.1', () => logger.info('admin_listening', { port: adminEnv.port }));
}
```

在 `shutdown` 里 `server.closeAllConnections();` 之后追加：

```ts
  adminServer?.close();
  adminServer?.closeAllConnections();
```

在 `runCleanup` 函数体里（`expireTranscripts` 那行之后）追加：

```ts
    if (memoryDb) {
      try {
        const deleted = expireAdminAudit(memoryDb, Date.now() - adminConfig.retention.auditDays * DAY_MS);
        if (deleted > 0) logger.info('admin_audit_retention', { deleted });
      } catch {
        logger.error('admin_audit_retention_failed', {});
      }
    }
```

`DAY_MS` 在 `index.ts` 里是在 `runCleanup` 之前声明的 `const`，`runCleanup` 首次执行发生在声明之后，可以直接用。

- [x] **Step 12: 手动冒烟（Mock，后台开启）**

```bash
cd gateway
HASH=$(printf 'correct horse battery staple' | npm run -s admin:hash-password)
MEMORY_DB_PATH=/tmp/avatar-admin-smoke/memory.db ADMIN_PORT=8788 ADMIN_PASSWORD_HASH="$HASH" ADAPTER=mock APP_SECRET=dev-secret-0123456789 PORT=8797 \
  node --import tsx src/index.ts > /tmp/avatar-admin-smoke.log 2>&1 &
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/admin/api/me            # expect 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/                         # expect 503 before P2-T6 build
grep -c '"event":"admin_listening"' /tmp/avatar-admin-smoke.log                          # expect 1
kill %1
```

Expected：`401`、`503`、`1`。另外确认 `lsof -nP -iTCP:8788 -sTCP:LISTEN` 显示的是 `127.0.0.1:8788`，不是 `*:8788`（kill 之前执行）。冒烟用的数据库在 `/tmp`，跑完 `rm -rf /tmp/avatar-admin-smoke /tmp/avatar-admin-smoke.log`。

- [x] **Step 13: 全量回归**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部通过。

- [x] **Step 14: Commit**

```bash
git add gateway/src/admin/http.ts gateway/src/admin/static.ts gateway/src/admin/audit.ts gateway/src/admin/routes/types.ts \
  gateway/src/admin/routes/auth.ts gateway/src/admin/server.ts gateway/src/index.ts gateway/test/support/admin.ts \
  gateway/test/admin-server.test.ts gateway/test/admin-static.test.ts gateway/test/admin-audit.test.ts
git commit -m "feat(admin): serve the admin api and static files on a loopback port

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
