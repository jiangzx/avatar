import type { CharacterId } from './characters.ts';

/** One deletable memory row as shown in settings. Ids are opaque uuids. */
export interface MemoryItem { id: string; text: string }

export interface MemoryFactItem extends MemoryItem {
  category: 'preference' | 'person' | 'health' | 'other' | 'safety';
  sensitive: boolean;
}

export interface MemoryPinnedItem extends MemoryItem { sensitive: boolean }

/** An open thread: the user's own words about something not yet settled (spec 2026-10-28). */
export interface MemoryThreadItem extends MemoryItem {
  kind: 'event' | 'concern' | 'plan';
  sensitive: boolean;
}

/** One session's mood, labels only; the App owns the wording. day = YYYY-MM-DD Asia/Shanghai. */
export interface MemoryMoodItem {
  id: string;
  day: string;
  emotion: 'neutral' | 'happy' | 'sad' | 'love';
  peak: 1 | 2 | 3;
}

/** GET /memory. `characters` lists every character in CHARACTER_IDS order, empty lists for ones never met. */
export interface MemoryOverview {
  profile: { addressing: MemoryItem | null; items: MemoryItem[] };
  characters: Array<{
    character: CharacterId;
    pinned: MemoryPinnedItem[];
    facts: MemoryFactItem[];
    /** Added 2026-10-28; optional so older clients and fixtures stay valid. The gateway always sends them. */
    threads?: MemoryThreadItem[];
    reflections?: MemoryItem[];
    moods?: MemoryMoodItem[];
  }>;
}

/** DELETE /memory?scope=... */
export type MemoryClearScope = 'profile' | 'character' | 'all';
