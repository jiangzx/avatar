import type { RoleCatalog } from '../roles/catalog.ts';

/** Per-session identity and role choice. Resolved on the server; never taken from client input. */
export interface SessionContext {
  ownerId?: string;
  agentId?: string;
  roleId: string;
  styleId: string;
  /** undefined = the adapter's configured default voice. */
  voice?: string;
  /** Frozen memory snapshot injected at session start (Plan C). */
  memorySnapshot?: string;
}

/** Context for sessions without a device token (dev / Mock mode): no owner, no memory. */
export function devContext(roles: RoleCatalog): SessionContext {
  const roleId = roles.defaultRole();
  const styleId = roles.defaultStyle(roleId);
  return { roleId, styleId, voice: roles.voiceFor(roleId, styleId) };
}
