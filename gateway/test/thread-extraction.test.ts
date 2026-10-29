import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadI18n } from '../src/i18n/load.ts';
import { attachQuoteSources, parseExtractBatch, type TextModelClient } from '../src/memory/extract.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { MemoryWorker } from '../src/memory/worker.ts';
import { seedOwner } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });
const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));
const policy = { timeoutMs: 1_000, retries: 0, backoffMs: 0, maxBackoffMs: 0 };
const quoteRules = { maxChars: 80, safety: i18n.safety, evidence: i18n.evidence };

describe('thread kind in extraction ops', () => {
  it('keeps a known kind and drops an unknown one without failing the batch', () => {
    const batch = parseExtractBatch(JSON.stringify({ ops: [
      { op: 'add', table: 'followups', text: '问问复查', dueAt: 9_000, quote: '我明天去复查', kind: 'event' },
      { op: 'add', table: 'followups', text: '问问睡眠', dueAt: 9_000, quote: '最近睡不好', kind: 'worry' },
    ] }));
    expect(batch.ops).toHaveLength(2);
    expect(batch.ops[0]).toMatchObject({ kind: 'event' });
    expect(batch.ops[1]).not.toHaveProperty('kind');
  });

  it('links a kept quote to the user line it was copied from', () => {
    const ops = attachQuoteSources([
      { op: 'add', table: 'followups', text: '问问复查', dueAt: 9_000, quote: '我明天要去医院复查腰' },
      { op: 'add', table: 'followups', text: '接着聊', dueAt: 9_000 },
    ], [{ id: 'm0', text: '你好' }, { id: 'm1', text: '我明天要去医院复查腰，有点担心。' }]);
    expect(ops[0]).toMatchObject({ sourceMessageIds: ['m1'] });
    expect(ops[1]).not.toHaveProperty('sourceMessageIds');
  });
});

describe('worker writes threads', () => {
  it('stores the kind and the source line id of a quoted followup', async () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(db);
    const store = new SqliteMemoryStore(db);
    const w = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: w.ownerId, agentId: w.agentId, role: 'user', text: '我后天上午要去医院复查腰。', bigrams: '', now: 2 });
    const client: TextModelClient = {
      complete: async () => JSON.stringify({ ops: [
        { op: 'add', table: 'followups', text: '问问复查', dueAt: 9_000, quote: '我后天上午要去医院复查腰', sensitive: true, kind: 'event' },
        { op: 'add', table: 'followups', text: '下次接着聊天气', dueAt: 9_000 },
      ] }),
    };
    const worker = new MemoryWorker({ store, client, systemPrompt: '陈述。', maxTokens: 80, policy, quote: quoteRules });
    await worker.enqueue(w.ownerId, w.agentId, 'session_end');
    expect(db.prepare('SELECT text, kind, source_message_ids AS src, quote IS NOT NULL AS quoted FROM followups ORDER BY text').all()).toEqual([
      { text: '下次接着聊天气', kind: 'concern', src: '[]', quoted: 0 },
      { text: '问问复查', kind: 'event', src: '["m1"]', quoted: 1 },
    ]);
    // P2-T1 trigger: deleting the cited line drops the thread, not the plain followup.
    store.deleteMessagesByIds(w.ownerId, w.agentId, ['m1']);
    expect(db.prepare('SELECT text FROM followups').all()).toEqual([{ text: '下次接着聊天气' }]);
  });
});
