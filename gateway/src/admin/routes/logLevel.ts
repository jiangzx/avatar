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
