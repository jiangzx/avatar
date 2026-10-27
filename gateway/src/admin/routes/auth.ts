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
