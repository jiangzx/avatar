# P2-T4: 只读查询 API（总览、用户、会话、时间线、日志、审计）

**目标：** 在后台服务上提供 7 个只读接口，数据全部来自 SQLite（`owners`、`agents`、`sessions`、`usage_events`、`log_events`、`admin_audit` 及记忆表的计数），形状严格按总览 C6。用户标识对外一律是 `oid`，响应里不出现原始 owner id；默认不含 Mock 数据。

**实现的 spec 章节：** Q15 页面清单的数据部分；Q23、Q31（异常标红的判定）；Q35（Asia/Shanghai 切日）；Q36（默认隐藏 Mock）；「后台 HTTP API」表中的 GET 行。

**前置：** P2-T3 完成（路由表、`bootAdmin` 测试启动器）。计划 1 已写入 `usage_events`、`log_events`、`sessions.adapter/end_reason`。

**Files:**
- Create: `gateway/src/admin/days.ts`
- Create: `gateway/src/admin/queries.ts`
- Create: `gateway/src/admin/routes/read.ts`
- Modify: `gateway/src/admin/audit.ts`（追加 `listAudit`）
- Modify: `gateway/src/admin/routes/types.ts`（`AdminServices` 增加 `queries`）
- Modify: `gateway/src/admin/server.ts`（创建 `AdminQueries`、挂上 `readRoutes()`）
- Create: `gateway/test/support/adminFixtures.ts`（插入测试数据，P2-T5 复用）
- Test: `gateway/test/admin-days.test.ts`、`gateway/test/admin-queries.test.ts`、`gateway/test/admin-read-routes.test.ts`（均新建）

**Interfaces:**
- Consumes：`ownerShortId`（C2）；`percentile`（`gateway/src/eval/logReport.ts`，nearest-rank，与 App 指标同规则）；`AdminConfig['alerts']`（P2-T1）；`AdminRoute`、`RouteContext`、`sendJson`、`sendError`（P2-T3）；C6 类型。
- Produces：
  ```ts
  // gateway/src/admin/days.ts
  export const SHANGHAI_OFFSET_MS = 28_800_000;
  export const DAY_MS = 86_400_000;
  export function shanghaiDay(ts: number): string;          // 'YYYY-MM-DD'
  export function shanghaiDayStart(ts: number): number;
  export interface RangeBounds { from: number; to: number; prevFrom: number; prevTo: number; days: string[] }
  export function rangeBounds(range: AdminRange, now: number): RangeBounds;
  export function sqlShanghaiDay(column: string): string;   // SQL expression

  // gateway/src/admin/queries.ts
  export class AdminQueries {
    constructor(db: DatabaseSync, now?: () => number);
    ownerIdFor(oid: string): string | null;
    overview(range: AdminRange, opts: { includeMock: boolean; adapter: string; alerts: AdminConfig['alerts'] }): AdminOverview;
    owners(opts: { includeMock: boolean; offset: number; limit: number }): AdminPage<AdminOwnerRow>;
    owner(oid: string, includeMock: boolean): AdminOwnerDetail | null;
    sessions(filter: SessionFilter): AdminPage<AdminSessionRow>;
    timeline(sid: string, firstAudioAlertMs: number): AdminTimeline | null; // threshold = admin.json alerts.firstAudioP95Ms
    logs(filter: LogFilter): AdminPage<AdminLogRow>;
  }
  export interface SessionFilter { ownerId: string | null; character: string | null; sid: string | null; from: number; to: number; includeMock: boolean; offset: number; limit: number }
  export interface LogFilter { sid: string | null; oid: string | null; event: string | null; minLevel: 'debug' | 'info' | 'warn' | 'error'; from: number; to: number; cursor: number | null; limit: number }

  // gateway/src/admin/audit.ts (added)
  export function listAudit(db: DatabaseSync, filter: { action: string | null; from: number; to: number; cursor: number | null; limit: number }): AdminPage<AdminAuditRow>;

  // gateway/src/admin/routes/read.ts
  export function readRoutes(): AdminRoute[];
  ```
- HTTP（全部 `auth: true`，GET）：

| 路径 | 查询参数（zod，`strict`） | 返回 |
|---|---|---|
| `/admin/api/overview` | `range=today\|7d\|30d`（默认 today）、`mock=0\|1` | `AdminOverview` |
| `/admin/api/owners` | `mock`、`cursor`（偏移）、`limit` 1–200（默认 50） | `AdminPage<AdminOwnerRow>` |
| `/admin/api/owners/:oid` | `mock` | `AdminOwnerDetail`；未知 404 |
| `/admin/api/sessions` | `mock`、`oid`、`character`、`from`、`to`（毫秒，默认近 30 天）、`cursor`、`limit` | `AdminPage<AdminSessionRow>` |
| `/admin/api/sessions/:sid/timeline` | 无 | `AdminTimeline`（`firstAudioAlertMs` = `alerts.firstAudioP95Ms`）；未知 404 |
| `/admin/api/logs` | `sid`、`oid`、`event`、`level`（最低级别，默认 info）、`from`、`to`（默认近 24 小时）、`cursor`（id）、`limit` 1–500（默认 100） | `AdminPage<AdminLogRow>` |
| `/admin/api/audit` | `action`、`from`、`to`、`cursor`（id）、`limit` | `AdminPage<AdminAuditRow>` |

## 口径（写进代码注释和测试）

- **切日**：固定 UTC+8 偏移。中国自 1991 年起不实行夏令时，固定偏移与 Asia/Shanghai 完全一致；SQLite 没有时区支持，Node 侧也就不依赖 ICU 时区数据。SQL 用 `strftime('%Y-%m-%d', (ts + 28800000) / 1000, 'unixepoch')`。
- **范围**：`today` = 今天 0 点到现在；`7d` / `30d` = 含今天的最近 7 / 30 个自然日。`prev*` 是紧挨着的前一段同样长度（today 对比昨天同一时段），只用于 `deltaMinutesVsPrev`。
- **通话分钟**：按会话**开始时间**归到哪一天、哪个范围；时长 = `min(ended_at 或现在, 范围终点) − started_at`，进行中的会话算到现在。跨午夜的会话整通算在开始那天（POC 规模下误差可以忽略，且总览数字与按天表格能对上）。四舍五入到整分钟。
- **活跃用户**：范围内开始过会话的不同 owner 数。
- **出错**：`kind='realtime_reply'` 且 `error_code` 非空的回复数。
- **token**：`input_tokens + output_tokens`（C1 总数列，null 按 0）。**费用**：`cost_micro_yuan` 求和；`unpricedCalls` = `cost_micro_yuan IS NULL` 的行数。
- **Mock**：`includeMock=false` 时排除 `usage_events.model='mock'` 和 `sessions.adapter='mock'`。
- **首音延迟**：`realtime_reply` 行的 `first_audio_ms`，nearest-rank p50/p95（复用 `percentile`）。没有样本为 null。
- **告警**：只看最近 1 小时。回复数 `< alerts.minSamples` 时不判定。错误率 `> alerts.errorRate1h` → `error_rate_1h`；p95 `> alerts.firstAudioP95Ms` → `first_audio_p95`。`value` 错误率保留 4 位小数。
- **记忆条数**：`profile_facts` + `agent_facts` + `pinned_memories` 的行数，只数不读正文。按角色时只数该 agent 的 `agent_facts` + `pinned_memories`（共享层不属于某个角色）。
- **oid ↔ owner id**：`ownerIdFor` 每次查询 `SELECT id FROM owners` 并计算 `ownerShortId`。owner 数量受 `MAX_OWNERS` 限制，POC 规模下这是毫秒级操作，不缓存（不缓存也就没有失效问题）。
- **SQL 参数**：全部用 `node:sqlite` 的具名参数（`$name`，传对象时键不带前缀）。注意：对象里多传一个 SQL 没用到的键会抛 `Unknown named parameter`；少传的键按 NULL 绑定。所以每个语句只传它用到的键。唯一的动态 SQL 是 `IN (?, ?, …)`，只拼接问号个数，值仍然绑定。
- **分页**：用户和会话按偏移分页（`cursor` 是下一页的偏移，字符串化的整数）；日志和审计按 id 倒序 keyset（`cursor` 是上一页最后一条的 id）。多取一条判断有没有下一页。

## Steps

- [x] **Step 1: 写测试数据辅助**

新建 `gateway/test/support/adminFixtures.ts`：

```ts
import type { DatabaseSync } from 'node:sqlite';

export const T = Date.parse('2026-10-27T12:00:00+08:00');
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const OWNER_A = '11111111-1111-4111-8111-111111111111';
export const OWNER_B = '22222222-2222-4222-8222-222222222222';
export const AGENT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
export const AGENT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
export const S_A1 = '5a100000-0000-4000-8000-000000000001';
export const S_B1 = '5b100000-0000-4000-8000-000000000001';
export const S_B0 = '5b000000-0000-4000-8000-000000000000';
export const S_M = '5e000000-0000-4000-8000-000000000000';

export function insertOwner(db: DatabaseSync, id: string, createdAt: number, lastSeenAt: number, bannedAt: number | null = null): void {
  db.prepare('INSERT INTO owners (id, created_at, last_seen_at, banned_at) VALUES (?, ?, ?, ?)').run(id, createdAt, lastSeenAt, bannedAt);
}

export function insertAgent(db: DatabaseSync, id: string, ownerId: string, character: string, createdAt = 0): void {
  db.prepare('INSERT INTO agents (id, owner_id, character_id, created_at) VALUES (?, ?, ?, ?)').run(id, ownerId, character, createdAt);
}

export function insertSession(db: DatabaseSync, s: { id: string; agentId: string; startedAt: number; endedAt: number | null; adapter: string; endReason?: string | null }): void {
  db.prepare('INSERT INTO sessions (id, agent_id, started_at, ended_at, adapter, end_reason) VALUES (?, ?, ?, ?, ?, ?)')
    .run(s.id, s.agentId, s.startedAt, s.endedAt, s.adapter, s.endReason ?? null);
}

export interface UsageRow {
  ts: number; ownerId: string | null; agentId?: string | null; sessionId?: string | null; characterId?: string | null;
  kind: string; adapter: string; model: string; input: number; output: number;
  cost: number | null; firstAudioMs?: number | null; errorCode?: string | null; estimated?: 0 | 1;
}

export function insertUsage(db: DatabaseSync, u: UsageRow): void {
  db.prepare(`INSERT INTO usage_events (ts, owner_id, agent_id, session_id, character_id, kind, adapter, model,
      input_tokens, output_tokens, first_audio_ms, error_code, estimated, price_id, cost_micro_yuan)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(u.ts, u.ownerId, u.agentId ?? null, u.sessionId ?? null, u.characterId ?? null, u.kind, u.adapter, u.model,
      u.input, u.output, u.firstAudioMs ?? null, u.errorCode ?? null, u.estimated ?? 0, u.cost === null ? null : 'p1', u.cost);
}

export function insertLog(db: DatabaseSync, l: { ts: number; level: string; event: string; sid?: string | null; oid?: string | null; char?: string | null; seq?: number | null; fields?: Record<string, unknown> }): void {
  db.prepare('INSERT INTO log_events (ts, level, event, sid, oid, char, seq, job, fields) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(l.ts, l.level, l.event, l.sid ?? null, l.oid ?? null, l.char ?? null, l.seq ?? null, JSON.stringify(l.fields ?? {}));
}

export function insertMemoryCounts(db: DatabaseSync, ownerId: string, agentId: string, counts: { profile: number; facts: number; pinned: number }): void {
  for (let i = 0; i < counts.profile; i++) {
    db.prepare("INSERT INTO profile_facts (id, owner_id, category, text, confidence, updated_at) VALUES (?, ?, 'profile', 'x', 1, 0)").run(`pf-${ownerId}-${i}`, ownerId);
  }
  for (let i = 0; i < counts.facts; i++) {
    db.prepare("INSERT INTO agent_facts (id, owner_id, agent_id, category, text, confidence, updated_at) VALUES (?, ?, ?, 'other', 'x', 1, 0)").run(`af-${agentId}-${i}`, ownerId, agentId);
  }
  for (let i = 0; i < counts.pinned; i++) {
    db.prepare("INSERT INTO pinned_memories (id, owner_id, agent_id, text, created_at) VALUES (?, ?, ?, 'x', 0)").run(`pm-${agentId}-${i}`, ownerId, agentId);
  }
}

/** Two owners, four sessions (one Mock, one yesterday), six usage rows, three log lines on S_A1. */
export function seedStandard(db: DatabaseSync): void {
  insertOwner(db, OWNER_A, T - 72 * HOUR, T - HOUR);
  insertOwner(db, OWNER_B, T - 48 * HOUR, T - 30 * MIN);
  insertAgent(db, AGENT_A, OWNER_A, 'xiaonuan');
  insertAgent(db, AGENT_B, OWNER_B, 'xiaokai');
  insertSession(db, { id: S_A1, agentId: AGENT_A, startedAt: T - 2 * HOUR, endedAt: T - 2 * HOUR + 10 * MIN, adapter: 'qwen', endReason: 'client_end' });
  insertSession(db, { id: S_B1, agentId: AGENT_B, startedAt: T - HOUR, endedAt: null, adapter: 'qwen' });
  insertSession(db, { id: S_B0, agentId: AGENT_B, startedAt: T - 26 * HOUR, endedAt: T - 26 * HOUR + 20 * MIN, adapter: 'qwen', endReason: 'grace_expired' });
  insertSession(db, { id: S_M, agentId: AGENT_B, startedAt: T - 30 * MIN, endedAt: T - 20 * MIN, adapter: 'mock', endReason: 'client_end' });
  const rt = { kind: 'realtime_reply', adapter: 'qwen', model: 'qwen3.8-omni-flash-realtime' };
  insertUsage(db, { ...rt, ts: T - 2 * HOUR + MIN, ownerId: OWNER_A, agentId: AGENT_A, sessionId: S_A1, characterId: 'xiaonuan', input: 1000, output: 500, cost: 3000, firstAudioMs: 900 });
  insertUsage(db, { ...rt, ts: T - 2 * HOUR + 3 * MIN, ownerId: OWNER_A, agentId: AGENT_A, sessionId: S_A1, characterId: 'xiaonuan', input: 2000, output: 1000, cost: 6000, firstAudioMs: 1100 });
  insertUsage(db, { ...rt, ts: T - 30 * MIN, ownerId: OWNER_B, agentId: AGENT_B, sessionId: S_B1, characterId: 'xiaokai', input: 1000, output: 0, cost: null, errorCode: 'qwen_socket_error' });
  insertUsage(db, { ts: T - HOUR, ownerId: OWNER_A, agentId: AGENT_A, kind: 'memory_extract', adapter: 'text', model: 'qwen-plus', input: 3000, output: 200, cost: 1000 });
  insertUsage(db, { ts: T - 25 * MIN, ownerId: OWNER_B, agentId: AGENT_B, sessionId: S_M, characterId: 'xiaokai', kind: 'realtime_reply', adapter: 'mock', model: 'mock', input: 100, output: 100, cost: null, firstAudioMs: 500, estimated: 1 });
  insertUsage(db, { ...rt, ts: T - 26 * HOUR + MIN, ownerId: OWNER_B, agentId: AGENT_B, sessionId: S_B0, characterId: 'xiaokai', input: 500, output: 500, cost: 2000, firstAudioMs: 1200 });
  insertMemoryCounts(db, OWNER_A, AGENT_A, { profile: 1, facts: 2, pinned: 1 });
  insertLog(db, { ts: T - 2 * HOUR, level: 'info', event: 'session_started', sid: S_A1, char: 'xiaonuan' });
  insertLog(db, { ts: T - 2 * HOUR + MIN, level: 'info', event: 'response_start', sid: S_A1, seq: 1, fields: { kind: 'reply' } });
  insertLog(db, { ts: T - 2 * HOUR + 5 * MIN, level: 'warn', event: 'upstream_error', sid: S_A1, fields: { code: 'rate_limited', attempt: 2 } });
}
```

- [x] **Step 2: 写失败的切日测试**

新建 `gateway/test/admin-days.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { rangeBounds, shanghaiDay, shanghaiDayStart, sqlShanghaiDay } from '../src/admin/days.ts';
import { openDatabase } from '../src/memory/db.ts';

describe('Shanghai days', () => {
  it('cuts days at 00:00 +08:00', () => {
    expect(shanghaiDay(Date.parse('2026-10-27T23:59:59+08:00'))).toBe('2026-10-27');
    expect(shanghaiDay(Date.parse('2026-10-27T16:00:00Z'))).toBe('2026-10-28');
    expect(shanghaiDayStart(Date.parse('2026-10-27T12:00:00+08:00'))).toBe(Date.parse('2026-10-27T00:00:00+08:00'));
  });

  it('builds today / 7d / 30d ranges ending now', () => {
    const now = Date.parse('2026-10-27T12:00:00+08:00');
    const today = rangeBounds('today', now);
    expect(today.from).toBe(Date.parse('2026-10-27T00:00:00+08:00'));
    expect(today.to).toBe(now + 1);
    expect(today.prevFrom).toBe(Date.parse('2026-10-26T00:00:00+08:00'));
    expect(today.prevTo).toBe(now + 1 - 86_400_000);
    expect(today.days).toEqual(['2026-10-27']);
    const week = rangeBounds('7d', now);
    expect(week.from).toBe(Date.parse('2026-10-21T00:00:00+08:00'));
    expect(week.days).toHaveLength(7);
    expect(week.days.at(-1)).toBe('2026-10-27');
    expect(rangeBounds('30d', now).days[0]).toBe('2026-09-28');
  });

  it('matches the SQL expression', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    for (const ts of [Date.parse('2026-10-27T15:59:59Z'), Date.parse('2026-10-27T16:00:00Z'), Date.parse('2026-01-01T00:00:00+08:00')]) {
      const row = db.prepare(`SELECT ${sqlShanghaiDay('$ts')} AS day`).get({ ts }) as { day: string };
      expect(row.day).toBe(shanghaiDay(ts));
    }
  });
});
```

- [x] **Step 3: 写失败的查询测试**

新建 `gateway/test/admin-queries.test.ts`：

```ts
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { listAudit } from '../src/admin/audit.ts';
import { AdminQueries } from '../src/admin/queries.ts';
import { ownerShortId } from '../src/log/ownerId.ts';
import { openDatabase } from '../src/memory/db.ts';
import {
  AGENT_A, HOUR, MIN, OWNER_A, OWNER_B, S_A1, S_B0, S_B1, T, insertAgent, insertOwner, insertSession, insertUsage, seedStandard,
} from './support/adminFixtures.ts';

const ALERTS = { errorRate1h: 0.1, firstAudioP95Ms: 2000, minSamples: 5 };
const OA = ownerShortId(OWNER_A);
const OB = ownerShortId(OWNER_B);
let db: DatabaseSync;
let q: AdminQueries;

beforeEach(() => {
  db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  q = new AdminQueries(db, () => T);
});

const noRawIds = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toContain(OWNER_A);
  expect(text).not.toContain(OWNER_B);
};

describe('overview', () => {
  it('summarizes today without Mock data', () => {
    seedStandard(db);
    const o = q.overview('today', { includeMock: false, adapter: 'qwen', alerts: ALERTS });
    expect(o.brief).toEqual({ owners: 2, callMinutes: 70, costMicroYuan: 10_000, errors: 1, deltaMinutesVsPrev: 50 });
    expect(o.days).toEqual([{ day: '2026-10-27', owners: 2, callMinutes: 70, tokens: 8700, costMicroYuan: 10_000, errors: 1 }]);
    expect(o.byKind).toEqual([
      { kind: 'realtime_reply', costMicroYuan: 9000, share: 0.9 },
      { kind: 'memory_extract', costMicroYuan: 1000, share: 0.1 },
    ]);
    expect(o.latency).toEqual({ firstAudioP50Ms: 900, firstAudioP95Ms: 1100 });
    expect(o.alerts).toEqual([]); // one reply in the last hour < minSamples
    expect(o.adapter).toBe('qwen');
    expect(o.range).toBe('today');
  });

  it('includes Mock rows on request', () => {
    seedStandard(db);
    const o = q.overview('today', { includeMock: true, adapter: 'mock', alerts: ALERTS });
    expect(o.brief.callMinutes).toBe(80);
    expect(o.days[0]!.tokens).toBe(8900);
    expect(o.latency.firstAudioP50Ms).toBe(900);
  });

  it('fills every day of a 7-day range', () => {
    seedStandard(db);
    const o = q.overview('7d', { includeMock: false, adapter: 'qwen', alerts: ALERTS });
    expect(o.days.map((d) => d.day)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
    expect(o.days[5]).toEqual({ day: '2026-10-26', owners: 1, callMinutes: 20, tokens: 1000, costMicroYuan: 2000, errors: 0 });
    expect(o.days[0]).toEqual({ day: '2026-10-21', owners: 0, callMinutes: 0, tokens: 0, costMicroYuan: 0, errors: 0 });
  });

  it('raises error-rate and latency alerts over the last hour', () => {
    insertOwner(db, OWNER_A, 0, T);
    insertAgent(db, AGENT_A, OWNER_A, 'xiaonuan');
    insertSession(db, { id: S_A1, agentId: AGENT_A, startedAt: T - 20 * MIN, endedAt: null, adapter: 'qwen' });
    const fa = [1000, 1000, 1000, 1000, 3000];
    fa.forEach((ms, i) => insertUsage(db, {
      ts: T - (10 - i) * MIN, ownerId: OWNER_A, agentId: AGENT_A, sessionId: S_A1, kind: 'realtime_reply', adapter: 'qwen',
      model: 'qwen3.8-omni-flash-realtime', input: 10, output: 10, cost: 1, firstAudioMs: ms, errorCode: i === 0 ? 'qwen_socket_error' : null,
    }));
    const o = q.overview('today', { includeMock: false, adapter: 'qwen', alerts: ALERTS });
    expect(o.alerts).toEqual([
      { code: 'error_rate_1h', value: 0.2, threshold: 0.1 },
      { code: 'first_audio_p95', value: 3000, threshold: 2000 },
    ]);
  });
});

describe('owners', () => {
  it('lists owners by last activity with oid only', () => {
    seedStandard(db);
    db.prepare('UPDATE owners SET banned_at = ? WHERE id = ?').run(T - MIN, OWNER_B);
    const page = q.owners({ includeMock: false, offset: 0, limit: 50 });
    expect(page.items.map((o) => o.oid)).toEqual([OB, OA]);
    expect(page.items[0]).toEqual({
      oid: OB, createdAt: T - 48 * HOUR, lastSeenAt: T - 30 * MIN, banned: true,
      sessions: 2, memoryItems: 0, usage: { tokens: 2000, costMicroYuan: 2000, unpricedCalls: 1 },
    });
    expect(page.items[1]).toMatchObject({ oid: OA, banned: false, sessions: 1, memoryItems: 4, usage: { tokens: 7700, costMicroYuan: 10_000, unpricedCalls: 0 } });
    expect(page.nextCursor).toBeNull();
    noRawIds(page);
  });

  it('pages by offset', () => {
    seedStandard(db);
    const first = q.owners({ includeMock: false, offset: 0, limit: 1 });
    expect(first.items.map((o) => o.oid)).toEqual([OB]);
    expect(first.nextCursor).toBe('1');
    const second = q.owners({ includeMock: false, offset: 1, limit: 1 });
    expect(second.items.map((o) => o.oid)).toEqual([OA]);
    expect(second.nextCursor).toBeNull();
  });

  it('details one owner per character with 30 days of usage', () => {
    seedStandard(db);
    const detail = q.owner(OA, false)!;
    expect(detail.characters).toEqual([
      { character: 'xiaonuan', sessions: 1, memoryItems: 3, usage: { tokens: 7700, costMicroYuan: 10_000, unpricedCalls: 0 } },
    ]);
    expect(detail.daily).toHaveLength(30);
    expect(detail.daily.at(-1)).toEqual({ day: '2026-10-27', tokens: 7700, costMicroYuan: 10_000 });
    expect(detail.daily[0]).toEqual({ day: '2026-09-28', tokens: 0, costMicroYuan: 0 });
    expect(q.owner('000000000000', false)).toBeNull();
    noRawIds(detail);
  });

  it('maps oid back to the owner id', () => {
    seedStandard(db);
    expect(q.ownerIdFor(OA)).toBe(OWNER_A);
    expect(q.ownerIdFor('ffffffffffff')).toBeNull();
  });
});

describe('sessions', () => {
  const base = { ownerId: null, character: null, sid: null, from: T - 30 * 24 * HOUR, to: T + 1, includeMock: false, offset: 0, limit: 50 };

  it('lists newest first with per-session numbers', () => {
    seedStandard(db);
    const page = q.sessions(base);
    expect(page.items.map((s) => s.sid)).toEqual([S_B1, S_A1, S_B0]);
    expect(page.items[1]).toEqual({
      sid: S_A1, oid: OA, character: 'xiaonuan', adapter: 'qwen', startedAt: T - 2 * HOUR, endedAt: T - 2 * HOUR + 10 * MIN,
      endReason: 'client_end', replies: 2, errors: 0, firstAudioP50Ms: 900, usage: { tokens: 4500, costMicroYuan: 9000, unpricedCalls: 0 },
    });
    expect(page.items[0]).toMatchObject({ replies: 1, errors: 1, firstAudioP50Ms: null, usage: { unpricedCalls: 1 } });
    noRawIds(page);
  });

  it('filters by owner and character', () => {
    seedStandard(db);
    expect(q.sessions({ ...base, ownerId: OWNER_A }).items.map((s) => s.sid)).toEqual([S_A1]);
    expect(q.sessions({ ...base, character: 'xiaokai' }).items.map((s) => s.sid)).toEqual([S_B1, S_B0]);
    expect(q.sessions({ ...base, includeMock: true, character: 'xiaokai' }).items).toHaveLength(3);
  });
});

describe('timeline', () => {
  it('merges log lines and usage rows in time order', () => {
    seedStandard(db);
    const tl = q.timeline(S_A1, 2000)!;
    expect(tl.session.sid).toBe(S_A1);
    expect(tl.items.map((i) => [i.ts - (T - 2 * HOUR), i.event])).toEqual([
      [0, 'session_started'],
      [MIN, 'response_start'],
      [MIN, 'usage_recorded'],
      [3 * MIN, 'usage_recorded'],
      [5 * MIN, 'upstream_error'],
    ]);
    expect(tl.items[2]!.fields).toEqual({
      kind: 'realtime_reply', model: 'qwen3.8-omni-flash-realtime', input_tokens: 1000, output_tokens: 500,
      first_audio_ms: 900, error_code: null, estimated: false, cost_micro_yuan: 3000,
    });
    expect(tl.items[1]!.seq).toBe(1);
    expect(tl.firstAudioAlertMs).toBe(2000);
    expect(q.timeline('99999999-0000-4000-8000-000000000000', 2000)).toBeNull();
    noRawIds(tl);
  });
});

describe('logs and audit', () => {
  const base = { sid: null, oid: null, event: null, minLevel: 'info' as const, from: 0, to: T + 1, cursor: null, limit: 100 };

  it('filters by minimum level, event and session, newest first', () => {
    seedStandard(db);
    expect(q.logs({ ...base, minLevel: 'warn' }).items.map((l) => l.event)).toEqual(['upstream_error']);
    expect(q.logs({ ...base, event: 'response_start' }).items).toHaveLength(1);
    expect(q.logs({ ...base, sid: S_B0 }).items).toHaveLength(0);
    const all = q.logs(base).items;
    expect(all.map((l) => l.event)).toEqual(['upstream_error', 'response_start', 'session_started']);
    expect(all[0]!.fields).toEqual({ code: 'rate_limited', attempt: 2 });
  });

  it('pages logs by id', () => {
    seedStandard(db);
    const first = q.logs({ ...base, limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = q.logs({ ...base, limit: 2, cursor: Number(first.nextCursor) });
    expect(second.items.map((l) => l.event)).toEqual(['session_started']);
    expect(second.nextCursor).toBeNull();
  });

  it('lists audit rows newest first with an action filter', () => {
    const insert = db.prepare("INSERT INTO admin_audit (ts, actor, action, target, detail) VALUES (?, 'admin', ?, NULL, ?)");
    insert.run(1, 'login_succeeded', '{}');
    insert.run(2, 'owner_banned', '{"sessionsEnded":1}');
    insert.run(3, 'logout', '{}');
    const all = listAudit(db, { action: null, from: 0, to: 10, cursor: null, limit: 50 });
    expect(all.items.map((r) => r.action)).toEqual(['logout', 'owner_banned', 'login_succeeded']);
    expect(all.items[1]!.detail).toEqual({ sessionsEnded: 1 });
    expect(listAudit(db, { action: 'owner_banned', from: 0, to: 10, cursor: null, limit: 50 }).items).toHaveLength(1);
  });
});
```

数字推导（实现前先核对一遍，方便定位失败）：
- 今天（不含 Mock）：会话 `S_A1` 10 分钟 + `S_B1` 进行中 60 分钟 = 70；昨天同时段 `S_B0` 20 分钟 → 差 +50。
- token：1500 + 3000 + 1000（`S_B1` 出错那条）+ 3200（记忆抽取）= 8700；费用 3000 + 6000 + 1000 = 10000（未定价那条不计）。
- 含 Mock：再加 `S_M` 10 分钟、200 token；Mock 的首音 500 进入样本 [500, 900, 1100]，p50 仍是 900。
- B 的用量（不含 Mock）：今天 1000 token 未定价 + 昨天 1000 token 2000 微元。

- [x] **Step 4: 写失败的路由测试**

新建 `gateway/test/admin-read-routes.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { ownerShortId } from '../src/log/ownerId.ts';
import { openDatabase } from '../src/memory/db.ts';
import { OWNER_A, OWNER_B, S_A1, T, seedStandard } from './support/adminFixtures.ts';
import { bootAdmin, type AdminHarness } from './support/admin.ts';

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

describe('admin read routes', () => {
  it('require login', async () => {
    h = await bootAdmin();
    for (const path of ['/admin/api/overview', '/admin/api/owners', '/admin/api/sessions', '/admin/api/logs', '/admin/api/audit']) {
      expect((await h.api(path)).status).toBe(401);
    }
  });

  it('return the overview', async () => {
    const { h, auth } = await seeded();
    const res = await h.api('/admin/api/overview?range=today', { auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { brief: { owners: number }; adapter: string };
    expect(body.brief.owners).toBe(2);
    expect(body.adapter).toBe('mock');
  });

  it('reject unknown or malformed query parameters', async () => {
    const { h, auth } = await seeded();
    for (const path of [
      '/admin/api/overview?range=year',
      '/admin/api/overview?foo=1',
      '/admin/api/owners?limit=0',
      '/admin/api/sessions?oid=XYZ',
      '/admin/api/logs?level=trace',
      '/admin/api/logs?event=DROP%20TABLE',
      '/admin/api/audit?cursor=-1',
    ]) {
      const res = await h.api(path, { auth });
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('查询条件不正确。');
    }
  });

  it('serve owners, one owner and 404 for an unknown oid', async () => {
    const { h, auth } = await seeded();
    const list = await h.api('/admin/api/owners', { auth });
    const text = await list.text();
    expect(text).toContain(ownerShortId(OWNER_A));
    expect(text).not.toContain(OWNER_A);
    expect(text).not.toContain(OWNER_B);
    expect((await h.api(`/admin/api/owners/${ownerShortId(OWNER_A)}`, { auth })).status).toBe(200);
    const missing = await h.api('/admin/api/owners/000000000000', { auth });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { message: string }).message).toBe('没有找到这个用户。');
  });

  it('filter sessions by oid and return an empty page for an unknown oid', async () => {
    const { h, auth } = await seeded();
    const mine = (await (await h.api(`/admin/api/sessions?oid=${ownerShortId(OWNER_A)}`, { auth })).json()) as { items: Array<{ sid: string }> };
    expect(mine.items.map((s) => s.sid)).toEqual([S_A1]);
    const none = (await (await h.api('/admin/api/sessions?oid=000000000000', { auth })).json()) as { items: unknown[]; nextCursor: null };
    expect(none).toEqual({ items: [], nextCursor: null });
  });

  it('serve a timeline and 404 for an unknown session', async () => {
    const { h, auth } = await seeded();
    const tl = (await (await h.api(`/admin/api/sessions/${S_A1}/timeline`, { auth })).json()) as { items: unknown[]; firstAudioAlertMs: number };
    expect(tl.items).toHaveLength(5);
    expect(tl.firstAudioAlertMs).toBe(2000); // bootAdmin uses the shipped admin.json alerts
    expect((await h.api('/admin/api/sessions/99999999-0000-4000-8000-000000000000/timeline', { auth })).status).toBe(404);
  });

  it('serve logs and audit', async () => {
    const { h, auth } = await seeded();
    const logs = (await (await h.api(`/admin/api/logs?sid=${S_A1}&level=warn&from=0`, { auth })).json()) as { items: Array<{ event: string }> };
    expect(logs.items.map((l) => l.event)).toEqual(['upstream_error']);
    const audit = (await (await h.api('/admin/api/audit', { auth })).json()) as { items: Array<{ action: string }> };
    expect(audit.items.map((a) => a.action)).toEqual(['login_succeeded']);
  });
});
```

- [x] **Step 5: 跑测试确认失败**

Run: `npm test -w gateway -- test/admin-days.test.ts test/admin-queries.test.ts test/admin-read-routes.test.ts`
Expected: FAIL，`Cannot find module '../src/admin/days.ts'` 等。

- [x] **Step 6: 实现 `days.ts`**

```ts
import type { AdminRange } from '@anyidea/protocol';

/** China has had no DST since 1991, so a fixed +08:00 equals Asia/Shanghai and needs no tz data (SQLite has none). */
export const SHANGHAI_OFFSET_MS = 28_800_000;
export const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<AdminRange, number> = { today: 1, '7d': 7, '30d': 30 };

export function shanghaiDay(ts: number): string {
  return new Date(ts + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function shanghaiDayStart(ts: number): number {
  return Math.floor((ts + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
}

export interface RangeBounds { from: number; to: number; prevFrom: number; prevTo: number; days: string[] }

/** [from, to) with `to` just after now; prev is the same span one range earlier. */
export function rangeBounds(range: AdminRange, now: number): RangeBounds {
  const n = RANGE_DAYS[range];
  const from = shanghaiDayStart(now) - (n - 1) * DAY_MS;
  const to = now + 1;
  return {
    from, to,
    prevFrom: from - n * DAY_MS,
    prevTo: to - n * DAY_MS,
    days: Array.from({ length: n }, (_, i) => shanghaiDay(from + i * DAY_MS)),
  };
}

/** Same cut as shanghaiDay(); integer division drops milliseconds. */
export function sqlShanghaiDay(column: string): string {
  return `strftime('%Y-%m-%d', (${column} + ${SHANGHAI_OFFSET_MS}) / 1000, 'unixepoch')`;
}
```

- [x] **Step 7: 实现 `queries.ts`**

```ts
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  AdminLogRow, AdminOverview, AdminOwnerDetail, AdminOwnerRow, AdminPage, AdminRange, AdminSessionRow, AdminTimeline, AdminTimelineItem, MoneyTokens,
} from '@anyidea/protocol';
import { percentile } from '../eval/logReport.ts';
import { ownerShortId } from '../log/ownerId.ts';
import type { AdminConfig } from './config.ts';
import { DAY_MS, rangeBounds, shanghaiDay, shanghaiDayStart, sqlShanghaiDay } from './days.ts';

type Field = string | number | boolean | null;
export interface SessionFilter { ownerId: string | null; character: string | null; sid: string | null; from: number; to: number; includeMock: boolean; offset: number; limit: number }
export interface LogFilter { sid: string | null; oid: string | null; event: string | null; minLevel: 'debug' | 'info' | 'warn' | 'error'; from: number; to: number; cursor: number | null; limit: number }

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const HOUR_MS = 3_600_000;
const TOKENS = 'COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0)';
const USAGE_MOCK = "($mock = 1 OR u.model <> 'mock')";
const SESSION_MOCK = "($mock = 1 OR COALESCE(s.adapter, '') <> 'mock')";
/** Per-row money columns for a usage subquery filtered by `where`. */
const money = (where: string) => `
  (SELECT COALESCE(SUM(${TOKENS}), 0) FROM usage_events u WHERE ${where}) AS tokens,
  (SELECT COALESCE(SUM(u.cost_micro_yuan), 0) FROM usage_events u WHERE ${where}) AS cost,
  (SELECT COUNT(*) FROM usage_events u WHERE ${where} AND u.cost_micro_yuan IS NULL) AS unpriced`;

const SQL = {
  sessionTotals: `SELECT COUNT(DISTINCT a.owner_id) AS owners,
      COALESCE(SUM(MIN(COALESCE(s.ended_at, $now), $to) - s.started_at), 0) AS ms
    FROM sessions s JOIN agents a ON a.id = s.agent_id
    WHERE s.started_at >= $from AND s.started_at < $to AND ${SESSION_MOCK}`,
  sessionDays: `SELECT ${sqlShanghaiDay('s.started_at')} AS day, COUNT(DISTINCT a.owner_id) AS owners,
      COALESCE(SUM(MIN(COALESCE(s.ended_at, $now), $to) - s.started_at), 0) AS ms
    FROM sessions s JOIN agents a ON a.id = s.agent_id
    WHERE s.started_at >= $from AND s.started_at < $to AND ${SESSION_MOCK} GROUP BY day`,
  usageTotals: `SELECT COALESCE(SUM(${TOKENS}), 0) AS tokens, COALESCE(SUM(u.cost_micro_yuan), 0) AS cost,
      COALESCE(SUM(CASE WHEN u.kind = 'realtime_reply' AND u.error_code IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors
    FROM usage_events u WHERE u.ts >= $from AND u.ts < $to AND ${USAGE_MOCK}`,
  usageDays: `SELECT ${sqlShanghaiDay('u.ts')} AS day, COALESCE(SUM(${TOKENS}), 0) AS tokens, COALESCE(SUM(u.cost_micro_yuan), 0) AS cost,
      COALESCE(SUM(CASE WHEN u.kind = 'realtime_reply' AND u.error_code IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors
    FROM usage_events u WHERE u.ts >= $from AND u.ts < $to AND ${USAGE_MOCK} GROUP BY day`,
  byKind: `SELECT u.kind AS kind, COALESCE(SUM(u.cost_micro_yuan), 0) AS cost
    FROM usage_events u WHERE u.ts >= $from AND u.ts < $to AND ${USAGE_MOCK} GROUP BY u.kind ORDER BY cost DESC, kind`,
  replies: `SELECT u.first_audio_ms AS ms, u.error_code AS errorCode
    FROM usage_events u WHERE u.kind = 'realtime_reply' AND u.ts >= $from AND u.ts < $to AND ${USAGE_MOCK}`,
  ownerIds: 'SELECT id FROM owners',
  owners: `SELECT o.id AS id, o.created_at AS createdAt, o.last_seen_at AS lastSeenAt, o.banned_at AS bannedAt,
      (SELECT COUNT(*) FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE a.owner_id = o.id AND ${SESSION_MOCK}) AS sessions,
      (SELECT COUNT(*) FROM profile_facts f WHERE f.owner_id = o.id)
        + (SELECT COUNT(*) FROM agent_facts f WHERE f.owner_id = o.id)
        + (SELECT COUNT(*) FROM pinned_memories p WHERE p.owner_id = o.id) AS memoryItems,
      ${money(`u.owner_id = o.id AND ${USAGE_MOCK}`)}
    FROM owners o WHERE ($owner IS NULL OR o.id = $owner)
    ORDER BY o.last_seen_at DESC, o.id DESC LIMIT $limit OFFSET $offset`,
  ownerCharacters: `SELECT a.character_id AS character,
      (SELECT COUNT(*) FROM sessions s WHERE s.agent_id = a.id AND ${SESSION_MOCK}) AS sessions,
      (SELECT COUNT(*) FROM agent_facts f WHERE f.agent_id = a.id) + (SELECT COUNT(*) FROM pinned_memories p WHERE p.agent_id = a.id) AS memoryItems,
      ${money(`u.agent_id = a.id AND ${USAGE_MOCK}`)}
    FROM agents a WHERE a.owner_id = $owner ORDER BY a.created_at, a.id`,
  ownerDaily: `SELECT ${sqlShanghaiDay('u.ts')} AS day, COALESCE(SUM(${TOKENS}), 0) AS tokens, COALESCE(SUM(u.cost_micro_yuan), 0) AS cost
    FROM usage_events u WHERE u.owner_id = $owner AND u.ts >= $from AND ${USAGE_MOCK} GROUP BY day`,
  sessions: `SELECT s.id AS sid, a.owner_id AS ownerId, a.character_id AS character, s.adapter AS adapter,
      s.started_at AS startedAt, s.ended_at AS endedAt, s.end_reason AS endReason,
      (SELECT COUNT(*) FROM usage_events u WHERE u.session_id = s.id AND u.kind = 'realtime_reply') AS replies,
      (SELECT COUNT(*) FROM usage_events u WHERE u.session_id = s.id AND u.kind = 'realtime_reply' AND u.error_code IS NOT NULL) AS errors,
      ${money('u.session_id = s.id')}
    FROM sessions s JOIN agents a ON a.id = s.agent_id
    WHERE ($owner IS NULL OR a.owner_id = $owner) AND ($character IS NULL OR a.character_id = $character)
      AND ($sid IS NULL OR s.id = $sid) AND s.started_at >= $from AND s.started_at < $to AND ${SESSION_MOCK}
    ORDER BY s.started_at DESC, s.id DESC LIMIT $limit OFFSET $offset`,
  sessionLogs: 'SELECT ts, level, event, seq, fields FROM log_events WHERE sid = $sid ORDER BY ts, id LIMIT 5000',
  sessionUsage: `SELECT ts, kind, model, input_tokens, output_tokens, first_audio_ms, error_code, estimated, cost_micro_yuan
    FROM usage_events WHERE session_id = $sid ORDER BY ts, id`,
  logs: `SELECT id, ts, level, event, sid, oid, char, seq, job, fields FROM log_events
    WHERE ($sid IS NULL OR sid = $sid) AND ($oid IS NULL OR oid = $oid) AND ($event IS NULL OR event = $event)
      AND level IN (SELECT value FROM json_each($levels)) AND ts >= $from AND ts < $to AND ($cursor IS NULL OR id < $cursor)
    ORDER BY id DESC LIMIT $limit`,
} as const;

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const minutes = (ms: unknown) => Math.round(num(ms) / 60_000);
const moneyOf = (r: Row): MoneyTokens => ({ tokens: num(r.tokens), costMicroYuan: num(r.cost), unpricedCalls: num(r.unpriced) });

function parseFields(raw: unknown): Record<string, Field> {
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, Field>) : {};
  } catch {
    return {};
  }
}

function sortedNumbers(values: unknown[]): number[] {
  return values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
}

function page<T>(rows: T[], limit: number, next: () => string): AdminPage<T> {
  const more = rows.length > limit;
  return { items: more ? rows.slice(0, limit) : rows, nextCursor: more ? next() : null };
}

/** Read-only admin queries. Owner ids never leave this class: callers get oid = ownerShortId(id). */
export class AdminQueries {
  private readonly q: Record<keyof typeof SQL, StatementSync>;

  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {
    this.q = Object.fromEntries(Object.entries(SQL).map(([k, sql]) => [k, db.prepare(sql)])) as Record<keyof typeof SQL, StatementSync>;
  }

  /** O(owners); owners are capped by MAX_OWNERS, so no cache (and no invalidation). */
  ownerIdFor(oid: string): string | null {
    for (const row of this.q.ownerIds.all() as Array<{ id: string }>) if (ownerShortId(row.id) === oid) return row.id;
    return null;
  }

  overview(range: AdminRange, opts: { includeMock: boolean; adapter: string; alerts: AdminConfig['alerts'] }): AdminOverview {
    const now = this.now();
    const b = rangeBounds(range, now);
    const mock = opts.includeMock ? 1 : 0;
    const span = { from: b.from, to: b.to, now, mock };
    const sessions = this.q.sessionTotals.get(span) as Row;
    const prev = this.q.sessionTotals.get({ from: b.prevFrom, to: b.prevTo, now, mock }) as Row;
    const usage = this.q.usageTotals.get({ from: b.from, to: b.to, mock }) as Row;
    const sessionDays = new Map((this.q.sessionDays.all(span) as Row[]).map((r) => [r.day as string, r]));
    const usageDays = new Map((this.q.usageDays.all({ from: b.from, to: b.to, mock }) as Row[]).map((r) => [r.day as string, r]));
    const kinds = this.q.byKind.all({ from: b.from, to: b.to, mock }) as Row[];
    const totalCost = kinds.reduce((sum, r) => sum + num(r.cost), 0);
    const latency = sortedNumbers((this.q.replies.all({ from: b.from, to: b.to, mock }) as Row[]).map((r) => r.ms));
    return {
      range,
      brief: {
        owners: num(sessions.owners),
        callMinutes: minutes(sessions.ms),
        costMicroYuan: num(usage.cost),
        errors: num(usage.errors),
        deltaMinutesVsPrev: minutes(sessions.ms) - minutes(prev.ms),
      },
      days: b.days.map((day) => {
        const s = sessionDays.get(day);
        const u = usageDays.get(day);
        return { day, owners: num(s?.owners), callMinutes: minutes(s?.ms), tokens: num(u?.tokens), costMicroYuan: num(u?.cost), errors: num(u?.errors) };
      }),
      byKind: kinds.map((r) => ({ kind: r.kind as string, costMicroYuan: num(r.cost), share: totalCost > 0 ? Math.round((num(r.cost) / totalCost) * 10_000) / 10_000 : 0 })),
      latency: {
        firstAudioP50Ms: latency.length ? percentile(latency, 50) : null,
        firstAudioP95Ms: latency.length ? percentile(latency, 95) : null,
      },
      alerts: this.alerts(now, mock, opts.alerts),
      adapter: opts.adapter,
    };
  }

  owners(opts: { includeMock: boolean; offset: number; limit: number }): AdminPage<AdminOwnerRow> {
    const rows = this.q.owners.all({ owner: null, mock: opts.includeMock ? 1 : 0, limit: opts.limit + 1, offset: opts.offset }) as Row[];
    return page(rows.map((r) => this.ownerRow(r)), opts.limit, () => String(opts.offset + opts.limit));
  }

  owner(oid: string, includeMock: boolean): AdminOwnerDetail | null {
    const ownerId = this.ownerIdFor(oid);
    if (!ownerId) return null;
    const mock = includeMock ? 1 : 0;
    const row = this.q.owners.get({ owner: ownerId, mock, limit: 1, offset: 0 }) as Row | undefined;
    if (!row) return null;
    const from = shanghaiDayStart(this.now()) - 29 * DAY_MS;
    const daily = new Map((this.q.ownerDaily.all({ owner: ownerId, from, mock }) as Row[]).map((r) => [r.day as string, r]));
    return {
      ...this.ownerRow(row),
      characters: (this.q.ownerCharacters.all({ owner: ownerId, mock }) as Row[]).map((r) => ({
        character: r.character as string, sessions: num(r.sessions), memoryItems: num(r.memoryItems), usage: moneyOf(r),
      })),
      daily: Array.from({ length: 30 }, (_, i) => {
        const day = shanghaiDay(from + i * DAY_MS);
        const d = daily.get(day);
        return { day, tokens: num(d?.tokens), costMicroYuan: num(d?.cost) };
      }),
    };
  }

  sessions(f: SessionFilter): AdminPage<AdminSessionRow> {
    const rows = this.q.sessions.all({
      owner: f.ownerId, character: f.character, sid: f.sid, from: f.from, to: f.to,
      mock: f.includeMock ? 1 : 0, limit: f.limit + 1, offset: f.offset,
    }) as Row[];
    const result = page(rows, f.limit, () => String(f.offset + f.limit));
    const p50 = this.firstAudioP50(result.items.map((r) => r.sid as string));
    return {
      nextCursor: result.nextCursor,
      items: result.items.map((r) => ({
        sid: r.sid as string,
        oid: ownerShortId(r.ownerId as string),
        character: r.character as string,
        adapter: (r.adapter as string | null) ?? null,
        startedAt: num(r.startedAt),
        endedAt: r.endedAt === null ? null : num(r.endedAt),
        endReason: (r.endReason as string | null) ?? null,
        replies: num(r.replies),
        errors: num(r.errors),
        firstAudioP50Ms: p50.get(r.sid as string) ?? null,
        usage: moneyOf(r),
      })),
    };
  }

  timeline(sid: string, firstAudioAlertMs: number): AdminTimeline | null {
    const session = this.sessions({ ownerId: null, character: null, sid, from: 0, to: Number.MAX_SAFE_INTEGER, includeMock: true, offset: 0, limit: 1 }).items[0];
    if (!session) return null;
    const logs: AdminTimelineItem[] = (this.q.sessionLogs.all({ sid }) as Row[]).map((r) => ({
      ts: num(r.ts), level: r.level as string, event: r.event as string, seq: r.seq === null ? null : num(r.seq), fields: parseFields(r.fields),
    }));
    const usage: AdminTimelineItem[] = (this.q.sessionUsage.all({ sid }) as Row[]).map((r) => ({
      ts: num(r.ts),
      level: r.error_code ? 'warn' : 'info',
      event: 'usage_recorded',
      seq: null,
      fields: {
        kind: r.kind as string, model: r.model as string,
        input_tokens: (r.input_tokens as number | null) ?? null, output_tokens: (r.output_tokens as number | null) ?? null,
        first_audio_ms: (r.first_audio_ms as number | null) ?? null, error_code: (r.error_code as string | null) ?? null,
        estimated: num(r.estimated) === 1, cost_micro_yuan: (r.cost_micro_yuan as number | null) ?? null,
      },
    }));
    // Stable sort: at equal ts a log line stays before the usage row it explains.
    return { session, items: [...logs, ...usage].sort((a, b) => a.ts - b.ts), firstAudioAlertMs };
  }

  logs(f: LogFilter): AdminPage<AdminLogRow> {
    const levels = JSON.stringify(LEVELS.slice(LEVELS.indexOf(f.minLevel)));
    const rows = this.q.logs.all({ sid: f.sid, oid: f.oid, event: f.event, levels, from: f.from, to: f.to, cursor: f.cursor, limit: f.limit + 1 }) as Row[];
    const items: AdminLogRow[] = rows.map((r) => ({
      id: num(r.id), ts: num(r.ts), level: r.level as string, event: r.event as string,
      sid: (r.sid as string | null) ?? null, oid: (r.oid as string | null) ?? null, char: (r.char as string | null) ?? null,
      seq: r.seq === null ? null : num(r.seq), job: (r.job as string | null) ?? null, fields: parseFields(r.fields),
    }));
    return page(items, f.limit, () => String(items[f.limit - 1]!.id));
  }

  private ownerRow(r: Row): AdminOwnerRow {
    return {
      oid: ownerShortId(r.id as string),
      createdAt: num(r.createdAt),
      lastSeenAt: r.lastSeenAt === null ? null : num(r.lastSeenAt),
      banned: r.bannedAt !== null,
      sessions: num(r.sessions),
      memoryItems: num(r.memoryItems),
      usage: moneyOf(r),
    };
  }

  private firstAudioP50(sids: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (sids.length === 0) return out;
    // Only the count of '?' marks is interpolated; the ids stay bound parameters.
    const marks = sids.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT session_id AS sid, first_audio_ms AS ms FROM usage_events
      WHERE kind = 'realtime_reply' AND first_audio_ms IS NOT NULL AND session_id IN (${marks})`).all(...sids) as Row[];
    const bySid = new Map<string, number[]>();
    for (const r of rows) {
      const list = bySid.get(r.sid as string) ?? [];
      list.push(num(r.ms));
      bySid.set(r.sid as string, list);
    }
    for (const [sid, values] of bySid) out.set(sid, percentile(values.sort((a, b) => a - b), 50));
    return out;
  }

  private alerts(now: number, mock: number, cfg: AdminConfig['alerts']): AdminOverview['alerts'] {
    const rows = this.q.replies.all({ from: now - HOUR_MS, to: now + 1, mock }) as Row[];
    if (rows.length < cfg.minSamples) return [];
    const out: AdminOverview['alerts'] = [];
    const rate = Math.round((rows.filter((r) => r.errorCode !== null).length / rows.length) * 10_000) / 10_000;
    if (rate > cfg.errorRate1h) out.push({ code: 'error_rate_1h', value: rate, threshold: cfg.errorRate1h });
    const latency = sortedNumbers(rows.map((r) => r.ms));
    const p95 = latency.length ? percentile(latency, 95) : null;
    if (p95 !== null && p95 > cfg.firstAudioP95Ms) out.push({ code: 'first_audio_p95', value: p95, threshold: cfg.firstAudioP95Ms });
    return out;
  }
}
```

- [x] **Step 8: 追加 `listAudit`**

在 `gateway/src/admin/audit.ts` 顶部追加 `import type { AdminAuditRow, AdminPage } from '@anyidea/protocol';`，文件末尾追加：

```ts
export function listAudit(db: DatabaseSync, f: { action: string | null; from: number; to: number; cursor: number | null; limit: number }): AdminPage<AdminAuditRow> {
  const rows = db.prepare(`SELECT id, ts, actor, action, target, detail FROM admin_audit
    WHERE ($action IS NULL OR action = $action) AND ts >= $from AND ts < $to AND ($cursor IS NULL OR id < $cursor)
    ORDER BY id DESC LIMIT $limit`).all({ action: f.action, from: f.from, to: f.to, cursor: f.cursor, limit: f.limit + 1 }) as Array<Record<string, unknown>>;
  const items: AdminAuditRow[] = rows.slice(0, f.limit).map((r) => {
    let detail: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(r.detail)) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
    } catch {
      // keep {}
    }
    return { id: Number(r.id), ts: Number(r.ts), actor: String(r.actor), action: String(r.action), target: (r.target as string | null) ?? null, detail };
  });
  return { items, nextCursor: rows.length > f.limit ? String(items.at(-1)!.id) : null };
}
```

- [x] **Step 9: 实现 `routes/read.ts`，挂到服务上**

新建 `gateway/src/admin/routes/read.ts`：

```ts
import { CHARACTER_IDS } from '@anyidea/protocol';
import { z } from 'zod';
import { listAudit } from '../audit.ts';
import { sendError, sendJson } from '../http.ts';
import type { AdminRoute, RouteContext } from './types.ts';

const DAY = 86_400_000;
const OID = z.string().regex(/^[0-9a-f]{12}$/);
const Mock = z.enum(['0', '1']).default('0').transform((v) => v === '1');
const Ms = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Cursor = z.string().regex(/^[0-9]{1,15}$/).transform(Number);
const limit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);

const OverviewQuery = z.object({ range: z.enum(['today', '7d', '30d']).default('today'), mock: Mock }).strict();
const OwnersQuery = z.object({ mock: Mock, cursor: Cursor.optional(), limit: limit(200, 50) }).strict();
const OwnerQuery = z.object({ mock: Mock }).strict();
const SessionsQuery = z.object({
  mock: Mock, oid: OID.optional(), character: z.enum(CHARACTER_IDS).optional(),
  from: Ms.optional(), to: Ms.optional(), cursor: Cursor.optional(), limit: limit(200, 50),
}).strict();
const LogsQuery = z.object({
  sid: z.uuid().optional(), oid: OID.optional(), event: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  from: Ms.optional(), to: Ms.optional(), cursor: Cursor.optional(), limit: limit(500, 100),
}).strict();
const AuditQuery = z.object({ action: z.string().regex(/^[a-z_]{1,40}$/).optional(), from: Ms.optional(), to: Ms.optional(), cursor: Cursor.optional(), limit: limit(200, 50) }).strict();

function query<T extends z.ZodType>(ctx: RouteContext, schema: T): z.infer<T> | null {
  const parsed = schema.safeParse(Object.fromEntries(ctx.url.searchParams));
  if (parsed.success) return parsed.data;
  sendError(ctx.res, 400, 'bad_request', '查询条件不正确。');
  return null;
}

export function readRoutes(): AdminRoute[] {
  return [
    {
      method: 'GET', path: /^\/admin\/api\/overview$/, name: 'overview', auth: true,
      handle: (ctx) => {
        const q = query(ctx, OverviewQuery);
        if (!q) return;
        sendJson(ctx.res, 200, ctx.services.queries.overview(q.range, { includeMock: q.mock, adapter: ctx.deps.adapterName, alerts: ctx.deps.config.alerts }));
      },
    },
    {
      method: 'GET', path: /^\/admin\/api\/owners$/, name: 'owners', auth: true,
      handle: (ctx) => {
        const q = query(ctx, OwnersQuery);
        if (!q) return;
        sendJson(ctx.res, 200, ctx.services.queries.owners({ includeMock: q.mock, offset: q.cursor ?? 0, limit: q.limit }));
      },
    },
    {
      method: 'GET', path: /^\/admin\/api\/owners\/([0-9a-f]{12})$/, name: 'owner', auth: true,
      handle: (ctx) => {
        const q = query(ctx, OwnerQuery);
        if (!q) return;
        const detail = ctx.services.queries.owner(ctx.params[0]!, q.mock);
        if (!detail) return sendError(ctx.res, 404, 'not_found', '没有找到这个用户。');
        sendJson(ctx.res, 200, detail);
      },
    },
    {
      method: 'GET', path: /^\/admin\/api\/sessions$/, name: 'sessions', auth: true,
      handle: (ctx) => {
        const q = query(ctx, SessionsQuery);
        if (!q) return;
        const now = ctx.services.now();
        const ownerId = q.oid ? ctx.services.queries.ownerIdFor(q.oid) : null;
        if (q.oid && !ownerId) return sendJson(ctx.res, 200, { items: [], nextCursor: null });
        sendJson(ctx.res, 200, ctx.services.queries.sessions({
          ownerId, character: q.character ?? null, sid: null,
          from: q.from ?? now - 30 * DAY, to: q.to ?? now + 1,
          includeMock: q.mock, offset: q.cursor ?? 0, limit: q.limit,
        }));
      },
    },
    {
      method: 'GET', path: /^\/admin\/api\/sessions\/([0-9a-f-]{36})\/timeline$/, name: 'timeline', auth: true,
      handle: (ctx) => {
        const sid = z.uuid().safeParse(ctx.params[0]);
        const timeline = sid.success ? ctx.services.queries.timeline(sid.data, ctx.deps.config.alerts.firstAudioP95Ms) : null;
        if (!timeline) return sendError(ctx.res, 404, 'not_found', '没有找到这通通话。');
        sendJson(ctx.res, 200, timeline);
      },
    },
    {
      method: 'GET', path: /^\/admin\/api\/logs$/, name: 'logs', auth: true,
      handle: (ctx) => {
        const q = query(ctx, LogsQuery);
        if (!q) return;
        const now = ctx.services.now();
        sendJson(ctx.res, 200, ctx.services.queries.logs({
          sid: q.sid ?? null, oid: q.oid ?? null, event: q.event ?? null, minLevel: q.level,
          from: q.from ?? now - DAY, to: q.to ?? now + 1, cursor: q.cursor ?? null, limit: q.limit,
        }));
      },
    },
    {
      method: 'GET', path: /^\/admin\/api\/audit$/, name: 'audit', auth: true,
      handle: (ctx) => {
        const q = query(ctx, AuditQuery);
        if (!q) return;
        sendJson(ctx.res, 200, listAudit(ctx.deps.db, { action: q.action ?? null, from: q.from ?? 0, to: q.to ?? ctx.services.now() + 1, cursor: q.cursor ?? null, limit: q.limit }));
      },
    },
  ];
}
```

`gateway/src/admin/routes/types.ts`：`AdminServices` 增加 `queries: AdminQueries;`（`import type { AdminQueries } from '../queries.ts';`）。

`gateway/src/admin/server.ts`：
- import `AdminQueries`（`./queries.ts`）和 `readRoutes`（`./routes/read.ts`）；
- `services` 里加 `queries: new AdminQueries(deps.db, now),`；
- `routes` 改为 `[...authRoutes(), ...readRoutes()]`。

- [x] **Step 10: 跑测试确认通过**

Run: `npm test -w gateway -- test/admin-days.test.ts test/admin-queries.test.ts test/admin-read-routes.test.ts`
Expected: PASS（3 + 14 + 7 项）。若总览数字不对，先按 Step 3 末尾的推导核对 fixture，再查 SQL；不要改测试里的期望值去迁就实现。

- [x] **Step 11: 全量回归**

Run: `npm test -w gateway && npm run typecheck -w gateway`
Expected: 全部通过。

- [x] **Step 12: Commit**

```bash
git add gateway/src/admin/days.ts gateway/src/admin/queries.ts gateway/src/admin/routes/read.ts gateway/src/admin/audit.ts \
  gateway/src/admin/routes/types.ts gateway/src/admin/server.ts gateway/test/support/adminFixtures.ts \
  gateway/test/admin-days.test.ts gateway/test/admin-queries.test.ts gateway/test/admin-read-routes.test.ts
git commit -m "feat(admin): add read-only overview, owner, session, timeline, log and audit apis

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
