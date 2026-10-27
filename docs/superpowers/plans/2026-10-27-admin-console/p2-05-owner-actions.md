# P2-T5: 封禁、解封、删除用户，`owner_banned`，临时日志级别

**目标：** 后台可以封禁 / 解封 / 删除一个用户（按 `oid`），封禁立即结束他进行中的会话，之后 `POST /session` 返回 403 `owner_banned`；删除连带删除用量和日志；管理员可以全局或按用户临时调高日志级别（30 分钟自动恢复）。所有动作写审计。

**实现的 spec 章节：** Q15 第 4 项；Q26（临时 debug）；Q32（封禁行为）；Q35（删除连带删除用量和日志，审计保留）；「App 与 protocol 改动」网关侧的 403；总览 C8。

**前置：** P2-T3、P2-T4 完成（`AdminQueries.ownerIdFor`、`bootAdmin`、`adminFixtures`）。计划 1 已把 `gateway/src/server/server.ts` 改成注入式 logger（P1-T6）。

**Files:**
- Modify: `gateway/src/memory/store.ts`（`isOwnerBanned`、`setOwnerBanned`）
- Create: `gateway/src/admin/ownerActions.ts`（`purgeOwnerLogs`、`scheduleLogPurge`）
- Create: `gateway/src/admin/routes/owners.ts`
- Create: `gateway/src/admin/routes/logLevel.ts`
- Modify: `gateway/src/admin/server.ts`（挂上两组路由）
- Modify: `gateway/src/server/server.ts`（`ownerBanned` 选项与 403）
- Modify: `gateway/src/index.ts`（传 `ownerBanned`）
- Modify: `gateway/src/session/session.ts`（`notifyEnd`）
- Modify: `gateway/src/session/manager.ts`（`endOwner` 可选通知参数）
- Test: `gateway/test/admin-owner-actions.test.ts`、`gateway/test/admin-log-level.test.ts`（新建）；`gateway/test/identity-http.test.ts`（追加 1 项）；`gateway/test/store-ban.test.ts`（新建）；`gateway/test/manager.test.ts`、`gateway/test/session.test.ts`（各追加 1 项）

**Interfaces:**
- Consumes：`AdminRoute`、`RouteContext`、`sendJson`、`sendError`、`sendNoContent`、`ADMIN_ACTOR`（P2-T3）；`AdminQueries.ownerIdFor`（P2-T4）；`LogLevelControl`（C2）；`SessionManager.endOwner(ownerId, reason): number`（现有，结束会话并断开 socket）；`MemoryStore.deleteOwner`、`immediate`（现有）；`SqliteUsageRecorder`（C3，只在测试里用）；`AdminLogLevelState`、`AdminLogLevelRequest`、`AdminDeleteOwnerRequest`（P2-T1）。
- Produces：
  ```ts
  // gateway/src/memory/store.ts (MemoryStore + SqliteMemoryStore)
  isOwnerBanned(ownerId: string): boolean;
  setOwnerBanned(ownerId: string, bannedAt: number | null): boolean; // false = no such owner; keeps the first ban time

  // gateway/src/admin/ownerActions.ts
  export function purgeOwnerLogs(db: DatabaseSync, oid: string): number;
  export function scheduleLogPurge(db: DatabaseSync, oid: string, delayMs: number, logger: Logger): NodeJS.Timeout;

  // gateway/src/admin/routes/owners.ts, logLevel.ts
  export function ownerRoutes(): AdminRoute[];
  export function logLevelRoutes(): AdminRoute[];

  // gateway/src/server/server.ts — GatewayServerOptions
  ownerBanned?: (ownerId: string) => boolean;

  // gateway/src/session/session.ts — Session
  notifyEnd(code: string): void; // sends { type: 'error', code, retryable: false } if a transport is attached

  // gateway/src/session/manager.ts — SessionManager (existing method, new optional 3rd parameter)
  endOwner(ownerId: string, reason: string, notice?: { code: string; closeDelayMs: number }): number;
  ```
- HTTP：

| 方法与路径 | 请求体 | 成功 | 失败 |
|---|---|---|---|
| `POST /admin/api/owners/:oid/ban` | 无 | 204 | 404 `not_found` |
| `POST /admin/api/owners/:oid/unban` | 无 | 204 | 404 |
| `DELETE /admin/api/owners/:oid` | `{ "confirm": "<oid>" }` | 204 | 400 `confirm_mismatch`、404 |
| `GET /admin/api/log-level` | — | 200 `AdminLogLevelState` | — |
| `POST /admin/api/log-level` | `AdminLogLevelRequest` | 200 `AdminLogLevelState` | 400、404（未知 oid） |
| `POST /session`（App 端口） | — | — | 403 `{ "error": "owner_banned" }` |

## 设计说明

- **封禁顺序**：先写 `banned_at`，再 `manager.endOwner(ownerId, 'owner_banned', { code: 'owner_banned', closeDelayMs: config.banCloseDelayMs })`。这样即使 App 在两步之间重连，`POST /session` 也已经能看到封禁。
- **先通知再断开**：`endOwner` 带 `notice` 时，对每个会话先调 `session.notifyEnd('owner_banned')`，经 WS 发出现有的错误消息形状 `{ "type": "error", "code": "owner_banned", "retryable": false }`（`protocol/src/index.ts:53` 的 `ServerMessage` 分支），然后照旧 flush、记录结束（`end_reason=owner_banned`，总览 C4）、销毁会话，最后在 `closeDelayMs` 毫秒后才调用 `terminate()`（定时器 `unref`）。`ws.terminate()` 会直接销毁 socket，立即调用可能让刚写出的错误消息丢失，所以要等一小段时间。不带 `notice`（删除用户、新会话顶替）时行为和现在完全一样。App 万一没收到这条消息，重连时还会拿到 403（P4-T2 两条路径都处理）。
- **封禁只挡新会话**：记忆路由（`GET/DELETE /memory`）不挡，用户仍能查看和删除自己的数据（合规上「删除」是用户权利）。已知限制：身份是匿名设备，卸载重装会得到新 owner，封禁可以被绕过；这在 spec 的 Q10 限制范围内，不在本任务解决。
- **封禁检查放在 `resolve` 之后**：`resolve` 会 `touchDevice`（更新最后活跃）并 `ensureAgent`，被封用户的「最后活跃」因此会更新到最近一次被拒的时间。可以接受：它如实反映这台设备还在尝试使用。
- **删除**：要求请求体 `confirm` 等于路径里的 `oid`（服务端也校验，不只靠前端）。顺序：`endOwner(..., 'owner_deleted')` → 同一事务里 `store.deleteOwner`（外键级联删除 devices、agents、sessions、记忆、`usage_events`）+ `purgeOwnerLogs` → 审计。日志 sink 是批量写的，删除前已缓冲、删除后才落库的行会带着这个 oid 回来，所以再安排一次延迟清理：`logSink.flushMs × 2 + 100` 毫秒后再删一遍（定时器 `unref`）。审计行保留，只含 oid。
- **用量缓冲**：同理，删除前缓冲在 `SqliteUsageRecorder` 里、引用这个 owner 的行，落库时会违反外键。本任务用一个测试钉住要求：**这些行被丢弃，同一批里其他 owner 的行照常写入，`flush()` 不抛出**。如果这个测试在 P1-T9 的实现上失败，这是 C3 层面的问题，按全局约束停下报告，不要在后台这边绕过。
- **日志级别**：`scope=global` 不能带 `oid`；`scope=owner` 必须带存在的 `oid`。`level='reset'` 清除该范围的覆盖，否则设置覆盖，`until = now + logLevelOverrideMs`。返回的 `global` 取 `levels.levelFor(undefined)`（此刻对没有 owner 覆盖的日志生效的级别）。

## Steps

- [ ] **Step 1: 写失败的 store 测试**

新建 `gateway/test/store-ban.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';

describe('owner ban flag', () => {
  it('sets, keeps the first time, clears, and reports missing owners', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    const store = new SqliteMemoryStore(db);
    const { ownerId } = store.createOwner({ tokenHash: 'h'.repeat(64), now: 1 });
    expect(store.isOwnerBanned(ownerId)).toBe(false);
    expect(store.setOwnerBanned(ownerId, 100)).toBe(true);
    expect(store.isOwnerBanned(ownerId)).toBe(true);
    expect(store.setOwnerBanned(ownerId, 200)).toBe(true);
    expect((db.prepare('SELECT banned_at FROM owners WHERE id = ?').get(ownerId) as { banned_at: number }).banned_at).toBe(100);
    expect(store.setOwnerBanned(ownerId, null)).toBe(true);
    expect(store.isOwnerBanned(ownerId)).toBe(false);
    expect(store.setOwnerBanned('00000000-0000-4000-8000-000000000000', 1)).toBe(false);
    expect(store.isOwnerBanned('00000000-0000-4000-8000-000000000000')).toBe(false);
  });
});
```

- [ ] **Step 2: 写失败的 App 端口测试**

在 `gateway/test/identity-http.test.ts` 的 `boot()` 中，给 `createGatewayServer({...})` 的参数追加一行（保持其他参数不变）：

```ts
    ownerBanned: identityOn ? (ownerId: string) => store.isOwnerBanned(ownerId) : undefined,
```

在文件末尾追加：

```ts
describe('banned owners', () => {
  it('get 403 owner_banned on POST /session until unbanned', async () => {
    const { base, store } = await boot();
    const token = await register(base);
    expect((await call(base, 'POST', '/session', { bearer: token })).status).toBe(200);
    const ownerId = store.findDevice(hashToken(token))!.ownerId;
    store.setOwnerBanned(ownerId, Date.now());
    expect(await call(base, 'POST', '/session', { bearer: token })).toEqual({ status: 403, json: { error: 'owner_banned' } });
    store.setOwnerBanned(ownerId, null);
    expect((await call(base, 'POST', '/session', { bearer: token })).status).toBe(200);
  });

});
```

记忆路由对被封用户不设限，这一点由 Step 7 的实现位置保证（检查只在 `createSession` 里），不额外加测试。

- [ ] **Step 3: 写失败的后台动作测试**

新建 `gateway/test/admin-owner-actions.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleLogPurge } from '../src/admin/ownerActions.ts';
import { createLogLevelControl } from '../src/log/levels.ts';
import { createLogger } from '../src/log/logger.ts';
import { ownerShortId } from '../src/log/ownerId.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqlitePriceBook } from '../src/usage/pricing.ts';
import { SqliteUsageRecorder } from '../src/usage/recorder.ts';
import { AGENT_A, OWNER_A, OWNER_B, T, insertLog, seedStandard } from './support/adminFixtures.ts';
import { bootAdmin, type AdminHarness } from './support/admin.ts';

const OA = ownerShortId(OWNER_A);
const OB = ownerShortId(OWNER_B);
let h: AdminHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  vi.restoreAllMocks();
});

async function seeded() {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  seedStandard(db);
  insertLog(db, { ts: T - 10_000, level: 'info', event: 'session_created', oid: OA });
  insertLog(db, { ts: T - 10_000, level: 'info', event: 'session_created', oid: OB });
  h = await bootAdmin({ db, now: () => T });
  return { h, auth: await h.login() };
}

const audit = (harness: AdminHarness) =>
  harness.db.prepare("SELECT action, target, detail FROM admin_audit WHERE action <> 'login_succeeded' ORDER BY id").all() as Array<{ action: string; target: string | null; detail: string }>;

describe('ban and unban', () => {
  it('bans, ends live sessions, and unbans', async () => {
    const { h, auth } = await seeded();
    const endOwner = vi.spyOn(h.manager, 'endOwner');
    expect((await h.api(`/admin/api/owners/${OA}/ban`, { method: 'POST', auth })).status).toBe(204);
    expect(h.store.isOwnerBanned(OWNER_A)).toBe(true);
    expect(endOwner).toHaveBeenCalledWith(OWNER_A, 'owner_banned', { code: 'owner_banned', closeDelayMs: 250 });
    const listed = (await (await h.api('/admin/api/owners', { auth })).json()) as { items: Array<{ oid: string; banned: boolean }> };
    expect(listed.items.find((o) => o.oid === OA)?.banned).toBe(true);
    expect((await h.api(`/admin/api/owners/${OA}/unban`, { method: 'POST', auth })).status).toBe(204);
    expect(h.store.isOwnerBanned(OWNER_A)).toBe(false);
    expect(audit(h)).toEqual([
      { action: 'owner_banned', target: OA, detail: '{"sessionsEnded":0}' },
      { action: 'owner_unbanned', target: OA, detail: '{}' },
    ]);
  });

  it('404s for an unknown oid and requires csrf', async () => {
    const { h, auth } = await seeded();
    expect((await h.api('/admin/api/owners/000000000000/ban', { method: 'POST', auth })).status).toBe(404);
    expect((await h.api(`/admin/api/owners/${OA}/ban`, { method: 'POST', headers: { cookie: auth.cookie } })).status).toBe(403);
    expect(h.store.isOwnerBanned(OWNER_A)).toBe(false);
  });
});

describe('delete', () => {
  it('requires the oid as confirmation', async () => {
    const { h, auth } = await seeded();
    for (const body of [undefined, {}, { confirm: OB }, { confirm: `${OA} ` }]) {
      const res = await h.api(`/admin/api/owners/${OA}`, { method: 'DELETE', auth, ...(body ? { body } : {}) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('请输入要删除的用户编号来确认。');
    }
    expect(h.store.getOwner(OWNER_A)).toBeDefined();
  });

  it('deletes the owner with usage and logs, keeps the audit row', async () => {
    const { h, auth } = await seeded();
    const endOwner = vi.spyOn(h.manager, 'endOwner');
    expect((await h.api(`/admin/api/owners/${OA}`, { method: 'DELETE', auth, body: { confirm: OA } })).status).toBe(204);
    expect(endOwner).toHaveBeenCalledWith(OWNER_A, 'owner_deleted');
    expect(h.store.getOwner(OWNER_A)).toBeUndefined();
    const count = (sql: string, ...args: string[]) => (h.db.prepare(sql).get(...args) as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM usage_events WHERE owner_id = ?', OWNER_A)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM usage_events WHERE owner_id = ?', OWNER_B)).toBeGreaterThan(0);
    expect(count('SELECT COUNT(*) AS n FROM log_events WHERE oid = ?', OA)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM log_events WHERE oid = ?', OB)).toBe(1);
    expect(audit(h)).toEqual([{ action: 'owner_deleted', target: OA, detail: '{"sessionsEnded":0}' }]);
    expect((await h.api(`/admin/api/owners/${OA}`, { auth })).status).toBe(404);
  });

  it('purges log lines that land after the delete', async () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    const logger = createLogger({ sinks: [], levels: createLogLevelControl('info'), strict: true });
    scheduleLogPurge(db, OA, 10, logger);
    insertLog(db, { ts: 1, level: 'info', event: 'session_destroyed', oid: OA });
    await new Promise((r) => setTimeout(r, 30));
    expect((db.prepare('SELECT COUNT(*) AS n FROM log_events').get() as { n: number }).n).toBe(0);
  });

  it('a buffered usage row of the deleted owner does not break the recorder', async () => {
    const { h, auth } = await seeded();
    const recorder = new SqliteUsageRecorder({ db: h.db, prices: new SqlitePriceBook(h.db, []), logger: h.logger, flushMs: 60_000, maxBatch: 100 });
    const base = { kind: 'memory_extract' as const, adapter: 'text' as const, model: 'qwen-plus', usage: { inputTokens: 1, outputTokens: 1 } };
    recorder.record({ ...base, attribution: { ownerId: OWNER_A, agentId: AGENT_A, sessionId: null, characterId: null }, ts: T });
    recorder.record({ ...base, attribution: { ownerId: OWNER_B, agentId: null, sessionId: null, characterId: null }, ts: T + 1 });
    expect((await h.api(`/admin/api/owners/${OA}`, { method: 'DELETE', auth, body: { confirm: OA } })).status).toBe(204);
    expect(() => recorder.flush()).not.toThrow();
    const rows = h.db.prepare('SELECT owner_id FROM usage_events WHERE ts >= ?').all(T) as Array<{ owner_id: string }>;
    expect(rows.map((r) => r.owner_id)).toEqual([OWNER_B]);
    recorder.close();
  });
});
```

- [ ] **Step 4: 写失败的日志级别测试**

新建 `gateway/test/admin-log-level.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { ownerShortId } from '../src/log/ownerId.ts';
import { openDatabase } from '../src/memory/db.ts';
import { OWNER_A, T, seedStandard } from './support/adminFixtures.ts';
import { bootAdmin, type AdminHarness } from './support/admin.ts';

const OA = ownerShortId(OWNER_A);
let h: AdminHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function seeded() {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  seedStandard(db);
  h = await bootAdmin({ db, now: () => T });
  return { h, auth: await h.login() };
}

describe('log level', () => {
  it('starts at the base level with no overrides', async () => {
    const { h, auth } = await seeded();
    expect(await (await h.api('/admin/api/log-level', { auth })).json()).toEqual({ global: 'info', overrides: [] });
  });

  it('turns on debug for one owner for the configured time, then resets', async () => {
    const { h, auth } = await seeded();
    const res = await h.api('/admin/api/log-level', { method: 'POST', auth, body: { scope: 'owner', oid: OA, level: 'debug' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      global: 'info',
      overrides: [{ scope: 'owner', oid: OA, level: 'debug', until: T + h.config.logLevelOverrideMs }],
    });
    expect(h.levels.levelFor(OA)).toBe('debug');
    expect(h.levels.levelFor(undefined)).toBe('info');
    const reset = await h.api('/admin/api/log-level', { method: 'POST', auth, body: { scope: 'owner', oid: OA, level: 'reset' } });
    expect(((await reset.json()) as { overrides: unknown[] }).overrides).toEqual([]);
    const rows = h.db.prepare("SELECT target, detail FROM admin_audit WHERE action = 'log_level_changed' ORDER BY id").all() as Array<{ target: string; detail: string }>;
    expect(rows.map((r) => [r.target, JSON.parse(r.detail)])).toEqual([
      [OA, { scope: 'owner', level: 'debug', minutes: h.config.logLevelOverrideMs / 60_000 }],
      [OA, { scope: 'owner', level: 'reset', minutes: 0 }],
    ]);
  });

  it('changes the global level', async () => {
    const { h, auth } = await seeded();
    const body = (await (await h.api('/admin/api/log-level', { method: 'POST', auth, body: { scope: 'global', level: 'debug' } })).json()) as { global: string };
    expect(body.global).toBe('debug');
    expect(h.levels.levelFor(undefined)).toBe('debug');
  });

  it('validates scope and oid', async () => {
    const { h, auth } = await seeded();
    const post = (body: unknown) => h.api('/admin/api/log-level', { method: 'POST', auth, body });
    expect((await post({ scope: 'owner', level: 'debug' })).status).toBe(400);
    expect((await post({ scope: 'global', oid: OA, level: 'debug' })).status).toBe(400);
    expect((await post({ scope: 'owner', oid: OA, level: 'trace' })).status).toBe(400);
    expect((await post({ scope: 'owner', oid: '000000000000', level: 'debug' })).status).toBe(404);
  });
});
```

- [ ] **Step 4b: 写失败的封禁通知测试**

在 `gateway/test/manager.test.ts` 里：`fakeSession()` 返回的对象加一项 `notifyEnd: vi.fn(),`；`describe('SessionManager', ...)` 中 `'endOwner ends every session of that owner and returns the count'` 之后追加：

```ts
  it('endOwner with a notice tells the client first and drops the socket after the delay', async () => {
    const { manager: m, made, events } = setup();
    const t = m.create(owned('o1'));
    const claim = m.claim(t.connectToken)!;
    const terminate = vi.fn();
    expect(m.attachSocket(t.sessionId, claim.connId, terminate)).toBe(true);
    expect(await m.begin(t.sessionId, claim.connId, 'start', transport)).toBe(true);
    expect(m.endOwner('o1', 'owner_banned', { code: 'owner_banned', closeDelayMs: 250 })).toBe(1);
    const session = made[0]!;
    expect(session.notifyEnd).toHaveBeenCalledWith('owner_banned');
    expect(session.notifyEnd.mock.invocationCallOrder[0]).toBeLessThan(session.flush.mock.invocationCallOrder[0]!);
    expect(events).toContain('ended:o1:owner_banned');
    expect(terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250); // this file already runs on fake timers (beforeEach)
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('endOwner without a notice terminates at once and sends nothing', async () => {
    const { manager: m, made } = setup();
    const t = m.create(owned('o1'));
    const claim = m.claim(t.connectToken)!;
    const terminate = vi.fn();
    m.attachSocket(t.sessionId, claim.connId, terminate);
    await m.begin(t.sessionId, claim.connId, 'start', transport);
    m.endOwner('o1', 'owner_deleted');
    expect(made[0]!.notifyEnd).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledOnce();
  });
```

在 `gateway/test/session.test.ts` 的 `describe('Session context', ...)` 末尾追加：

```ts
  it('notifyEnd sends a non-retryable error to the attached client', () => {
    const { session, sent, transport } = setup();
    session.notifyEnd('owner_banned'); // no transport yet: nothing to send, no throw
    session.attachTransport(transport);
    session.notifyEnd('owner_banned');
    expect(sent).toContainEqual({ type: 'error', code: 'owner_banned', retryable: false });
    session.end();
  });
```

- [ ] **Step 5: 跑测试确认失败**

Run: `npm test -w gateway -- test/store-ban.test.ts test/identity-http.test.ts test/admin-owner-actions.test.ts test/admin-log-level.test.ts test/manager.test.ts test/session.test.ts`
Expected: FAIL：`session.notifyEnd is not a function`（session、manager 新增项），`store.isOwnerBanned is not a function`、`Cannot find module '../src/admin/ownerActions.ts'`，`banned owners` 一项失败（403 断言拿到 200）。

- [ ] **Step 6: store 增加封禁方法**

在 `gateway/src/memory/store.ts` 的 `MemoryStore` 接口里，`deleteOwner` 声明之后加：

```ts
  /** Admin ban flag (spec Q32). */
  isOwnerBanned(ownerId: string): boolean;
  /** Sets (keeping the first ban time) or clears banned_at. False when the owner does not exist. */
  setOwnerBanned(ownerId: string, bannedAt: number | null): boolean;
```

在 `prepareStatements` 的 Identity 区（`getOwner` 那行之后）加：

```ts
    ownerBanned: p('SELECT banned_at FROM owners WHERE id = ?'),
    banOwner: p('UPDATE owners SET banned_at = COALESCE(banned_at, ?) WHERE id = ?'),
    unbanOwner: p('UPDATE owners SET banned_at = NULL WHERE id = ?'),
```

在 `SqliteMemoryStore` 的 `deleteOwner` 方法之后加：

```ts
  isOwnerBanned(ownerId: string): boolean {
    const row = this.q.ownerBanned.get(ownerId) as { banned_at: number | null } | undefined;
    return row !== undefined && row.banned_at !== null;
  }

  setOwnerBanned(ownerId: string, bannedAt: number | null): boolean {
    const result = bannedAt === null ? this.q.unbanOwner.run(ownerId) : this.q.banOwner.run(bannedAt, ownerId);
    return Number(result.changes) === 1;
  }
```

- [ ] **Step 7: App 端口返回 403**

在 `gateway/src/server/server.ts` 的 `GatewayServerOptions` 接口末尾加：

```ts
  /** Admin ban check (spec Q32). Absent = no bans (dev mode). */
  ownerBanned?: (ownerId: string) => boolean;
```

在 `createSession` 里 `if (!resolved?.ok) { ... }` 块之后、`// create() flushes the previous owner` 注释之前插入下面这段。P1-T6 在 `server.ts` 里加了 `loggerOf(opts)`（`opts.logger ?? defaultLogger()`），同一函数里的 `session_rejected` 也是这样写的：

```ts
  // Memory routes stay open for a banned owner; only new sessions are refused.
  if (resolved.ctx.ownerId !== undefined && opts.ownerBanned?.(resolved.ctx.ownerId)) {
    loggerOf(opts).info('session_rejected', { reason: 'owner_banned' });
    json(res, 403, { error: 'owner_banned' });
    return;
  }
```

在 `gateway/src/index.ts` 的 `createGatewayServer({...})` 参数里加一行：

```ts
  ...(store ? { ownerBanned: (ownerId: string) => store.isOwnerBanned(ownerId) } : {}),
```

- [ ] **Step 8: 实现 `ownerActions.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../log/logger.ts';

export function purgeOwnerLogs(db: DatabaseSync, oid: string): number {
  return Number(db.prepare('DELETE FROM log_events WHERE oid = ?').run(oid).changes);
}

/** The log sink batches writes: lines buffered before a delete can land after it. Sweep once more. */
export function scheduleLogPurge(db: DatabaseSync, oid: string, delayMs: number, logger: Logger): NodeJS.Timeout {
  const timer = setTimeout(() => {
    try {
      purgeOwnerLogs(db, oid);
    } catch {
      logger.error('admin_owner_log_purge_failed', {});
    }
  }, delayMs);
  timer.unref();
  return timer;
}
```

- [ ] **Step 8b: 会话通知与延迟断开**

在 `gateway/src/session/session.ts` 的 `flush(): void {` 方法之前加：

```ts
  /** Tells the client why the session is ending (e.g. owner_banned) before the socket goes. */
  notifyEnd(code: string): void {
    this.send({ type: 'error', code, retryable: false });
  }
```

在 `gateway/src/session/manager.ts` 把 `endOwner` 整个替换为：

```ts
  /**
   * Ends every session of one owner and drops its socket. Returns how many were ended.
   * With a notice, the client gets an error message first and the socket is dropped after
   * closeDelayMs, because ws.terminate() can discard a message that was just written.
   */
  endOwner(ownerId: string, reason: string, notice?: { code: string; closeDelayMs: number }): number {
    let ended = 0;
    for (const [sessionId, entry] of [...this.sessions]) {
      if (entry.ctx.ownerId !== ownerId) continue;
      const terminate = entry.terminate;
      if (notice) {
        try {
          entry.session.notifyEnd(notice.code);
        } catch {
          // A failed notice must not keep the session alive; the app also gets 403 on reconnect.
        }
      }
      this.flushSession(entry);
      this.destroy(sessionId, reason);
      if (terminate) {
        if (notice && notice.closeDelayMs > 0) setTimeout(terminate, notice.closeDelayMs).unref();
        else terminate(); // the socket's close event then finds no entry and is ignored
      }
      ended++;
    }
    return ended;
  }
```

- [ ] **Step 9: 实现 `routes/owners.ts`**

```ts
import { z } from 'zod';
import { sendError, sendNoContent } from '../http.ts';
import { purgeOwnerLogs, scheduleLogPurge } from '../ownerActions.ts';
import type { AdminRoute, RouteContext } from './types.ts';

const OID_PATH = '([0-9a-f]{12})';
const DeleteSchema = z.object({ confirm: z.string().max(64) }).strict();

/** Resolves the path oid or answers 404. */
function ownerOf(ctx: RouteContext): { oid: string; ownerId: string } | null {
  const oid = ctx.params[0]!;
  const ownerId = ctx.services.queries.ownerIdFor(oid);
  if (ownerId) return { oid, ownerId };
  sendError(ctx.res, 404, 'not_found', '没有找到这个用户。');
  return null;
}

function ban(ctx: RouteContext): void {
  const owner = ownerOf(ctx);
  if (!owner) return;
  // Flag first: a reconnect racing this request already sees the ban.
  ctx.deps.store.setOwnerBanned(owner.ownerId, ctx.services.now());
  const sessionsEnded = ctx.deps.manager.endOwner(owner.ownerId, 'owner_banned', { code: 'owner_banned', closeDelayMs: ctx.deps.config.banCloseDelayMs });
  ctx.services.audit.record({ actor: ctx.session!.actor, action: 'owner_banned', target: owner.oid, detail: { sessionsEnded } });
  sendNoContent(ctx.res);
}

function unban(ctx: RouteContext): void {
  const owner = ownerOf(ctx);
  if (!owner) return;
  ctx.deps.store.setOwnerBanned(owner.ownerId, null);
  ctx.services.audit.record({ actor: ctx.session!.actor, action: 'owner_unbanned', target: owner.oid });
  sendNoContent(ctx.res);
}

async function remove(ctx: RouteContext): Promise<void> {
  const owner = ownerOf(ctx);
  if (!owner) return;
  const body = DeleteSchema.safeParse(await ctx.body());
  if (!body.success || body.data.confirm !== owner.oid) {
    sendError(ctx.res, 400, 'confirm_mismatch', '请输入要删除的用户编号来确认。');
    return;
  }
  const { store, db, manager, logger, config } = ctx.deps;
  // End first so the session end is recorded before the cascade (same order as DELETE /dev/owner).
  const sessionsEnded = manager.endOwner(owner.ownerId, 'owner_deleted');
  let deleted = false;
  store.immediate(() => {
    deleted = store.deleteOwner(owner.ownerId); // cascades devices, agents, sessions, memory, usage_events
    purgeOwnerLogs(db, owner.oid);
  });
  if (!deleted) {
    sendError(ctx.res, 404, 'not_found', '没有找到这个用户。');
    return;
  }
  scheduleLogPurge(db, owner.oid, config.logSink.flushMs * 2 + 100, logger);
  ctx.services.audit.record({ actor: ctx.session!.actor, action: 'owner_deleted', target: owner.oid, detail: { sessionsEnded } });
  sendNoContent(ctx.res);
}

export function ownerRoutes(): AdminRoute[] {
  return [
    { method: 'POST', path: new RegExp(`^/admin/api/owners/${OID_PATH}/ban$`), name: 'owner_ban', auth: true, handle: ban },
    { method: 'POST', path: new RegExp(`^/admin/api/owners/${OID_PATH}/unban$`), name: 'owner_unban', auth: true, handle: unban },
    { method: 'DELETE', path: new RegExp(`^/admin/api/owners/${OID_PATH}$`), name: 'owner_delete', auth: true, bodyLimit: 1024, handle: remove },
  ];
}
```

- [ ] **Step 10: 实现 `routes/logLevel.ts`**

```ts
import type { AdminLogLevelState } from '@anyidea/protocol';
import { z } from 'zod';
import { sendError, sendJson } from '../http.ts';
import type { AdminRoute, RouteContext } from './types.ts';

const Level = z.enum(['debug', 'info', 'warn', 'error']);
const RequestSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global'), level: z.union([Level, z.literal('reset')]) }).strict(),
  z.object({ scope: z.literal('owner'), oid: z.string().regex(/^[0-9a-f]{12}$/), level: z.union([Level, z.literal('reset')]) }).strict(),
]);

function state(ctx: RouteContext): AdminLogLevelState {
  const { levels } = ctx.deps;
  return {
    global: levels.levelFor(undefined),
    overrides: levels.overrides().map((o) => ({ scope: o.scope, oid: o.oid, level: o.level, until: o.until })),
  };
}

async function change(ctx: RouteContext): Promise<void> {
  const parsed = RequestSchema.safeParse(await ctx.body());
  if (!parsed.success) {
    sendError(ctx.res, 400, 'bad_request', '日志级别设置不正确。');
    return;
  }
  const req = parsed.data;
  const oid = req.scope === 'owner' ? req.oid : null;
  if (oid && !ctx.services.queries.ownerIdFor(oid)) {
    sendError(ctx.res, 404, 'not_found', '没有找到这个用户。');
    return;
  }
  const { levels, config } = ctx.deps;
  if (req.level === 'reset') {
    levels.clearOverride(req.scope, oid);
  } else {
    levels.setOverride({ scope: req.scope, oid, level: req.level, until: ctx.services.now() + config.logLevelOverrideMs, actor: ctx.session!.actor });
  }
  const minutes = req.level === 'reset' ? 0 : config.logLevelOverrideMs / 60_000;
  ctx.services.audit.record({ actor: ctx.session!.actor, action: 'log_level_changed', target: oid, detail: { scope: req.scope, level: req.level, minutes } });
  sendJson(ctx.res, 200, state(ctx));
}

export function logLevelRoutes(): AdminRoute[] {
  return [
    { method: 'GET', path: /^\/admin\/api\/log-level$/, name: 'log_level', auth: true, handle: (ctx) => sendJson(ctx.res, 200, state(ctx)) },
    { method: 'POST', path: /^\/admin\/api\/log-level$/, name: 'log_level_change', auth: true, bodyLimit: 1024, handle: change },
  ];
}
```

- [ ] **Step 11: 挂路由**

`gateway/src/admin/server.ts`：import `ownerRoutes`（`./routes/owners.ts`）和 `logLevelRoutes`（`./routes/logLevel.ts`），`routes` 改为：

```ts
  const routes: readonly AdminRoute[] = [...authRoutes(), ...readRoutes(), ...ownerRoutes(), ...logLevelRoutes()];
```

- [ ] **Step 12: 跑测试确认通过**

Run: `npm test -w gateway -- test/store-ban.test.ts test/identity-http.test.ts test/admin-owner-actions.test.ts test/admin-log-level.test.ts test/manager.test.ts test/session.test.ts`
Expected: PASS。`a buffered usage row of the deleted owner does not break the recorder` 若失败，停下报告（见设计说明「用量缓冲」），其余项必须通过。

- [ ] **Step 13: 手动冒烟（Mock + 后台）**

按 P2-T3 Step 12 的方式启动网关（Mock、`ADMIN_PORT=8788`、临时 `MEMORY_DB_PATH`）。然后：

```bash
APP=http://127.0.0.1:8797; ADMIN=http://127.0.0.1:8788; S=dev-secret-0123456789
TOKEN=$(curl -s -X POST $APP/device/register -H "x-app-secret: $S" -H 'content-type: application/json' -d '{"clientInfo":{"platform":"cli"}}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).deviceToken')
curl -s -o /dev/null -w '%{http_code}\n' -X POST $APP/session -H "x-app-secret: $S" -H "authorization: Bearer $TOKEN"        # 200
LOGIN=$(curl -s -i -X POST $ADMIN/admin/api/login -H 'content-type: application/json' -d '{"password":"correct horse battery staple"}')
COOKIE=$(printf '%s' "$LOGIN" | grep -i '^set-cookie' | sed -E 's/^[^:]+: ([^;]+);.*/\1/')
CSRF=$(printf '%s' "$LOGIN" | tail -1 | node -pe 'JSON.parse(require("fs").readFileSync(0)).csrfToken')
OID=$(curl -s $ADMIN/admin/api/owners -H "cookie: $COOKIE" | node -pe 'JSON.parse(require("fs").readFileSync(0)).items[0].oid')
curl -s -o /dev/null -w '%{http_code}\n' -X POST $ADMIN/admin/api/owners/$OID/ban -H "cookie: $COOKIE" -H "x-csrf-token: $CSRF"   # 204
curl -s -X POST $APP/session -H "x-app-secret: $S" -H "authorization: Bearer $TOKEN"; echo                                       # {"error":"owner_banned"}
```

Expected：`200`、`204`、`{"error":"owner_banned"}`；网关 stdout 有 `"event":"session_rejected"` 且 `"reason":"owner_banned"`，没有任何 token 或密码。跑完停进程、删除临时库。

- [ ] **Step 14: 全量回归**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部通过。

- [ ] **Step 15: Commit**

```bash
git add gateway/src/memory/store.ts gateway/src/admin/ownerActions.ts gateway/src/admin/routes/owners.ts gateway/src/admin/routes/logLevel.ts \
  gateway/src/admin/server.ts gateway/src/server/server.ts gateway/src/index.ts gateway/src/session/session.ts gateway/src/session/manager.ts \
  gateway/test/store-ban.test.ts gateway/test/identity-http.test.ts gateway/test/admin-owner-actions.test.ts gateway/test/admin-log-level.test.ts \
  gateway/test/manager.test.ts gateway/test/session.test.ts
git commit -m "feat(admin): ban, unban and delete owners, and temporary log levels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
