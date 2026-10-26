import type { CharacterId, Language } from '@anyidea/protocol';
import type { CharacterRegistry } from '../characters/registry.ts';
import type { RoleCatalog } from '../roles/catalog.ts';

/** Per-session identity and character. Resolved on the server; scope keys never come from client input. */
export interface SessionContext {
  ownerId?: string;
  agentId?: string;
  characterId: CharacterId;
  language?: Language;
  /** This owner has no ended session with this character yet. */
  firstMeet: boolean;
  /** Start of the owner's continuous use across characters; set for the rest reminder. */
  continuousSince?: number;
  /** Frozen memory snapshot injected into normal replies. */
  memorySnapshot?: string;
  /** Greeting planner view. */
  greetingMemorySnapshot?: string;
  /** True when the greeting view has a real topic fact, not only the name. */
  greetingHasTopic?: boolean;
  /** Silence planner view; never the name or sensitive memory. */
  proactiveMemorySnapshot?: string;
  /** Pinned block rendered before the snapshot; never clipped. */
  pinnedMemory?: string;
}

/** Context without a device token (dev / Mock mode): no owner, no memory, so always a first meeting. */
export function devContext(roles: RoleCatalog, characters: CharacterRegistry | undefined, characterId: CharacterId): SessionContext {
  const roleId = characters?.roleOf(characterId) ?? roles.defaultRole();
  return { characterId, language: roles.defaultLanguage(roleId), firstMeet: true };
}

export type ResolveResult = { ok: true; ctx: SessionContext; noticePending: boolean } | { ok: false };

/** Maps the optional device bearer and the requested character to a session context. DeviceRegistry implements this when MEMORY_DB_PATH is set. */
export interface ContextResolver {
  resolve(bearer: string | undefined, characterId: CharacterId): ResolveResult;
}

/** Dev / Mock resolver (identity disabled): any bearer is rejected. */
export function devContextResolver(roles: RoleCatalog, characters?: CharacterRegistry): ContextResolver {
  return {
    resolve: (bearer, characterId) => (bearer === undefined
      ? { ok: true, ctx: devContext(roles, characters, characterId), noticePending: false }
      : { ok: false }),
  };
}
