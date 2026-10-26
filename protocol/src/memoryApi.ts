import type { CharacterId } from './characters.ts';

/** One deletable memory row as shown in settings. Ids are opaque uuids. */
export interface MemoryItem { id: string; text: string }

export interface MemoryFactItem extends MemoryItem {
  category: 'preference' | 'person' | 'health' | 'other' | 'safety';
  sensitive: boolean;
}

export interface MemoryPinnedItem extends MemoryItem { sensitive: boolean }

/** GET /memory. `characters` lists every character in CHARACTER_IDS order, empty lists for ones never met. */
export interface MemoryOverview {
  profile: { addressing: MemoryItem | null; items: MemoryItem[] };
  characters: Array<{ character: CharacterId; pinned: MemoryPinnedItem[]; facts: MemoryFactItem[] }>;
}

/** DELETE /memory?scope=... */
export type MemoryClearScope = 'profile' | 'character' | 'all';
