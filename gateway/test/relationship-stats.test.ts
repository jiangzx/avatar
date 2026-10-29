import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore, relationshipStatsOf } from '../src/memory/store.ts';
import { agentOf, seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });
const at = (iso: string) => Date.parse(iso);

describe('relationshipStatsOf', () => {
  it('is empty with no sessions', () => {
    expect(relationshipStatsOf([])).toEqual({
      firstMetAt: null, sessions: 0, totalMinutes: 0, activeDays: 0, lastSessionAt: null, hourHistogram: Array(24).fill(0),
    });
  });
});

describe('relationshipStats', () => {
  it('counts this agent’s ended sessions in Asia/Shanghai time', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(db);
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1');
    const b = agentOf(store, a.ownerId, 'xiaokai');
    const session = (id: string, agentId: string, start: string, end: string | null) => {
      store.recordSessionStart(id, agentId, at(start));
      if (end) store.recordSessionEnd(id, agentId, at(end));
    };
    session('s1', a.agentId, '2026-11-02T09:10:00+08:00', '2026-11-02T09:40:00+08:00');
    session('s2', a.agentId, '2026-11-02T20:00:00+08:00', '2026-11-02T20:30:00+08:00');
    // 00:05 Beijing is still the previous UTC day: the day and hour must use Beijing time.
    session('s3', a.agentId, '2026-11-04T00:05:00+08:00', '2026-11-04T00:20:00+08:00');
    session('open', a.agentId, '2026-11-05T10:00:00+08:00', null);
    session('other', b.agentId, '2026-11-01T10:00:00+08:00', '2026-11-01T11:00:00+08:00');
    const stats = store.relationshipStats(a.ownerId, a.agentId);
    const hours = Array(24).fill(0);
    hours[9] = 1; hours[20] = 1; hours[0] = 1;
    expect(stats).toEqual({
      firstMetAt: at('2026-11-02T09:10:00+08:00'),
      sessions: 3,
      totalMinutes: 75,
      activeDays: 2,
      lastSessionAt: at('2026-11-04T00:05:00+08:00'),
      hourHistogram: hours,
    });
    // A foreign owner sees nothing.
    const other = seedOwner(store, 'h2');
    expect(store.relationshipStats(other.ownerId, a.agentId).sessions).toBe(0);
  });
});
