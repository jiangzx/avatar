import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { agentOf, seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

function setup() {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  const store = new SqliteMemoryStore(db);
  const a = seedOwner(store, 'h1');
  const b = agentOf(store, a.ownerId, 'xiaokai');
  return { store, a, b };
}

describe('proactive store', () => {
  it('keeps one tier per character', () => {
    const { store, a, b } = setup();
    expect(store.getProactiveTier(a.ownerId, a.agentId)).toBeUndefined();
    store.setProactiveTier(a.ownerId, a.agentId, 'quiet', 1);
    store.setProactiveTier(a.ownerId, a.agentId, 'active', 2);
    expect(store.getProactiveTier(a.ownerId, a.agentId)).toBe('active');
    expect(store.getProactiveTier(a.ownerId, b.agentId)).toBeUndefined();
  });

  it('counts outcomes per intent kind', () => {
    const { store, a, b } = setup();
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'routine', 'accepted', 1);
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'routine', 'rejected', 2);
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'routine', 'accepted', 3);
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'thread_followup', 'rejected', 4);
    store.recordProactiveOutcome(a.ownerId, b.agentId, 'routine', 'accepted', 5);
    expect(store.proactiveStats(a.ownerId, a.agentId)).toEqual([
      { kind: 'routine', accepted: 2, rejected: 1 },
      { kind: 'thread_followup', accepted: 0, rejected: 1 },
    ]);
  });

  it('reads when an intent kind last had an outcome', () => {
    const { store, a, b } = setup();
    expect(store.proactiveLastAt(a.ownerId, a.agentId, 'humanConnection')).toBeNull();
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'humanConnection', 'accepted', 5);
    store.recordProactiveOutcome(a.ownerId, a.agentId, 'humanConnection', 'rejected', 9);
    expect(store.proactiveLastAt(a.ownerId, a.agentId, 'humanConnection')).toBe(9);
    expect(store.proactiveLastAt(a.ownerId, b.agentId, 'humanConnection')).toBeNull();
  });

  it('counts proactive lines per day', () => {
    const { store, a } = setup();
    expect(store.proactiveDaily(a.ownerId, a.agentId, '2026-11-02')).toBe(0);
    expect(store.incrementProactiveDaily(a.ownerId, a.agentId, '2026-11-02')).toBe(1);
    expect(store.incrementProactiveDaily(a.ownerId, a.agentId, '2026-11-02')).toBe(2);
    expect(store.incrementProactiveDaily(a.ownerId, a.agentId, '2026-11-03')).toBe(1);
    expect(store.proactiveDaily(a.ownerId, a.agentId, '2026-11-02')).toBe(2);
  });

  it('resets the daily count for one day only', () => {
    const { store, a } = setup();
    store.incrementProactiveDaily(a.ownerId, a.agentId, '2026-11-02');
    store.incrementProactiveDaily(a.ownerId, a.agentId, '2026-11-02');
    store.incrementProactiveDaily(a.ownerId, a.agentId, '2026-11-03');
    expect(store.resetProactiveDaily(a.ownerId, '2026-11-02')).toBe(1);
    expect(store.proactiveDaily(a.ownerId, a.agentId, '2026-11-02')).toBe(0);
    expect(store.proactiveDaily(a.ownerId, a.agentId, '2026-11-03')).toBe(1);
  });

  it('remembers the most recent fallback lines per key, newest first, up to keep', () => {
    const { store, a } = setup();
    store.recordFallbackLine(a.ownerId, a.agentId, 'checkin', 2, 10, 3);
    store.recordFallbackLine(a.ownerId, a.agentId, 'checkin', 0, 20, 3);
    store.recordFallbackLine(a.ownerId, a.agentId, 'checkin', 4, 30, 3);
    store.recordFallbackLine(a.ownerId, a.agentId, 'checkin', 1, 40, 3);
    store.recordFallbackLine(a.ownerId, a.agentId, 'checkin', 0, 50, 3); // reused: moves to the front
    store.recordFallbackLine(a.ownerId, a.agentId, 'rest', 3, 60, 3);
    expect(store.recentFallbackLines(a.ownerId, a.agentId, 'checkin', 10)).toEqual([0, 1, 4]);
    expect(store.recentFallbackLines(a.ownerId, a.agentId, 'checkin', 2)).toEqual([0, 1]);
    expect(store.recentFallbackLines(a.ownerId, a.agentId, 'rest', 10)).toEqual([3]);
  });

  it('ignores a foreign owner', () => {
    const { store, a } = setup();
    const other = seedOwner(store, 'h2');
    store.setProactiveTier(other.ownerId, a.agentId, 'quiet', 1);
    store.recordProactiveOutcome(other.ownerId, a.agentId, 'routine', 'accepted', 1);
    expect(store.incrementProactiveDaily(other.ownerId, a.agentId, '2026-11-02')).toBe(0);
    store.recordFallbackLine(other.ownerId, a.agentId, 'checkin', 1, 1, 3);
    expect(store.getProactiveTier(a.ownerId, a.agentId)).toBeUndefined();
    expect(store.proactiveStats(a.ownerId, a.agentId)).toEqual([]);
    expect(store.recentFallbackLines(a.ownerId, a.agentId, 'checkin', 10)).toEqual([]);
  });
});
