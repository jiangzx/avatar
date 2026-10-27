import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { LANGUAGES, type CharacterId } from '@anyidea/protocol';
import { loadI18n } from '../src/i18n/load.ts';
import { bigrams } from '../src/memory/bigram.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { ActionRouter } from '../src/session/actions.ts';
import { ConversationLedger } from '../src/session/ledger.ts';
import { createToolRegistry, type ToolContext } from '../src/session/tools/registry.ts';
import { NO_TURN } from '../src/session/turnAccess.ts';

const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));

describe('list copy', () => {
  it('ships the appendix B zh copy', () => {
    const list = i18n.memory.zh.list;
    expect(list.introText).toBe('我记得这些：');
    expect(list.itemJoiner).toBe('；');
    expect(list.itemEnd).toBe('。');
    expect(list.sensitiveHint).toBe('还有些身体方面的事，在设置里能看到。');
    expect(list.emptyText).toBe('我这儿还没记下什么，您慢慢跟我说。');
  });

  it('has every list field in every language and names no character', () => {
    for (const language of LANGUAGES) {
      const list = i18n.memory[language].list;
      for (const text of [list.introText, list.itemJoiner, list.itemEnd, list.sensitiveHint, list.emptyText, list.toolDescription]) {
        expect(text.length).toBeGreaterThan(0);
      }
      for (const name of ['小暖', '小凯', '小欣', 'Xiaonuan', 'Xiaokai', 'Xiaoxin']) expect(list.toolDescription).not.toContain(name);
    }
  });
});

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.isOpen) db.close(); });

/** One owner who has met two characters. */
function seed() {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  const store = new SqliteMemoryStore(db);
  const { ownerId } = store.createOwner({ tokenHash: `h-scope-${dbs.length}`, now: 1 });
  const a = store.ensureAgent(ownerId, 'xiaonuan', 1);
  const b = store.ensureAgent(ownerId, 'xiaokai', 1);
  store.markNotified(ownerId, 2);
  return { db, store, ownerId, a: a.id, b: b.id };
}
type Seed = ReturnType<typeof seed>;

function agentFact(s: Seed, agentId: string, id: string, category: string, text: string, sensitive = false): void {
  s.db.prepare(
    `INSERT INTO agent_facts (id, owner_id, agent_id, category, text, sensitive, confidence, source_session_id, source_message_ids, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 's0', '[]', 10)`,
  ).run(id, s.ownerId, agentId, category, text, sensitive ? 1 : 0);
}

function profileFact(s: Seed, id: string, category: 'addressing' | 'profile', text: string): void {
  s.db.prepare(
    `INSERT INTO profile_facts (id, owner_id, category, text, confidence, source_session_id, source_message_ids, updated_at)
     VALUES (?, ?, ?, ?, 1, 's0', '[]', 10)`,
  ).run(id, s.ownerId, category, text);
}

function pin(s: Seed, agentId: string, id: string, text: string, now: number, sensitive = false): void {
  s.store.insertPinned({ id, ownerId: s.ownerId, agentId, text, sensitive, sourceSessionId: 's0', sourceMessageId: null, now });
}

/** A user line in its own ended session of that agent, so recent recall can see it. */
function say(s: Seed, agentId: string, id: string, text: string, now: number): void {
  const sessionId = `ended-${id}`;
  s.store.recordSessionStart(sessionId, agentId, 1);
  s.store.insertMessage({ id, sessionId, ownerId: s.ownerId, agentId, role: 'user', text, bigrams: bigrams(text), now });
  s.store.recordSessionEnd(sessionId, agentId, 100);
}

function ctx(s: Seed, agentId: string, characterId: CharacterId, ledger = new ConversationLedger()): ToolContext {
  return {
    ownerId: s.ownerId,
    agentId,
    characterId,
    sessionId: 'live-1',
    store: s.store,
    ledger,
    actions: new ActionRouter(),
    now: 50_000,
    turn: NO_TURN,
    memoryGate: () => 'ok',
  };
}

function registry(language: 'zh' | 'ja' | 'en' = 'zh', listMaxItems = 5) {
  return createToolRegistry({
    language,
    memory: i18n.memory[language],
    evidence: i18n.evidence,
    recentQueries: i18n.recentQueries,
    recallPrompt: 'FIXTURE RECALL',
    safety: i18n.safety,
    clipChars: 80,
    phraseTimeoutMs: 1_500,
    listMaxItems,
  });
}

const zh = i18n.memory.zh;
const messageRow = (s: Seed, id: string) => s.db.prepare('SELECT text, excluded FROM messages WHERE id = ?').get(id) as { text: string; excluded: number };

describe('list_memory', () => {
  it('reads pinned (newest first), then profile, then non-sensitive facts; skips the name; adds the health hint', async () => {
    const s = seed();
    profileFact(s, 'addr', 'addressing', '王叔');
    profileFact(s, 'home', 'profile', '家在青岛');
    pin(s, s.a, 'p-old', '我女儿叫小芳', 10);
    pin(s, s.a, 'p-new', '下周三去复查', 20);
    pin(s, s.a, 'p-health', '我有高血压', 30, true);
    agentFact(s, s.a, 'f-tea', 'preference', '喜欢喝茶。');
    agentFact(s, s.a, 'f-knee', 'health', '膝盖不好', true);
    const out = await registry().handle('list_memory', {}, ctx(s, s.a, 'xiaonuan'));
    expect(out).toEqual({
      ok: true,
      spokenText: '我记得这些：下周三去复查；我女儿叫小芳；家在青岛；喜欢喝茶。还有些身体方面的事，在设置里能看到。',
      spokenFound: true,
    });
    expect(out.spokenText).not.toContain('王叔');
    expect(out.spokenText).not.toContain('高血压');
    expect(out.spokenText).not.toContain('膝盖');
  });

  it('caps at listMaxItems, and the name does not count', async () => {
    const s = seed();
    profileFact(s, 'addr', 'addressing', '王叔');
    for (let i = 1; i <= 6; i++) pin(s, s.a, `p${i}`, `第${i}件事`, i);
    const out = await registry('zh', 5).handle('list_memory', {}, ctx(s, s.a, 'xiaonuan'));
    expect(out.spokenText).toBe('我记得这些：第6件事；第5件事；第4件事；第3件事；第2件事。');
  });

  it('speaks the empty line with nothing remembered, and only the hint with only health items', async () => {
    const s = seed();
    profileFact(s, 'addr', 'addressing', '王叔');
    await expect(registry().handle('list_memory', {}, ctx(s, s.a, 'xiaonuan')))
      .resolves.toEqual({ ok: true, spokenText: zh.list.emptyText, spokenFound: false });
    agentFact(s, s.a, 'f-knee', 'health', '膝盖不好', true);
    await expect(registry().handle('list_memory', {}, ctx(s, s.a, 'xiaonuan')))
      .resolves.toEqual({ ok: true, spokenText: zh.list.sensitiveHint, spokenFound: true });
  });

  it('never lists another character’s pinned or private facts, but does list the shared profile', async () => {
    const s = seed();
    profileFact(s, 'home', 'profile', '家在青岛');
    pin(s, s.a, 'p-a', '我女儿叫小芳', 10);
    agentFact(s, s.a, 'f-a', 'preference', '喜欢喝茶');
    pin(s, s.b, 'p-b', '周末去钓鱼', 10);
    const out = await registry().handle('list_memory', {}, ctx(s, s.b, 'xiaokai'));
    expect(out.spokenText).toBe('我记得这些：周末去钓鱼；家在青岛。');
  });

  it('uses the ja and en templates', async () => {
    const s = seed();
    pin(s, s.a, 'p1', 'my daughter is Hana', 10);
    agentFact(s, s.a, 'f1', 'preference', 'likes green tea.');
    await expect(registry('en').handle('list_memory', {}, ctx(s, s.a, 'xiaonuan'))).resolves.toMatchObject({
      spokenText: "Here's what I remember: my daughter is Hana; likes green tea.",
    });
    await expect(registry('ja').handle('list_memory', {}, ctx(s, s.a, 'xiaonuan'))).resolves.toMatchObject({
      spokenText: '覚えていることはこちらです：my daughter is Hana。likes green tea。',
    });
  });

  it('takes no arguments and reports a missing store', async () => {
    const s = seed();
    const spec = registry().specs().find((item) => item.name === 'list_memory');
    expect(spec).toEqual({ name: 'list_memory', description: zh.list.toolDescription, parameters: { type: 'object', properties: {} } });
    await expect(registry().handle('list_memory', { extra: 1 }, ctx(s, s.a, 'xiaonuan'))).resolves.toEqual({ ok: false, error: 'invalid_args' });
    const { agentId: _agentId, ...noAgent } = ctx(s, s.a, 'xiaonuan');
    await expect(registry().handle('list_memory', {}, noAgent)).resolves.toEqual({ ok: false, error: 'memory_unavailable' });
  });
});

describe('forget_memory scope', () => {
  it('never touches another character’s private facts, pins, or lines; bumps only the caller’s agent epoch', async () => {
    const s = seed();
    agentFact(s, s.a, 'f-a', 'preference', '喜欢喝龙井');
    pin(s, s.a, 'p-a', '喜欢喝龙井的事', 10);
    say(s, s.a, 'm-a', '我喜欢喝龙井', 20);
    const before = s.store.memoryEpochs(s.ownerId, s.b)!;
    const beforeA = s.store.memoryEpochs(s.ownerId, s.a)!;
    const out = await registry().handle('forget_memory', { query: '龙井' }, ctx(s, s.b, 'xiaokai'));
    expect(out).toEqual({ ok: false, error: 'not_found' });
    expect(s.store.listAgentFacts(s.ownerId, s.a).map((row) => row.id)).toEqual(['f-a']);
    expect(s.store.listPinned(s.ownerId, s.a).map((row) => row.id)).toEqual(['p-a']);
    expect(messageRow(s, 'm-a')).toEqual({ text: '我喜欢喝龙井', excluded: 0 });
    expect(s.store.memoryEpochs(s.ownerId, s.b)).toEqual({ owner: before.owner, agent: before.agent + 1 });
    expect(s.store.memoryEpochs(s.ownerId, s.a)).toEqual(beforeA);
  });

  it('forgets the caller’s pin with an agent epoch bump only', async () => {
    const s = seed();
    pin(s, s.b, 'p-b', '周末去钓鱼', 10);
    const before = s.store.memoryEpochs(s.ownerId, s.b)!;
    const beforeA = s.store.memoryEpochs(s.ownerId, s.a)!;
    const out = await registry().handle('forget_memory', { query: '钓鱼' }, ctx(s, s.b, 'xiaokai'));
    expect(out).toMatchObject({ ok: true, rebuild: 'forget', confirmText: zh.forgetConfirmText });
    expect(s.store.listPinned(s.ownerId, s.b)).toEqual([]);
    expect(s.store.memoryEpochs(s.ownerId, s.b)).toEqual({ owner: before.owner, agent: before.agent + 1 });
    expect(s.store.memoryEpochs(s.ownerId, s.a)).toEqual(beforeA);
  });

  it('forgets a shared profile fact for everyone with an owner epoch bump, but only blanks the caller’s own lines', async () => {
    const s = seed();
    profileFact(s, 'home', 'profile', '家在青岛');
    say(s, s.a, 'm-a', '我家在青岛', 20);
    say(s, s.b, 'm-b', '我家在青岛', 30);
    const before = s.store.memoryEpochs(s.ownerId, s.b)!;
    const ledger = new ConversationLedger();
    ledger.addUser('我家在青岛', 40);
    const out = await registry().handle('forget_memory', { query: '青岛' }, ctx(s, s.b, 'xiaokai', ledger));
    expect(out).toMatchObject({ ok: true, rebuild: 'forget' });
    expect(s.store.listProfileFacts(s.ownerId)).toEqual([]);
    expect(s.store.memoryEpochs(s.ownerId, s.b)!.owner).toBe(before.owner + 1);
    expect(messageRow(s, 'm-b').excluded).toBe(1);
    // Voice forget is said in front of one character: other characters' lines stay (spec, on purpose).
    expect(messageRow(s, 'm-a')).toEqual({ text: '我家在青岛', excluded: 0 });
    expect(ledger.recent.map((entry) => entry.text)).not.toContain('我家在青岛');
  });

  it('reports memory_unavailable without an agent', async () => {
    const s = seed();
    const { agentId: _agentId, ...noAgent } = ctx(s, s.a, 'xiaonuan');
    await expect(registry().handle('forget_memory', { query: '青岛' }, noAgent)).resolves.toEqual({ ok: false, error: 'memory_unavailable' });
  });
});

describe('recall_memory scope', () => {
  it('finds only the caller’s own lines (FTS, LIKE, and vague recent)', async () => {
    const s = seed();
    say(s, s.a, 'm-a1', '我一直想看恐怖片', 20);
    say(s, s.a, 'm-a2', '茶', 21);
    say(s, s.b, 'm-b1', '我周末去钓鱼了', 30);
    const fromB = (query: string) => registry().handle('recall_memory', { query }, ctx(s, s.b, 'xiaokai'));
    await expect(fromB('恐怖片')).resolves.toMatchObject({ spokenText: zh.recall.emptyText, spokenFound: false });
    await expect(fromB('茶')).resolves.toMatchObject({ spokenText: zh.recall.emptyText, spokenFound: false });
    const recent = await fromB('上次聊过什么');
    expect(recent.spokenText).toContain('我周末去钓鱼了');
    expect(recent.spokenText).not.toContain('恐怖片');
    const fromA = await registry().handle('recall_memory', { query: '恐怖片' }, ctx(s, s.a, 'xiaonuan'));
    expect(fromA.spokenText).toContain('我一直想看恐怖片');
  });

  it('reports memory_unavailable without an agent', async () => {
    const s = seed();
    const { agentId: _agentId, ...noAgent } = ctx(s, s.a, 'xiaonuan');
    await expect(registry().handle('recall_memory', { query: '恐怖片' }, noAgent)).resolves.toEqual({ ok: false, error: 'memory_unavailable' });
  });
});
