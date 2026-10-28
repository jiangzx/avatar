import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { ServerMessage } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import { QwenAdapter } from '../src/adapters/qwen.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer, type Summarizer } from '../src/session/ledger.ts';
import { Session, type SessionDeps, type Transport } from '../src/session/session.ts';

const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));

const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting',
  followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle',
  resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: 'ok',
  memoryNoticeInstruction: 'M', memoryNoticeText: 'notice',
};

const ctx = (language: 'zh' | 'en'): SessionContext => ({ characterId: 'xiaonuan', firstMeet: false, language });
const bilingual = () => fixedRoleCatalog('P-zh', director, {
  languages: ['zh', 'en'],
  defaultLanguage: 'en',
  personas: { zh: 'P-zh', en: 'P-en' },
});
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

type Wire = { type: string; session?: { instructions?: string; audio?: { output?: { voice?: string } } } };

/** A local Qwen upstream: acks the session, records what the gateway sends, lets the test speak as the model. */
async function qwenUpstream(servers: WebSocketServer[]) {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const received: Wire[] = [];
  let socket: WebSocket | null = null;
  server.on('connection', (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: 'session.created' }));
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Wire;
      received.push(event);
      if (event.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
    });
  });
  const emit = (event: Record<string, unknown>) => socket!.send(JSON.stringify(event));
  return {
    port: (server.address() as { port: number }).port,
    updates: () => received.filter((event) => event.type === 'session.update'),
    final: (transcript: string) => emit({ type: 'conversation.item.input_audio_transcription.completed', transcript }),
    start: (id: string) => {
      emit({ type: 'response.created', response: { id } });
      emit({ type: 'response.audio_transcript.delta', response_id: id, delta: 'fixture reply' });
      emit({ type: 'response.audio.delta', response_id: id, delta: Buffer.from(new Int16Array(480).buffer).toString('base64') });
    },
    done: (id: string) => {
      emit({ type: 'response.audio.done', response_id: id });
      emit({ type: 'response.done', response: { id, status: 'completed' } });
    },
  };
}

function qwenSession(port: number, overrides: Partial<SessionDeps>, language: 'zh' | 'en') {
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (message) => sent.push(message), sendAudio: () => {} };
  const session = new Session({
    adapterFactory: () => new QwenAdapter({ apiKey: 'fixture-key', endpoint: `ws://127.0.0.1:${port}`, voice: 'voice-default' }),
    summarizer: new MockSummarizer(),
    roles: bilingual(),
    i18n,
    languageRules: i18n.language,
    voiceFor: (l) => `voice-${l}`,
    // Production Qwen: the server VAD owns turns.
    modelOwnsTurns: true,
    ...overrides,
  }, ctx(language), `seam-${language}`);
  return { session, transport, sent };
}

describe('push seam on a Qwen upstream (blockers #48)', () => {
  const servers: WebSocketServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends no session.update while a reply is due or live after a language switch, then one combined update', async () => {
    const up = await qwenUpstream(servers);
    const { session, transport } = qwenSession(up.port, {}, 'en');
    await session.start(transport);
    await wait();
    up.start('r1');
    up.done('r1');
    await wait();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    await wait();
    const base = up.updates().length; // the connect update and anything settled before the test turn

    up.final('今天天气不错'); // switches the session to zh before the reply starts
    await wait();
    expect(session.currentLanguage).toBe('zh');
    expect(up.updates()).toHaveLength(base);
    up.start('r2');
    await wait();
    expect(up.updates()).toHaveLength(base);
    up.done('r2');
    await wait();
    expect(up.updates()).toHaveLength(base); // generation ended, playback has not

    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await wait();
    const added = up.updates().slice(base);
    expect(added).toHaveLength(1);
    expect(added[0]!.session?.audio?.output?.voice).toBe('voice-zh');
    expect(added[0]!.session?.instructions).toContain('P-zh');
    session.end();
  });

  it('holds the summary push while a reply is live and sends it after playback ends', async () => {
    const up = await qwenUpstream(servers);
    let release: (text: string) => void = () => {};
    const summarizer: Summarizer = { summarize: () => new Promise<string>((resolve) => { release = resolve; }) };
    const { session, transport } = qwenSession(up.port, {
      summarizer,
      ledger: { keepRecentTurns: 1, summarizeAfterTurns: 1, summarizeAfterTokens: 10_000 },
    }, 'zh');
    await session.start(transport);
    await wait();
    up.start('r1');
    up.done('r1');
    await wait();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    up.final('第一句');
    up.start('r2');
    up.done('r2');
    await wait();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await wait();
    const base = up.updates().length;

    up.final('第二句'); // two user turns: the summary starts
    up.start('r3');
    await wait();
    release('SUMMARY-FIXTURE');
    await wait();
    expect(session.ledger.summary).toBe('SUMMARY-FIXTURE');
    expect(up.updates()).toHaveLength(base);
    up.done('r3');
    await wait();
    expect(up.updates()).toHaveLength(base);

    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 300, reason: 'ended' });
    await wait();
    const added = up.updates().slice(base);
    expect(added).toHaveLength(1);
    expect(added[0]!.session?.instructions).toContain('SUMMARY-FIXTURE');
    session.end();
  });
});

const script: MockScript = { greeting: '你好呀', followup: '还在吗', fallbackReply: '我在听', turns: [] };

function mockSession(overrides: Partial<SessionDeps> = {}) {
  const mocks: MockAdapter[] = [];
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (message) => sent.push(message), sendAudio: () => {} };
  const session = new Session({
    adapterFactory: () => {
      const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
      mocks.push(m);
      return m;
    },
    summarizer: new MockSummarizer(),
    roles: bilingual(),
    i18n,
    languageRules: i18n.language,
    voiceFor: (l) => `voice-${l}`,
    ...overrides,
  }, ctx('zh'), 'seam-mock');
  return { session, transport, sent, mocks };
}

const gateOf = (session: Session) => session as unknown as { gate: { hasPending: boolean } };

describe('push seam lifecycle', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('drops a held push after a reconnect, since connect carries the new language', async () => {
    vi.useFakeTimers();
    const s = mockSession();
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    await vi.advanceTimersByTimeAsync(150); // reply seq 2 is live
    s.session.setInitialLanguage('en');
    expect(gateOf(s.session).gate.hasPending).toBe(true);

    s.mocks[0]!.simulateDrop();
    await vi.advanceTimersByTimeAsync(10);
    expect(s.mocks).toHaveLength(2);
    expect(gateOf(s.session).gate.hasPending).toBe(false);
    expect(s.mocks[1]!.instructions).toContain('P-en');
    expect(s.mocks[1]!.voice).toBe('voice-en');
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.mocks[0]!.sessionUpdates).toEqual([]);
    expect(s.mocks[1]!.sessionUpdates).toEqual([]);
    s.session.end();
  });

  it('flushes a held push when no reply forms after the final', async () => {
    vi.useFakeTimers();
    const s = mockSession({ push: { minIntervalMs: 0, noResponseAfterMs: 3_000 } });
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    // A final with no upstream reply (the mock only answers audio or debug text).
    s.mocks[0]!.emit('userTranscript', 'Could we speak English from now on please', true);
    expect(s.session.currentLanguage).toBe('en');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(s.mocks[0]!.sessionUpdates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.mocks[0]!.sessionUpdates).toHaveLength(1);
    expect(s.mocks[0]!.sessionUpdates[0]).toMatchObject({ voice: { value: 'voice-en' } });
    s.session.end();
  });

  it('never pushes before the adapter has connected', async () => {
    vi.useFakeTimers();
    const s = mockSession();
    s.session.setInitialLanguage('en');
    expect(gateOf(s.session).gate.hasPending).toBe(true);
    await s.session.start(s.transport);
    expect(gateOf(s.session).gate.hasPending).toBe(false);
    expect(s.mocks[0]!.instructions).toContain('P-en');
    expect(s.mocks[0]!.voice).toBe('voice-en');
    expect(s.mocks[0]!.sessionUpdates).toEqual([]);
    s.session.end();
  });
});
