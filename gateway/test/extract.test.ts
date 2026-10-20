import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyExtractOps, loadExtractPrompt, parseExtractOps } from '../src/memory/extract.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { QwenTextClient } from '../src/memory/textClient.ts';
import { loadMemoryBudget } from '../src/session/pacing.ts';

const dbs: DatabaseSync[] = [];

function open(): DatabaseSync {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  vi.unstubAllGlobals();
});

const owner = (store: SqliteMemoryStore) =>
  store.createOwner({ tokenHash: 'h1', roleId: 'elder-companion', styleId: 'grandchild', now: 1_000 });

function extracted(db: DatabaseSync, id: string): number {
  return (db.prepare('SELECT extracted FROM messages WHERE id = ?').get(id) as { extracted: number }).extracted;
}

describe('parseExtractOps', () => {
  it('rejects a missing op and bad JSON', () => {
    expect(() => parseExtractOps({ ops: [{ table: 'user_facts', category: 'preference', text: '喜欢喝茶' }] })).toThrow();
    expect(() => parseExtractOps('{')).toThrow();
  });

  it('reads an ops array from a JSON string', () => {
    expect(parseExtractOps('{"ops":[{"op":"add","table":"user_facts","category":"preference","text":"喜欢喝茶"}]}')).toEqual([
      { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶' },
    ]);
  });
});

describe('applyExtractOps', () => {
  it('inserts a fact and marks only the consumed messages extracted', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = owner(store);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, role: 'user', text: '今天想喝茶', bigrams: '', now: 1 });
    store.insertMessage({ id: 'm2', sessionId: 's1', ownerId: created.ownerId, role: 'user', text: '还没抽', bigrams: '', now: 2 });
    const result = applyExtractOps(store, created.ownerId, 0, [
      { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sensitive: false },
    ], ['m1']);
    expect(result).toBe('applied');
    expect(store.listFacts(created.ownerId)).toEqual([{ category: 'preference', text: '喜欢喝茶' }]);
    expect(extracted(db, 'm1')).toBe(1);
    expect(extracted(db, 'm2')).toBe(0);
  });

  it('returns stale and writes nothing when the epoch changed', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = owner(store);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, role: 'user', text: '今天想喝茶', bigrams: '', now: 1 });
    store.bumpEpoch(created.ownerId);
    const result = applyExtractOps(store, created.ownerId, 0, [
      { op: 'add', table: 'user_facts', category: 'preference', text: '不该留下', sensitive: false },
    ], ['m1']);
    expect(result).toBe('stale');
    expect(store.listFacts(created.ownerId)).toEqual([]);
    expect(extracted(db, 'm1')).toBe(0);
  });

  it('marks health facts sensitive and can update or remove only that owner', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = owner(store);
    const other = store.createOwner({ tokenHash: 'h2', roleId: 'elder-companion', styleId: 'grandchild', now: 2_000 });
    expect(applyExtractOps(store, created.ownerId, 0, [
      { op: 'add', table: 'user_facts', category: 'health', text: '膝盖不太好', sensitive: false },
    ], [])).toBe('applied');
    const row = db.prepare('SELECT id, sensitive FROM user_facts WHERE owner_id = ?').get(created.ownerId) as { id: string; sensitive: number };
    expect(row.sensitive).toBe(1);
    expect(applyExtractOps(store, other.ownerId, 0, [
      { op: 'update', table: 'user_facts', id: row.id, text: '改成别人的' },
    ], [])).toBe('applied');
    expect(store.listFacts(created.ownerId)).toEqual([{ category: 'health', text: '膝盖不太好' }]);
    expect(applyExtractOps(store, created.ownerId, 0, [
      { op: 'update', table: 'user_facts', id: row.id, text: '膝盖旧伤' },
      { op: 'remove', table: 'user_facts', id: row.id },
    ], [])).toBe('applied');
    expect(store.listFacts(created.ownerId)).toEqual([]);
  });

  it('rolls back the batch when a note agent cannot be resolved', () => {
    const db = open();
    const store = new SqliteMemoryStore(db);
    const created = owner(store);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: created.ownerId, role: 'user', text: '今天想喝茶', bigrams: '', now: 1 });
    const result = applyExtractOps(store, created.ownerId, 0, [
      { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶', sensitive: false },
      { op: 'add', table: 'relationship_notes', agentId: 'missing-agent', text: '说话慢一点' },
    ], ['m1']);
    expect(result).toBe('incomplete');
    expect(store.listFacts(created.ownerId)).toEqual([]);
    expect(extracted(db, 'm1')).toBe(0);
    expect((db.prepare('SELECT count(*) AS n FROM relationship_notes').get() as { n: number }).n).toBe(0);
  });
});

describe('extract prompt and config', () => {
  it('keeps the extract rules in the shared prompt and the shipped memory config', () => {
    const prompt = loadExtractPrompt();
    expect(prompt).toContain('陈述');
    expect(prompt).toContain('没把握');
    expect(prompt).toContain('sensitive');
    expect(prompt).toContain('指令');
    // Only user lines are evidence; assistant paraphrases never become user facts.
    expect(prompt).toContain('只有「用户：」');
    expect(prompt).toContain('不要推断');
    const memory = loadMemoryBudget(fileURLToPath(new URL('../config/memory.json', import.meta.url)));
    expect(memory.instructions.budgetRatio).toBe(0.4);
    expect(memory.extractEveryUserTurns).toBe(10);
    expect(memory.extractSilenceMs).toBe(180_000);
    expect(memory.extractModel).toBe('qwen-plus');
  });
});

describe('QwenTextClient', () => {
  it('posts the configured model and returns only the message content', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer fixture-key');
      const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number; response_format?: unknown; messages: Array<{ role: string }> };
      expect(body.model).toBe('qwen-plus');
      expect(body.max_tokens).toBe(80);
      expect(body.response_format).toBeUndefined();
      expect(body.messages.map((message) => message.role)).toEqual(['system', 'user']);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ops":[]}' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QwenTextClient({ apiKey: 'fixture-key', endpoint: 'https://example.test/chat', model: 'qwen-plus' });
    const signal = new AbortController().signal;
    await expect(client.complete({ system: 'sys', user: 'user', maxTokens: 80, signal })).resolves.toBe('{"ops":[]}');
  });

  it('asks for a JSON object only when json mode is requested', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: unknown };
      expect(body.response_format).toEqual({ type: 'json_object' });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"speak":true}' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QwenTextClient({ apiKey: 'fixture-key', endpoint: 'https://example.test/chat', model: 'qwen-plus' });
    await expect(client.complete({
      system: 'sys', user: 'user', maxTokens: 80, jsonMode: true, signal: new AbortController().signal,
    })).resolves.toBe('{"speak":true}');
  });

  it('hides upstream bodies behind an error code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret transcript', { status: 500 })));
    const client = new QwenTextClient({ apiKey: 'fixture-key', endpoint: 'https://example.test/chat', model: 'qwen-plus' });
    await expect(client.complete({
      system: 'sys', user: 'user', maxTokens: 80, signal: new AbortController().signal,
    })).rejects.toThrow('extract_http_500');
  });
});
