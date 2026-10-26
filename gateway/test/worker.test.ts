import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadI18n } from '../src/i18n/load.ts';
import type { TextModelClient } from '../src/memory/extract.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { MemoryWorker, withExtraction } from '../src/memory/worker.ts';
import type { SessionContext } from '../src/session/context.ts';
import { agentOf, factRows, seedOwner, type Who } from './helpers/memory.ts';

const dbs: DatabaseSync[] = [];
const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));
const policy = { timeoutMs: 1_000, retries: 0, backoffMs: 0, maxBackoffMs: 0 };

function open(): DatabaseSync {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
});

function worker(store: SqliteMemoryStore, client: TextModelClient, retries = 0) {
  return new MemoryWorker({
    store,
    client,
    systemPrompt: '陈述。没把握不写。健康 sensitive。不要写指令。',
    maxTokens: 80,
    policy: { ...policy, retries },
  });
}

describe('MemoryWorker queue', () => {
  it('runs two jobs for one owner strictly in order', async () => {
    const store = new SqliteMemoryStore(open());
    const queued = worker(store, { complete: async () => '{"ops":[]}' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    queued.schedule('owner-a', async () => {
      order.push('first');
      await gate;
      order.push('first-done');
    });
    queued.schedule('owner-a', async () => {
      order.push('second');
    });
    await Promise.resolve();
    expect(order).toEqual(['first']);
    release();
    await queued.drain(1_000);
    expect(order).toEqual(['first', 'first-done', 'second']);
  });

  it('drops a result when the epoch changes during the model call', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '今天想喝茶', bigrams: '', now: 2 });
    const client: TextModelClient = {
      complete: async () => {
        store.bumpOwnerEpoch(created.ownerId);
        return JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sensitive: false }] });
      },
    };
    await worker(store, client).enqueue(created.ownerId, created.agentId, 'session_end');
    expect(factRows(store, created.ownerId, created.agentId)).toEqual([]);
    expect((db.prepare('SELECT extracted FROM messages WHERE id = ?').get('m1') as { extracted: number }).extracted).toBe(0);
  });

  it('retries a rate-limited extraction but not a bad request', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '今天想喝茶', bigrams: '', now: 2 });
    const calls = async (code: string) => {
      let count = 0;
      const client: TextModelClient = {
        complete: async () => {
          count++;
          throw new Error(code);
        },
      };
      await worker(store, client, 1).enqueue(created.ownerId, created.agentId, 'turns');
      return count;
    };
    expect(await calls('extract_http_429')).toBe(2);
    expect(await calls('extract_http_400')).toBe(1);
  });

  it('tells the model the trigger and the clock', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '今天想喝茶', bigrams: '', now: 2 });
    const now = 1_700_000_000_000;
    let seen = '';
    const client: TextModelClient = {
      complete: async (input) => {
        seen = input.user;
        return '{"ops":[]}';
      },
    };
    const timed = new MemoryWorker({
      store,
      client,
      systemPrompt: '陈述。',
      maxTokens: 80,
      policy,
      now: () => now,
    });
    await timed.enqueue(created.ownerId, created.agentId, 'session_end');
    expect(seen).toContain('session_end');
    expect(seen).toContain(String(now));
  });

  it('applies a fake client result and marks the consumed row', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '今天想喝茶', bigrams: '', now: 2 });
    let seen = '';
    const client: TextModelClient = {
      complete: async (input) => {
        seen = input.user;
        return JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sensitive: false }] });
      },
    };
    await worker(store, client).enqueue(created.ownerId, created.agentId, 'startup');
    expect(seen).toContain('今天想喝茶');
    expect(factRows(store, created.ownerId, created.agentId)).toEqual([{ category: 'preference', text: '喜欢喝茶' }]);
    expect((db.prepare('SELECT extracted FROM messages WHERE id = ?').get('m1') as { extracted: number }).extracted).toBe(1);
  });

  it('extracts only user lines but advances the assistant watermark', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '我喜欢喝茶', bigrams: '', now: 2 });
    store.insertMessage({ id: 'm2', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'assistant', text: '好呀，我记住了', bigrams: '', now: 3 });
    let seen = '';
    const client: TextModelClient = {
      complete: async (input) => {
        seen = input.user;
        return '{"ops":[]}';
      },
    };
    await worker(store, client).enqueue(created.ownerId, created.agentId, 'session_end');
    expect(seen).toContain('只有「用户：」是本轮证据');
    expect(seen).toContain('用户：我喜欢喝茶');
    expect(seen).not.toContain('好呀，我记住了');
    expect((db.prepare('SELECT extracted FROM messages WHERE id = ?').get('m1') as { extracted: number }).extracted).toBe(1);
    expect((db.prepare('SELECT extracted FROM messages WHERE id = ?').get('m2') as { extracted: number }).extracted).toBe(1);
  });

  it('advances an assistant-only tail without calling the model', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'assistant', text: '我自己说的', bigrams: '', now: 2 });
    let calls = 0;
    await worker(store, { complete: async () => { calls += 1; return '{"ops":[]}'; } }).enqueue(created.ownerId, created.agentId, 'startup');
    expect(calls).toBe(0);
    expect((db.prepare('SELECT extracted FROM messages WHERE id = ?').get('m1') as { extracted: number }).extracted).toBe(1);
  });

  it('does not call the model when nothing is pending', async () => {
    const store = new SqliteMemoryStore(open());
    const created = seedOwner(store, 'h1', 1);
    let calls = 0;
    await worker(store, { complete: async () => { calls += 1; return '{"ops":[]}'; } }).enqueue(created.ownerId, created.agentId, 'turns');
    expect(calls).toBe(0);
  });

  it('retries a retryable client error through the shared policy', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '今天想喝茶', bigrams: '', now: 2 });
    let calls = 0;
    const client: TextModelClient = {
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new Error('extract_network_error');
        return JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sensitive: false }] });
      },
    };
    await worker(store, client, 1).enqueue(created.ownerId, created.agentId, 'silence');
    expect(calls).toBe(2);
    expect(factRows(store, created.ownerId, created.agentId)).toEqual([{ category: 'preference', text: '喜欢喝茶' }]);
  });

  it('selects the ja prompt and labels for a ja batch', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    const seen: string[] = [];
    const w = new MemoryWorker({
      store,
      client: { complete: async (input) => { seen.push(input.system, input.user); return '{"ops":[]}'; } },
      systemPrompts: { zh: 'ZH', ja: 'JA', en: 'EN' },
      labels: { ja: i18n.memory.ja.extractLabels },
      maxTokens: 80,
      policy,
    });
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '私はお茶が好きです。', bigrams: '', now: 2 });

    await w.enqueue(created.ownerId, created.agentId, 'session_end', 'ja');

    expect(seen[0]).toBe('JA');
    expect(seen[1]).toContain(i18n.memory.ja.extractLabels.memoryHeader);
    expect(seen[1]).toContain(i18n.memory.ja.extractLabels.user);
    expect(seen[1]).toContain(i18n.memory.ja.extractLabels.newDialogueHeader);
  });

  it('chooses the dominant pending language when none is given', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    const seen: string[] = [];
    const w = new MemoryWorker({
      store,
      client: { complete: async (input) => { seen.push(input.system); return '{"ops":[]}'; } },
      systemPrompts: { zh: 'ZH', ja: 'JA', en: 'EN' },
      maxTokens: 80,
      policy,
    });
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '私はお茶が好きです。', bigrams: '', now: 2 });

    await w.enqueue(created.ownerId, created.agentId, 'startup');

    expect(seen).toEqual(['JA']);
  });

  it('fails fast when the batch language has no system prompt', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    let calls = 0;
    const w = new MemoryWorker({
      store,
      client: { complete: async () => { calls += 1; return '{"ops":[]}'; } },
      systemPrompts: { zh: 'ZH' },
      maxTokens: 80,
      policy,
    });
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '私はお茶が好きです。', bigrams: '', now: 2 });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await w.enqueue(created.ownerId, created.agentId, 'session_end', 'ja');
    // The queue logs the failure after settling the job promise.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const out = write.mock.calls.map((call) => String(call[0])).join('');
    write.mockRestore();
    expect(calls).toBe(0);
    expect(out).toContain('extract_prompt_missing:ja');
    expect((db.prepare('SELECT extracted FROM messages WHERE id = ?').get('m1') as { extracted: number }).extracted).toBe(0);
  });

  it('drain resolves after the in-flight job', async () => {
    const store = new SqliteMemoryStore(open());
    const queued = worker(store, { complete: async () => '{"ops":[]}' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    queued.schedule('owner-a', async () => { await gate; finished = true; });
    const drained = queued.drain(1_000);
    release();
    await drained;
    expect(finished).toBe(true);
  });

  it('passes the session context agent and language to session-end extraction', () => {
    const seen: Array<{ ownerId: string; agentId: string; reason: string; language?: string }> = [];
    const base = { started() {}, ended() {}, extract() {} };
    const fake = {
      enqueue: async (ownerId: string, agentId: string, reason: string, language?: string) => {
        seen.push({ ownerId, agentId, reason, language });
      },
    };
    const lifecycle = withExtraction(base, fake as unknown as MemoryWorker);
    lifecycle.extract?.('s1', { ownerId: 'owner-1', agentId: 'agent-1', language: 'ja' } as SessionContext, 'client_end');
    lifecycle.extract?.('s2', { ownerId: 'owner-1', language: 'ja' } as SessionContext, 'client_end');
    expect(seen).toEqual([{ ownerId: 'owner-1', agentId: 'agent-1', reason: 'session_end', language: 'ja' }]);
  });
});

describe('followup quotes in the worker', () => {
  const quoteRules = { maxChars: 80, safety: i18n.safety, evidence: i18n.evidence };
  const followups = (db: DatabaseSync) => db.prepare('SELECT text, quote, sensitive FROM followups ORDER BY text').all();

  function quoted(store: SqliteMemoryStore, client: TextModelClient) {
    return new MemoryWorker({ store, client, systemPrompt: '陈述。', maxTokens: 80, policy, quote: quoteRules });
  }

  it('keeps a quote copied from a user line and drops one copied from the assistant', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '我明天要去医院复查腰，有点担心。', bigrams: '', now: 2 });
    store.insertMessage({ id: 'm2', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'assistant', text: '别担心，复查完就踏实了。', bigrams: '', now: 3 });
    const client: TextModelClient = {
      complete: async () => JSON.stringify({ ops: [
        { op: 'add', table: 'followups', text: '问问腰部复查', dueAt: 9_000, quote: '我明天要去医院复查腰', sensitive: true },
        { op: 'add', table: 'followups', text: '问问是否踏实', dueAt: 9_000, quote: '复查完就踏实了' },
      ] }),
    };
    await quoted(store, client).enqueue(created.ownerId, created.agentId, 'session_end');
    expect(followups(db)).toEqual([
      { text: '问问是否踏实', quote: null, sensitive: 0 },
      { text: '问问腰部复查', quote: '我明天要去医院复查腰', sensitive: 1 },
    ]);
  });

  it('drops every quote when no quote rules are configured', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '我明天要去医院复查腰。', bigrams: '', now: 2 });
    const client: TextModelClient = {
      complete: async () => JSON.stringify({ ops: [{ op: 'add', table: 'followups', text: '问问腰部复查', dueAt: 9_000, quote: '我明天要去医院复查腰' }] }),
    };
    await worker(store, client).enqueue(created.ownerId, created.agentId, 'session_end');
    expect(followups(db)).toEqual([{ text: '问问腰部复查', quote: null, sensitive: 0 }]);
  });

  it('never shows a stored quote to the extractor', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = seedOwner(store, 'h1', 1);
    store.immediate(() => store.writeExtraction(created.ownerId, created.agentId, {
      now: 5, messageIds: [], facts: [], notes: [], episodes: [],
      followups: [{ op: 'add', text: '问问复查结果', dueAt: 99, quote: '我下周二去医院复查膝盖' }],
    }));
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, agentId: created.agentId, role: 'user', text: '今天天气不错', bigrams: '', now: 6 });
    let seen = '';
    await quoted(store, { complete: async (input) => { seen = input.user; return '{"ops":[]}'; } }).enqueue(created.ownerId, created.agentId, 'turns');
    expect(seen).toContain('问问复查结果');
    expect(seen).not.toContain('我下周二去医院复查膝盖');
  });
});

describe('per-character extraction', () => {
  function say(store: SqliteMemoryStore, who: Who, id: string, text: string, now: number, role: 'user' | 'assistant' = 'user'): void {
    store.insertMessage({ id, sessionId: 's1', ownerId: who.ownerId, agentId: who.agentId, role, text, bigrams: '', now });
  }
  const sourcesOf = (db: DatabaseSync, text: string): string[] => {
    const row = db.prepare(
      'SELECT source_message_ids AS ids FROM agent_facts WHERE text = ? UNION ALL SELECT source_message_ids AS ids FROM profile_facts WHERE text = ?',
    ).get(text, text) as { ids: string } | undefined;
    if (!row) throw new Error(`no fact: ${text}`);
    return JSON.parse(row.ids) as string[];
  };
  const extractedFlag = (db: DatabaseSync, id: string) => (db.prepare('SELECT extracted FROM messages WHERE id = ?').get(id) as { extracted: number }).extracted;
  const logged = (writes: string[], event: string) => writes
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);

  it('numbers user lines u1..uN and stores the cited message ids', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    say(store, a, 'm1', '我老家在山东', 2);
    say(store, a, 'm2', '山东是好地方', 3, 'assistant');
    say(store, a, 'm3', '我喜欢喝茶', 4);
    let seen = '';
    const client: TextModelClient = {
      complete: async (input) => {
        seen = input.user;
        return JSON.stringify({ ops: [
          { op: 'add', table: 'user_facts', category: 'profile', text: '老家山东', sources: ['u1'] },
          { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sources: ['u2', 'u2'] },
        ] });
      },
    };
    await worker(store, client).enqueue(a.ownerId, a.agentId, 'session_end');
    expect(seen).toContain('[u1] 用户：我老家在山东');
    expect(seen).toContain('[u2] 用户：我喜欢喝茶');
    expect(seen).not.toContain('山东是好地方');
    expect(sourcesOf(db, '老家山东')).toEqual(['m1']);
    expect(sourcesOf(db, '喜欢喝茶')).toEqual(['m3']);
    expect(store.listProfileFacts(a.ownerId).map((row) => row.text)).toEqual(['老家山东']);
  });

  it('keeps a fact without sources and still advances the watermark', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    say(store, a, 'm1', '我喜欢喝茶', 2);
    const client: TextModelClient = {
      complete: async () => JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶' }] }),
    };
    await worker(store, client).enqueue(a.ownerId, a.agentId, 'turns');
    expect(factRows(store, a.ownerId, a.agentId)).toEqual([{ category: 'preference', text: '喜欢喝茶' }]);
    expect(sourcesOf(db, '喜欢喝茶')).toEqual([]);
    expect(extractedFlag(db, 'm1')).toBe(1);
  });

  it('drops refs outside this run, removes malformed sources, and logs only counts', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    say(store, a, 'm1', '我喜欢喝茶', 2);
    say(store, a, 'm2', '我每天散步', 3);
    const client: TextModelClient = {
      complete: async () => JSON.stringify({ ops: [
        { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sources: ['u1', 'u9', 'm-other', 'u0'] },
        { op: 'add', table: 'user_facts', category: 'other', text: '每天散步', sources: 'u2' },
        { op: 'add', table: 'user_facts', category: 'misc', text: '怪分类' },
      ] }),
    };
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    await worker(store, client).enqueue(a.ownerId, a.agentId, 'session_end');
    spy.mockRestore();
    expect(sourcesOf(db, '喜欢喝茶')).toEqual(['m1']);
    expect(sourcesOf(db, '每天散步')).toEqual([]);
    expect(factRows(store, a.ownerId, a.agentId).map((row) => row.text)).toEqual(['喜欢喝茶', '每天散步']);
    expect(extractedFlag(db, 'm1')).toBe(1);
    expect(extractedFlag(db, 'm2')).toBe(1);
    expect(logged(writes, 'memory_extract')).toEqual([expect.objectContaining({
      result: 'applied', ops: 2, droppedCategory: 1, missingSources: 0, invalidSources: 1, droppedSources: 3, droppedAddressing: 0,
    })]);
    const out = writes.join('');
    for (const text of ['喜欢喝茶', '每天散步', '怪分类', '我喜欢喝茶']) expect(out).not.toContain(text);
  });

  it('unions sources when a later run updates the same fact', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    say(store, a, 'm1', '我喜欢喝茶', 2);
    await worker(store, {
      complete: async () => JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sources: ['u1'] }] }),
    }).enqueue(a.ownerId, a.agentId, 'turns');
    say(store, a, 'm2', '我现在更喜欢绿茶', 3);
    await worker(store, {
      complete: async () => {
        const id = store.listAgentFacts(a.ownerId, a.agentId)[0]!.id;
        return JSON.stringify({ ops: [{ op: 'update', table: 'user_facts', id, text: '喜欢喝绿茶', sources: ['u1'] }] });
      },
    }).enqueue(a.ownerId, a.agentId, 'turns');
    expect(sourcesOf(db, '喜欢喝绿茶')).toEqual(['m1', 'm2']);
  });

  it('stores the name as a plain shared row, drops an overlong one, and keeps health private', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    const kai = agentOf(store, a.ownerId, 'xiaokai');
    say(store, a, 'm1', '叫我王叔就行，我有高血压，退休前是老师', 2);
    await worker(store, {
      complete: async () => JSON.stringify({ ops: [
        { op: 'add', table: 'user_facts', category: 'addressing', text: '称呼：王叔', sources: ['u1'] },
        { op: 'add', table: 'user_facts', category: 'addressing', text: `称呼：${'名'.repeat(21)}`, sources: ['u1'] },
        { op: 'add', table: 'user_facts', category: 'profile', text: '退休前是老师', sources: ['u1'] },
        { op: 'add', table: 'user_facts', category: 'health', text: '有高血压', sensitive: false, sources: ['u1'] },
      ] }),
    }).enqueue(a.ownerId, a.agentId, 'session_end');
    expect(store.listProfileFacts(kai.ownerId).map(({ category, text }) => ({ category, text }))).toEqual([
      { category: 'addressing', text: '王叔' },
      { category: 'profile', text: '退休前是老师' },
    ]);
    expect(store.listAgentFacts(a.ownerId, a.agentId).map(({ category, text, sensitive }) => ({ category, text, sensitive }))).toEqual([
      { category: 'health', text: '有高血压', sensitive: true },
    ]);
    expect(store.listAgentFacts(kai.ownerId, kai.agentId)).toEqual([]);
  });

  it('extracts one character at a time: A lines and private memory never reach B', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    const b = agentOf(store, a.ownerId, 'xiaokai');
    say(store, a, 'a1', '我喜欢喝茶', 2);
    say(store, b, 'b1', '我爱下棋', 3);
    store.writeExtraction(a.ownerId, a.agentId, {
      now: 4, messageIds: [], notes: [], episodes: [], followups: [],
      facts: [{ op: 'add', category: 'preference', text: 'A的私有偏好' }, { op: 'add', category: 'profile', text: '老家山东' }],
    });
    const privateA = store.listAgentFacts(a.ownerId, a.agentId)[0]!.id;
    let seen = '';
    await worker(store, {
      complete: async (input) => {
        seen = input.user;
        return JSON.stringify({ ops: [
          { op: 'add', table: 'user_facts', category: 'preference', text: '爱下棋', sources: ['u1'] },
          { op: 'remove', table: 'user_facts', id: privateA },
        ] });
      },
    }).enqueue(b.ownerId, b.agentId, 'session_end');
    expect(seen).toContain('[u1] 用户：我爱下棋');
    expect(seen).not.toContain('我喜欢喝茶');
    expect(seen).not.toContain('A的私有偏好');
    expect(seen).toContain('老家山东');
    expect(store.listAgentFacts(b.ownerId, b.agentId).map((row) => row.text)).toEqual(['爱下棋']);
    expect(sourcesOf(db, '爱下棋')).toEqual(['b1']);
    expect(store.listAgentFacts(a.ownerId, a.agentId).map((row) => row.text)).toEqual(['A的私有偏好']);
    expect(extractedFlag(db, 'a1')).toBe(0);
    expect(extractedFlag(db, 'b1')).toBe(1);
  });

  it('drops a result when this agent epoch moves during the model call, but not for another agent', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    const b = agentOf(store, a.ownerId, 'xiaokai');
    say(store, a, 'a1', '我喜欢喝茶', 2);
    const addTea = JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sources: ['u1'] }] });
    await worker(store, { complete: async () => { store.bumpAgentEpoch(a.ownerId, a.agentId); return addTea; } }).enqueue(a.ownerId, a.agentId, 'turns');
    expect(store.listAgentFacts(a.ownerId, a.agentId)).toEqual([]);
    expect(extractedFlag(db, 'a1')).toBe(0);
    await worker(store, { complete: async () => { store.bumpAgentEpoch(b.ownerId, b.agentId); return addTea; } }).enqueue(a.ownerId, a.agentId, 'turns');
    expect(store.listAgentFacts(a.ownerId, a.agentId).map((row) => row.text)).toEqual(['喜欢喝茶']);
    expect(extractedFlag(db, 'a1')).toBe(1);
  });

  it('runs jobs of one owner strictly in order across characters', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const a = seedOwner(store, 'h1', 1);
    const b = agentOf(store, a.ownerId, 'xiaokai');
    say(store, a, 'a1', '我喜欢喝茶', 2);
    say(store, b, 'b1', '我爱下棋', 3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const queued = worker(store, {
      complete: async (input) => {
        const who = input.user.includes('我喜欢喝茶') ? 'a' : 'b';
        order.push(`${who}-start`);
        if (who === 'a') await gate;
        order.push(`${who}-done`);
        return '{"ops":[]}';
      },
    });
    const first = queued.enqueue(a.ownerId, a.agentId, 'turns');
    const second = queued.enqueue(b.ownerId, b.agentId, 'turns');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['a-start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-done', 'b-start', 'b-done']);
  });
});
