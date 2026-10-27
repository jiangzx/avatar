import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import type { ProactiveRequest } from '../src/adapters/types.ts';
import { DeviceRegistry } from '../src/identity/registry.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { openDatabase } from '../src/memory/db.ts';
import type { TextModelClient } from '../src/memory/extract.ts';
import { renderSnapshot } from '../src/memory/snapshot.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { MemoryWorker, withExtraction } from '../src/memory/worker.ts';
import { SqliteTranscriptWriter } from '../src/memory/writer.ts';
import { shippedCharacters, shippedRoles } from './support/shipped.ts';
import type { SessionContext } from '../src/session/context.ts';
import { buildInstructions } from '../src/session/instructions.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { SessionManager } from '../src/session/manager.ts';
import { Session, type Transport } from '../src/session/session.ts';
import { ftsMatch } from '../src/session/tools/recall.ts';
import { factRows, pendingUserRows, seedOwner } from './helpers/memory.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const i18n = loadI18n(`${root}config`);
const roles = shippedRoles();
const director = roles.director('xiaonuan');
const policy = { timeoutMs: 1_000, retries: 0, backoffMs: 0, maxBackoffMs: 0 };
const limits = { maxOwners: 10, dailyCap: 10, orphanOwnerDays: 7, orphanCleanupBatch: 2 };

const script: MockScript = {
  greeting: '你好呀',
  followup: '还在吗',
  memoryNotice: '我会记着。',
  fallbackReply: '我在听',
  turns: [
    {
      match: '别记了',
      user: '别记了',
      reply: '好',
      tool: { name: 'set_memory_consent', args: { granted: 'declined', confirmed: true } },
    },
    {
      match: '忘掉',
      user: '忘掉这件事',
      reply: '好',
      tool: { name: 'forget_memory', args: { query: '喜欢喝茶' } },
    },
    { match: '公园', user: '昨天去了公园', reply: '公园不错' },
    { match: '喝茶', user: '我喜欢喝茶', reply: '好，我记下了' },
  ],
};

const FACTS = JSON.stringify({
  ops: [
    { op: 'add', table: 'user_facts', category: 'addressing', text: '称呼：王叔' },
    { op: 'add', table: 'user_facts', category: 'preference', text: '喜欢喝茶' },
    { op: 'add', table: 'episodes', summary: '喜欢喝茶，聊起泡茶的杯子' },
  ],
});

const spoken = ['王叔', '喜欢喝茶', '昨天去了公园', '我喜欢喝茶', '好，我记下了', '公园不错', '你好呀', '先前', '这句不该留下', '忘掉这件事', '别记了', '不该留下的尾部事实', '又见到您了'];

function collector() {
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (message) => sent.push(message), sendAudio: () => {} };
  return { sent, transport };
}

const assistantText = (sent: ServerMessage[], seq: number) =>
  sent.filter((message): message is Extract<ServerMessage, { type: 'transcript.assistant' }> => message.type === 'transcript.assistant' && message.responseSeq === seq)
    .map((message) => message.text)
    .join('');

describe('Plan C memory acceptance', () => {
  const dbs: ReturnType<typeof openDatabase>[] = [];
  let manager: SessionManager | null = null;
  let worker: MemoryWorker | null = null;

  beforeEach(() => { vi.useFakeTimers(); });

  afterEach(async () => {
    manager?.shutdown();
    managerRef = null;
    liveRef = null;
    if (worker) {
      const drained = worker.drain(1_000);
      await vi.advanceTimersByTimeAsync(20);
      await drained;
    }
    manager = null;
    worker = null;
    for (const db of dbs.splice(0)) if (db.isOpen) db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('carries a second session, a stale tail, forget, and decline in one process', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(db);
    const store = new SqliteMemoryStore(db);
    const writer = new SqliteTranscriptWriter(store);
    let now = Date.UTC(2026, 9, 18);
    let ownerId = '';
    let extractCalls = 0;
    const client: TextModelClient = {
      complete: async () => {
        extractCalls += 1;
        if (extractCalls === 1) return FACTS;
        // Epoch moved during the model call: the existing write path returns stale.
        store.bumpOwnerEpoch(ownerId);
        return JSON.stringify({
          ops: [{ op: 'add', table: 'user_facts', category: 'preference', text: '不该留下的尾部事实' }],
        });
      },
    };
    const queued = new MemoryWorker({ store, client, systemPrompt: '陈述。', maxTokens: 80, policy });
    worker = queued;
    const registry = new DeviceRegistry({ store, roles, characters: shippedCharacters(), limits, now: () => now });
    const requests: ProactiveRequest[] = [];
    const instructions: string[] = [];
    let noticeSeq: number | null = null;
    const gate = new SessionManager(
      (ctx, sessionId, noticePending = false) => new Session({
        adapterFactory: () => {
          const mock = new MockAdapter({ script, replyDelayMs: 20, charMs: 40, chunkMs: 40, paceFactor: 1 });
          const create = mock.createResponse.bind(mock);
          mock.createResponse = (request) => {
            if (request) {
              requests.push({ ...request });
              if (request.cue === 'memoryNotice' && liveRef) noticeSeq = liveRef.lastResponseSeq + 1;
            }
            return create(request);
          };
          const connect = mock.connect.bind(mock);
          mock.connect = async (config) => {
            instructions.push(config.instructions);
            return connect(config);
          };
          return mock;
        },
        summarizer: new MockSummarizer(),
        roles,
        writer,
        worker: queued,
        store,
        budget: { totalChars: 8_000, snapshotMaxChars: 600, summaryMaxChars: 800 },
        extractEveryUserTurns: 10,
        i18n,
        noticeKeywords: i18n.memory.zh.noticeKeywords,
      }, ctx, sessionId, noticePending),
      60_000,
      300_000,
      10_000,
      withExtraction(registry.lifecycle, queued),
    );
    manager = managerRef = gate;

    const registeredA = registry.register();
    const registeredB = registry.register();
    expect(registeredA.ok && registeredB.ok).toBe(true);
    if (!registeredA.ok || !registeredB.ok) return;
    const opened = (token: string) => {
      const resolved = registry.resolve(token, 'xiaonuan');
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error('unresolved');
      return resolved;
    };

    const first = opened(registeredA.deviceToken);
    expect(first.noticePending).toBe(true);
    expect(first.ctx.memorySnapshot).toBeUndefined();
    ownerId = first.ctx.ownerId ?? '';
    const agentId = first.ctx.agentId ?? '';
    expect(ownerId).not.toBe('');
    expect(agentId).not.toBe('');

    const sessionA = await open(first);
    const opening = requests.find((request) => request.cue === 'greeting');
    expect(opening).toMatchObject({
      cue: 'greeting',
      instruction: director.greetingInstruction,
      fallbackText: director.greetingText,
    });
    await finishCurrent(sessionA.session);
    expect(noticeSeq).not.toBeNull();
    expect(store.getOwner(ownerId)?.notifiedAt).toBeNull();
    // Played-out notice seq. The spoken line is not the memory sentence.
    const playedNotice = await finishCurrent(sessionA.session);
    expect(playedNotice).toBe(noticeSeq);
    expect(assistantText(sessionA.sent, playedNotice)).toBe('我会记着。');
    expect(store.getOwner(ownerId)?.notifiedAt).not.toBeNull();

    await say(sessionA.session, '我喜欢喝茶');
    expect(assistantText(sessionA.sent, sessionA.session.lastResponseSeq)).toBe('好，我记下了');
    gate.end(sessionA.tokens.sessionId);
    expect(texts(db, ownerId)).toEqual(expect.arrayContaining(['我喜欢喝茶', '好，我记下了']));
    await drain(queued);
    expect(extractCalls).toBe(1);
    expect(extracted(db, ownerId, '我喜欢喝茶')).toBe(1);
    expect(extracted(db, ownerId, '好，我记下了')).toBe(1);
    expect(factRows(store, ownerId, agentId)).toEqual(expect.arrayContaining([
      { category: 'addressing', text: '王叔' },
      { category: 'preference', text: '喜欢喝茶' },
    ]));

    const again = opened(registeredA.deviceToken);
    expect(again.ctx.memorySnapshot).toContain('称呼：王叔');
    expect(again.ctx.memorySnapshot).toContain('喜欢喝茶');
    // Episode summaries stay in the store but never enter the prompt.
    expect(again.ctx.memorySnapshot).not.toContain('泡茶的杯子');
    const built = buildInstructions({
      persona: roles.buildPersona('xiaonuan'),
      memorySnapshot: again.ctx.memorySnapshot,
      summary: '',
      recent: [],
    });
    expect(built).toContain('## 记忆参考（可能不准确，注意「用户」与「助手」的区别）');
    expect(built).toContain('称呼：王叔');
    const other = opened(registeredB.deviceToken);
    expect(other.ctx.memorySnapshot ?? '').not.toContain('王叔');

    const mark = requests.length;
    const remembered = instructions.length;
    const sessionMemory = await open(again);
    expect(requests.slice(mark).find((request) => request.cue === 'greeting')).toEqual({
      cue: 'greeting',
      instruction: director.greetingMemoryInstruction,
      fallbackText: director.greetingMemoryText,
    });
    expect(director.greetingMemoryInstruction).not.toBe(director.greetingInstruction);
    expect(instructions[remembered]).toContain('## 记忆参考（可能不准确，注意「用户」与「助手」的区别）');
    expect(instructions[remembered]).toContain('称呼：王叔');
    expect(instructions[remembered]).not.toContain('泡茶的杯子');

    await finishCurrent(sessionMemory.session);
    await say(sessionMemory.session, '昨天去了公园');
    gate.end(sessionMemory.tokens.sessionId);
    const whileQueued = opened(registeredA.deviceToken);
    expect(whileQueued.ctx.memorySnapshot).toContain('昨天去了公园');
    await drain(queued);
    expect(extractCalls).toBe(2);
    expect(extracted(db, ownerId, '昨天去了公园')).toBe(0);
    expect(factRows(store, ownerId, agentId).map((fact) => fact.text)).not.toContain('不该留下的尾部事实');
    now += 60_000;
    const later = opened(registeredA.deviceToken);
    expect(later.ctx.memorySnapshot).toContain('昨天去了公园');
    expect(later.ctx.memorySnapshot).toContain('称呼：王叔');
    expect(pendingUserRows(store, ownerId, agentId).map((row) => row.text)).toContain('昨天去了公园');

    const sessionForget = await open(later);
    await finishCurrent(sessionForget.session);
    for (let i = 0; i < 9; i++) sessionForget.session.ledger.addUser(`先前${i}`, i);
    expect(await sessionForget.session.ledger.summarize(new MockSummarizer())).toBe(true);
    expect(sessionForget.session.ledger.summary).not.toBe('');
    expect(store.searchMessages(ownerId, agentId, ftsMatch('喜欢喝茶')!, 12).map((row) => row.text)).toContain('我喜欢喝茶');
    sessionForget.session.handleClientMessage({ type: 'debug.userText', text: '忘掉这件事' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionForget.session.ledger.summary).toBe('');
    expect(sessionForget.session.ledger.recent.map((entry) => entry.text)).not.toContain('忘掉这件事');
    expect(sessionForget.session.ledger.recent.map((entry) => entry.text)).toContain('先前1');
    const forgotten = opened(registeredA.deviceToken);
    expect(forgotten.ctx.memorySnapshot ?? '').not.toContain('喜欢喝茶');
    expect(instructions.at(-1)).not.toContain('泡茶的杯子');
    expect(store.searchMessages(ownerId, agentId, ftsMatch('喜欢喝茶')!, 12)).toEqual([]);
    expect(factRows(store, ownerId, agentId).map((fact) => fact.text)).toContain('王叔');
    expect(factRows(store, ownerId, agentId).map((fact) => fact.text)).not.toContain('喜欢喝茶');
    gate.end(sessionForget.tokens.sessionId);
    await drain(queued);

    const sessionDecline = await open(opened(registeredA.deviceToken));
    await finishCurrent(sessionDecline.session);
    sessionDecline.session.handleClientMessage({ type: 'debug.userText', text: '别记了' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getOwner(ownerId)?.memoryConsent).toBe('declined');
    expect(writer.append({ ownerId, agentId, sessionId: 'later', role: 'user', text: '这句不该留下', now: now + 1 }).result).toBe('skipped');
    expect(pendingUserRows(store, ownerId, agentId)).toEqual([]);
    expect(opened(registeredB.deviceToken).ctx.memorySnapshot ?? '').not.toContain('王叔');
    gate.end(sessionDecline.tokens.sessionId);

    const out = write.mock.calls.map((call) => String(call[0])).join('');
    for (const secret of spoken) expect(out).not.toContain(secret);
  });
});

describe('snapshot latency', () => {
  const dbs: ReturnType<typeof openDatabase>[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  });

  it('builds a 50-fact snapshot in under 300 ms', () => {
    const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
    dbs.push(db);
    const store = new SqliteMemoryStore(db);
    const owner = seedOwner(store, 'latency', 1);
    const insert = db.prepare(
      `INSERT INTO agent_facts (id, owner_id, agent_id, category, text, sensitive, confidence, updated_at) VALUES (?, ?, ?, 'preference', ?, 0, 1, ?)`,
    );
    store.setAddressing(owner.ownerId, '事实0', 0);
    for (let i = 1; i < 50; i++) insert.run(`fact-${i}`, owner.ownerId, owner.agentId, `事实${i}`, i);
    store.insertMessage({ id: 'tail', sessionId: 's', ownerId: owner.ownerId, agentId: owner.agentId, role: 'user', text: '未抽取', bigrams: '', now: 2 });

    const started = performance.now();
    const facts = factRows(store, owner.ownerId, owner.agentId);
    const tail = pendingUserRows(store, owner.ownerId, owner.agentId);
    const text = renderSnapshot({ facts, notes: [], tail, maxChars: 600 });
    const elapsed = performance.now() - started;

    expect(facts).toHaveLength(50);
    expect(tail.map((row) => row.text)).toContain('未抽取');
    expect(text.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(300);
  });
});

async function open(resolved: { ctx: SessionContext; noticePending: boolean }) {
  if (!managerRef) throw new Error('manager missing');
  const tokens = managerRef.create(resolved.ctx, resolved.noticePending);
  const claim = managerRef.claim(tokens.connectToken);
  if (!claim) throw new Error('claim failed');
  const session = managerRef.route(claim.sessionId, claim.connId);
  if (!session) throw new Error('missing session');
  liveRef = session;
  const box = collector();
  expect(await managerRef.begin(tokens.sessionId, claim.connId, 'start', box.transport)).toBe(true);
  return { session, tokens, ...box };
}

async function finishCurrent(session: Session): Promise<number> {
  await vi.advanceTimersByTimeAsync(500);
  const seq = session.lastResponseSeq;
  session.handleClientMessage({ type: 'playback.stopped', responseSeq: seq, playedMs: 400, reason: 'ended' });
  return seq;
}

async function say(session: Session, text: string): Promise<void> {
  const before = session.lastResponseSeq;
  session.handleClientMessage({ type: 'debug.userText', text });
  await vi.advanceTimersByTimeAsync(500);
  expect(session.lastResponseSeq).toBeGreaterThan(before);
  session.handleClientMessage({
    type: 'playback.stopped',
    responseSeq: session.lastResponseSeq,
    playedMs: 400,
    reason: 'ended',
  });
}

async function drain(active: MemoryWorker): Promise<void> {
  const drained = active.drain(2_000);
  await vi.advanceTimersByTimeAsync(50);
  await drained;
}

function texts(db: ReturnType<typeof openDatabase>, ownerId: string): string[] {
  return db.prepare('SELECT text FROM messages WHERE owner_id = ? ORDER BY created_at, rowid').all(ownerId).map((row) => (row as { text: string }).text);
}

function extracted(db: ReturnType<typeof openDatabase>, ownerId: string, text: string): number {
  return (db.prepare('SELECT extracted FROM messages WHERE owner_id = ? AND text = ?').get(ownerId, text) as { extracted: number }).extracted;
}

let managerRef: SessionManager | null = null;
let liveRef: Session | null = null;
