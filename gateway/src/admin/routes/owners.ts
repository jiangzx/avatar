import { z } from 'zod';
import { shanghaiDay } from '../days.ts';
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

function resetProactiveDaily(ctx: RouteContext): void {
  const owner = ownerOf(ctx);
  if (!owner) return;
  const day = shanghaiDay(ctx.services.now());
  const rows = ctx.deps.store.resetProactiveDaily(owner.ownerId, day);
  ctx.services.audit.record({ actor: ctx.session!.actor, action: 'proactive_daily_reset', target: owner.oid, detail: { day, rows } });
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
    { method: 'POST', path: new RegExp(`^/admin/api/owners/${OID_PATH}/proactive-daily/reset$`), name: 'proactive_daily_reset', auth: true, handle: resetProactiveDaily },
    { method: 'DELETE', path: new RegExp(`^/admin/api/owners/${OID_PATH}$`), name: 'owner_delete', auth: true, bodyLimit: 1024, handle: remove },
  ];
}
