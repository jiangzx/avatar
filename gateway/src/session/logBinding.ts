import type { LogBinding } from '../log/logger.ts';
import { ownerShortId } from '../log/ownerId.ts';
import type { SessionContext } from './context.ts';

/** Log binding for one session. Ids come from the server-side context only, never from client input. */
export function sessionLogBinding(sessionId: string, ctx: Pick<SessionContext, 'ownerId' | 'characterId'>): LogBinding {
  return { sid: sessionId, ...(ctx.ownerId ? { oid: ownerShortId(ctx.ownerId) } : {}), char: ctx.characterId };
}
