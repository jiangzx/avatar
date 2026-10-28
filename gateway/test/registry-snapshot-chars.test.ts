import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { DeviceRegistry } from '../src/identity/registry.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { shippedCharacters, shippedRoles } from './support/shipped.ts';

let db: DatabaseSync | null = null;
afterEach(() => { if (db?.isOpen) db.close(); db = null; });

describe('DeviceRegistry snapshotMaxChars', () => {
  it('reads a getter on every resolve', () => {
    db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    let reads = 0;
    const registry = new DeviceRegistry({
      store: new SqliteMemoryStore(db),
      roles: shippedRoles(),
      characters: shippedCharacters(),
      continuityGapMs: 600_000,
      limits: { maxOwners: 10, dailyCap: 10, orphanOwnerDays: 7, orphanCleanupBatch: 2 },
      snapshotMaxChars: () => { reads++; return 300; },
    });
    const registered = registry.register();
    if (!registered.ok) throw new Error(registered.error);
    expect(registry.resolve(registered.deviceToken, 'xiaonuan').ok).toBe(true);
    expect(registry.resolve(registered.deviceToken, 'xiaokai').ok).toBe(true);
    expect(reads).toBe(2);
  });
});
