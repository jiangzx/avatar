import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session, type SessionDeps, type Transport } from '../src/session/session.ts';

const script: MockScript = {
  greeting: '你好呀',
  followup: '还在吗',
  fallbackReply: '我在听',
  turns: [
    { user: '我叫老王', reply: '王叔好' },
    { match: '挥', user: '跟我挥挥手', reply: '好呀', tool: { name: 'perform_action', args: { action: 'wave' } } },
  ],
};

const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', followupInstruction: 'F', idleNoticeInstruction: 'I', resumeInstruction: 'R',
};

function collector() {
  const sent: ServerMessage[] = [];
  const audio: Array<{ seq: number; n: number }> = [];
  const transport: Transport = { send: (m) => sent.push(m), sendAudio: (seq, pcm) => audio.push({ seq, n: pcm.length }) };
  return { sent, audio, transport };
}

function setup(overrides: Partial<SessionDeps> = {}) {
  const mocks: MockAdapter[] = [];
  const session = new Session({
    adapterFactory: () => {
      const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
      mocks.push(m);
      return m;
    },
    summarizer: new MockSummarizer(),
    persona: 'P',
    director,
    ...overrides,
  });
  return { session, mocks, ...collector() };
}

const of = <T extends ServerMessage['type']>(sent: ServerMessage[], type: T) =>
  sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
const assistantText = (sent: ServerMessage[], seq: number) =>
  of(sent, 'transcript.assistant').filter((m) => m.responseSeq === seq).map((m) => m.text).join('');
const loud = () => new Int16Array(320).fill(3000);
const quiet = () => new Int16Array(320);

async function greetAndFinish(s: ReturnType<typeof setup>) {
  await s.session.start(s.transport);
  await vi.advanceTimersByTimeAsync(1000);
  s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
}

describe('Session', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('greets proactively and records the greeting once playback ends', async () => {
    const s = setup();
    await greetAndFinish(s);
    expect(of(s.sent, 'response.start')).toEqual([{ type: 'response.start', responseSeq: 1, kind: 'greeting' }]);
    expect(assistantText(s.sent, 1)).toBe('你好呀');
    expect(of(s.sent, 'response.end')).toEqual([{ type: 'response.end', responseSeq: 1 }]);
    expect(s.audio.length).toBeGreaterThan(0);
    expect(s.audio.every((a) => a.seq === 1)).toBe(true);
    expect(s.session.ledger.recent).toEqual([{ role: 'assistant', text: '你好呀', ts: expect.any(Number) }]);
  });

  it('handles a spoken user turn end to end', async () => {
    const s = setup();
    await greetAndFinish(s);
    for (let i = 0; i < 10; i++) s.session.handleMicAudio(loud());
    for (let i = 0; i < 40; i++) s.session.handleMicAudio(quiet());
    expect(of(s.sent, 'transcript.user').at(-1)).toEqual({ type: 'transcript.user', text: '我叫老王', final: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(s.sent, 'response.start').at(-1)).toEqual({ type: 'response.start', responseSeq: 2, kind: 'reply' });
    expect(assistantText(s.sent, 2)).toBe('王叔好');
    expect(s.session.ledger.recent.map((e) => e.text)).toEqual(['你好呀', '我叫老王']);
  });

  it('client interruption cancels the reply, drops late audio and truncates the ledger', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '随便聊聊' });
    await vi.advanceTimersByTimeAsync(150); // reply started at 50 ms, first chunk sent
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 50, reason: 'interrupted' });
    const framesAtCancel = s.audio.filter((a) => a.seq === 2).length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(s.sent, 'response.cancelled')).toEqual([{ type: 'response.cancelled', responseSeq: 2 }]);
    expect(s.audio.filter((a) => a.seq === 2).length).toBe(framesAtCancel);
    const last = s.session.ledger.recent.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.interrupted).toBe(true);
    expect('我在听'.startsWith(last.text)).toBe(true);
    expect(s.mocks[0].notes).toHaveLength(1);
  });

  it('does not inject a context note when nothing of the reply was played', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '随便聊聊' });
    await vi.advanceTimersByTimeAsync(150);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 0, reason: 'interrupted' });
    expect(of(s.sent, 'response.cancelled')).toEqual([{ type: 'response.cancelled', responseSeq: 2 }]);
    expect(s.session.ledger.recent.some((e) => e.role === 'assistant' && e.interrupted)).toBe(false); // blank text is not recorded
    expect(s.mocks[0].notes).toEqual([]);
  });

  it('ignores model-only speech during playback but cancels once local VAD confirms', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '随便聊聊' });
    await vi.advanceTimersByTimeAsync(100);
    s.mocks[0].emit('userSpeechStarted'); // echo heard by the model
    await vi.advanceTimersByTimeAsync(400);
    expect(of(s.sent, 'response.cancelled')).toEqual([]);
    s.mocks[0].emit('userSpeechStarted');
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    expect(of(s.sent, 'response.cancelled')).toEqual([{ type: 'response.cancelled', responseSeq: 2 }]);
  });

  it('cancels and records a still-playing response when the model starts a new one', async () => {
    const s = setup();
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000); // greeting streamed; the client is still playing it
    s.session.handleClientMessage({ type: 'playback.progress', responseSeq: 1, playedMs: 150 });
    s.mocks[0].sendUserText('随便聊聊'); // e.g. the model took echo or a barge-in as a new turn
    await vi.advanceTimersByTimeAsync(100);
    const types = s.sent.map((m) => (m.type === 'response.cancelled' || m.type === 'response.start' ? `${m.type}:${m.responseSeq}` : null)).filter(Boolean);
    expect(types).toEqual(['response.start:1', 'response.cancelled:1', 'response.start:2']);
    expect(s.session.ledger.recent.at(-1)).toEqual({ role: 'assistant', text: '你好', ts: expect.any(Number), interrupted: true });
    expect(s.mocks[0].notes).toHaveLength(1);
  });

  it('runs an action once when keyword and tool call agree', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '跟我挥挥手' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(s.sent, 'avatar.action')).toEqual([{ type: 'avatar.action', action: 'wave', source: 'keyword' }]);
    expect(s.mocks[0].toolResults).toEqual([{ callId: 'call-mock-2', result: { ok: true } }]);
  });

  it('summarizes older turns into the model instructions', async () => {
    const s = setup({ ledger: { keepRecentTurns: 1, summarizeAfterTurns: 1, summarizeAfterTokens: 10_000 } });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '第一句' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    s.session.handleClientMessage({ type: 'debug.userText', text: '第二句' });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.session.ledger.summary).toBe('助手：你好呀；用户：第一句；助手：我在听');
    expect(s.mocks[0].instructions).toContain('助手：你好呀；用户：第一句；助手：我在听');
    expect(s.mocks[0].instructions).toContain('用户：第二句');
  });

  it('rebuilds the model session after a drop, carrying the ledger', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '我叫老王' });
    await vi.advanceTimersByTimeAsync(1000);
    s.mocks[0].simulateDrop();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.mocks).toHaveLength(2);
    expect(of(s.sent, 'error')).toContainEqual({ type: 'error', code: 'model_reconnecting', retryable: true });
    expect(s.mocks[1].instructions).toContain('用户：我叫老王');
  });

  it('silently slims the model context after enough turns', async () => {
    const s = setup({ rebuildAfterTurns: 1 });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.mocks).toHaveLength(2);
    expect(of(s.sent, 'error')).toEqual([]);
  });

  it('ignores a stale playback end that arrives after a new turn started', async () => {
    const s = setup({ rebuildAfterTurns: 1 });
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000); // greeting streamed, still playing on the client
    s.session.handleClientMessage({ type: 'debug.userText', text: '随便聊聊' });
    await vi.advanceTimersByTimeAsync(150); // reply seq 2 is active
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.mocks).toHaveLength(1);
    expect(of(s.sent, 'response.cancelled')).toEqual([{ type: 'response.cancelled', responseSeq: 1 }]);
    expect(assistantText(s.sent, 2)).toBe('我在听');
  });

  it('survives a client disconnect and resumes with a bridging line', async () => {
    const s = setup();
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(75); // greeting is streaming
    s.session.detachTransport();
    await vi.advanceTimersByTimeAsync(5000);
    const second = collector();
    s.session.attachTransport(second.transport);
    expect(second.sent[0]).toEqual({ type: 'session.resumed', lastResponseSeq: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(second.sent, 'response.start')).toEqual([{ type: 'response.start', responseSeq: 2, kind: 'followup' }]);
    expect(assistantText(second.sent, 2)).toBe('还在吗');
    expect(second.audio.length).toBeGreaterThan(0);
    expect(second.audio.every((a) => a.seq === 2)).toBe(true);
  });

  it('a drop while the user was speaking does not leave the speaking state stuck', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    s.session.detachTransport(); // the 'vad silent' message is lost with the socket
    const second = collector();
    s.session.attachTransport(second.transport);
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(second.sent, 'response.start')).toEqual([{ type: 'response.start', responseSeq: 2, kind: 'followup' }]);
    s.mocks[0].emit('userSpeechStarted'); // model-only speech must wait for local confirmation again
    expect(of(second.sent, 'response.cancelled')).toEqual([]);
  });

  it('drops uplink audio while muted', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'client.mute', muted: true });
    for (let i = 0; i < 10; i++) s.session.handleMicAudio(loud());
    for (let i = 0; i < 40; i++) s.session.handleMicAudio(quiet());
    expect(of(s.sent, 'transcript.user')).toEqual([]);
  });

  it('end() closes the model and clears memory', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.end();
    expect(s.session.ledger.recent).toEqual([]);
    s.session.handleClientMessage({ type: 'debug.userText', text: '还在吗' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(s.sent, 'response.start')).toHaveLength(1);
  });
});
