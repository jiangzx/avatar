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
