import type { RoleCatalog } from '../roles/catalog.ts';

/** Per-session identity and role choice. Resolved on the server; never taken from client input. */
export interface SessionContext {
  ownerId?: string;
  agentId?: string;
  roleId: string;
  styleId: string;
  /** undefined = the adapter's configured default voice. */
  voice?: string;
  /** Frozen memory snapshot injected into normal replies: addressing, non-sensitive facts, user tail. */
  memorySnapshot?: string;
  /** Greeting planner: addressing and non-sensitive facts only. */
  greetingMemorySnapshot?: string;
  /** True when the greeting view has a real topic fact, not only the name. */
  greetingHasTopic?: boolean;
  /** Silence planner: non-sensitive facts only; never the name or sensitive memory. */
  proactiveMemorySnapshot?: string;
}

/** Context for sessions without a device token (dev / Mock mode): no owner, no memory. */
export function devContext(roles: RoleCatalog): SessionContext {
  const roleId = roles.defaultRole();
  const styleId = roles.defaultStyle(roleId);
  return { roleId, styleId, voice: roles.voiceFor(roleId, styleId) };
}

export type ResolveResult = { ok: true; ctx: SessionContext; noticePending: boolean } | { ok: false };

/** Maps the optional device bearer token to a session context. DeviceRegistry implements this when MEMORY_DB_PATH is set. */
export interface ContextResolver {
  resolve(bearer: string | undefined): ResolveResult;
}

/** Dev / Mock resolver (identity disabled): any bearer is rejected. */
export function devContextResolver(roles: RoleCatalog): ContextResolver {
  return { resolve: (bearer) => (bearer === undefined ? { ok: true, ctx: devContext(roles), noticePending: false } : { ok: false }) };
}
