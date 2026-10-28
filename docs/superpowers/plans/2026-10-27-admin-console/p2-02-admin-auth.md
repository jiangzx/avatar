# P2-T2: 后台鉴权组件（会话存储、登录限流锁定、Cookie、CSRF）

**目标：** 实现后台鉴权需要的三个纯组件：内存里的后台会话存储（空闲与绝对过期、CSRF token）、按来源地址的登录失败计数与锁定、`admin_sid` Cookie 的读写。本任务不接 HTTP，HTTP 接线在 P2-T3。

**实现的 spec 章节：** 决策 Q6；「后台 HTTP API」中的鉴权段；「安全复核卡」鉴权与会话一行。

**前置：** P2-T1 完成（`AdminConfig` 的 `session`、`login` 字段）。

**Files:**
- Create: `gateway/src/admin/sessions.ts`
- Create: `gateway/src/admin/loginGuard.ts`
- Create: `gateway/src/admin/cookies.ts`
- Test: `gateway/test/admin-auth.test.ts`（新建）

**Interfaces:**
- Consumes：`safeEqual(a, b)`（`gateway/src/session/tokens.ts`）；`AdminConfig['session']`、`AdminConfig['login']`（P2-T1）。
- Produces：
  ```ts
  // gateway/src/admin/sessions.ts
  export interface AdminSession { id: string; actor: string; csrfToken: string; createdAt: number; lastSeenAt: number }
  export class AdminSessionStore {
    constructor(opts: { idleMs: number; absoluteMs: number; now?: () => number });
    create(actor: string): AdminSession;            // fresh random id every time (no fixation)
    get(id: string): AdminSession | null;           // null when unknown/expired; touches lastSeenAt
    destroy(id: string): void;
    idleExpiresAt(session: AdminSession): number;   // min(lastSeenAt + idleMs, createdAt + absoluteMs)
    get size(): number;
  }
  export function csrfMatches(session: AdminSession, header: string | string[] | undefined): boolean;
  export const SESSION_ID_PATTERN: RegExp;          // /^[A-Za-z0-9_-]{43}$/

  // gateway/src/admin/loginGuard.ts
  export type LoginCheck = { allowed: true } | { allowed: false; retryAfterMs: number };
  export class LoginGuard {
    constructor(opts: { maxFailures: number; windowMs: number; lockMs: number; now?: () => number });
    check(source: string): LoginCheck;
    fail(source: string): void;
    succeed(source: string): void;
    get size(): number;
  }

  // gateway/src/admin/cookies.ts
  export const ADMIN_COOKIE = 'admin_sid';
  export function readCookie(header: string | undefined, name: string): string | null;
  export function sessionCookie(id: string, maxAgeMs: number): string;
  export function clearedSessionCookie(): string;
  ```

## 设计说明

- **会话只放内存**（spec「数据模型」：进程重启需要重新登录），由 `index.ts` 通过 `createAdminServer` 内部创建并持有，不是模块级状态。
- **按 SHA-256(id) 存**，原始 id 只在 `create()` 返回给调用方写进 Cookie；内存转储里拿不到可用的 Cookie 值。
- **会话 id 和 CSRF token 各 32 字节 `randomBytes`，base64url 编码（43 字符）**。`get()` 先用 `SESSION_ID_PATTERN` 校验格式，再查表。
- **每次登录都发新 id**（`create()` 永远新建），旧 Cookie 的会话由 P2-T3 在登录时 `destroy()`，防止会话固定。
- **CSRF**：token 绑定在会话上，写操作要求 `x-csrf-token` 头与之相等（常量时间比较）。配合 `SameSite=Strict`。
- **登录锁定**：同一来源在 `windowMs` 内失败 `maxFailures` 次，锁定 `lockMs`；锁定期间 `check()` 直接拒绝，**不再校验密码**（也就不耗 scrypt CPU）。成功登录清掉该来源的计数。每 256 次调用清扫一次过期记录，表大小有界。
- 后台只绑 127.0.0.1：经 SSH 隧道或反向代理访问时，来源地址都是 127.0.0.1，锁定实际上是全局的。单管理员下可以接受：最坏情况是被人试错锁住 15 分钟。P2-T3 不信任 `X-Forwarded-For`。

## Steps

- [x] **Step 1: 写失败测试**

新建 `gateway/test/admin-auth.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ADMIN_COOKIE, clearedSessionCookie, readCookie, sessionCookie } from '../src/admin/cookies.ts';
import { LoginGuard } from '../src/admin/loginGuard.ts';
import { AdminSessionStore, SESSION_ID_PATTERN, csrfMatches } from '../src/admin/sessions.ts';

const MIN = 60_000;

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('AdminSessionStore', () => {
  it('creates distinct random ids and csrf tokens', () => {
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 720 * MIN });
    const a = store.create('admin');
    const b = store.create('admin');
    expect(a.id).toMatch(SESSION_ID_PATTERN);
    expect(a.csrfToken).toMatch(SESSION_ID_PATTERN);
    expect(a.id).not.toBe(b.id);
    expect(a.csrfToken).not.toBe(a.id);
    expect(store.size).toBe(2);
  });

  it('expires after idle time and slides on use', () => {
    const c = clock();
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 720 * MIN, now: c.now });
    const s = store.create('admin');
    c.advance(29 * MIN);
    expect(store.get(s.id)?.actor).toBe('admin');
    c.advance(29 * MIN); // 58 min since create, 29 since last use
    expect(store.get(s.id)).not.toBeNull();
    c.advance(31 * MIN);
    expect(store.get(s.id)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('expires at the absolute limit even when used', () => {
    const c = clock();
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 60 * MIN, now: c.now });
    const s = store.create('admin');
    for (let i = 0; i < 3; i++) {
      c.advance(20 * MIN);
      if (i < 2) expect(store.get(s.id)).not.toBeNull();
    }
    expect(store.get(s.id)).toBeNull();
  });

  it('reports the earlier of idle and absolute expiry', () => {
    const c = clock();
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 40 * MIN, now: c.now });
    const s = store.create('admin');
    expect(store.idleExpiresAt(s)).toBe(c.now() + 30 * MIN);
    c.advance(20 * MIN);
    const touched = store.get(s.id)!;
    expect(store.idleExpiresAt(touched)).toBe(1_000_000 + 40 * MIN);
  });

  it('ignores malformed and unknown ids, and destroys', () => {
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 720 * MIN });
    expect(store.get('')).toBeNull();
    expect(store.get('../../etc')).toBeNull();
    expect(store.get('A'.repeat(43))).toBeNull();
    const s = store.create('admin');
    store.destroy(s.id);
    expect(store.get(s.id)).toBeNull();
  });

  it('matches csrf tokens exactly', () => {
    const store = new AdminSessionStore({ idleMs: 30 * MIN, absoluteMs: 720 * MIN });
    const s = store.create('admin');
    expect(csrfMatches(s, s.csrfToken)).toBe(true);
    expect(csrfMatches(s, undefined)).toBe(false);
    expect(csrfMatches(s, '')).toBe(false);
    expect(csrfMatches(s, `${s.csrfToken}x`)).toBe(false);
    expect(csrfMatches(s, [s.csrfToken, s.csrfToken])).toBe(false);
  });
});

describe('LoginGuard', () => {
  it('locks a source after maxFailures within the window', () => {
    const c = clock();
    const guard = new LoginGuard({ maxFailures: 3, windowMs: 15 * MIN, lockMs: 15 * MIN, now: c.now });
    for (let i = 0; i < 3; i++) {
      expect(guard.check('1.1.1.1')).toEqual({ allowed: true });
      guard.fail('1.1.1.1');
    }
    expect(guard.check('1.1.1.1')).toEqual({ allowed: false, retryAfterMs: 15 * MIN });
    expect(guard.check('2.2.2.2')).toEqual({ allowed: true });
    c.advance(10 * MIN);
    expect(guard.check('1.1.1.1')).toEqual({ allowed: false, retryAfterMs: 5 * MIN });
    c.advance(5 * MIN);
    expect(guard.check('1.1.1.1')).toEqual({ allowed: true });
  });

  it('forgets failures older than the window', () => {
    const c = clock();
    const guard = new LoginGuard({ maxFailures: 3, windowMs: 15 * MIN, lockMs: 15 * MIN, now: c.now });
    guard.fail('a');
    guard.fail('a');
    c.advance(16 * MIN);
    guard.fail('a');
    expect(guard.check('a')).toEqual({ allowed: true });
  });

  it('clears the count on success', () => {
    const guard = new LoginGuard({ maxFailures: 2, windowMs: 15 * MIN, lockMs: 15 * MIN });
    guard.fail('a');
    guard.succeed('a');
    guard.fail('a');
    expect(guard.check('a')).toEqual({ allowed: true });
  });

  it('sweeps expired entries so the table stays bounded', () => {
    const c = clock();
    const guard = new LoginGuard({ maxFailures: 5, windowMs: MIN, lockMs: MIN, now: c.now });
    for (let i = 0; i < 300; i++) guard.fail(`src-${i}`);
    c.advance(2 * MIN);
    for (let i = 0; i < 256; i++) guard.check('fresh');
    expect(guard.size).toBeLessThanOrEqual(1);
  });
});

describe('cookies', () => {
  it('reads one cookie among several', () => {
    expect(readCookie('a=1; admin_sid=abc; b=2', ADMIN_COOKIE)).toBe('abc');
    expect(readCookie('admin_sid_x=1', ADMIN_COOKIE)).toBeNull();
    expect(readCookie(undefined, ADMIN_COOKIE)).toBeNull();
    expect(readCookie('admin_sid=', ADMIN_COOKIE)).toBeNull();
  });

  it('writes a strict, http-only, secure session cookie', () => {
    expect(sessionCookie('abc', 43_200_000)).toBe('admin_sid=abc; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200');
    expect(clearedSessionCookie()).toBe('admin_sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test -w gateway -- test/admin-auth.test.ts`
Expected: FAIL，`Cannot find module '../src/admin/cookies.ts'`。

- [x] **Step 3: 实现 `sessions.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto';
import { safeEqual } from '../session/tokens.ts';

export interface AdminSession { id: string; actor: string; csrfToken: string; createdAt: number; lastSeenAt: number }
type Stored = Omit<AdminSession, 'id'>;

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const newSecret = () => randomBytes(32).toString('base64url');
const keyOf = (id: string) => createHash('sha256').update(id).digest('hex');

/** In-memory admin sessions keyed by SHA-256(id). Restart = log in again. */
export class AdminSessionStore {
  private readonly sessions = new Map<string, Stored>();
  private readonly now: () => number;

  constructor(private readonly opts: { idleMs: number; absoluteMs: number; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  create(actor: string): AdminSession {
    this.sweep();
    const id = newSecret();
    const at = this.now();
    const stored: Stored = { actor, csrfToken: newSecret(), createdAt: at, lastSeenAt: at };
    this.sessions.set(keyOf(id), stored);
    return { id, ...stored };
  }

  get(id: string): AdminSession | null {
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const key = keyOf(id);
    const stored = this.sessions.get(key);
    if (!stored) return null;
    const at = this.now();
    if (at >= this.expiry(stored)) {
      this.sessions.delete(key);
      return null;
    }
    stored.lastSeenAt = at;
    return { id, ...stored };
  }

  destroy(id: string): void {
    if (SESSION_ID_PATTERN.test(id)) this.sessions.delete(keyOf(id));
  }

  idleExpiresAt(session: AdminSession): number {
    return this.expiry(session);
  }

  private expiry(s: Pick<Stored, 'createdAt' | 'lastSeenAt'>): number {
    return Math.min(s.lastSeenAt + this.opts.idleMs, s.createdAt + this.opts.absoluteMs);
  }

  private sweep(): void {
    const at = this.now();
    for (const [key, stored] of this.sessions) if (at >= this.expiry(stored)) this.sessions.delete(key);
  }
}

export function csrfMatches(session: AdminSession, header: string | string[] | undefined): boolean {
  return typeof header === 'string' && header.length > 0 && safeEqual(header, session.csrfToken);
}
```

- [x] **Step 4: 实现 `loginGuard.ts`**

```ts
export type LoginCheck = { allowed: true } | { allowed: false; retryAfterMs: number };
interface Entry { failures: number[]; lockedUntil: number }

/** Counts failed logins per source; a locked source is refused before the password is checked. */
export class LoginGuard {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private calls = 0;

  constructor(private readonly opts: { maxFailures: number; windowMs: number; lockMs: number; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  check(source: string): LoginCheck {
    const at = this.now();
    if (++this.calls % 256 === 0) this.sweep(at);
    const entry = this.entries.get(source);
    if (entry && entry.lockedUntil > at) return { allowed: false, retryAfterMs: entry.lockedUntil - at };
    return { allowed: true };
  }

  fail(source: string): void {
    const at = this.now();
    const entry = this.entries.get(source) ?? { failures: [], lockedUntil: 0 };
    entry.failures = entry.failures.filter((t) => t > at - this.opts.windowMs);
    entry.failures.push(at);
    if (entry.failures.length >= this.opts.maxFailures) {
      entry.lockedUntil = at + this.opts.lockMs;
      entry.failures = [];
    }
    this.entries.set(source, entry);
  }

  succeed(source: string): void {
    this.entries.delete(source);
  }

  private sweep(at: number): void {
    for (const [source, entry] of this.entries) {
      const recent = entry.failures.filter((t) => t > at - this.opts.windowMs);
      if (recent.length === 0 && entry.lockedUntil <= at) this.entries.delete(source);
      else entry.failures = recent;
    }
  }
}
```

- [x] **Step 5: 实现 `cookies.ts`**

```ts
export const ADMIN_COOKIE = 'admin_sid';
const ATTRS = 'HttpOnly; Secure; SameSite=Strict; Path=/';

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

export function sessionCookie(id: string, maxAgeMs: number): string {
  return `${ADMIN_COOKIE}=${id}; ${ATTRS}; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export function clearedSessionCookie(): string {
  return `${ADMIN_COOKIE}=; ${ATTRS}; Max-Age=0`;
}
```

- [x] **Step 6: 跑测试确认通过**

Run: `npm test -w gateway -- test/admin-auth.test.ts`
Expected: PASS（12 项）。

Run: `npm run typecheck -w gateway`
Expected: 无错误。

- [x] **Step 7: Commit**

```bash
git add gateway/src/admin/sessions.ts gateway/src/admin/loginGuard.ts gateway/src/admin/cookies.ts gateway/test/admin-auth.test.ts
git commit -m "feat(admin): add admin sessions, login lockout and cookie helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
