import type { Language } from '@anyidea/protocol';
import type { RoleCatalog } from '../roles/catalog.ts';

/** Per-session identity and role choice. Resolved on the server; never taken from client input. */
export interface SessionContext {
  ownerId?: string;
  agentId?: string;
  roleId: string;
  styleId: string;
  /** Resolved role/style override for the default language; M1 production uses zh. */
  voice?: string;
  language?: Language;
  /** Frozen memory snapshot injected into normal replies: addressing, non-sensitive facts, user tail. */
  memorySnapshot?: string;
  /** Greeting planner: addressing and non-sensitive facts only. */
  greetingMemorySnapshot?: string;
  /** True when the greeting view has a real topic fact, not only the name. */
  greetingHasTopic?: boolean;
  /** Silence planner: non-sensitive facts only; never the name or sensitive memory. */
  proactiveMemorySnapshot?: string;
  /** Every pin of this character, sensitive ones included; rendered beside the snapshot, never clipped (Q33). */
  pinnedMemory?: string;
}

/** Temporary until Task 7 removes styles: the default of the two former style ids. */
export const LEGACY_DEFAULT_STYLE = 'grandchild';

/** Temporary until Task 7 removes styles. */
export function isLegacyStyle(styleId: string): boolean {
  return styleId === 'grandchild' || styleId === 'old-friend';
}

/** Context for sessions without a device token (dev / Mock mode): no owner, no memory. */
export function devContext(roles: RoleCatalog): SessionContext {
  const roleId = roles.defaultRole();
  const language = roles.defaultLanguage(roleId);
  return { roleId, styleId: LEGACY_DEFAULT_STYLE, voice: undefined, language };
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
