import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import type { SessionConfig } from '../src/adapters/types.ts';
import { fixedRoleCatalog, type RoleCatalog } from '../src/roles/catalog.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import type { ReplyMetrics } from '../src/session/metrics.ts';
import { InterruptCoordinator } from '../src/session/interrupt.ts';
import { Session, type SessionDeps, type TranscriptWriter, type Transport } from '../src/session/session.ts';

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
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
  toolContinueInstruction: '用一句话接上刚才的动作。不要描述动作过程。', toolContinueText: '好。',
  memoryNoticeInstruction: '用下面这句告诉对方，以后聊天的内容会记住，方便下次接着聊。不要加问题。',
  memoryNoticeText: '之后咱们聊的事，我会记着，下次还能接着说。',
};

function collector() {
  const sent: ServerMessage[] = [];
  const audio: Array<{ seq: number; n: number }> = [];
  const transport: Transport = { send: (m) => sent.push(m), sendAudio: (seq, pcm) => audio.push({ seq, n: pcm.length }) };
  return { sent, audio, transport };
}

describe('Session context', () => {
  it('builds instructions and voice from the session context', async () => {
    const configs: SessionConfig[] = [];
    const roles: RoleCatalog = { ...fixedRoleCatalog('P', director), buildPersona: (_r, s) => `persona:${s}` };
    const session = new Session(
      {
        adapterFactory: () => {
          const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
          const connect = m.connect.bind(m);
          vi.spyOn(m, 'connect').mockImplementation((c) => { configs.push(c); return connect(c); });
          return m;
        },
        summarizer: new MockSummarizer(),
        roles,
      },
      { roleId: 'elder-companion', styleId: 'old-friend', voice: 'voice-old' },
    );
    await session.start(collector().transport);
    expect(configs[0]?.voice).toBe('voice-old');
    expect(configs[0]?.instructions).toContain('persona:old-friend');
    expect(session.context.styleId).toBe('old-friend');
    session.end();
  });
});

const ownedCtx: SessionContext = {
  ownerId: 'owner-1', agentId: 'agent-1', roleId: 'elder-companion', styleId: 'grandchild',
};

function setup(overrides: Partial<SessionDeps> = {}, ctx?: SessionContext, sessionId?: string, noticePending = false) {
  const mocks: MockAdapter[] = [];
  const session = new Session({
    adapterFactory: () => {
      const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
      mocks.push(m);
      return m;
    },
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    ...overrides,
  }, ctx, sessionId, noticePending);
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

  it('keeps the substantive answer when a deferred memory notice plays after it', async () => {
    const inputs: unknown[] = [];
    const s = setup({
      adapterFactory: () => new MockAdapter({
        script: { ...script, memoryNotice: director.memoryNoticeText, turns: [{ match: '老王', user: '我叫老王', reply: '王叔好' }] },
        replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1,
      }),
      roles: fixedRoleCatalog('P', { ...director, contextAfterMs: 3000, silenceDecision: {
        instruction: 'DECIDE', speakInstruction: 'READ {continuation}',
        maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60,
        policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      } }),
      textClient: { complete: async input => { inputs.push(JSON.parse(input.user)); return '{"speak":false}'; } },
    }, ownedCtx, 'deferred-notice', true);
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(150);
    s.session.handleClientMessage({ type: 'debug.userText', text: '我叫老王' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(assistantText(s.sent, 3)).toBe(director.memoryNoticeText);
    expect(inputs).toEqual([]);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 5000, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(inputs).toEqual([{ stage: 'context', userText: '我叫老王', assistantText: '王叔好', previousTexts: [] }]);
    await vi.advanceTimersByTimeAsync(600000);
    expect(of(s.sent, 'response.start')).toHaveLength(4);
    s.session.end();
  });

  it('decides once from completed playback and ignores duplicate playback receipts', async () => {
    const inputs: unknown[] = [];
    const s = setup({
      roles: fixedRoleCatalog('P', { ...director, contextAfterMs: 3000, silenceDecision: {
        instruction: 'DECIDE', speakInstruction: 'READ {continuation}',
        maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60,
        policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      } }),
      textClient: { complete: async input => { inputs.push(JSON.parse(input.user)); return '{"speak":false}'; } },
    });
    await greetAndFinish(s);
    for (let i = 0; i < 10; i++) s.session.handleMicAudio(loud());
    for (let i = 0; i < 40; i++) s.session.handleMicAudio(quiet());
    await vi.advanceTimersByTimeAsync(5000);
    expect(inputs).toEqual([]);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(inputs).toEqual([{ stage: 'context', userText: '我叫老王', assistantText: '王叔好', previousTexts: [] }]);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(600000);
    expect(inputs).toHaveLength(1);
    // A declined context line still speaks the configured fallback; the duplicate receipt adds nothing.
    expect(of(s.sent, 'response.start')).toHaveLength(3);
    s.session.end();
  });

  it.each(['new_turn', 'disconnect', 'rebuild'] as const)('discards optional speech across %s', async event => {
    let finish!: (raw: string) => void;
    let decisionSignal!: AbortSignal;
    const s = setup({
      roles: fixedRoleCatalog('P', { ...director, contextAfterMs: 3000, silenceDecision: {
        instruction: 'DECIDE', speakInstruction: 'READ {continuation}',
        maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60,
        policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      } }),
      textClient: { complete: input => {
        decisionSignal = input.signal;
        return new Promise(resolve => { finish = resolve; });
      } },
    });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '聊聊公园' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(decisionSignal).toBeDefined();
    if (event === 'new_turn') s.session.handleClientMessage({ type: 'debug.userText', text: '再聊聊树' });
    if (event === 'disconnect') s.session.detachTransport();
    if (event === 'rebuild') s.mocks[0].emit('error', 'synthetic_retryable', true);
    expect(decisionSignal.aborted).toBe(true);
    finish('{"speak":true,"text":"公园里那条小路让您惦记着。"}');
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(s.sent, 'response.start').filter(m => m.kind === 'followup')).toEqual([]);
    s.session.end();
  });

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
    expect(s.mocks[0].notes).toEqual([]);
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
    expect(s.mocks[0].notes).toEqual([]);
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

  it('backs off repeated summarizer failures', async () => {
    let calls = 0;
    const s = setup({
      ledger: { keepRecentTurns: 1, summarizeAfterTurns: 1, summarizeAfterTokens: 10_000 },
      summarizer: { summarize: async () => { calls++; throw new Error('upstream'); } },
    });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '第一句' });
    await Promise.resolve();
    s.session.handleClientMessage({ type: 'debug.userText', text: '第二句' });
    await Promise.resolve();
    expect(calls).toBe(1);
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

  it('retries a failed model rebuild with backoff', async () => {
    let created = 0;
    let first: MockAdapter;
    const s = setup({ adapterFactory: () => {
      const adapter = new MockAdapter({ script });
      created++;
      if (created === 1) first = adapter;
      if (created === 2) vi.spyOn(adapter, 'connect').mockRejectedValue(new Error('temporary'));
      return adapter;
    } });
    await s.session.start(s.transport);
    first!.simulateDrop();
    await Promise.resolve();
    expect(created).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(created).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(created).toBe(3);
  });

  it('buffers a short mic tail while rebuilding and sends it after reconnect', async () => {
    let created = 0;
    let first: MockAdapter;
    const sends: number[] = [];
    const s = setup({ adapterFactory: () => {
      const adapter = new MockAdapter({ script });
      created++;
      if (created === 1) first = adapter;
      vi.spyOn(adapter, 'sendAudio').mockImplementation((pcm) => sends.push(pcm.length));
      if (created === 2) vi.spyOn(adapter, 'connect').mockRejectedValue(new Error('temporary'));
      return adapter;
    } });
    await s.session.start(s.transport);
    first!.simulateDrop();
    s.session.handleMicAudio(loud());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(created).toBe(3);
    expect(sends).toContain(320);
  });

  it('restores the upstream input mute state after rebuilding', async () => {
    const transitions: boolean[][] = [];
    const adapters: MockAdapter[] = [];
    const s = setup({ adapterFactory: () => {
      const adapter = new MockAdapter({ script });
      const states: boolean[] = [];
      Object.assign(adapter, { setInputMuted: (muted: boolean) => states.push(muted) });
      adapters.push(adapter);
      transitions.push(states);
      return adapter;
    } });
    await s.session.start(s.transport);
    s.session.handleClientMessage({ type: 'client.mute', muted: true });
    adapters[0].simulateDrop();
    await vi.advanceTimersByTimeAsync(10);
    expect(transitions[1]).toEqual([true]);
    s.session.end();
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
    const muteTransitions: boolean[] = [];
    (s.mocks[0] as MockAdapter & { setInputMuted: (muted: boolean) => void }).setInputMuted = (muted) => muteTransitions.push(muted);
    s.session.handleClientMessage({ type: 'client.mute', muted: true });
    for (let i = 0; i < 10; i++) s.session.handleMicAudio(loud());
    for (let i = 0; i < 40; i++) s.session.handleMicAudio(quiet());
    s.session.handleClientMessage({ type: 'client.mute', muted: false });
    expect(of(s.sent, 'transcript.user')).toEqual([]);
    expect(muteTransitions).toEqual([true, false]);
  });

  it('keeps playback audio off the model and resumes uplink after the tail guard', async () => {
    const s = setup({ modelOwnsTurns: true, tailGuardMs: 400 });
    let uplink = 0;
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(200);
    s.mocks[0].sendAudio = () => { uplink++; };
    s.session.handleMicAudio(loud());
    expect(uplink).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    s.session.handleMicAudio(loud());
    expect(uplink).toBe(0); // speaker tail
    await vi.advanceTimersByTimeAsync(400);
    s.session.handleMicAudio(loud());
    expect(uplink).toBe(1);
  });

  it('streams the barge-in while playback is still active', async () => {
    const s = setup({ modelOwnsTurns: true });
    let uplink = 0;
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(200);
    s.mocks[0].sendAudio = () => { uplink++; };
    s.session.handleMicAudio(quiet());
    s.session.handleMicAudio(loud());
    s.session.handleMicAudio(loud());
    expect(uplink).toBe(0);
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 1 });
    expect(uplink).toBe(2);
    s.session.handleMicAudio(loud());
    expect(uplink).toBe(3);
  });

  it('does not delay uplink after an interruption', async () => {
    const s = setup({ modelOwnsTurns: true, tailGuardMs: 400 });
    let uplink = 0;
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(400);
    s.session.handleClientMessage({ type: 'debug.userText', text: '随便聊聊' });
    await vi.advanceTimersByTimeAsync(150);
    s.mocks[0].sendAudio = () => { uplink++; };
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 50, reason: 'interrupted' });
    s.session.handleMicAudio(loud());
    expect(uplink).toBe(1);
  });

  it('runs silence follow-ups and the reconnect line when the model owns turns', async () => {
    const s = setup({ modelOwnsTurns: true });
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(8_500);
    expect(of(s.sent, 'response.start').map((m) => m.kind)).toEqual(['greeting', 'followup']);
    await vi.advanceTimersByTimeAsync(1_000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    s.session.detachTransport();
    const second = collector();
    s.session.attachTransport(second.transport);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(of(second.sent, 'response.start').map((m) => m.kind)).toEqual(['followup']);
  });

  it('never starts a proactive response while the model is still generating', async () => {
    const s = setup({ modelOwnsTurns: true });
    await greetAndFinish(s);
    const creates = vi.spyOn(s.mocks[0], 'createResponse');
    s.mocks[0].emit('responseStarted', 'external'); // e.g. an audio-less reply before a tool call
    // Playback of seq 2 ends (nothing to play) while generation is still running: active is cleared, generating is not.
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 0, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(8_500);
    expect(creates).not.toHaveBeenCalled();
  });

  it('clears the generating flag when the model is rebuilt mid-generation', async () => {
    const s = setup({ modelOwnsTurns: true });
    await greetAndFinish(s);
    s.mocks[0].emit('responseStarted', 'external'); // generating, no audio
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 0, reason: 'ended' });
    s.mocks[0].simulateDrop(); // rebuild drops the old adapter; its responseDone never arrives
    await vi.advanceTimersByTimeAsync(50);
    expect(s.mocks).toHaveLength(2);
    let uplink = 0;
    s.mocks[1].sendAudio = () => { uplink++; };
    s.session.handleMicAudio(loud());
    expect(uplink).toBe(1);
    s.session.attachTransport(s.transport);
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(s.sent, 'response.start').map((m) => m.kind)).toContain('followup');
  });

  it('does not let a stale tail guard block uplink after an interruption', async () => {
    const s = setup({ modelOwnsTurns: true, tailGuardMs: 400 });
    let uplink = 0;
    await greetAndFinish(s); // greeting ended: tail guard armed
    s.session.handleClientMessage({ type: 'debug.userText', text: '随便聊聊' });
    await vi.advanceTimersByTimeAsync(150);
    s.mocks[0].sendAudio = () => { uplink++; };
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 50, reason: 'interrupted' });
    s.session.handleMicAudio(loud());
    expect(uplink).toBe(1);
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
  it('reports content-free metrics for every finalized reply', async () => {
    const metrics: ReplyMetrics[] = [];
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write);
    const s = setup({ onReplyMetrics: (m) => metrics.push(m) });
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000);
    s.mocks[0].emit('responseUsage', 'mock-1', { inputTokens: 10, outputTokens: 5 });
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    s.session.handleClientMessage({ type: 'debug.userText', text: '跟我挥挥手' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    spy.mockRestore();
    expect(metrics.map((m) => [m.seq, m.kind, m.outcome, m.replyChars, m.toolCalls, m.outputTokens])).toEqual([
      [1, 'greeting', 'ended', 3, 0, 5],
      [2, 'reply', 'ended', 2, 1, null],
    ]);
    const lines = writes.filter((w) => w.includes('"reply_metrics"'));
    expect(lines).toHaveLength(2);
    expect(lines.join('')).not.toMatch(/你好呀|好呀|挥挥手/);
  });

  it('times out a hanging summarizer through the policy and retries after backoff', async () => {
    let calls = 0;
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write);
    try {
      const s = setup({
        ledger: { keepRecentTurns: 1, summarizeAfterTurns: 1, summarizeAfterTokens: 10_000 },
        // Settles (rejects) at 1000 ms, after the 500 ms policy timeout, so the ledger flag clears by then.
        summarizer: { summarize: () => { calls++; return new Promise<string>((_, reject) => setTimeout(() => reject(new Error('slow_summarizer')), 1000)); } },
        summarizePolicy: { timeoutMs: 500, retries: 0, backoffMs: 100, maxBackoffMs: 100 },
      });
      await greetAndFinish(s);
      s.session.handleClientMessage({ type: 'debug.userText', text: '第一句' });
      s.session.handleClientMessage({ type: 'debug.userText', text: '第二句' }); // > 1 user turn: summarize starts
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(600); // policy timeout fires at 500 ms; cooldown (1 s) runs to ~1500 ms
      const failed = writes.filter((w) => w.includes('"policy_failed"')).join('');
      expect(failed).toContain('"summarize_timeout"');
      expect(failed).not.toMatch(/第一句|第二句/);
      await vi.advanceTimersByTimeAsync(500); // t~1100: late rejection settled, still inside the cooldown
      s.session.handleClientMessage({ type: 'debug.userText', text: '第三句' });
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(600); // past the cooldown
      s.session.handleClientMessage({ type: 'debug.userText', text: '第四句' });
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
  it('does not count recent turns twice when deciding to slim the context', async () => {
    // Old estimate (chars since rebuild + current instructions incl. recent turns) ≈ 150 > 120 → rebuild.
    // Correct estimate (chars since rebuild + instructions last sent, 31 chars) ≈ 87 → no rebuild.
    const s = setup({ modelContextTokenLimit: 120, rebuildTriggerRatio: 1 });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '好'.repeat(50) });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.mocks).toHaveLength(1);
  });

  it('keeps instructions within the budget and summarizes before history is truncated', async () => {
    const budget = { totalChars: 200, snapshotMaxChars: 0, summaryMaxChars: 60 };
    const s = setup({ budget, ledger: { keepRecentTurns: 1, summarizeAfterTurns: 100, summarizeAfterTokens: 10_000 } });
    await greetAndFinish(s);
    // History room = 200 - 31 (persona 'P' + empty sections) = 169 chars; two 90-char turns exceed it.
    for (const text of ['甲'.repeat(90), '乙'.repeat(90)]) {
      s.session.handleClientMessage({ type: 'debug.userText', text });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(s.session.ledger.summary).not.toBe('');
    expect(s.mocks[0].instructions.length).toBeLessThanOrEqual(200 + 4);
  });

  it('restarts silence after a proactive line is cut off while nobody is speaking', async () => {
    const s = setup();
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(6100);
    expect(of(s.sent, 'response.start').map((m) => m.kind)).toEqual(['greeting', 'followup']);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 50, reason: 'interrupted' });
    await vi.advanceTimersByTimeAsync(6100);
    expect(of(s.sent, 'response.start').map((m) => m.kind)).toEqual(['greeting', 'followup', 'followup']);
  });

  it('carries the interruption into the model instructions', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '随便聊聊' });
    await vi.advanceTimersByTimeAsync(150);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 50, reason: 'interrupted' });
    expect(s.mocks[0].instructions).not.toContain('被用户打断');
    expect(s.session.ledger.recent.at(-1)?.interrupted).toBe(true);
  });

  it('passes the configured output cap to the adapter', async () => {
    const seen: Array<number | undefined> = [];
    const s = setup({
      maxOutputTokens: 150,
      adapterFactory: () => {
        const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
        const connect = m.connect.bind(m);
        vi.spyOn(m, 'connect').mockImplementation((c) => { seen.push(c.maxOutputTokens); return connect(c); });
        return m;
      },
    });
    await s.session.start(s.transport);
    expect(seen).toEqual([150]);
  });

  it('omits the output cap when none is configured', async () => {
    const seen: Array<SessionConfig> = [];
    const s = setup({
      adapterFactory: () => {
        const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
        const connect = m.connect.bind(m);
        vi.spyOn(m, 'connect').mockImplementation((c) => { seen.push(c); return connect(c); });
        return m;
      },
    });
    await s.session.start(s.transport);
    expect(seen).toHaveLength(1);
    expect('maxOutputTokens' in seen[0]!).toBe(false);
  });

  it('continues after a forced playback cancel when the client never reports playback.stopped', async () => {
    const s = setup();
    await greetAndFinish(s);
    const creates = vi.spyOn(s.mocks[0], 'createResponse');
    s.session.handleClientMessage({ type: 'debug.userText', text: '跟我挥挥手' });
    await vi.advanceTimersByTimeAsync(60); // tool call and first audio; origin response.done is later
    const originSeq = s.session.lastResponseSeq;
    expect(s.audio.some((a) => a.seq === originSeq)).toBe(true);
    expect(of(s.sent, 'response.cancelled')).toContainEqual({ type: 'response.cancelled', responseSeq: originSeq });
    expect(creates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(of(s.sent, 'response.end').some((m) => m.responseSeq === originSeq)).toBe(true);
    expect(creates).toHaveBeenCalledTimes(1);
    expect(creates).toHaveBeenCalledWith({
      cue: 'toolContinue',
      instruction: '用一句话接上刚才的动作。不要描述动作过程。',
      fallbackText: '好。',
    });
  });

  it('continues after a tool action once playback ends and keeps the mic quiet', async () => {
    const s = setup();
    const finished = vi.spyOn(InterruptCoordinator.prototype, 'onResponseFinished');
    try {
      await greetAndFinish(s);
      finished.mockClear();
      const creates = vi.spyOn(s.mocks[0], 'createResponse');
      s.session.handleClientMessage({ type: 'debug.userText', text: '跟我挥挥手' });
      await vi.advanceTimersByTimeAsync(60); // tool call and first audio; origin response.done is later
      const originSeq = s.session.lastResponseSeq;
      expect(s.mocks[0].toolResults).toEqual([{ callId: 'call-mock-2', result: { ok: true } }]);
      expect(of(s.sent, 'avatar.action').some((m) => m.action === 'wave')).toBe(true);
      expect(of(s.sent, 'response.cancelled')).toContainEqual({ type: 'response.cancelled', responseSeq: originSeq });
      expect(finished).toHaveBeenCalledWith(originSeq);
      const finishOrder = finished.mock.invocationCallOrder[0]!;
      const uplink = vi.spyOn(s.mocks[0], 'sendAudio');
      s.session.handleMicAudio(loud());
      s.session.handleMicAudio(quiet());
      expect(uplink).not.toHaveBeenCalled();
      s.mocks[0].emit('error', 'invalid_request_error', true);
      expect(of(s.sent, 'error')).toEqual([]);
      s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
      expect(creates).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(creates).toHaveBeenCalledTimes(1);
      expect(creates).toHaveBeenCalledWith({
        cue: 'toolContinue',
        instruction: '用一句话接上刚才的动作。不要描述动作过程。',
        fallbackText: '好。',
      });
      expect(finishOrder).toBeLessThan(creates.mock.invocationCallOrder[0]!);
      s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: originSeq, playedMs: 300, reason: 'ended' });
      expect(creates).toHaveBeenCalledTimes(1);
    } finally {
      finished.mockRestore();
    }
  });

  it('sends avatar emotions from user and assistant text when configured', async () => {
    const s = setup({ emotion: { defaultEmotion: 'happy', debounceMs: 0, revertAfterMs: 6000, firstSentenceMaxChars: 20, priority: ['sad', 'love', 'happy'], lexicon: { neutral: [], happy: ['你好'], sad: ['难过'], love: [] } } });
    await greetAndFinish(s); // greeting '你好呀' has no sentence end yet; happy is already the default anyway
    s.session.handleClientMessage({ type: 'debug.userText', text: '我今天很难过' });
    expect(of(s.sent, 'avatar.emotion').map((m) => m.emotion)).toEqual(['sad']);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(of(s.sent, 'avatar.emotion').map((m) => m.emotion)).toEqual(['sad', 'happy']);
  });

  it('writes a user final when it arrives and flushes assistant replies once', async () => {
    const append = vi.fn<TranscriptWriter['append']>(() => 'stored');
    const s = setup({ writer: { append, markNotified: () => {} } }, ownedCtx, 'session-fixed');
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000);
    s.session.flush();
    expect(append).not.toHaveBeenCalled();
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    s.session.flush();
    s.session.handleClientMessage({ type: 'debug.userText', text: '我叫老王' });
    expect(append.mock.calls.map((c) => c[0])).toEqual([
      { ownerId: 'owner-1', sessionId: 'session-fixed', role: 'assistant', text: '你好呀', now: expect.any(Number) },
      { ownerId: 'owner-1', sessionId: 'session-fixed', role: 'user', text: '我叫老王', now: expect.any(Number) },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(assistantText(s.sent, 2)).toBe('我在听');
    s.session.flush();
    expect(append.mock.calls.map((c) => c[0].text)).toEqual(['你好呀', '我叫老王']);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 400, reason: 'ended' });
    s.session.flush();
    expect(append.mock.calls.map((c) => c[0])).toEqual([
      { ownerId: 'owner-1', sessionId: 'session-fixed', role: 'assistant', text: '你好呀', now: expect.any(Number) },
      { ownerId: 'owner-1', sessionId: 'session-fixed', role: 'user', text: '我叫老王', now: expect.any(Number) },
      { ownerId: 'owner-1', sessionId: 'session-fixed', role: 'assistant', text: '我在听', now: expect.any(Number) },
    ]);
    s.session.flush();
    expect(append).toHaveBeenCalledTimes(3);
  });

  it('flushes the playback slice of an interrupted reply', async () => {
    const append = vi.fn<TranscriptWriter['append']>(() => 'stored');
    const s = setup({ writer: { append, markNotified: () => {} } }, ownedCtx, 'session-cut');
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '随便聊聊' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(assistantText(s.sent, 2)).toBe('我在听');
    // 3×100ms chunks at 24 kHz. Half of that audio is the first two characters.
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 150, reason: 'interrupted' });
    s.session.flush();
    expect(append.mock.calls.map((c) => c[0].text)).toEqual(['随便聊聊', '你好呀', '我在']);
  });

  it('marks notified only when the memory-notice seq plays to the end', async () => {
    const markNotified = vi.fn();
    const writer: TranscriptWriter = { append: () => 'stored', markNotified };
    const s = setup({ writer }, ownedCtx, 'notice-session', true);
    await greetAndFinish(s);
    expect(markNotified).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    const notice = of(s.sent, 'response.start').at(-1);
    expect(notice).toEqual({ type: 'response.start', responseSeq: 2, kind: 'followup' });
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: notice!.responseSeq, playedMs: 300, reason: 'ended' });
    expect(markNotified).toHaveBeenCalledTimes(1);
    expect(markNotified).toHaveBeenCalledWith('owner-1', expect.any(Number));
    await vi.advanceTimersByTimeAsync(6000);
    const later = of(s.sent, 'response.start').at(-1)!;
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: later.responseSeq, playedMs: 300, reason: 'ended' });
    expect(markNotified).toHaveBeenCalledTimes(1);
  });

  it('does not mark notified when the memory notice is interrupted', async () => {
    const markNotified = vi.fn();
    const writer: TranscriptWriter = { append: () => 'stored', markNotified };
    const s = setup({ writer }, ownedCtx, 'notice-cut', true);
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(1000);
    const noticeSeq = of(s.sent, 'response.start').at(-1)!.responseSeq;
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: noticeSeq, playedMs: 80, reason: 'interrupted' });
    expect(markNotified).not.toHaveBeenCalled();
  });

  it('retries a notice that ends without playback ended, then marks notified once', async () => {
    const markNotified = vi.fn();
    const cues: Array<string | undefined> = [];
    const adapters: MockAdapter[] = [];
    const s = setup({
      writer: { append: () => 'stored', markNotified },
      adapterFactory: () => {
        const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
        adapters.push(m);
        const create = m.createResponse.bind(m);
        m.createResponse = (req) => { cues.push(req?.cue); return create(req); };
        return m;
      },
    }, ownedCtx, 'notice-missed', true);
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(80);
    expect(cues.filter((c) => c === 'memoryNotice')).toHaveLength(1);
    adapters[0]!.cancelResponse();
    expect(markNotified).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(cues.filter((c) => c === 'memoryNotice').length).toBeGreaterThanOrEqual(2);
    const retry = of(s.sent, 'response.start').at(-1)!;
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: retry.responseSeq, playedMs: 300, reason: 'ended' });
    expect(markNotified).toHaveBeenCalledTimes(1);
    const notices = cues.filter((c) => c === 'memoryNotice').length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(cues.filter((c) => c === 'memoryNotice')).toHaveLength(notices);
  });

  it('does not record a server-VAD reply as the memory notice', async () => {
    const markNotified = vi.fn();
    const writer: TranscriptWriter = { append: () => 'stored', markNotified };
    const s = setup({ writer }, ownedCtx, 'notice-reply');
    await greetAndFinish(s);
    for (let i = 0; i < 10; i++) s.session.handleMicAudio(loud());
    for (let i = 0; i < 40; i++) s.session.handleMicAudio(quiet());
    await vi.advanceTimersByTimeAsync(1000);
    const reply = of(s.sent, 'response.start').at(-1);
    expect(reply).toEqual({ type: 'response.start', responseSeq: 2, kind: 'reply' });
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: reply!.responseSeq, playedMs: 300, reason: 'ended' });
    expect(markNotified).not.toHaveBeenCalled();
  });

  it('enqueues extraction every configured number of user turns when a worker is injected', () => {
    const reasons: string[] = [];
    const s = setup({
      worker: { extractOwner: async (_ownerId, reason) => { reasons.push(reason); } },
      extractEveryUserTurns: 2,
    }, ownedCtx, 'extract-turns');
    s.session.handleClientMessage({ type: 'debug.userText', text: '第一句' });
    expect(reasons).toEqual([]);
    s.session.handleClientMessage({ type: 'debug.userText', text: '第二句' });
    expect(reasons).toEqual(['turns']);
    s.session.handleClientMessage({ type: 'debug.userText', text: '第三句' });
    expect(reasons).toEqual(['turns']);
  });

  it('does not enqueue extraction when no worker is injected', () => {
    const s = setup({}, ownedCtx, 'extract-dev');
    expect(() => s.session.handleClientMessage({ type: 'debug.userText', text: '第一句' })).not.toThrow();
  });

  it('writes nothing when the writer or the owner is missing', async () => {
    const append = vi.fn<TranscriptWriter['append']>(() => 'stored');
    const noOwner = setup({ writer: { append, markNotified: () => {} } }, undefined, 'session-no-owner');
    await greetAndFinish(noOwner);
    noOwner.session.handleClientMessage({ type: 'debug.userText', text: '我叫老王' });
    noOwner.session.flush();
    expect(append).not.toHaveBeenCalled();

    const noWriter = setup({}, ownedCtx);
    await greetAndFinish(noWriter);
    expect(() => noWriter.session.handleClientMessage({ type: 'debug.userText', text: '我叫老王' })).not.toThrow();
    expect(() => noWriter.session.flush()).not.toThrow();
  });

  it('continues after an unknown tool once the origin is ready', async () => {
    const calls: Array<{ cue?: string; instruction?: string; fallbackText?: string }> = [];
    const mocks: MockAdapter[] = [];
    const s = setup({
      adapterFactory: () => {
        const mock = new MockAdapter({
          script: {
            ...script,
            turns: [{ match: '未知', user: '未知工具', reply: '好呀', tool: { name: 'not_a_tool', args: {} } }],
          },
          replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1,
        });
        const create = mock.createResponse.bind(mock);
        mock.createResponse = (request) => {
          if (request) calls.push(request);
          return create(request);
        };
        mocks.push(mock);
        return mock;
      },
    });
    await greetAndFinish(s);
    calls.length = 0;
    s.session.handleClientMessage({ type: 'debug.userText', text: '未知工具' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(mocks[0]!.toolResults).toEqual([{ callId: 'call-mock-2', result: { ok: false, error: 'unknown_tool' } }]);
    expect(calls).toContainEqual({
      cue: 'toolContinue',
      instruction: director.toolContinueInstruction,
      fallbackText: director.toolContinueText,
    });
  });

  it('does not cancel the adapter when the user speaks before a continuation is requested', async () => {
    const s = setup();
    await greetAndFinish(s);
    const creates = vi.spyOn(s.mocks[0]!, 'createResponse');
    const cancel = vi.spyOn(s.mocks[0]!, 'cancelResponse');
    s.session.handleClientMessage({ type: 'debug.userText', text: '跟我挥挥手' });
    await vi.advanceTimersByTimeAsync(60);
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 1 });
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(creates).toHaveBeenCalledWith({
      cue: 'toolContinue',
      instruction: director.toolContinueInstruction,
      fallbackText: director.toolContinueText,
    });
  });

  it('cancels a continuation that was already requested when the user speaks', async () => {
    const s = setup();
    await greetAndFinish(s);
    const creates = vi.spyOn(s.mocks[0]!, 'createResponse');
    s.session.handleClientMessage({ type: 'debug.userText', text: '跟我挥挥手' });
    await vi.advanceTimersByTimeAsync(260);
    expect(creates).toHaveBeenCalledTimes(1);
    const cancel = vi.spyOn(s.mocks[0]!, 'cancelResponse');
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 2 });
    expect(cancel).toHaveBeenCalledTimes(1);
    const uplink = vi.spyOn(s.mocks[0]!, 'sendAudio');
    s.session.handleMicAudio(loud());
    expect(uplink).toHaveBeenCalled();
  });

  it('continues after playback when the origin finished before the tool call', async () => {
    const s = setup();
    await greetAndFinish(s);
    const creates = vi.spyOn(s.mocks[0]!, 'createResponse');
    s.mocks[0]!.emit('responseStarted', 'early-done');
    s.mocks[0]!.emit('audioDelta', 'early-done', new Int16Array(480));
    s.mocks[0]!.emit('responseDone', 'early-done');
    const seq = s.session.lastResponseSeq;
    s.mocks[0]!.emit('toolCall', 'early-done', 'call-early', 'perform_action', { action: 'wave' });
    await vi.advanceTimersByTimeAsync(0);
    expect(creates).not.toHaveBeenCalled();
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: seq, playedMs: 20, reason: 'ended' });
    expect(creates).toHaveBeenCalledTimes(1);
    expect(creates).toHaveBeenCalledWith({
      cue: 'toolContinue',
      instruction: director.toolContinueInstruction,
      fallbackText: director.toolContinueText,
    });
  });

  it('continues when playback already ended before the tool call', async () => {
    const s = setup();
    await greetAndFinish(s);
    const creates = vi.spyOn(s.mocks[0]!, 'createResponse');
    s.mocks[0]!.emit('responseStarted', 'played-out');
    s.mocks[0]!.emit('audioDelta', 'played-out', new Int16Array(480));
    s.mocks[0]!.emit('responseDone', 'played-out');
    const seq = s.session.lastResponseSeq;
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: seq, playedMs: 20, reason: 'ended' });
    expect(creates).not.toHaveBeenCalled();
    s.mocks[0]!.emit('toolCall', 'played-out', 'call-played', 'perform_action', { action: 'wave' });
    await vi.advanceTimersByTimeAsync(0);
    expect(creates).toHaveBeenCalledTimes(1);
    expect(creates).toHaveBeenCalledWith({
      cue: 'toolContinue',
      instruction: director.toolContinueInstruction,
      fallbackText: director.toolContinueText,
    });
  });

  it('does not treat an interrupted stop before the tool call as playback ended', async () => {
    const s = setup();
    await greetAndFinish(s);
    const creates = vi.spyOn(s.mocks[0]!, 'createResponse');
    s.mocks[0]!.emit('responseStarted', 'cut-off');
    s.mocks[0]!.emit('audioDelta', 'cut-off', new Int16Array(480));
    s.mocks[0]!.emit('responseDone', 'cut-off');
    const seq = s.session.lastResponseSeq;
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: seq, playedMs: 10, reason: 'interrupted' });
    s.mocks[0]!.emit('toolCall', 'cut-off', 'call-cut', 'perform_action', { action: 'wave' });
    await vi.advanceTimersByTimeAsync(0);
    expect(creates).not.toHaveBeenCalled();
  });
});
