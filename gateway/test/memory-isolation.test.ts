import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { bigrams } from '../src/memory/bigram.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore, type ExtractionChange } from '../src/memory/store.ts';
import { ftsMatch } from '../src/session/tools/recall.ts';
import { agentOf, seedOwner, type Who } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
});

/** One owner, two characters: A = xiaonuan writes, B = xiaokai reads. */
function setup() {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  const store = new SqliteMemoryStore(db);
  const a = seedOwner(store, 'iso', 1, 'xiaonuan');
  const b = agentOf(store, a.ownerId, 'xiaokai');
  return { db, store, a, b };
}

function say(store: SqliteMemoryStore, who: Who, id: string, text: string, now: number, sessionId: string): void {
  store.insertMessage({ id, sessionId, ownerId: who.ownerId, agentId: who.agentId, role: 'user', text, bigrams: bigrams(text), now });
}

const change = (partial: Partial<ExtractionChange>): ExtractionChange => ({ now: 10, messageIds: [], facts: [], notes: [], episodes: [], followups: [], ...partial });

describe('per-character isolation: A writes, B reads nothing', () => {
  it('FTS search', () => {
    const { store, a, b } = setup();
    say(store, a, 'a1', '我喜欢喝茶', 2, 's-a');
    expect(store.searchMessages(a.ownerId, a.agentId, ftsMatch('喜欢喝茶')!, 50)).toEqual([{ text: '我喜欢喝茶' }]);
    expect(store.searchMessages(b.ownerId, b.agentId, ftsMatch('喜欢喝茶')!, 50)).toEqual([]);
  });

  it('LIKE search', () => {
    const { store, a, b } = setup();
    say(store, a, 'a1', '茶', 2, 's-a');
    expect(store.searchMessagesLike(a.ownerId, a.agentId, '%茶%', 50)).toEqual([{ text: '茶' }]);
    expect(store.searchMessagesLike(b.ownerId, b.agentId, '%茶%', 50)).toEqual([]);
  });

  it('recent statements from ended sessions', () => {
    const { store, a, b } = setup();
    store.recordSessionStart('s-a', a.agentId, 1);
    say(store, a, 'a1', '昨天去了公园', 2, 's-a');
    store.recordSessionEnd('s-a', a.agentId, 3);
    expect(store.recentUserMessages(a.ownerId, a.agentId, 12)).toEqual([{ text: '昨天去了公园' }]);
    expect(store.recentUserMessages(b.ownerId, b.agentId, 12)).toEqual([]);
  });

  it('pending messages for extraction', () => {
    const { store, a, b } = setup();
    say(store, a, 'a1', '我喜欢喝茶', 2, 's-a');
    expect(store.listPendingMessages(a.ownerId, a.agentId).map((row) => row.id)).toEqual(['a1']);
    expect(store.listPendingMessages(b.ownerId, b.agentId)).toEqual([]);
    expect(store.agentsPendingExtraction()).toEqual([{ ownerId: a.ownerId, agentId: a.agentId }]);
  });

  it('agent facts and pinned memories', () => {
    const { store, a, b } = setup();
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [{ op: 'add', category: 'preference', text: '喜欢喝茶' }, { op: 'add', category: 'health', text: '膝盖不好' }] }));
    store.insertPinned({ id: 'pin-a', ownerId: a.ownerId, agentId: a.agentId, text: '孙子三月三号生日', sensitive: false, sourceSessionId: 's-a', sourceMessageId: null, now: 5 });
    expect(store.listAgentFacts(a.ownerId, a.agentId)).toHaveLength(2);
    expect(store.listAgentFacts(b.ownerId, b.agentId)).toEqual([]);
    expect(store.listPinned(a.ownerId, a.agentId)).toHaveLength(1);
    expect(store.listPinned(b.ownerId, b.agentId)).toEqual([]);
  });

  it('notes, episodes and followups in the extractor memory', () => {
    const { store, a, b } = setup();
    store.recordSessionStart('s-a', a.agentId, 1);
    say(store, a, 'a1', '我喜欢喝茶', 2, 's-a');
    store.writeExtraction(a.ownerId, a.agentId, change({
      messageIds: ['a1'],
      facts: [{ op: 'add', category: 'preference', text: '喜欢喝茶' }, { op: 'add', category: 'profile', text: '老家山东' }],
      notes: [{ op: 'add', text: '说话慢一点' }],
      episodes: [{ op: 'add', summary: '聊了喝茶' }],
      followups: [{ op: 'add', text: '问问喝茶', dueAt: 99 }],
    }));
    const forB = store.memoryForExtract(b.ownerId, b.agentId);
    expect(forB.agents).toEqual([{ id: b.agentId }]);
    expect(forB.facts.map((fact) => fact.text)).toEqual(['老家山东']); // only the shared layer
    expect(forB.notes).toEqual([]);
    expect(forB.episodes).toEqual([]);
    expect(forB.followups).toEqual([]);
    const forA = store.memoryForExtract(a.ownerId, a.agentId);
    expect(forA.facts.map((fact) => fact.text)).toEqual(['老家山东', '喜欢喝茶']);
    expect(forA.notes.map((note) => note.text)).toEqual(['说话慢一点']);
    expect(forA.episodes.map((episode) => episode.summary)).toEqual(['聊了喝茶']);
    expect(forA.followups.map((followup) => followup.text)).toEqual(['问问喝茶']);
  });

  it('forget started from B leaves A untouched', () => {
    const { store, a, b } = setup();
    say(store, a, 'a1', '我喜欢喝茶', 2, 's-a');
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [{ op: 'add', category: 'preference', text: '喜欢喝茶' }], notes: [{ op: 'add', text: '喝茶要热的' }] }));
    store.insertPinned({ id: 'pin-a', ownerId: a.ownerId, agentId: a.agentId, text: '喝茶别放糖', sensitive: false, sourceSessionId: 's-a', sourceMessageId: null, now: 5 });
    const result = store.forgetMatches(b.ownerId, b.agentId, '喝茶', ftsMatch('喝茶', 'all'), 's-b', '我喜欢喝茶');
    expect(result).toEqual({ messages: 0, facts: 0, notes: 0, episodes: 0, followups: 0, pinned: 0, profile: 0, reflections: 0 });
    expect(store.listAgentFacts(a.ownerId, a.agentId)).toHaveLength(1);
    expect(store.listPinned(a.ownerId, a.agentId)).toHaveLength(1);
    expect(store.memoryForExtract(a.ownerId, a.agentId).notes).toHaveLength(1);
    expect(store.searchMessages(a.ownerId, a.agentId, ftsMatch('喜欢喝茶')!, 50)).toEqual([{ text: '我喜欢喝茶' }]);
  });

  it('an extraction for B cannot update or remove A rows', () => {
    const { store, a, b } = setup();
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [{ op: 'add', category: 'preference', text: '喜欢喝茶' }], notes: [{ op: 'add', text: '说话慢一点' }] }));
    const factId = store.listAgentFacts(a.ownerId, a.agentId)[0]!.id;
    const noteId = store.memoryForExtract(a.ownerId, a.agentId).notes[0]!.id;
    store.writeExtraction(b.ownerId, b.agentId, change({
      facts: [{ op: 'update', id: factId, text: '被改了' }, { op: 'remove', id: factId }],
      notes: [{ op: 'remove', id: noteId }],
    }));
    expect(store.listAgentFacts(a.ownerId, a.agentId).map((fact) => fact.text)).toEqual(['喜欢喝茶']);
    expect(store.memoryForExtract(a.ownerId, a.agentId).notes.map((note) => note.text)).toEqual(['说话慢一点']);
  });
});

describe('shared layer', () => {
  it('shows a name and basic facts learned through A to B, but never health', () => {
    const { store, a, b } = setup();
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [
      { op: 'add', category: 'addressing', text: '王叔' },
      { op: 'add', category: 'profile', text: '退休前是中学老师' },
      { op: 'add', category: 'health', text: '有高血压' },
    ] }));
    expect(store.listProfileFacts(b.ownerId).map(({ category, text }) => ({ category, text }))).toEqual([
      { category: 'addressing', text: '王叔' },
      { category: 'profile', text: '退休前是中学老师' },
    ]);
    expect(store.listAgentFacts(b.ownerId, b.agentId)).toEqual([]);
    expect(store.listAgentFacts(a.ownerId, a.agentId).map((fact) => fact.text)).toEqual(['有高血压']);
  });
});

describe('cross-owner isolation', () => {
  it('keeps another owner out of every agent-scoped read', () => {
    const { store, a } = setup();
    const other = seedOwner(store, 'other', 1);
    store.recordSessionStart('s-a', a.agentId, 1);
    say(store, a, 'a1', '我喜欢喝茶', 2, 's-a');
    store.recordSessionEnd('s-a', a.agentId, 3);
    store.writeExtraction(a.ownerId, a.agentId, change({ facts: [{ op: 'add', category: 'profile', text: '老家山东' }, { op: 'add', category: 'preference', text: '喜欢喝茶' }] }));
    // A forged pairing (other owner + A's agent) sees nothing.
    expect(store.searchMessages(other.ownerId, a.agentId, ftsMatch('喜欢喝茶')!, 50)).toEqual([]);
    expect(store.recentUserMessages(other.ownerId, a.agentId, 12)).toEqual([]);
    expect(store.listAgentFacts(other.ownerId, a.agentId)).toEqual([]);
    expect(store.listProfileFacts(other.ownerId)).toEqual([]);
    expect(store.listPendingMessages(other.ownerId, a.agentId)).toEqual([]);
  });
});
