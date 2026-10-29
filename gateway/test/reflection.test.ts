import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadI18n } from '../src/i18n/load.ts';
import { openDatabase } from '../src/memory/db.ts';
import type { TextModelClient } from '../src/memory/extract.ts';
import { parseReflections } from '../src/memory/reflect.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { MemoryWorker } from '../src/memory/worker.ts';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { loadMemoryBudget } from '../src/session/pacing.ts';
import { LANGUAGES } from '@anyidea/protocol';
import { agentOf, seedOwner } from './helpers/memory.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const i18n = loadI18n(`${root}config`);
const policy = { timeoutMs: 1_000, retries: 0, backoffMs: 0, maxBackoffMs: 0 };
const reflect = { enabled: true, maxTokens: 200, maxItems: 2, maxChars: 20, contextItems: 10 };
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

describe('parseReflections', () => {
  const refs = new Map([['u1', 'm1'], ['u2', 'm2']]);
  const rules = { maxItems: 2, maxChars: 20, known: ['女儿在深圳工作'], safety: i18n.safety };

  it('keeps grounded, short, new items and maps refs to message ids', () => {
    const raw = JSON.stringify({ items: [
      { text: '最近常一个人吃午饭', sources: ['u1', 'u1', 'u9'] },
      { text: '没有依据的判断', sources: ['u7'] },
      { text: '女儿在深圳工作。', sources: ['u2'] },
      { text: '这一条判断写得实在是太长太长太长太长太长了', sources: ['u2'] },
      { text: '腰不太好', sources: ['u2'] },
      { text: '第三条会超过上限', sources: ['u1'] },
    ] });
    expect(parseReflections(raw, refs, rules)).toEqual({
      items: [
        { text: '最近常一个人吃午饭', evidenceMessageIds: ['m1'] },
        { text: '腰不太好', evidenceMessageIds: ['m2'] },
      ],
      dropped: 4,
    });
  });

  it('returns null for a reply that is not the expected JSON', () => {
    expect(parseReflections('not json', refs, rules)).toBeNull();
    expect(parseReflections(JSON.stringify({ ops: [] }), refs, rules)).toBeNull();
  });
});

describe('reflection prompt', () => {
  it('ships for every role language and carries no placeholder', () => {
    const roles = loadRoleCatalog(`${root}roles`, loadCharacterRegistry(`${root}characters`, LANGUAGES));
    for (const language of LANGUAGES) {
      expect(roles.reflectPrompt(language).length).toBeGreaterThan(50);
      expect(roles.reflectPrompt(language)).not.toContain('{{');
    }
  });

  it('is configured in memory.json', () => {
    expect(loadMemoryBudget(`${root}config/memory.json`).reflect).toEqual({ enabled: true, maxTokens: 400, maxItems: 3, maxChars: 60, contextItems: 10 });
  });
});

describe('MemoryWorker.reflectSession', () => {
  function setup(reply: string) {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(db);
    const store = new SqliteMemoryStore(db);
    const w = seedOwner(store, 'h1', 1);
    const inputs: Array<{ user: string; usage: unknown }> = [];
    const client: TextModelClient = { complete: async (input) => { inputs.push({ user: input.user, usage: input.usage }); return reply; } };
    const worker = new MemoryWorker({
      store, client, systemPrompt: '陈述。', maxTokens: 80, policy,
      quote: { maxChars: 80, safety: i18n.safety, evidence: i18n.evidence },
      reflectPrompts: { zh: 'REFLECT' }, reflect, now: () => 5_000,
    });
    return { db, store, w, worker, inputs };
  }

  it('reflects on this session’s user statements only and stores grounded items', async () => {
    const reply = JSON.stringify({ items: [{ text: '常一个人吃午饭', sources: ['u1'] }] });
    const { db, store, w, worker, inputs } = setup(reply);
    store.markNotified(w.ownerId, 2);
    const b = agentOf(store, w.ownerId, 'xiaokai');
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: w.ownerId, agentId: w.agentId, role: 'user', text: '最近中午都是我一个人吃饭。', bigrams: '', now: 3 });
    store.insertMessage({ id: 'm2', sessionId: 's1', ownerId: w.ownerId, agentId: w.agentId, role: 'user', text: '你说我是不是该多出去走走？', bigrams: '', now: 3 });
    store.insertMessage({ id: 'm3', sessionId: 's1', ownerId: w.ownerId, agentId: w.agentId, role: 'assistant', text: '一个人吃饭也要好好吃。', bigrams: '', now: 3 });
    store.insertMessage({ id: 'm4', sessionId: 's0', ownerId: w.ownerId, agentId: w.agentId, role: 'user', text: '上次的事不提了。', bigrams: '', now: 1 });
    store.insertMessage({ id: 'm5', sessionId: 's1', ownerId: w.ownerId, agentId: b.agentId, role: 'user', text: '我在学太极。', bigrams: '', now: 3 });
    await worker.reflectSession(w.ownerId, w.agentId, 's1', 'zh');
    expect(inputs).toHaveLength(1);
    // Only this agent's statements from this session: no question, no assistant line, no other session or agent.
    expect(JSON.parse(inputs[0]!.user)).toEqual({ known: [], lines: [{ ref: 'u1', text: '最近中午都是我一个人吃饭。' }] });
    expect(inputs[0]!.usage).toEqual({ kind: 'memory_extract', attribution: { ownerId: w.ownerId, agentId: w.agentId, sessionId: 's1', characterId: null } });
    expect(store.listReflections(w.ownerId, w.agentId, 5)).toEqual([{ id: expect.any(String), text: '常一个人吃午饭', evidenceMessageIds: ['m1'], createdAt: 5_000 }]);
    // Deleting the evidence line drops the reflection (P2-T1 trigger).
    store.deleteMessagesByIds(w.ownerId, w.agentId, ['m1']);
    expect(db.prepare('SELECT count(*) AS n FROM reflections').get()).toEqual({ n: 0 });
  });

  it('does nothing before the notice, after a decline, or when disabled', async () => {
    const reply = JSON.stringify({ items: [{ text: '常一个人吃午饭', sources: ['u1'] }] });
    const { store, w, worker, inputs } = setup(reply);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: w.ownerId, agentId: w.agentId, role: 'user', text: '最近中午都是我一个人吃饭。', bigrams: '', now: 3 });
    await worker.reflectSession(w.ownerId, w.agentId, 's1', 'zh');
    expect(inputs).toHaveLength(0);
    store.markNotified(w.ownerId, 2);
    const off = new MemoryWorker({ store, client: { complete: async () => reply }, systemPrompt: 'x', maxTokens: 80, policy, reflectPrompts: { zh: 'R' }, reflect: { ...reflect, enabled: false } });
    await off.reflectSession(w.ownerId, w.agentId, 's1', 'zh');
    expect(store.listReflections(w.ownerId, w.agentId, 5)).toEqual([]);
  });

  it('passes known reflections back to the model so it does not repeat them', async () => {
    const { store, w, worker, inputs } = setup(JSON.stringify({ items: [] }));
    store.markNotified(w.ownerId, 2);
    store.insertReflections(w.ownerId, w.agentId, 's0', [{ text: '女儿在深圳工作', evidenceMessageIds: [] }], 1);
    store.insertMessage({ id: 'm1', sessionId: 's1', ownerId: w.ownerId, agentId: w.agentId, role: 'user', text: '今天去公园转了转。', bigrams: '', now: 3 });
    await worker.reflectSession(w.ownerId, w.agentId, 's1', 'zh');
    expect(JSON.parse(inputs[0]!.user).known).toEqual(['女儿在深圳工作']);
  });
});
