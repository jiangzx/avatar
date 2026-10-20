import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { TextModelClient } from '../src/memory/extract.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { MemoryWorker } from '../src/memory/worker.ts';

const dbs: DatabaseSync[] = [];
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
    queued.enqueue('owner-a', async () => {
      order.push('first');
      await gate;
      order.push('first-done');
    });
    queued.enqueue('owner-a', async () => {
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
    const created = store.createOwner({ tokenHash: 'h1', roleId: 'elder-companion', styleId: 'grandchild', now: 1 });
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, role: 'user', text: '今天想喝茶', bigrams: '', now: 2 });
    const client: TextModelClient = {
      complete: async () => {
        store.bumpEpoch(created.ownerId);
        return JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sensitive: false }] });
      },
    };
    await worker(store, client).extractOwner(created.ownerId, 'session_end');
    expect(store.listFacts(created.ownerId)).toEqual([]);
    expect((db.prepare('SELECT extracted FROM messages WHERE id = ?').get('m1') as { extracted: number }).extracted).toBe(0);
  });

  it('tells the model the trigger and the clock', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = store.createOwner({ tokenHash: 'h1', roleId: 'elder-companion', styleId: 'grandchild', now: 1 });
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, role: 'user', text: '今天想喝茶', bigrams: '', now: 2 });
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
    await timed.extractOwner(created.ownerId, 'session_end');
    expect(seen).toContain('session_end');
    expect(seen).toContain(String(now));
  });

  it('applies a fake client result and marks the consumed row', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = store.createOwner({ tokenHash: 'h1', roleId: 'elder-companion', styleId: 'grandchild', now: 1 });
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, role: 'user', text: '今天想喝茶', bigrams: '', now: 2 });
    let seen = '';
    const client: TextModelClient = {
      complete: async (input) => {
        seen = input.user;
        return JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sensitive: false }] });
      },
    };
    await worker(store, client).extractOwner(created.ownerId, 'startup');
    expect(seen).toContain('今天想喝茶');
    expect(store.listFacts(created.ownerId)).toEqual([{ category: 'preference', text: '喜欢喝茶' }]);
    expect((db.prepare('SELECT extracted FROM messages WHERE id = ?').get('m1') as { extracted: number }).extracted).toBe(1);
  });

  it('extracts only user lines but advances the assistant watermark', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = store.createOwner({ tokenHash: 'h1', roleId: 'elder-companion', styleId: 'grandchild', now: 1 });
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, role: 'user', text: '我喜欢喝茶', bigrams: '', now: 2 });
    store.insertMessage({ id: 'm2', sessionId: 's1', ownerId: created.ownerId, role: 'assistant', text: '好呀，我记住了', bigrams: '', now: 3 });
    let seen = '';
    const client: TextModelClient = {
      complete: async (input) => {
        seen = input.user;
        return '{"ops":[]}';
      },
    };
    await worker(store, client).extractOwner(created.ownerId, 'session_end');
    expect(seen).toContain('只有「用户：」是本轮证据');
    expect(seen).toContain('用户：我喜欢喝茶');
    expect(seen).not.toContain('好呀，我记住了');
    expect((db.prepare('SELECT extracted FROM messages WHERE id = ?').get('m1') as { extracted: number }).extracted).toBe(1);
    expect((db.prepare('SELECT extracted FROM messages WHERE id = ?').get('m2') as { extracted: number }).extracted).toBe(1);
  });

  it('advances an assistant-only tail without calling the model', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = store.createOwner({ tokenHash: 'h1', roleId: 'elder-companion', styleId: 'grandchild', now: 1 });
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, role: 'assistant', text: '我自己说的', bigrams: '', now: 2 });
    let calls = 0;
    await worker(store, { complete: async () => { calls += 1; return '{"ops":[]}'; } }).extractOwner(created.ownerId, 'startup');
    expect(calls).toBe(0);
    expect((db.prepare('SELECT extracted FROM messages WHERE id = ?').get('m1') as { extracted: number }).extracted).toBe(1);
  });

  it('does not call the model when nothing is pending', async () => {
    const store = new SqliteMemoryStore(open());
    const created = store.createOwner({ tokenHash: 'h1', roleId: 'elder-companion', styleId: 'grandchild', now: 1 });
    let calls = 0;
    await worker(store, { complete: async () => { calls += 1; return '{"ops":[]}'; } }).extractOwner(created.ownerId, 'turns');
    expect(calls).toBe(0);
  });

  it('retries a retryable client error through the shared policy', async () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = store.createOwner({ tokenHash: 'h1', roleId: 'elder-companion', styleId: 'grandchild', now: 1 });
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, role: 'user', text: '今天想喝茶', bigrams: '', now: 2 });
    let calls = 0;
    const client: TextModelClient = {
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new Error('extract_network_error');
        return JSON.stringify({ ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sensitive: false }] });
      },
    };
    await worker(store, client, 1).extractOwner(created.ownerId, 'silence');
    expect(calls).toBe(2);
    expect(store.listFacts(created.ownerId)).toEqual([{ category: 'preference', text: '喜欢喝茶' }]);
  });

  it('drain resolves after the in-flight job', async () => {
    const store = new SqliteMemoryStore(open());
    const queued = worker(store, { complete: async () => '{"ops":[]}' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    queued.enqueue('owner-a', async () => { await gate; finished = true; });
    const drained = queued.drain(1_000);
    release();
    await drained;
    expect(finished).toBe(true);
  });
});
