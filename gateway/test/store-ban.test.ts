import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';

describe('owner ban flag', () => {
  it('sets, keeps the first time, clears, and reports missing owners', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    const store = new SqliteMemoryStore(db);
    const { ownerId } = store.createOwner({ tokenHash: 'h'.repeat(64), now: 1 });
    expect(store.isOwnerBanned(ownerId)).toBe(false);
    expect(store.setOwnerBanned(ownerId, 100)).toBe(true);
    expect(store.isOwnerBanned(ownerId)).toBe(true);
    expect(store.setOwnerBanned(ownerId, 200)).toBe(true);
    expect((db.prepare('SELECT banned_at FROM owners WHERE id = ?').get(ownerId) as { banned_at: number }).banned_at).toBe(100);
    expect(store.setOwnerBanned(ownerId, null)).toBe(true);
    expect(store.isOwnerBanned(ownerId)).toBe(false);
    expect(store.setOwnerBanned('00000000-0000-4000-8000-000000000000', 1)).toBe(false);
    expect(store.isOwnerBanned('00000000-0000-4000-8000-000000000000')).toBe(false);
  });
});
