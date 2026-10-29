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
        + (SELECT COUNT(*) FROM pinned_memories p WHERE p.owner_id = o.id)
        + (SELECT COUNT(*) FROM followups t WHERE t.owner_id = o.id AND t.quote IS NOT NULL AND t.done_at IS NULL)
        + (SELECT COUNT(*) FROM reflections r WHERE r.owner_id = o.id) AS memoryItems,
      ${money(`u.owner_id = o.id AND ${USAGE_MOCK}`)}
    FROM owners o WHERE ($owner IS NULL OR o.id = $owner)
    ORDER BY o.last_seen_at DESC, o.id DESC LIMIT $limit OFFSET $offset`,
  ownerCharacters: `SELECT a.character_id AS character,
      (SELECT COUNT(*) FROM sessions s WHERE s.agent_id = a.id AND ${SESSION_MOCK}) AS sessions,
      (SELECT COUNT(*) FROM agent_facts f WHERE f.agent_id = a.id) + (SELECT COUNT(*) FROM pinned_memories p WHERE p.agent_id = a.id)
        + (SELECT COUNT(*) FROM followups t WHERE t.agent_id = a.id AND t.quote IS NOT NULL AND t.done_at IS NULL)
        + (SELECT COUNT(*) FROM reflections r WHERE r.agent_id = a.id) AS memoryItems,
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
