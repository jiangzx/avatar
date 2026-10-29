import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import type { AffectCard, AffectSummary } from '../src/session/affect.ts';
import { summarizeMood } from '../src/session/mood.ts';
import { seedOwner } from './helpers/memory.ts';

const summary = (byEmotion: Partial<AffectSummary['byEmotion']>, crisis: 0 | 1 = 0): AffectSummary => ({
  calls: 3, failures: 0, crisis, exhaustedArmed: 0, exhaustedRevoked: 0,
  byEmotion: { neutral: 0, happy: 0, sad: 0, love: 0, ...byEmotion },
});
const card = (over: Partial<AffectCard> = {}): AffectCard => ({
  emotion: 'happy', intensity: 1, trend: 'better', need: 'share_joy', strategy: 'affirm', mismatch: false, crisis: false, ...over,
});

describe('summarizeMood', () => {
  it('takes the most frequent emotion, the peak, and the last card as the ending', () => {
    expect(summarizeMood(summary({ sad: 2, happy: 1 }), card({ emotion: 'happy', intensity: 1, trend: 'better' }), 3, 's1')).toEqual({
      sessionId: 's1', dominant: 'sad', peakIntensity: 3, endEmotion: 'happy', endIntensity: 1, endTrend: 'better', crisis: false,
    });
  });

  it('breaks ties toward the emotion that matters most for care', () => {
    expect(summarizeMood(summary({ happy: 1, sad: 1 }), null, 1, 's1')!.dominant).toBe('sad');
    expect(summarizeMood(summary({ happy: 1, love: 1 }), null, 1, 's1')!.dominant).toBe('love');
  });

  it('falls back to the dominant emotion when the last card was cleared, and flags a crisis', () => {
    expect(summarizeMood(summary({ sad: 1 }, 1), null, 2, 's1')).toEqual({
      sessionId: 's1', dominant: 'sad', peakIntensity: 2, endEmotion: 'sad', endIntensity: 1, endTrend: 'flat', crisis: true,
    });
  });

  it('writes nothing when no card was accepted', () => {
    expect(summarizeMood(summary({}), null, 0, 's1')).toBeNull();
  });
});

describe('mood summary store', () => {
  const dbs: DatabaseSync[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });
  const input = { sessionId: 's1', dominant: 'sad', peakIntensity: 2, endEmotion: 'sad', endIntensity: 1, endTrend: 'flat', crisis: false } as const;

  it('stores after the notice, lists newest first, and skips a declined or un-notified owner', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(db);
    const store = new SqliteMemoryStore(db);
    const w = seedOwner(store, 'h1');
    expect(store.recordMoodSummary(w.ownerId, w.agentId, input, 100)).toBe(false); // notice not played yet
    store.markNotified(w.ownerId, 50);
    expect(store.recordMoodSummary(w.ownerId, w.agentId, input, 100)).toBe(true);
    expect(store.recordMoodSummary(w.ownerId, w.agentId, { ...input, sessionId: 's2', dominant: 'happy', endEmotion: 'happy' }, 200)).toBe(true);
    const rows = store.listMoodSummaries(w.ownerId, w.agentId, 5);
    expect(rows.map((r) => [r.sessionId, r.dominant, r.createdAt])).toEqual([['s2', 'happy', 200], ['s1', 'sad', 100]]);
    expect(rows[1]).toMatchObject({ peakIntensity: 2, endIntensity: 1, endTrend: 'flat', crisis: false });
    expect(store.listMoodSummaries(w.ownerId, w.agentId, 1)).toHaveLength(1);
    store.wipeOwnerMemory(w.ownerId); // decline
    expect(store.recordMoodSummary(w.ownerId, w.agentId, input, 300)).toBe(false);
  });
});
