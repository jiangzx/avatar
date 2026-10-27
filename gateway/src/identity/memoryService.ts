import { CHARACTER_IDS, type CharacterId, type MemoryClearScope, type MemoryOverview } from '@anyidea/protocol';
import type { SafetyRules } from '../config.ts';
import { defaultLogger, type Logger } from '../log/logger.ts';
import { ownerShortId } from '../log/ownerId.ts';
import { ftsMatch } from '../memory/fts.ts';
import type { AgentRecord, DeletedItem, MemoryStore } from '../memory/store.ts';
import { cleanUserLine, trimEdges } from '../memory/userText.ts';
import { hashToken } from './tokens.ts';

/** What the settings page needs (spec §7). Owner comes from the bearer only; never from a body. */
export interface MemoryService {
  ownerOf(bearer: string): string | undefined;
  overview(ownerId: string): MemoryOverview;
  setAddressing(ownerId: string, text: string): 'ok' | 'declined' | 'rejected';
  deleteItem(ownerId: string, itemId: string): boolean;          // Q35/Q36 source deletion inside
  clear(ownerId: string, scope: MemoryClearScope, characterId?: CharacterId): void;
}

export interface MemoryServiceDeps {
  store: MemoryStore;
  safety: SafetyRules;
  now?: () => number;
  logger?: Logger;
}

/** Upper bound on lines one fallback match may delete; the FTS match is already all-tokens. */
const FALLBACK_MATCH_LIMIT = 200;

const TABLE_OF: Record<DeletedItem['kind'], string> = {
  profile: 'profile_facts',
  agent_fact: 'agent_facts',
  pinned: 'pinned_memories',
};

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const { store, safety } = deps;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? defaultLogger();

  const agentFor = (ownerId: string, characterId: CharacterId): AgentRecord | undefined =>
    store.listAgents(ownerId).find((agent) => agent.characterId === characterId);

  /** Q35/Q36: source ids first; no ids → the forget-style match. Private → its agent, shared → every agent. */
  const deleteSources = (ownerId: string, item: DeletedItem): { deleted: number; fallback: boolean } => {
    const scope = item.kind === 'profile' ? null : item.agentId;
    if (item.sourceMessageIds.length > 0) {
      // Dangling ids (forgotten or expired lines) simply match nothing.
      return { deleted: store.deleteMessagesByIds(ownerId, scope, item.sourceMessageIds), fallback: false };
    }
    const match = ftsMatch(item.text, 'all');
    if (!match) return { deleted: 0, fallback: true };
    const ids = store.matchMessageIds(ownerId, scope, match, FALLBACK_MATCH_LIMIT);
    return { deleted: ids.length > 0 ? store.deleteMessagesByIds(ownerId, scope, ids) : 0, fallback: true };
  };

  return {
    ownerOf(bearer) {
      return store.findDevice(hashToken(bearer))?.ownerId;
    },

    overview(ownerId) {
      const profile = store.listProfileFacts(ownerId);
      const addressing = profile.find((row) => row.category === 'addressing');
      const agents = store.listAgents(ownerId);
      return {
        profile: {
          addressing: addressing ? { id: addressing.id, text: addressing.text } : null,
          items: profile.filter((row) => row.category === 'profile').map((row) => ({ id: row.id, text: row.text })),
        },
        // Every character in display order; one never met has empty lists.
        characters: CHARACTER_IDS.map((character) => {
          const agent = agents.find((row) => row.characterId === character);
          if (!agent) return { character, pinned: [], facts: [] };
          return {
            character,
            pinned: store.listPinned(ownerId, agent.id).map((row) => ({ id: row.id, text: row.text, sensitive: row.sensitive })),
            facts: store.listAgentFacts(ownerId, agent.id)
              .map((row) => ({ id: row.id, text: row.text, category: row.category, sensitive: row.sensitive })),
          };
        }),
      };
    },

    setAddressing(ownerId, text) {
      const owner = store.getOwner(ownerId);
      if (!owner) return 'rejected';
      if (owner.memoryConsent === 'declined') return 'declined';
      // Typed in settings, not spoken: the notice gate does not apply here (spec §7, on purpose).
      const cleaned = cleanUserLine(trimEdges(text), safety);
      if (!cleaned.ok) return 'rejected';
      const old = store.listProfileFacts(ownerId).find((row) => row.category === 'addressing');
      store.immediate(() => {
        store.bumpOwnerEpoch(ownerId);
        store.setAddressing(ownerId, cleaned.text, now());
        if (old) store.scrubChangeDiffs(ownerId, { rowId: old.id });
        store.recordMemoryChange({ ownerId, agentId: null, table: 'profile_facts', rowId: 'addressing', op: 'set', now: now() });
      });
      logger.child({ oid: ownerShortId(ownerId) }).info('memory_addressing_set');
      return 'ok';
    },

    deleteItem(ownerId, itemId) {
      const startedAt = now();
      const outcome = store.immediate(() => {
        const item = store.deleteMemoryItem(ownerId, itemId);
        if (!item) return null;
        // Same transaction as the delete: an in-flight extraction re-checks the epochs and goes stale.
        if (item.kind === 'profile' || item.agentId === null) store.bumpOwnerEpoch(ownerId);
        else store.bumpAgentEpoch(ownerId, item.agentId);
        const sources = deleteSources(ownerId, item);
        store.scrubChangeDiffs(ownerId, { rowId: itemId });
        store.recordMemoryChange({ ownerId, agentId: item.agentId, table: TABLE_OF[item.kind], rowId: itemId, op: 'delete', now: now() });
        return { kind: item.kind, ...sources };
      });
      if (!outcome) return false;
      logger.child({ oid: ownerShortId(ownerId) }).info('memory_item_deleted', { kind: outcome.kind, sources: outcome.deleted, fallback: outcome.fallback, ms: now() - startedAt });
      return true;
    },

    clear(ownerId, scope, characterId) {
      const startedAt = now();
      store.immediate(() => {
        if (scope === 'profile') {
          store.bumpOwnerEpoch(ownerId);
          store.clearProfile(ownerId);
          store.scrubChangeDiffs(ownerId, { table: 'profile_facts' });
        } else if (scope === 'character') {
          const agent = characterId ? agentFor(ownerId, characterId) : undefined;
          if (!agent) return; // never met: nothing to clear
          store.bumpAgentEpoch(ownerId, agent.id);
          store.clearAgentMemory(ownerId, agent.id); // keeps the agent row: next session is a first meeting
          store.scrubChangeDiffs(ownerId, { agentId: agent.id });
        } else {
          store.bumpOwnerEpoch(ownerId);
          store.clearAllMemory(ownerId); // keeps owners/devices/agents/consent, unlike wipeOwnerMemory
          store.scrubChangeDiffs(ownerId, {});
        }
        store.recordMemoryChange({ ownerId, agentId: null, table: 'memory', rowId: scope, op: 'clear', now: now() });
      });
      logger.child({ oid: ownerShortId(ownerId) }).info('memory_cleared', { scope, ms: now() - startedAt });
    },
  };
}
