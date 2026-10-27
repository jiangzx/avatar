import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig } from '../src/adapters/types.ts';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import { openDatabase } from '../src/memory/db.ts';
import { SqliteMemoryStore } from '../src/memory/store.ts';
import { SqliteTranscriptWriter } from '../src/memory/writer.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session } from '../src/session/session.ts';

const zh = DEFAULT_I18N.memory.zh.pin;
const characters = loadCharacterRegistry(fileURLToPath(new URL('../characters', import.meta.url)), ['zh', 'ja', 'en']);
const director: DirectorConfig = {
  followupAfterMs: 600_000, idleNoticeAfterMs: 600_000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300_000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup',
  idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
  toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
  contextAfterMs: 600_000, checkAfterMs: 600_000, leaveAfterMs: 600_000, checkinAfterMs: 600_000,
};
const speak = (line: string) => ({ cue: 'toolContinue', instruction: `请直接说下面这句话，不要改写：${line}`, fallbackText: line });

/** The test drives model events itself, in Qwen or Seeduplex order. */
class FakeAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  readonly supportsUserText = true;
  readonly requests: ProactiveRequest[] = [];
  readonly pushes: string[] = [];
  readonly toolResults: Array<{ callId: string; result: unknown }> = [];
  audioFrames = 0;
  private counter = 0;
  private activeId: string | null = null;

  constructor(readonly verbatimFallback: boolean) {
    super();
  }

  async connect(_config: SessionConfig): Promise<void> {}
  sendAudio(_pcm: Int16Array): void { this.audioFrames++; }
  sendUserText(_text: string): void {}
  updateInstructions(text: string): void { this.pushes.push(text); }
  updateVoice(_voice: string | undefined): void {}
  createResponse(request?: ProactiveRequest): void {
    if (request) this.requests.push(request);
    this.begin();
  }
  cancelResponse(): void {}
  sendToolResult(callId: string, result: unknown): void { this.toolResults.push({ callId, result }); }
  injectContextNote(_text: string): void {}
  close(): void {}

  begin(): string {
    const id = `resp-${++this.counter}`;
    this.activeId = id;
    this.emit('responseStarted', id);
    return id;
  }

  done(): void {
    const id = this.activeId;
    if (!id) throw new Error('no_active_response');
    this.activeId = null;
    this.emit('responseDone', id);
  }
}

const dbs: DatabaseSync[] = [];
const sessions: Session[] = [];

function boot(opts: { verbatim?: boolean; notified?: boolean; declined?: boolean } = {}) {
  const db = openDatabase(':memory:', { busyTimeoutMs: 1000 });
  dbs.push(db);
  const store = new SqliteMemoryStore(db);
  const { ownerId } = store.createOwner({ tokenHash: `h-pin-session-${dbs.length}`, now: 1 });
  const agent = store.ensureAgent(ownerId, 'xiaonuan', 1);
  if (opts.notified ?? true) store.markNotified(ownerId, 2);
  if (opts.declined) store.setConsent(ownerId, 'declined', 3);
  const adapter = new FakeAdapter(opts.verbatim ?? false);
  const sent: ServerMessage[] = [];
  const session = new Session({
    adapterFactory: () => adapter,
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    characters,
    writer: new SqliteTranscriptWriter(store),
    store,
    toolTurnTimeoutMs: 3_000,
    // The pin wait has its own limit (pinFinalWaitMs); the timeout case below advances 3 s.
    pin: { maxPerCharacter: 10, maxChars: { zh: 40, ja: 50, en: 50 }, finalWaitMs: 3_000 },
    budget: { totalChars: 6_000, snapshotMaxChars: 600, summaryMaxChars: 800, pinnedMaxChars: 700 },
  }, { ownerId, agentId: agent.id, characterId: 'xiaonuan', firstMeet: false } satisfies SessionContext, `pin-session-${dbs.length}`);
  sessions.push(session);
  const transport = { send: (msg: ServerMessage) => { sent.push(msg); }, sendAudio: () => {} };
  const pinned = () => store.listPinned(ownerId, agent.id).map((row) => row.text);
  const messageId = (text: string) => (db.prepare("SELECT id FROM messages WHERE role = 'user' AND text = ?").get(text) as { id: string }).id;
  const sourceId = () => (db.prepare('SELECT source_message_id AS id FROM pinned_memories').get() as { id: string | null }).id;
  return { db, store, ownerId, agentId: agent.id, adapter, session, sent, transport, pinned, messageId, sourceId };
}

/** Greeting played to the end; the session is idle and opened. */
async function open(t: ReturnType<typeof boot>): Promise<void> {
  await t.session.start(t.transport);
  t.adapter.done();
  t.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 0, reason: 'ended' });
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const session of sessions.splice(0)) session.end();
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  vi.useRealTimers();
});

describe('pin_memory in a live session', () => {
  it('waits for a late final (Qwen order), pins the user words with their message id, and speaks the confirm', async () => {
    const t = boot();
    await open(t);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pinned()).toEqual([]);
    t.adapter.emit('userTranscript', '记住，我女儿叫小芳', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pinned()).toEqual(['我女儿叫小芳']);
    expect(t.sourceId()).toBe(t.messageId('记住，我女儿叫小芳'));
    t.adapter.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adapter.requests.at(-1)).toEqual(speak(zh.confirmText));
  });

  it('uses a final that arrived before the tool call', async () => {
    const t = boot();
    await open(t);
    t.adapter.emit('userTranscript', '帮我记住我下周三去复查', true);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.store.listPinned(t.ownerId, t.agentId)[0]).toMatchObject({ text: '我下周三去复查', sensitive: true });
  });

  it('pins the previous user line with its own message id', async () => {
    const t = boot();
    await open(t);
    t.adapter.emit('userTranscript', '我孙子下个月十号结婚', true);
    t.adapter.begin();
    t.adapter.done();
    t.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 0, reason: 'ended' });
    t.adapter.emit('userTranscript', '把刚才那句记下来', true);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-2', 'pin_memory', { target: 'previous' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pinned()).toEqual(['我孙子下个月十号结婚']);
    expect(t.sourceId()).toBe(t.messageId('我孙子下个月十号结婚'));
  });

  it('times out into the empty line, and a later final is stored but not pinned', async () => {
    const t = boot();
    await open(t);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(3_000);
    t.adapter.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adapter.requests.at(-1)).toEqual(speak(zh.emptyText));
    t.adapter.emit('userTranscript', '记住我女儿叫小芳', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pinned()).toEqual([]);
    expect(t.messageId('记住我女儿叫小芳')).toBeTypeOf('string');
  });

  it('gives up on interruption without a tool turn, so the new utterance reaches the model', async () => {
    const t = boot();
    await open(t);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    t.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    t.adapter.emit('userSpeechStarted'); // server VAD confirms the barge-in: the origin is cancelled
    await vi.advanceTimersByTimeAsync(0);
    expect(t.pinned()).toEqual([]);
    // Timeout and interruption are both null at the TurnAccess level; the cut-off origin gets no tool turn.
    expect(t.adapter.toolResults).toEqual([{ callId: 'call-1', result: { ok: false, error: 'pin_no_final' } }]);
    t.session.handleMicAudio(new Int16Array(320));
    expect(t.adapter.audioFrames).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.adapter.requests.some((request) => request.cue === 'toolContinue')).toBe(false);
  });

  it('reads the write gate from the owner row', async () => {
    const pending = boot({ notified: false });
    await open(pending);
    pending.adapter.emit('userTranscript', '记住我女儿叫小芳', true);
    const a = pending.adapter.begin();
    pending.adapter.emit('toolCall', a, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    pending.adapter.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.adapter.requests.at(-1)).toEqual(speak(zh.noticePendingText));

    const declined = boot({ declined: true });
    await open(declined);
    declined.adapter.emit('userTranscript', '记住我女儿叫小芳', true);
    const b = declined.adapter.begin();
    declined.adapter.emit('toolCall', b, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    declined.adapter.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(declined.adapter.requests.at(-1)).toEqual(speak(zh.declinedText));
    expect(pending.pinned()).toEqual([]);
    expect(declined.pinned()).toEqual([]);
  });

  it('sends the same grounded request to a direct-TTS (Seeduplex) adapter', async () => {
    const t = boot({ verbatim: true });
    await open(t);
    t.adapter.emit('userTranscript', '记住我女儿叫小芳', true);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    t.adapter.done();
    await vi.advanceTimersByTimeAsync(0);
    // Seeduplex speaks fallbackText; Qwen follows the verbatim instruction. Never toolContinueText.
    expect(t.adapter.requests.at(-1)).toEqual(speak(zh.confirmText));
    expect(t.adapter.requests.some((request) => request.fallbackText === director.toolContinueText)).toBe(false);
  });

  it('refreshes the snapshot and pushes the pinned block only at the seam after the tool turn', async () => {
    const t = boot();
    await open(t);
    t.adapter.emit('userTranscript', '记住我女儿叫小芳', true);
    const origin = t.adapter.begin();
    t.adapter.emit('toolCall', origin, 'call-1', 'pin_memory', { target: 'this' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.session.context.pinnedMemory).toContain('我女儿叫小芳');
    t.adapter.done(); // origin done: continuation starts
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adapter.pushes).toEqual([]);
    t.adapter.done(); // continuation done: the tool turn ends, playback still open
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adapter.pushes).toEqual([]);
    t.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 0, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.adapter.pushes).toHaveLength(1);
    expect(t.adapter.pushes[0]).toContain('我女儿叫小芳');
  });
});
