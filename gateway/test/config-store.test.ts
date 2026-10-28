import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigConflictError, ConfigInvalidError } from '../src/config-store/errors.ts';
import type { Overlay } from '../src/config-store/keys.ts';
import { SqliteConfigStore, fixedConfigSource } from '../src/config-store/store.ts';
import { defaultLogger } from '../src/log/logger.ts';
import { openDatabase } from '../src/memory/db.ts';

interface FakeSnapshot { version: number; overlay: Overlay }

let db: DatabaseSync;
let clock = 1_000;
const builds: Overlay[] = [];
function build(overlay: Overlay, version: number): FakeSnapshot {
  builds.push(overlay);
  if ('pacing:bad' in overlay) throw new ConfigInvalidError([{ key: 'pacing:bad', message: '不行' }]);
  return { version, overlay };
}
function makeStore() {
  return new SqliteConfigStore<FakeSnapshot>({ db, build, logger: defaultLogger(), now: () => clock });
}

beforeEach(() => { db = openDatabase(':memory:', { busyTimeoutMs: 1000 }); builds.length = 0; clock = 1_000; });
afterEach(() => { if (db.isOpen) db.close(); });

describe('SqliteConfigStore', () => {
  it('starts at version 0 with an empty overlay', () => {
    const store = makeStore();
    expect(store.activeVersion()).toBe(0);
    expect(store.activeOverlay()).toEqual({});
    expect(store.snapshot()).toEqual({ version: 0, overlay: {} });
    expect(store.startupIssues).toEqual([]);
  });

  it('publishes, persists and reloads the active overlay', () => {
    const store = makeStore();
    clock = 2_000;
    const row = store.publish({ baseVersion: 0, changes: { 'pacing:restReminder.firstAfterMs': 5_400_000 }, actor: 'admin', note: '调休息提醒' });
    expect(row).toEqual({ id: 1, createdAt: 2_000, baseVersion: 0, kind: 'publish', note: '调休息提醒', actor: 'admin', overlay: { 'pacing:restReminder.firstAfterMs': 5_400_000 } });
    expect(store.snapshot()).toEqual({ version: 1, overlay: { 'pacing:restReminder.firstAfterMs': 5_400_000 } });
    const reloaded = makeStore();
    expect(reloaded.activeVersion()).toBe(1);
    expect(reloaded.snapshot().overlay).toEqual({ 'pacing:restReminder.firstAfterMs': 5_400_000 });
  });

  it('merges changes and removals onto the active overlay', () => {
    const store = makeStore();
    store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 3, 'affect:enabled': false }, actor: 'admin' });
    store.publish({ baseVersion: 1, changes: { 'memory:listMaxItems': 4 }, removals: ['affect:enabled'], actor: 'admin' });
    expect(store.activeOverlay()).toEqual({ 'memory:listMaxItems': 4 });
  });

  it('rejects a stale baseVersion without building', () => {
    const store = makeStore();
    store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 3 }, actor: 'admin' });
    builds.length = 0;
    expect(() => store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 4 }, actor: 'admin' })).toThrow(ConfigConflictError);
    expect(builds).toEqual([]);
    try { store.preview({ baseVersion: 0, changes: {} }); } catch (error) { expect((error as ConfigConflictError).activeVersion).toBe(1); }
  });

  it('keeps the old snapshot when the build fails', () => {
    const store = makeStore();
    expect(() => store.publish({ baseVersion: 0, changes: { 'pacing:bad': 1 }, actor: 'admin' })).toThrow(ConfigInvalidError);
    expect(store.activeVersion()).toBe(0);
    expect(store.versions({ limit: 10 })).toEqual([]);
  });

  it('rejects unknown keys, bad values and empty publishes', () => {
    const store = makeStore();
    expect(() => store.publish({ baseVersion: 0, changes: { 'nope:x': 1 }, actor: 'admin' })).toThrow(ConfigInvalidError);
    expect(() => store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': { a: 1 } as never }, actor: 'admin' })).toThrow(ConfigInvalidError);
    try {
      store.publish({ baseVersion: 0, changes: {}, actor: 'admin' });
    } catch (error) {
      expect((error as ConfigInvalidError).issues).toEqual([{ key: null, message: '没有需要发布的改动。' }]);
    }
  });

  it('previews without persisting', () => {
    const store = makeStore();
    const result = store.preview({ baseVersion: 0, changes: { 'memory:listMaxItems': 3 } });
    expect(result.overlay).toEqual({ 'memory:listMaxItems': 3 });
    expect(store.activeVersion()).toBe(0);
  });

  it('rolls back by copying an older overlay into a new version', () => {
    const store = makeStore();
    store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 3 }, actor: 'admin' });
    store.publish({ baseVersion: 1, changes: { 'memory:listMaxItems': 4 }, actor: 'admin' });
    const row = store.rollback({ toVersion: 1, baseVersion: 2, actor: 'admin' });
    expect(row.kind).toBe('rollback');
    expect(row.id).toBe(3);
    expect(row.note).toBe('回滚到版本 1');
    expect(store.activeOverlay()).toEqual({ 'memory:listMaxItems': 3 });
    expect(store.rollback({ toVersion: 0, baseVersion: 3, actor: 'admin' }).overlay).toEqual({});
    expect(() => store.rollback({ toVersion: 99, baseVersion: 4, actor: 'admin' })).toThrow(ConfigInvalidError);
  });

  it('resets one key or everything', () => {
    const store = makeStore();
    store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 3, 'affect:enabled': false }, actor: 'admin' });
    expect(store.reset({ keys: ['affect:enabled'], baseVersion: 1, actor: 'admin' }).overlay).toEqual({ 'memory:listMaxItems': 3 });
    expect(store.reset({ keys: 'all', baseVersion: 2, actor: 'admin' }).overlay).toEqual({});
    expect(store.versions({ limit: 2 }).map((v) => v.kind)).toEqual(['reset', 'reset']);
    expect(store.versions({ limit: 10, before: 2 }).map((v) => v.id)).toEqual([1]);
  });

  it('falls back to the baseline when the stored overlay no longer builds', () => {
    const store = makeStore();
    store.publish({ baseVersion: 0, changes: { 'memory:listMaxItems': 3 }, actor: 'admin' });
    // Simulate a repo change that makes version 1 invalid.
    db.prepare('UPDATE config_versions SET overlay = ? WHERE id = 1').run(JSON.stringify({ 'pacing:bad': 1 }));
    const reloaded = makeStore();
    expect(reloaded.activeVersion()).toBe(0);
    expect(reloaded.snapshot()).toEqual({ version: 0, overlay: {} });
    expect(reloaded.startupIssues).toEqual([{ key: 'pacing:bad', message: '不行' }]);
  });

  it('fixedConfigSource always returns the same snapshot', () => {
    const snap = { version: 0, overlay: {} };
    expect(fixedConfigSource(snap).snapshot()).toBe(snap);
  });
});
