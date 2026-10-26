import type { CharacterId } from '@anyidea/protocol';
import type { MemoryStore } from '../../src/memory/store.ts';

export interface Who { ownerId: string; agentId: string }
export interface SeededOwner extends Who { deviceId: string }

/** Owner + device + one agent (default xiaonuan). Older tests got all three from createOwner. */
export function seedOwner(store: MemoryStore, tokenHash: string, now = 1_000, characterId: CharacterId = 'xiaonuan'): SeededOwner {
  const created = store.createOwner({ tokenHash, now });
  return { ...created, agentId: store.ensureAgent(created.ownerId, characterId, now).id };
}

/** Another character's agent under the same owner. */
export function agentOf(store: MemoryStore, ownerId: string, characterId: CharacterId, now = 1_000): Who {
  return { ownerId, agentId: store.ensureAgent(ownerId, characterId, now).id };
}

/** Unextracted, non-excluded user rows of one agent. Replaces the removed snapshotRows in tests. */
export function pendingUserRows(store: MemoryStore, ownerId: string, agentId: string): Array<{ role: 'user'; text: string }> {
  return store.listPendingMessages(ownerId, agentId)
    .filter((row) => row.role === 'user')
    .map((row) => ({ role: 'user' as const, text: row.text }));
}

/** Shared profile facts first, then this agent's facts. Replaces the removed listFacts in tests. */
export function factRows(store: MemoryStore, ownerId: string, agentId: string): Array<{ category: string; text: string }> {
  return [
    ...store.listProfileFacts(ownerId).map(({ category, text }) => ({ category, text })),
    ...store.listAgentFacts(ownerId, agentId).map(({ category, text }) => ({ category, text })),
  ];
}
