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
  const add = (w: { ownerId: string; agentId: string }, id: string, quote: string | null, kind: string, createdAt: number, doneAt: number | null = null) =>
    db.prepare(`INSERT INTO followups (id, owner_id, agent_id, text, due_at, done_at, source_session_id, quote, sensitive, created_at, kind)
      VALUES (?, ?, ?, 'summary', 5000, ?, 's1', ?, 1, ?, ?)`).run(id, w.ownerId, w.agentId, doneAt, quote, createdAt, kind);
  return { db, store, a, b, add };
}

describe('thread store', () => {
  it('lists only this agent’s open quoted followups, newest first', () => {
    const { store, a, b, add } = setup();
    add(a, 't-old', '我腿疼', 'concern', 10);
    add(a, 't-new', '我后天去复查', 'event', 20);
    add(a, 'plain', null, 'concern', 30);
    add(a, 'done', '想学太极', 'plan', 40, 41);
    add(b, 'other', '别的角色的事', 'concern', 50);
    expect(store.listOpenThreads(a.ownerId, a.agentId)).toEqual([
      { id: 't-new', kind: 'event', quote: '我后天去复查', dueAt: 5000, sensitive: true, mentionCount: 0, lastMentionedAt: null, createdAt: 20, sourceSessionId: 's1' },
      { id: 't-old', kind: 'concern', quote: '我腿疼', dueAt: 5000, sensitive: true, mentionCount: 0, lastMentionedAt: null, createdAt: 10, sourceSessionId: 's1' },
    ]);
  });

  it('counts mentions and closes a thread, clearing its quote', () => {
    const { db, store, a, add } = setup();
    add(a, 't1', '我腿疼', 'concern', 10);
    expect(store.markThreadMentioned(a.ownerId, 't1', 100)).toBe(true);
    expect(store.markThreadMentioned(a.ownerId, 't1', 200)).toBe(true);
    expect(store.listOpenThreads(a.ownerId, a.agentId)[0]).toMatchObject({ mentionCount: 2, lastMentionedAt: 200 });
    expect(store.closeThread(a.ownerId, 't1', 'resolved', 300)).toBe(true);
    expect(store.listOpenThreads(a.ownerId, a.agentId)).toEqual([]);
    expect(db.prepare('SELECT done_at, close_reason, quote FROM followups WHERE id = ?').get('t1')).toEqual({ done_at: 300, close_reason: 'resolved', quote: null });
    // Closed threads cannot be mentioned or closed again.
    expect(store.markThreadMentioned(a.ownerId, 't1', 400)).toBe(false);
    expect(store.closeThread(a.ownerId, 't1', 'declined', 400)).toBe(false);
    // The audit row is content-free.
    expect(db.prepare("SELECT op, diff FROM memory_changes WHERE row_id = 't1' AND op = 'close'").all()).toEqual([{ op: 'close', diff: '' }]);
  });

  it('never touches another owner’s thread', () => {
    const { store, a, add } = setup();
    const other = seedOwner(store, 'h2');
    add(a, 't1', '我腿疼', 'concern', 10);
    expect(store.markThreadMentioned(other.ownerId, 't1', 100)).toBe(false);
    expect(store.closeThread(other.ownerId, 't1', 'resolved', 100)).toBe(false);
    expect(store.listOpenThreads(a.ownerId, a.agentId)).toHaveLength(1);
  });
});
