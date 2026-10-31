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
    db.prepare('INSERT INTO proactive_daily (owner_id, agent_id, day, count) VALUES (?, ?, ?, ?)').run(OWNER_A, AGENT_A, '2026-10-27', 7);
    const detail = q.owner(OA, false)!;
    expect(detail.characters).toEqual([
      { character: 'xiaonuan', sessions: 1, memoryItems: 3, usage: { tokens: 7700, costMicroYuan: 10_000, unpricedCalls: 0 } },
    ]);
    expect(detail.proactiveDaily).toEqual([{ character: 'xiaonuan', count: 7 }]);
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

  it('counts open threads and reflections as memory items, never their text', () => {
    seedStandard(db);
    db.prepare(`INSERT INTO followups (id, owner_id, agent_id, text, due_at, source_session_id, quote, sensitive, created_at)
      VALUES ('t-open', ?, ?, 'x', 1, 's', '我后天复查', 1, 1), ('t-plain', ?, ?, 'x', 1, 's', NULL, 0, 1)`).run(OWNER_A, AGENT_A, OWNER_A, AGENT_A);
    db.prepare(`INSERT INTO reflections (id, owner_id, agent_id, text, evidence_message_ids, session_id, created_at)
      VALUES ('r1', ?, ?, '常一个人吃午饭', '[]', 's', 1)`).run(OWNER_A, AGENT_A);
    const page = q.owners({ includeMock: false, offset: 0, limit: 50 });
    expect(page.items.find((o) => o.oid === OA)!.memoryItems).toBe(6);
    expect(q.owner(OA, false)!.characters[0]!.memoryItems).toBe(5);
    expect(JSON.stringify(page)).not.toContain('复查');
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
