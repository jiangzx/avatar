import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BASELINE_VERSION, MIGRATIONS, migrate } from '../src/memory/migrations.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { agentOf, seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

function rawDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys = ON');
  dbs.push(db);
  return db;
}
function storeDb(): { db: DatabaseSync; store: SqliteMemoryStore } {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  return { db, store: new SqliteMemoryStore(db) };
}

const columns = (db: DatabaseSync, table: string): string[] =>
  db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => (row as { name: string }).name);
const names = (db: DatabaseSync, type: 'table' | 'index' | 'trigger'): string[] =>
  db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type).map((row) => (row as { name: string }).name);
const count = (db: DatabaseSync, sql: string, ...args: (string | number)[]): number => (db.prepare(sql).get(...args) as { n: number }).n;

function message(db: DatabaseSync, w: { ownerId: string; agentId: string }, id: string, text: string, session = 's1'): void {
  db.prepare(`INSERT INTO messages (id, session_id, owner_id, agent_id, role, text, bigrams, created_at)
    VALUES (?, ?, ?, ?, 'user', ?, '', 1)`).run(id, session, w.ownerId, w.agentId, text);
}
function thread(db: DatabaseSync, w: { ownerId: string; agentId: string }, id: string, quote: string | null, sources: string[]): void {
  db.prepare(`INSERT INTO followups (id, owner_id, agent_id, text, due_at, source_session_id, quote, sensitive, created_at, source_message_ids)
    VALUES (?, ?, ?, 'summary', 9, 's1', ?, 1, 1, ?)`).run(id, w.ownerId, w.agentId, quote, JSON.stringify(sources));
}
function reflection(db: DatabaseSync, w: { ownerId: string; agentId: string }, id: string, text: string, evidence: string[]): void {
  db.prepare(`INSERT INTO reflections (id, owner_id, agent_id, text, evidence_message_ids, session_id, created_at)
    VALUES (?, ?, ?, ?, ?, 's1', 1)`).run(id, w.ownerId, w.agentId, text, JSON.stringify(evidence));
}

describe('schema v8', () => {
  it('is the latest version', () => {
    expect(BASELINE_VERSION + MIGRATIONS.length - 1).toBe(9);
    expect(migrate(rawDb())).toBe(9);
  });

  it('turns followups into threads and adds the proactivity tables and citation triggers', () => {
    const db = rawDb();
    migrate(db);
    expect(columns(db, 'followups')).toEqual([
      'id', 'owner_id', 'agent_id', 'text', 'due_at', 'done_at', 'source_session_id', 'quote', 'sensitive', 'created_at',
      'kind', 'source_message_ids', 'mention_count', 'last_mentioned_at', 'close_reason',
    ]);
    expect(columns(db, 'reflections')).toEqual(['id', 'owner_id', 'agent_id', 'text', 'evidence_message_ids', 'session_id', 'created_at']);
    expect(columns(db, 'mood_summaries')).toEqual([
      'id', 'owner_id', 'agent_id', 'session_id', 'dominant', 'peak_intensity', 'end_emotion', 'end_intensity', 'end_trend', 'crisis', 'created_at',
    ]);
    expect(columns(db, 'proactive_prefs')).toEqual(['owner_id', 'agent_id', 'tier', 'updated_at']);
    expect(columns(db, 'proactive_stats')).toEqual(['owner_id', 'agent_id', 'kind', 'accepted', 'rejected', 'updated_at']);
    expect(columns(db, 'proactive_daily')).toEqual(['owner_id', 'agent_id', 'day', 'count']);
    expect(columns(db, 'proactive_fallbacks')).toEqual(['owner_id', 'agent_id', 'fallback_key', 'line', 'used_at']);
    expect(names(db, 'index')).toEqual(expect.arrayContaining(['reflections_agent', 'mood_summaries_agent']));
    expect(names(db, 'trigger')).toEqual(expect.arrayContaining(['messages_cite_ad', 'messages_cite_au']));
  });

  it('upgrades a v7 database, defaults kind to concern and links quotes to their user line', () => {
    const db = rawDb();
    expect(migrate(db, MIGRATIONS.slice(0, 2))).toBe(7);
    db.prepare('INSERT INTO owners (id, created_at, last_seen_at) VALUES (?, 1, 1)').run('o7');
    db.prepare('INSERT INTO agents (id, owner_id, character_id, created_at) VALUES (?, ?, ?, 1)').run('a7', 'o7', 'xiaonuan');
    db.prepare("INSERT INTO messages (id, session_id, owner_id, agent_id, role, text, bigrams, created_at) VALUES ('m1', 's7', 'o7', 'a7', 'user', '我明天要去医院复查腰，有点担心。', '', 1)").run();
    db.prepare("INSERT INTO messages (id, session_id, owner_id, agent_id, role, text, bigrams, created_at) VALUES ('m2', 's7', 'o7', 'a7', 'assistant', '我明天要去医院复查腰', '', 2)").run();
    db.prepare(`INSERT INTO followups (id, owner_id, agent_id, text, due_at, source_session_id, quote, sensitive, created_at)
      VALUES ('f1', 'o7', 'a7', '问问复查', 9, 's7', '我明天要去医院复查腰', 1, 3), ('f2', 'o7', 'a7', '接着聊', 9, 's7', NULL, 0, 3)`).run();
    expect(migrate(db)).toBe(9);
    const rows = db.prepare('SELECT id, kind, source_message_ids AS src, mention_count AS mentions FROM followups ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'f1', kind: 'concern', src: '["m1"]', mentions: 0 },
      { id: 'f2', kind: 'concern', src: '[]', mentions: 0 },
    ]);
  });

  it('drops threads and reflections whose cited user line is deleted or blanked', () => {
    const { db, store } = storeDb();
    const w = seedOwner(store, 'h1');
    message(db, w, 'm1', '我明天要去医院复查腰');
    message(db, w, 'm2', '最近总是一个人吃午饭');
    message(db, w, 'm3', '今天天气不错');
    thread(db, w, 't1', '我明天要去医院复查腰', ['m1']);
    thread(db, w, 't2', '最近总是一个人吃午饭', ['m2']);
    thread(db, w, 't3', null, []);
    reflection(db, w, 'r1', '常一个人吃饭', ['m2', 'm3']);
    reflection(db, w, 'r2', '腰不好', ['m1']);
    store.deleteMessagesByIds(w.ownerId, w.agentId, ['m1']);
    expect(db.prepare('SELECT id FROM followups ORDER BY id').all()).toEqual([{ id: 't2' }, { id: 't3' }]);
    expect(db.prepare('SELECT id FROM reflections ORDER BY id').all()).toEqual([{ id: 'r1' }]);
    // Voice forget blanks the line (excluded 0 -> 1) instead of deleting it.
    db.prepare("UPDATE messages SET text = '', bigrams = '', excluded = 1 WHERE id = 'm3'").run();
    expect(db.prepare('SELECT id FROM reflections').all()).toEqual([]);
    expect(db.prepare('SELECT id FROM followups ORDER BY id').all()).toEqual([{ id: 't2' }, { id: 't3' }]);
  });

  it('clears one character’s derived memory but keeps its proactive tier and other characters', () => {
    const { db, store } = storeDb();
    const a = seedOwner(store, 'h1');
    const b = agentOf(store, a.ownerId, 'xiaokai');
    for (const w of [a, b]) {
      reflection(db, w, `r-${w.agentId}`, '常一个人吃饭', []);
      db.prepare(`INSERT INTO mood_summaries (id, owner_id, agent_id, session_id, dominant, peak_intensity, end_emotion, end_intensity, end_trend, crisis, created_at)
        VALUES (?, ?, ?, 's1', 'sad', 2, 'sad', 2, 'flat', 0, 1)`).run(`m-${w.agentId}`, w.ownerId, w.agentId);
      db.prepare("INSERT INTO proactive_prefs (owner_id, agent_id, tier, updated_at) VALUES (?, ?, 'quiet', 1)").run(w.ownerId, w.agentId);
      db.prepare("INSERT INTO proactive_stats (owner_id, agent_id, kind, accepted, rejected, updated_at) VALUES (?, ?, 'routine', 1, 0, 1)").run(w.ownerId, w.agentId);
      db.prepare("INSERT INTO proactive_daily (owner_id, agent_id, day, count) VALUES (?, ?, '2026-11-02', 2)").run(w.ownerId, w.agentId);
      db.prepare("INSERT INTO proactive_fallbacks (owner_id, agent_id, fallback_key, line, used_at) VALUES (?, ?, 'checkin', 0, 1)").run(w.ownerId, w.agentId);
    }
    store.clearAgentMemory(a.ownerId, a.agentId);
    for (const table of ['reflections', 'mood_summaries', 'proactive_stats', 'proactive_daily', 'proactive_fallbacks']) {
      expect(count(db, `SELECT count(*) AS n FROM ${table} WHERE agent_id = ?`, a.agentId), table).toBe(0);
      expect(count(db, `SELECT count(*) AS n FROM ${table} WHERE agent_id = ?`, b.agentId), table).toBe(1);
    }
    expect(count(db, 'SELECT count(*) AS n FROM proactive_prefs WHERE agent_id = ?', a.agentId)).toBe(1);
    // Deleting the owner cascades to every new table.
    store.deleteOwner(a.ownerId);
    for (const table of ['reflections', 'mood_summaries', 'proactive_prefs', 'proactive_stats', 'proactive_daily', 'proactive_fallbacks']) {
      expect(count(db, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    }
  });

  it('voice forget deletes this agent’s matching reflections only', () => {
    const { db, store } = storeDb();
    const a = seedOwner(store, 'h1');
    const b = agentOf(store, a.ownerId, 'xiaokai');
    reflection(db, a, 'ra', '每周三女儿会来', []);
    reflection(db, b, 'rb', '每周三女儿会来', []);
    const result = store.forgetMatches(a.ownerId, a.agentId, '女儿', null, 's-now');
    expect(result.reflections).toBe(1);
    expect(db.prepare('SELECT id FROM reflections').all()).toEqual([{ id: 'rb' }]);
  });
});
