import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Language, ServerMessage } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import type { SessionConfig } from '../src/adapters/types.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { fixedRoleCatalog, type RoleCatalog } from '../src/roles/catalog.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig, SilenceContext } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import type { ReplyMetrics } from '../src/session/metrics.ts';
import type { MemoryStore } from '../src/memory/store.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';
import { PROMPT_LABELS } from '../src/roles/labels.ts';
import { loadAffectConfig } from '../src/session/affect.ts';
import type { PushGate } from '../src/session/pushGate.ts';
import { timeContext } from '../src/session/timeContext.ts';
import { InterruptCoordinator } from '../src/session/interrupt.ts';
import type { PacingConfig } from '../src/session/pacing.ts';
import { Session, type SessionDeps, type TranscriptWriter, type Transport } from '../src/session/session.ts';

const i18n = loadI18n(`${fileURLToPath(new URL('..', import.meta.url))}config`);
const languageRules = i18n.language;

const script: MockScript = {
  greeting: '你好呀',
  followup: '还在吗',
  memoryNotice: '我会记着',
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

  it('uses the young male voice for every language', async () => {
    const configs: SessionConfig[] = [];
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'ja', 'en'], defaultLanguage: 'zh' });
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
        voiceFor: (language) => language === 'zh' ? 'longanlingxin' : 'Tina',
        youngMaleVoice: 'Evan',
      },
      { roleId: 'elder-companion', styleId: 'grandchild', language: 'ja' },
    );
    session.useYoungMaleVoice();
    await session.start(collector().transport);
    expect(configs[0]?.voice).toBe('Evan');
    session.setInitialLanguage('zh');
    expect(session.currentLanguage).toBe('zh');
    session.end();
  });

  it('uses Ryan for Chinese so a wave dash is not spoken as a bar', async () => {
    vi.useFakeTimers();
    try {
      const s = setup({
        roles: fixedRoleCatalog('P', director, { languages: ['zh', 'ja', 'en'], defaultLanguage: 'zh' }),
        voiceFor: (language) => language === 'zh' ? 'longanlingxin' : 'Tina',
        youngMaleVoice: 'Evan',
        youngMaleVoices: { zh: 'Ryan', ja: 'Evan', en: 'Evan' },
      }, { roleId: 'elder-companion', styleId: 'grandchild', language: 'zh' });
      s.session.useYoungMaleVoice();
      await greetAndFinish(s);
      expect(s.mocks[0]!.voice).toBe('Ryan');
      s.session.setInitialLanguage('ja');
      expect(s.mocks[0]!.sessionUpdates.at(-1)?.voice?.value).toBe('Evan');
      s.session.end();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the session language for persona and voice', async () => {
    const configs: SessionConfig[] = [];
    const roles = fixedRoleCatalog('P-zh', director, {
      languages: ['zh', 'en'],
      defaultLanguage: 'zh',
      personas: { zh: 'P-zh', en: 'P-en' },
      directors: { en: { ...director, greetingText: 'hello' } },
    });
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
        voiceFor: (language) => language === 'en' ? 'voice-en' : undefined,
      },
      { roleId: 'elder-companion', styleId: 'grandchild', language: 'en' },
    );
    await session.start(collector().transport);
    expect(configs[0]?.instructions).toContain('P-en');
    expect(configs[0]?.voice).toBe('voice-en');
    expect(session.currentLanguage).toBe('en');

    session.setInitialLanguage('zh');
    expect(session.currentLanguage).toBe('zh');
    session.end();
  });

  it('builds tool specs in the session language', async () => {
    const configs: SessionConfig[] = [];
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'ja', 'en'], defaultLanguage: 'zh' });
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
        i18n,
      },
      { roleId: 'elder-companion', styleId: 'grandchild', language: 'ja' },
    );
    await session.start(collector().transport);

    const tools = configs[0]!.tools;
    expect(tools.find((tool) => tool.name === 'recall_memory')?.description).toBe(i18n.memory.ja.recall.toolDescription);
    expect(tools.find((tool) => tool.name === 'perform_action')?.description).toBe(i18n.memory.ja.performAction.toolDescription);
    expect(tools.find((tool) => tool.name === 'forget_memory')?.description).toBe(i18n.memory.ja.recall.forgetToolDescription);
    session.end();
  });

  it('falls back to the role default when a language is unsupported', () => {
    const roles = fixedRoleCatalog('P', director, { languages: ['zh'], defaultLanguage: 'zh' });
    const session = new Session(
      { adapterFactory: () => new MockAdapter({ script }), summarizer: new MockSummarizer(), roles },
      { roleId: 'elder-companion', styleId: 'grandchild', language: 'ja' },
    );
    expect(session.currentLanguage).toBe('zh');
    session.end();
  });
});

const ownedCtx: SessionContext = {
  ownerId: 'owner-1', agentId: 'agent-1', roleId: 'elder-companion', styleId: 'grandchild',
};

/** Only the rows refreshMemorySnapshot reads. */
function memoryStoreStub(input: { addressing?: string[]; facts?: string[]; tail?: string[] }): MemoryStore {
  return {
    listProfileFacts: () => (input.addressing ?? []).map((text, i) => ({ id: `p${i}`, category: 'addressing', text })),
    listAgentFacts: () => (input.facts ?? []).map((text, i) => ({ id: `f${i}`, category: 'preference', text, sensitive: false })),
    recentUserMessages: () => (input.tail ?? []).map((text) => ({ text })),
  } as unknown as MemoryStore;
}

const slimOn: NonNullable<PacingConfig['slim']> = {
  enabled: true,
  intervalMs: 1_500,
  maxDeferMs: 5_000,
  bridgeAfterMs: 400,
  bridge: { zh: '我想想刚才聊到哪。', ja: 'さっきの続きを思い出すね。', en: 'Let me think about where we were.' },
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
    noticeKeywords: ['记着', '记住'],
    languageRules,
    ...overrides,
  }, ctx, sessionId, noticePending);
  return { session, mocks, ...collector() };
}

/** Two-language catalog used by the instruction-push tests. */
const bilingualRoles = (): RoleCatalog => fixedRoleCatalog('P-zh', director, {
  languages: ['zh', 'en'],
  defaultLanguage: 'zh',
  personas: { zh: 'P-zh', en: 'P-en' },
});

/** Narrow cast: the guard tests need one push attempt without a real model request. */
const drivePush = (session: Session): void =>
  (session as unknown as { gate: { flush(): void } }).gate.flush();

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

  it('uses a safe name greeting instead of planning a topic', async () => {
    let plannerCalls = 0;
    const roles = fixedRoleCatalog('P', {
      ...director,
      greetingNameTexts: ['{name}，又见面了。'],
      silenceDecision: {
        instruction: 'D', speakInstruction: 'SAY {continuation}',
        maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
        policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      },
    });
    const s = setup({
      roles,
      textClient: { complete: async () => { plannerCalls += 1; return '{"speak":true,"text":"上次聊到您喜欢听京剧"}'; } },
    }, { ...ownedCtx, memorySnapshot: '称呼：王叔', greetingMemorySnapshot: '称呼：王叔', greetingHasTopic: true }, 'safe-greeting');
    const creates = vi.spyOn(s.mocks[0]!, 'createResponse');
    await s.session.start(s.transport);
    expect(plannerCalls).toBe(0);
    expect(creates).toHaveBeenCalledWith({ cue: 'greeting', instruction: '王叔，又见面了。', fallbackText: '王叔，又见面了。' });
    s.session.end();
  });

  it('reads the localized addressing line for the safe greeting', async () => {
    const enDirector: DirectorConfig = {
      ...director,
      greetingNameTexts: ['{name}, good to see you again.'],
      silenceDecision: {
        instruction: 'D', speakInstruction: 'SAY {continuation}',
        maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
        policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      },
    };
    const roles = fixedRoleCatalog('P-en', enDirector, { languages: ['en'], defaultLanguage: 'en', directors: { en: enDirector } });
    const s = setup({
      roles,
      store: memoryStoreStub({ addressing: ['My name is Hanako'], facts: ['likes tea'] }),
      budget: { totalChars: 8_000, snapshotMaxChars: 600, summaryMaxChars: 800 },
      textClient: { complete: async () => '{"speak":false}' },
    }, { ...ownedCtx, language: 'en' }, 'en-safe-greeting');
    const creates = vi.spyOn(s.mocks[0]!, 'createResponse');
    await s.session.start(s.transport);
    expect(creates).toHaveBeenCalledWith({
      cue: 'greeting', instruction: 'Hanako, good to see you again.', fallbackText: 'Hanako, good to see you again.',
    });
    s.session.end();
  });

  it('greets with a zh-stored name in an en session', async () => {
    const enDirector: DirectorConfig = {
      ...director,
      greetingNameTexts: ['{name}, good to see you again.'],
      silenceDecision: {
        instruction: 'D', speakInstruction: 'SAY {continuation}',
        maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
        policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      },
    };
    const roles = fixedRoleCatalog('P-en', enDirector, { languages: ['en'], defaultLanguage: 'en', directors: { en: enDirector } });
    const s = setup({
      roles,
      store: memoryStoreStub({ addressing: ['称呼：王叔'] }),
      budget: { totalChars: 8_000, snapshotMaxChars: 600, summaryMaxChars: 800 },
      textClient: { complete: async () => '{"speak":false}' },
    }, { ...ownedCtx, language: 'en' }, 'en-zh-addressing');
    expect(s.session.context.greetingMemorySnapshot).toBe('Address as: 王叔');
    const creates = vi.spyOn(s.mocks[0]!, 'createResponse');
    await s.session.start(s.transport);
    expect(creates).toHaveBeenCalledWith({
      cue: 'greeting', instruction: '王叔, good to see you again.', fallbackText: '王叔, good to see you again.',
    });
    s.session.end();
  });

  it('re-renders the memory snapshot with the new labels when the language changes', () => {
    const roles = fixedRoleCatalog('P-zh', director, {
      languages: ['zh', 'en'],
      defaultLanguage: 'zh',
      personas: { zh: 'P-zh', en: 'P-en' },
    });
    const store = memoryStoreStub({
      addressing: ['My name is Hanako'],
      facts: ['likes tea'],
      tail: ['I walk every morning.'],
    });
    const session = new Session({
      adapterFactory: () => new MockAdapter({ script }),
      summarizer: new MockSummarizer(),
      roles,
      store,
      budget: { totalChars: 8_000, snapshotMaxChars: 600, summaryMaxChars: 800 },
    }, { ...ownedCtx, language: 'zh' });
    expect(session.context.memorySnapshot).toBe('My name is Hanako\n事实：likes tea\n用户：I walk every morning.');

    session.setInitialLanguage('en');
    expect(session.context.memorySnapshot).toBe('Address as: Hanako\nFact: likes tea\nUser: I walk every morning.');
    session.end();
  });

  it('keeps the substantive answer when a deferred memory notice plays after it', async () => {
    const inputs: unknown[] = [];
    const s = setup({
      adapterFactory: () => new MockAdapter({
        script: { ...script, memoryNotice: director.memoryNoticeText, turns: [{ match: '老王', user: '我叫老王', reply: '王叔好' }] },
        replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1,
      }),
      roles: fixedRoleCatalog('P', { ...director, contextAfterMs: 3000, silenceDecision: {
        instruction: 'DECIDE', speakInstruction: 'READ {continuation}',
        maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
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
    expect(inputs).toEqual([{ stage: 'greeting', userText: '', assistantText: '', previousTexts: [], memorySnapshot: '' }]);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 5000, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(inputs).toEqual([
      { stage: 'greeting', userText: '', assistantText: '', previousTexts: [], memorySnapshot: '' },
      { stage: 'context', userText: '我叫老王', assistantText: '王叔好', previousTexts: [], memorySnapshot: '' },
    ]);
    await vi.advanceTimersByTimeAsync(600000);
    expect(of(s.sent, 'response.start')).toHaveLength(4);
    s.session.end();
  });

  it('decides once from completed playback and ignores duplicate playback receipts', async () => {
    const inputs: unknown[] = [];
    const s = setup({
      roles: fixedRoleCatalog('P', { ...director, contextAfterMs: 3000, silenceDecision: {
        instruction: 'DECIDE', speakInstruction: 'READ {continuation}',
        maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
        policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      } }),
      textClient: { complete: async input => { inputs.push(JSON.parse(input.user)); return '{"speak":false}'; } },
    });
    await greetAndFinish(s);
    for (let i = 0; i < 10; i++) s.session.handleMicAudio(loud());
    for (let i = 0; i < 40; i++) s.session.handleMicAudio(quiet());
    await vi.advanceTimersByTimeAsync(5000);
    expect(inputs).toHaveLength(1);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(inputs).toEqual([
      { stage: 'greeting', userText: '', assistantText: '', previousTexts: [], memorySnapshot: '' },
      { stage: 'context', userText: '我叫老王', assistantText: '王叔好', previousTexts: [], memorySnapshot: '' },
    ]);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(600000);
    expect(inputs).toHaveLength(2);
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
        maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
        policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      } }),
      textClient: { complete: input => {
        const context = JSON.parse(input.user) as { stage: string };
        if (context.stage === 'greeting') return Promise.resolve('{"speak":false}');
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

  it('refuses debug text when the adapter cannot start a text turn', async () => {
    let adapter!: MockAdapter;
    const s = setup({
      adapterFactory: () => {
        adapter = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
        Object.defineProperty(adapter, 'supportsUserText', { value: false });
        return adapter;
      },
    });
    await s.session.start(s.transport);
    const send = vi.spyOn(adapter, 'sendUserText');
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    expect(send).not.toHaveBeenCalled();
    expect(of(s.sent, 'error').at(-1)).toEqual({ type: 'error', code: 'debug_text_unsupported', retryable: false });
    s.session.end();
  });

  it('rearms the silence ladder after a gateway-confirmed barge-in cancel', async () => {
    const s = setup();
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '随便聊聊' });
    await vi.advanceTimersByTimeAsync(100);
    s.mocks[0]!.emit('userSpeechStarted'); // the model hears the user first
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 }); // local VAD confirms in the window
    expect(of(s.sent, 'response.cancelled')).toEqual([{ type: 'response.cancelled', responseSeq: 2 }]);
    s.session.handleClientMessage({ type: 'vad', state: 'silent', t: 400 });
    await vi.advanceTimersByTimeAsync(2600); // the barge-miss line waits 2.5 s
    expect(of(s.sent, 'response.start').at(-1)!.responseSeq).toBeGreaterThan(2);
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
    // The summary waits for the seam: the reply to 第二句 is still due.
    expect(s.mocks[0].sessionUpdates).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.mocks[0].sessionUpdates).toEqual([]);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 300, reason: 'ended' });
    expect(s.mocks[0].sessionUpdates).toHaveLength(1);
    expect(s.mocks[0].instructions).toContain('助手：你好呀；用户：第一句；助手：我在听');
    expect(s.mocks[0].instructions).toContain('用户：第二句');
  });

  it('summarizes in the session language', async () => {
    const languages: Array<Language | undefined> = [];
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'ja'], defaultLanguage: 'zh' });
    const s = setup(
      {
        roles,
        ledger: { keepRecentTurns: 1, summarizeAfterTurns: 1, summarizeAfterTokens: 10_000 },
        summarizer: { summarize: async (_prev, _entries, language) => { languages.push(language); return 'S'; } },
      },
      { ...ownedCtx, language: 'ja' },
    );
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '第一句' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    s.session.handleClientMessage({ type: 'debug.userText', text: '第二句' });
    await vi.advanceTimersByTimeAsync(10);
    expect(languages).toEqual(['ja']);
    s.session.end();
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

  it('prefers the current language budget over the fallback budget', async () => {
    const roles = fixedRoleCatalog('P-zh', director, {
      languages: ['zh', 'en'],
      defaultLanguage: 'zh',
      personas: { zh: 'P-zh', en: 'P-en' },
    });
    const fallback = { totalChars: 2_000, snapshotMaxChars: 0, summaryMaxChars: 60 };
    const long = 'A'.repeat(400);
    const s = setup(
      { roles, budget: fallback, budgets: { zh: fallback, en: { totalChars: 300, snapshotMaxChars: 0, summaryMaxChars: 60 } } },
      { ...ownedCtx, language: 'en' },
    );
    s.session.ledger.addUser(long, Date.now());
    await greetAndFinish(s);
    const instructions = s.mocks[0]!.instructions;
    expect(instructions).toContain('P-en');
    expect(instructions).not.toContain(long);
    expect(instructions.length).toBeLessThanOrEqual(304);
    s.session.end();
  });

  it('uses the initial language budget for the history room', async () => {
    const s = setup(
      {
        roles: bilingualRoles(),
        budgets: {
          zh: { totalChars: 200, snapshotMaxChars: 0, summaryMaxChars: 60 },
          en: { totalChars: 2_000, snapshotMaxChars: 0, summaryMaxChars: 60 },
        },
        ledger: { keepRecentTurns: 4, summarizeAfterTurns: 100, summarizeAfterTokens: 10_000 },
      },
      { ...ownedCtx, language: 'en' },
    );
    await greetAndFinish(s);
    // Keep the session in en: Han text would switch to zh and lower the threshold.
    for (const text of ['A'.repeat(150), 'B'.repeat(150)]) {
      s.session.handleClientMessage({ type: 'debug.userText', text });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(s.session.ledger.needsSummary()).toBe(false);
    s.session.end();
  });

  it('ignores a smaller global history fallback when a language budget exists', () => {
    const s = setup(
      {
        roles: fixedRoleCatalog('P', director, { languages: ['zh'], defaultLanguage: 'zh' }),
        budget: { totalChars: 4_000, snapshotMaxChars: 0, summaryMaxChars: 60 },
        maxHistoryChars: 500,
      },
      ownedCtx,
    );
    expect(s.session.ledger.summarizeThreshold).toBeGreaterThan(500);
    s.session.end();
  });

  it('lowers the summary threshold when switching to a smaller language budget', () => {
    const s = setup(
      {
        roles: fixedRoleCatalog('P', director, { languages: ['zh', 'ja'], defaultLanguage: 'zh' }),
        budgets: {
          zh: { totalChars: 4_000, snapshotMaxChars: 0, summaryMaxChars: 60 },
          ja: { totalChars: 1_200, snapshotMaxChars: 0, summaryMaxChars: 60 },
        },
      },
      ownedCtx,
    );
    const before = s.session.ledger.summarizeThreshold;
    s.session.setInitialLanguage('ja');
    expect(s.session.ledger.summarizeThreshold).toBeLessThan(before);
    s.session.end();
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

  it('moves voice and instructions in one update at the next seam, once per turn', async () => {
    const s = setup({
      roles: bilingualRoles(),
      voiceFor: (language) => language === 'en' ? 'voice-en' : 'voice-zh',
    }, { ...ownedCtx });
    await greetAndFinish(s);
    const updates = s.mocks[0]!.sessionUpdates;

    s.session.setInitialLanguage('en'); // seam open: sent now
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ voice: { value: 'voice-en' } });
    expect(updates[0]!.instructions).toContain('P-en');
    expect(s.mocks[0]!.voice).toBe('voice-en');

    s.session.setInitialLanguage('zh'); // same turn: held
    expect(updates).toHaveLength(1);
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    await vi.advanceTimersByTimeAsync(1000); // reply streamed, still playing on the client
    expect(updates).toHaveLength(1);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ voice: { value: 'voice-zh' } });
    expect(updates[1]!.instructions).toContain('P-zh');
    expect(s.mocks[0]!.voice).toBe('voice-zh');
    s.session.end();
  });

  it('pushes held new-language instructions right before the next proactive request', async () => {
    const s = setup({ roles: bilingualRoles() }, { ...ownedCtx });
    await greetAndFinish(s);
    const push = vi.spyOn(s.mocks[0]!, 'updateSession');
    const creates = vi.spyOn(s.mocks[0]!, 'createResponse');
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    s.session.setInitialLanguage('en');
    s.session.handleClientMessage({ type: 'vad', state: 'silent', t: 400 });
    expect(push).not.toHaveBeenCalled(); // a silent edge is not a seam: a reply may still form
    await vi.advanceTimersByTimeAsync(8_500); // silence follow-up goes through requestResponse
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0].instructions).toContain('P-en');
    expect(creates).toHaveBeenCalled();
    expect(push.mock.invocationCallOrder[0]!).toBeLessThan(creates.mock.invocationCallOrder[0]!);
    s.session.end();
  });

  it('defers new-language instructions while the user is speaking', async () => {
    const s = setup({ roles: bilingualRoles() }, { ...ownedCtx });
    await greetAndFinish(s);
    const push = vi.spyOn(s.mocks[0]!, 'updateSession');
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    s.session.setInitialLanguage('en');
    drivePush(s.session);
    expect(push).not.toHaveBeenCalled();
    s.session.handleClientMessage({ type: 'vad', state: 'silent', t: 400 });
    expect(push).not.toHaveBeenCalled();
    drivePush(s.session);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[0].instructions).toContain('P-en');
    s.session.end();
  });

  it('does not push new-language instructions when an interruption finalizes the reply', async () => {
    const s = setup({ roles: bilingualRoles() }, { ...ownedCtx });
    await greetAndFinish(s);
    const push = vi.spyOn(s.mocks[0]!, 'updateSession');
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    await vi.advanceTimersByTimeAsync(150); // reply seq 2 is live
    s.session.setInitialLanguage('en');
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 50, reason: 'interrupted' });
    expect(push).not.toHaveBeenCalled();
    s.session.end();
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

  it('uses the current language for the generic tool-continue copy', async () => {
    // The default stays en, so the zh copy proves the user's Chinese final switched the language.
    const roles = fixedRoleCatalog('P', director, {
      languages: ['zh', 'en'],
      defaultLanguage: 'en',
      directors: { en: { ...director, toolContinueInstruction: 'Say Continue.', toolContinueText: 'Continue.' } },
    });
    const s = setup({ roles }, { roleId: 'elder-companion', styleId: 'grandchild', language: 'en' }, 'tool-continue-en');
    await greetAndFinish(s);
    const creates = vi.spyOn(s.mocks[0]!, 'createResponse');
    s.session.handleClientMessage({ type: 'debug.userText', text: '跟我挥挥手' });
    expect(s.session.currentLanguage).toBe('zh');
    await vi.advanceTimersByTimeAsync(1000);
    expect(creates).toHaveBeenCalledWith({
      cue: 'toolContinue',
      instruction: '用一句话接上刚才的动作。不要描述动作过程。',
      fallbackText: '好。',
    });
    s.session.end();
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
      { ownerId: 'owner-1', agentId: 'agent-1', sessionId: 'session-fixed', role: 'assistant', text: '你好呀', now: expect.any(Number) },
      { ownerId: 'owner-1', agentId: 'agent-1', sessionId: 'session-fixed', role: 'user', text: '我叫老王', now: expect.any(Number) },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(assistantText(s.sent, 2)).toBe('我在听');
    s.session.flush();
    expect(append.mock.calls.map((c) => c[0].text)).toEqual(['你好呀', '我叫老王']);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 400, reason: 'ended' });
    s.session.flush();
    expect(append.mock.calls.map((c) => c[0])).toEqual([
      { ownerId: 'owner-1', agentId: 'agent-1', sessionId: 'session-fixed', role: 'assistant', text: '你好呀', now: expect.any(Number) },
      { ownerId: 'owner-1', agentId: 'agent-1', sessionId: 'session-fixed', role: 'user', text: '我叫老王', now: expect.any(Number) },
      { ownerId: 'owner-1', agentId: 'agent-1', sessionId: 'session-fixed', role: 'assistant', text: '我在听', now: expect.any(Number) },
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

  it('does not mark notified when the notice transcript lacks a keyword', async () => {
    const markNotified = vi.fn();
    const writer: TranscriptWriter = { append: () => 'stored', markNotified };
    const s = setup({
      writer,
      adapterFactory: () => new MockAdapter({
        script: { ...script, memoryNotice: '好的' },
        replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1,
      }),
    }, ownedCtx, 'notice-unverified', true);
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(1000);
    const notice = of(s.sent, 'response.start').at(-1)!;
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: notice.responseSeq, playedMs: 300, reason: 'ended' });
    expect(markNotified).not.toHaveBeenCalled();
    s.session.end();
  });

  it('verifies the memory notice with the language it was requested in', async () => {
    const markNotified = vi.fn();
    const roles = fixedRoleCatalog('P', director, {
      languages: ['zh', 'ja'],
      defaultLanguage: 'zh',
      directors: { ja: { ...director, memoryNoticeText: 'これからは覚えておきますね。' } },
    });
    const s = setup({
      roles,
      writer: { append: () => 'stored', markNotified },
      noticeKeywordsByLanguage: { zh: ['记着'], ja: ['覚えて'] },
      adapterFactory: () => new MockAdapter({
        script: { ...script, memoryNotice: 'これからは覚えておきますね。' },
        replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1,
      }),
    }, { ...ownedCtx, language: 'ja' }, 'notice-ja', true);
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(1000);
    const notice = of(s.sent, 'response.start').at(-1)!;
    expect(assistantText(s.sent, notice.responseSeq)).toContain('覚えて');
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: notice.responseSeq, playedMs: 300, reason: 'ended' });
    expect(markNotified).toHaveBeenCalledTimes(1);
    s.session.end();
  });

  it('verifies an en memory notice keyword regardless of case', async () => {
    const markNotified = vi.fn();
    const noticeText = 'Remember, I will keep this for next time.';
    const roles = fixedRoleCatalog('P', director, {
      languages: ['zh', 'en'],
      defaultLanguage: 'zh',
      directors: { en: { ...director, memoryNoticeText: noticeText } },
    });
    const s = setup({
      roles,
      writer: { append: () => 'stored', markNotified },
      noticeKeywordsByLanguage: { en: i18n.memory.en.noticeKeywords },
      adapterFactory: () => new MockAdapter({
        script: { ...script, memoryNotice: noticeText },
        replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1,
      }),
    }, { ...ownedCtx, language: 'en' }, 'notice-en', true);
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(1000);
    const notice = of(s.sent, 'response.start').at(-1)!;
    expect(assistantText(s.sent, notice.responseSeq)).toContain('Remember');
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: notice.responseSeq, playedMs: 300, reason: 'ended' });
    expect(markNotified).toHaveBeenCalledTimes(1);
    s.session.end();
  });

  it('keeps the request language for notice verification after a language switch', async () => {
    const markNotified = vi.fn();
    const roles = fixedRoleCatalog('P', director, {
      languages: ['zh', 'en'],
      defaultLanguage: 'zh',
      directors: { en: { ...director, memoryNoticeText: 'Okay, done.' } },
    });
    const s = setup({
      roles,
      writer: { append: () => 'stored', markNotified },
      noticeKeywordsByLanguage: { zh: ['记着'], en: ['remember'] },
    }, ownedCtx, 'notice-switch', true);
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(1000);
    const notice = of(s.sent, 'response.start').at(-1)!;
    s.session.setInitialLanguage('en');
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: notice.responseSeq, playedMs: 300, reason: 'ended' });
    expect(markNotified).toHaveBeenCalledTimes(1);
    s.session.end();
  });

  it('rejects a notice missing its language keyword and retries it', async () => {
    const markNotified = vi.fn();
    const cues: Array<string | undefined> = [];
    const roles = fixedRoleCatalog('P', director, {
      languages: ['zh', 'en'],
      defaultLanguage: 'zh',
      // Chinese copy, but the request is in English and the en keyword is absent.
      directors: { en: { ...director, memoryNoticeText: '好，我会记着。' } },
    });
    const s = setup({
      roles,
      writer: { append: () => 'stored', markNotified },
      noticeKeywordsByLanguage: { en: ['remember'] },
      adapterFactory: () => {
        const m = new MockAdapter({
          script: { ...script, memoryNotice: '好，我会记着。' },
          replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1,
        });
        const create = m.createResponse.bind(m);
        m.createResponse = (request) => { cues.push(request?.cue); return create(request); };
        return m;
      },
    }, { ...ownedCtx, language: 'en' }, 'notice-en-mismatch', true);
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(1000);
    const notice = of(s.sent, 'response.start').at(-1)!;
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: notice.responseSeq, playedMs: 300, reason: 'ended' });
    expect(markNotified).not.toHaveBeenCalled();
    expect(cues.filter((cue) => cue === 'memoryNotice').length).toBeGreaterThanOrEqual(2);
    s.session.end();
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

  it('survives transcript store failures', async () => {
    const writer: TranscriptWriter = {
      append: () => { throw new Error('db down'); },
      markNotified: () => { throw new Error('db down'); },
    };
    const s = setup({ writer }, ownedCtx, 'write-fail', true);
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(200);
    const notice = of(s.sent, 'response.start').at(-1)!;
    expect(() => s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: notice.responseSeq, playedMs: 300, reason: 'ended' })).not.toThrow();
    expect(() => s.session.handleClientMessage({ type: 'debug.userText', text: '你好' })).not.toThrow();
    expect(() => s.session.flush()).not.toThrow();
    s.session.end();
  });

  it('enqueues extraction every configured number of user turns when a worker is injected', () => {
    const reasons: string[] = [];
    const s = setup({
      worker: { enqueue: async (_ownerId, _agentId, reason) => { reasons.push(reason); } },
      extractEveryUserTurns: 2,
    }, ownedCtx, 'extract-turns');
    s.session.handleClientMessage({ type: 'debug.userText', text: '第一句' });
    expect(reasons).toEqual([]);
    s.session.handleClientMessage({ type: 'debug.userText', text: '第二句' });
    expect(reasons).toEqual(['turns']);
    s.session.handleClientMessage({ type: 'debug.userText', text: '第三句' });
    expect(reasons).toEqual(['turns']);
  });

  it('passes the current language to extraction after a switch', () => {
    const seen: Array<{ reason: string; language?: Language }> = [];
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'en'], defaultLanguage: 'zh' });
    const s = setup({
      roles,
      worker: { enqueue: async (_ownerId, _agentId, reason, language) => { seen.push({ reason, language }); } },
      extractEveryUserTurns: 1,
    }, ownedCtx, 'extract-language');
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    expect(seen).toEqual([{ reason: 'turns', language: 'zh' }]);

    s.session.handleClientMessage({ type: 'debug.userText', text: 'I like tea' });

    expect(s.session.currentLanguage).toBe('en');
    expect(s.session.context.language).toBe('en');
    expect(seen).toEqual([
      { reason: 'turns', language: 'zh' },
      { reason: 'turns', language: 'en' },
    ]);
  });

  it('builds the current language tool specs after a switch', async () => {
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'ja'], defaultLanguage: 'zh' });
    const s = setup({ roles }, ownedCtx, 'tools-language');
    await s.session.start(s.transport);
    s.session.setInitialLanguage('ja');
    const config = (s.session as unknown as { sessionConfig(): SessionConfig }).sessionConfig();
    expect(config.tools.find((tool) => tool.name === 'recall_memory')?.description)
      .toBe(i18n.memory.ja.recall.toolDescription);
    s.session.end();
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

  it('rebuilds slim on the interval once the seam is open, with presence and no reconnect error', async () => {
    const s = setup({ slim: slimOn });
    await greetAndFinish(s);
    expect(s.mocks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(900); // t=1900: the 1500 ms interval fired with nothing playing
    expect(s.mocks).toHaveLength(2);
    expect(of(s.sent, 'presence')).toEqual([
      { type: 'presence', phase: 'refreshing' },
      { type: 'presence', phase: 'ready' },
    ]);
    expect(of(s.sent, 'error')).toEqual([]);
    expect(s.mocks[1]!.instructions).toContain('你好呀');
    s.session.end();
  });

  it('defers the slim rebuild while the user is speaking and rebuilds on the silent edge', async () => {
    const s = setup({ slim: slimOn });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    await vi.advanceTimersByTimeAsync(700); // t=1700: the interval fired with the seam closed
    expect(s.mocks).toHaveLength(1);
    s.session.handleClientMessage({ type: 'vad', state: 'silent', t: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.mocks).toHaveLength(2);
    expect(of(s.sent, 'presence')).toEqual([
      { type: 'presence', phase: 'refreshing' },
      { type: 'presence', phase: 'ready' },
    ]);
    s.session.end();
  });

  it('forces the slim rebuild at the deferral deadline even while the seam stays closed', async () => {
    const s = setup({ slim: { ...slimOn, maxDeferMs: 1_000 } });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    await vi.advanceTimersByTimeAsync(1_400); // t=2400: deferred at 1500, deadline is 2500
    expect(s.mocks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200); // past the deadline, still speaking
    expect(s.mocks).toHaveLength(2);
    expect(of(s.sent, 'presence')).toContainEqual({ type: 'presence', phase: 'refreshing' });
    expect(of(s.sent, 'error')).toEqual([]);
    s.session.end();
  });

  it('keeps the slim rebuild off the clock when slim is disabled', async () => {
    const s = setup({ slim: { ...slimOn, enabled: false } });
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.mocks).toHaveLength(1);
    expect(of(s.sent, 'presence')).toEqual([]);
    s.session.end();
  });

  it('keeps the turn-based slim thinking state but no bridge when slim is disabled', async () => {
    const s = setup({ rebuildAfterTurns: 1, slim: { ...slimOn, enabled: false } });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.mocks).toHaveLength(2);
    expect(of(s.sent, 'error')).toEqual([]);
    expect(of(s.sent, 'presence')).toEqual([
      { type: 'presence', phase: 'refreshing' },
      { type: 'presence', phase: 'ready' },
    ]);
    s.session.end();
  });

  it('speaks the configured bridge line only when the slim reconnect is slow', async () => {
    let created = 0;
    const s = setup({
      slim: slimOn,
      adapterFactory: () => {
        const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
        created++;
        if (created === 2) {
          const connect = m.connect.bind(m);
          vi.spyOn(m, 'connect').mockImplementation(async (c) => {
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
            return connect(c);
          });
        }
        return m;
      },
    });
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(600); // the delayed reconnect lands past bridgeAfterMs
    await vi.advanceTimersByTimeAsync(1500);
    expect(assistantText(s.sent, 2)).toBe(slimOn.bridge.zh);
    expect(of(s.sent, 'presence')).toEqual([{ type: 'presence', phase: 'refreshing' }]);
    expect(of(s.sent, 'error')).toEqual([]);
    s.session.end();
  });

  it('speaks the bridge line in the session language', async () => {
    let created = 0;
    const roles = fixedRoleCatalog('P', director, { languages: ['zh', 'ja'], defaultLanguage: 'zh' });
    const s = setup(
      {
        roles,
        slim: slimOn,
        adapterFactory: () => {
          const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
          created++;
          if (created === 2) {
            const connect = m.connect.bind(m);
            vi.spyOn(m, 'connect').mockImplementation(async (c) => {
              await new Promise<void>((resolve) => setTimeout(resolve, 500));
              return connect(c);
            });
          }
          return m;
        },
      },
      { ...ownedCtx, language: 'ja' },
    );
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(600); // the delayed reconnect lands past bridgeAfterMs
    await vi.advanceTimersByTimeAsync(2500); // the longer ja line needs more mock streaming time
    expect(assistantText(s.sent, 2)).toBe(slimOn.bridge.ja);
    s.session.end();
  });

  it('skips the bridge line when the slim reconnect is fast', async () => {
    const s = setup({ slim: slimOn });
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(900); // interval fires at t=1500, the reconnect is immediate
    expect(s.session.lastResponseSeq).toBe(1); // no bridge response was created
    expect(of(s.sent, 'presence')).toEqual([
      { type: 'presence', phase: 'refreshing' },
      { type: 'presence', phase: 'ready' },
    ]);
    s.session.end();
  });

  it('still announces a dropped connection while slim is enabled', async () => {
    const s = setup({ slim: slimOn });
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    s.mocks[0]!.simulateDrop();
    await vi.advanceTimersByTimeAsync(10);
    expect(of(s.sent, 'error')).toContainEqual({ type: 'error', code: 'model_reconnecting', retryable: true });
    expect(of(s.sent, 'presence')).toEqual([]);
    s.session.end();
  });

  it('keeps the slim rebuild out while a reply is in flight', async () => {
    const s = setup({ slim: slimOn });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    await vi.advanceTimersByTimeAsync(900); // t=1900: the interval fires with a live response
    expect(s.mocks).toHaveLength(1);
    expect(of(s.sent, 'presence')).toEqual([]);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.mocks).toHaveLength(2);
    expect(of(s.sent, 'presence')).toContainEqual({ type: 'presence', phase: 'refreshing' });
    s.session.end();
  });

  it('keeps the slim rebuild out while a response is still generating but playback already ended', async () => {
    const long = '这是一段更长的回复，用来让响应在区间到期时仍然在生成过程中。';
    let created = 0;
    const s = setup({
      slim: slimOn,
      adapterFactory: () => {
        created++;
        return new MockAdapter({
          script: { ...script, fallbackReply: long },
          replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1,
        });
      },
    });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '你好' });
    await vi.advanceTimersByTimeAsync(100); // seq 2 started; its generation is still in flight
    // Playback ended early: interrupt.active clears, responseLive stays true until responseDone.
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 100, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(500); // t=1600: the interval fired while responseLive is still true
    expect(created).toBe(1);
    expect(of(s.sent, 'presence')).toEqual([]);
    s.session.end();
  });

  it('releases the thinking pose when the slim rebuild cannot connect', async () => {
    let created = 0;
    const s = setup({
      slim: slimOn,
      adapterFactory: () => {
        const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
        created++;
        if (created === 2) {
          vi.spyOn(m, 'connect').mockRejectedValue(new Error('fixture_connect_failed'));
        }
        return m;
      },
    });
    await greetAndFinish(s);
    await vi.advanceTimersByTimeAsync(900); // the interval fires and the replacement adapter rejects
    expect(of(s.sent, 'presence')).toEqual([
      { type: 'presence', phase: 'refreshing' },
      { type: 'presence', phase: 'ready' },
    ]);
    expect(of(s.sent, 'error')).toEqual([]);
    expect(assistantText(s.sent, 2)).toBe('');
    s.session.end();
  });

  it('logs the slim rebuild without any line or conversation text', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const s = setup({ slim: slimOn });
      await greetAndFinish(s);
      await vi.advanceTimersByTimeAsync(900); // the interval fires and the reconnect is immediate
      s.session.end();
    } finally {
      spy.mockRestore();
    }
    const rebuilds = chunks
      .filter((line) => line.includes('"event":"model_rebuild"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rebuilds).toHaveLength(1);
    expect(Object.keys(rebuilds[0]!).sort()).toEqual(['bridge', 'elapsedMs', 'event', 'reason', 't']);
    expect(chunks.join('')).not.toContain(slimOn.bridge.zh);
  });
});

describe('Session affect tracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const affectConfig = loadAffectConfig(fileURLToPath(new URL('../config/affect.json', import.meta.url)));
  const sadCard = '{"emotion":"sad","intensity":2,"trend":"flat","need":"vent","strategy":"comfort","mismatch":false,"crisis":false}';
  const recordingClient = () => {
    const inputs: Array<{ system: string; user: string }> = [];
    const client: TextModelClient = {
      complete: async (input) => {
        inputs.push({ system: input.system, user: input.user });
        return sadCard;
      },
    };
    return { inputs, client };
  };

  it('analyzes non-light finals with the affect prompt and skips light ones', async () => {
    const { inputs, client } = recordingClient();
    const s = setup({ textClient: client, affect: affectConfig });
    s.mocks[0]!.emit('userTranscript', '嗯', true);
    s.mocks[0]!.emit('userTranscript', '今天腰有点疼，心里也闷', true);
    await vi.advanceTimersByTimeAsync(10);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.system).toBe('FIXTURE AFFECT');
    expect(JSON.parse(inputs[0]!.user)).toEqual({
      language: 'zh',
      current: '今天腰有点疼，心里也闷',
      history: [{ role: 'user', text: '嗯' }],
    });
    s.session.end();
  });

  it('keeps the analyzer off without the affect config or when it is disabled', async () => {
    const { inputs, client } = recordingClient();
    for (const overrides of [{ textClient: client }, { textClient: client, affect: { ...affectConfig, enabled: false } }]) {
      const s = setup(overrides);
      s.mocks[0]!.emit('userTranscript', '今天腰有点疼', true);
      await vi.advanceTimersByTimeAsync(10);
      s.session.end();
    }
    expect(inputs).toHaveLength(0);
  });

  it('does not analyze finals dropped during a memory-tool turn', async () => {
    const { inputs, client } = recordingClient();
    const s = setup({ textClient: client, affect: affectConfig });
    // Narrow cast: the forget/decline wait state without driving a whole tool turn.
    (s.session as unknown as { dropUserFinals: boolean }).dropUserFinals = true;
    s.mocks[0]!.emit('userTranscript', '今天腰有点疼', true);
    await vi.advanceTimersByTimeAsync(10);
    expect(inputs).toHaveLength(0);
    s.session.end();
  });

  it('logs a content-free affect summary once at session end', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const { client } = recordingClient();
    const s = setup({ textClient: client, affect: affectConfig });
    s.mocks[0]!.emit('userTranscript', '今天腰有点疼，心里也闷', true);
    await vi.advanceTimersByTimeAsync(10);
    s.session.end();
    s.session.end();
    const summaries = writes
      .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
      .filter((event): event is Record<string, unknown> => event?.event === 'affect_summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      calls: 1, failures: 0, crisis: 0, exhaustedArmed: 0, exhaustedRevoked: 0,
      emotionNeutral: 0, emotionHappy: 0, emotionSad: 1, emotionLove: 0,
    });
    expect(writes.join('')).not.toContain('腰');
  });

  it('resets the tracker when a forget rebuild starts', async () => {
    const { client } = recordingClient();
    const s = setup({ textClient: client, affect: affectConfig });
    s.mocks[0]!.emit('userTranscript', '今天腰有点疼，心里也闷', true);
    await vi.advanceTimersByTimeAsync(10);
    const view = s.session as unknown as { affect: { card: unknown }; rebuild(reason: string, keepToolTurn?: boolean): Promise<void> };
    expect(view.affect.card).not.toBeNull();
    void view.rebuild('forget', true);
    expect(view.affect.card).toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    s.session.end();
  });
});

const affectFixture = loadAffectConfig(`${fileURLToPath(new URL('..', import.meta.url))}config/affect.json`);
const affectCardJson = (over: Record<string, unknown> = {}) => JSON.stringify({
  emotion: 'sad', intensity: 3, trend: 'worse', need: 'vent', strategy: 'comfort', mismatch: false, crisis: false, ...over,
});
const sessionInternals = (session: Session) => session as unknown as { gate: PushGate; instructions(): string };

describe('Session affect render', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders an accepted card after the persona, moves the avatar, and asks for one push per change', async () => {
    let reply = affectCardJson();
    const s = setup({ i18n, emotion: i18n.emotion, affect: affectFixture, textClient: { complete: async () => reply } });
    await greetAndFinish(s);
    const request = vi.spyOn(sessionInternals(s.session).gate, 'request');
    const pushes = () => request.mock.calls.filter(([update]) => update.instructions === true).length;
    const lines = i18n.affect.zh.lines;

    s.session.handleClientMessage({ type: 'debug.userText', text: '今天下午去了一趟菜场' });
    await vi.advanceTimersByTimeAsync(10);
    const text = sessionInternals(s.session).instructions();
    expect(text.startsWith(`P\n\n${PROMPT_LABELS.zh.affectHeader}\n\n${lines.mood.low}`)).toBe(true);
    expect(text).toContain(lines.need.vent);
    expect(text).toContain(lines.tail);
    expect(pushes()).toBe(1);
    expect(of(s.sent, 'avatar.emotion').at(-1)?.emotion).toBe('sad');

    // Same card again: the render is unchanged, so no new push.
    s.session.handleClientMessage({ type: 'debug.userText', text: '买了点青菜和豆腐回来' });
    await vi.advanceTimersByTimeAsync(10);
    expect(pushes()).toBe(1);

    // A different card changes the render and asks again.
    reply = affectCardJson({ emotion: 'happy', intensity: 1, trend: 'better', need: 'share_joy', strategy: 'affirm' });
    s.session.handleClientMessage({ type: 'debug.userText', text: '孙子说周末带我去公园' });
    await vi.advanceTimersByTimeAsync(10);
    expect(pushes()).toBe(2);
    expect(sessionInternals(s.session).instructions()).toContain(lines.mood.happy);
    s.session.end();
  });

  it('puts the crisis line first, keeps the avatar neutral and logs affect_crisis once without content', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const s = setup({ i18n, emotion: i18n.emotion, affect: affectFixture, textClient: { complete: async () => affectCardJson({ crisis: true }) } });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '最近总觉得撑不下去' });
    await vi.advanceTimersByTimeAsync(10);
    s.session.handleClientMessage({ type: 'debug.userText', text: '我一个人在家' });
    await vi.advanceTimersByTimeAsync(10);
    const lines = i18n.affect.zh.lines;
    expect(sessionInternals(s.session).instructions()
      .startsWith(`P\n\n${PROMPT_LABELS.zh.affectHeader}\n\n${lines.crisis}\n${lines.mood.low}`)).toBe(true);
    expect(of(s.sent, 'avatar.emotion').at(-1)?.emotion).toBe('neutral');
    const logged = write.mock.calls.map((c) => String(c[0])).join('');
    expect(logged.match(/"event":"affect_crisis"/g)).toHaveLength(1);
    expect(logged).not.toContain('撑不下去');
    write.mockRestore();
    s.session.end();
  });

  it('renders the affect section in the session language', async () => {
    const s = setup(
      {
        i18n,
        affect: affectFixture,
        roles: fixedRoleCatalog('P', director, { languages: ['zh', 'en'], defaultLanguage: 'zh' }),
        textClient: { complete: async () => affectCardJson() },
      },
      { roleId: 'elder-companion', styleId: 'grandchild', language: 'en' },
    );
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: 'I went to the market this afternoon.' });
    await vi.advanceTimersByTimeAsync(10);
    const text = sessionInternals(s.session).instructions();
    expect(text).toContain(`${PROMPT_LABELS.en.affectHeader}\n\n${i18n.affect.en.lines.mood.low}`);
    expect(text).not.toContain(PROMPT_LABELS.zh.affectHeader);
    s.session.end();
  });

  it('drops the session copy of the card when a forget rebuild starts', async () => {
    const s = setup({ i18n, emotion: i18n.emotion, affect: affectFixture, textClient: { complete: async () => affectCardJson() } });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '今天下午去了一趟菜场' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).toContain(PROMPT_LABELS.zh.affectHeader);
    const view = s.session as unknown as { rebuild(reason: string, keepToolTurn?: boolean): Promise<void> };
    void view.rebuild('forget', true);
    // Synchronous part of rebuild: the card is gone before the reconnect builds its instructions.
    expect(sessionInternals(s.session).instructions()).not.toContain(PROMPT_LABELS.zh.affectHeader);
    await vi.advanceTimersByTimeAsync(10);
    s.session.end();
  });

  it('keeps instructions unchanged when no analyzer runs', async () => {
    const s = setup({ i18n, affect: affectFixture });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '今天下午去了一趟菜场' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).not.toContain(PROMPT_LABELS.zh.affectHeader);
    s.session.end();
  });

  it('reserves the affect room when it sets the summarize threshold', () => {
    const budget = { totalChars: 3000, snapshotMaxChars: 100, summaryMaxChars: 200 };
    const plain = setup({ budget });
    const reserved = setup({ budget: { ...budget, affectMaxChars: 150 } });
    expect(plain.session.ledger.summarizeThreshold - reserved.session.ledger.summarizeThreshold)
      .toBe(150 + PROMPT_LABELS.zh.affectHeader.length + 4);
    plain.session.end();
    reserved.session.end();
  });
});

describe('Session planner extras and topic exhaustion', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const plannerDirector: DirectorConfig = {
    ...director,
    contextAfterMs: 3000,
    silenceDecision: {
      instruction: 'DECIDE', speakInstruction: 'READ {continuation}',
      maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
      policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
    },
  };
  /** 14:00 in Asia/Shanghai on 2026-10-23. */
  const FIXED_NOW = Date.UTC(2026, 9, 23, 6, 0);

  it('sends the latest card, the open loop and local time words to the planner', async () => {
    const plannerInputs: unknown[] = [];
    const s = setup({
      roles: fixedRoleCatalog('P', plannerDirector),
      i18n,
      affect: affectFixture,
      now: () => FIXED_NOW,
      textClient: { complete: async (input) => {
        if (input.system === 'DECIDE') {
          plannerInputs.push(JSON.parse(input.user));
          return '{"speak":false}';
        }
        return affectCardJson({ emotion: 'happy', intensity: 1, trend: 'flat', need: 'chat', strategy: 'ask', openLoop: '明天要去医院复查' });
      } },
    });
    const time = timeContext(FIXED_NOW, affectFixture.timeZone, affectFixture.solarTermWindowDays, i18n.affect.zh);
    await greetAndFinish(s);
    expect(plannerInputs).toEqual([{ stage: 'greeting', userText: '', assistantText: '', previousTexts: [], memorySnapshot: '', ...time }]);
    s.session.handleClientMessage({ type: 'debug.userText', text: '明天要去医院复查' });
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(plannerInputs[1]).toEqual({
      stage: 'context',
      userText: '明天要去医院复查',
      assistantText: '我在听',
      previousTexts: [],
      memorySnapshot: '',
      ...time,
      affect: { emotion: 'happy', intensity: 1, trend: 'flat', need: 'chat', low: false, crisis: false },
      openLoop: '明天要去医院复查',
    });
    s.session.end();
  });

  it('arms the topic-exhaustion hint after one short answer and drops it on real content, asking for a push each time', async () => {
    const s = setup({
      i18n,
      affect: affectFixture,
      textClient: { complete: async () => affectCardJson({ emotion: 'neutral', intensity: 1, trend: 'flat', need: 'chat', strategy: 'ask' }) },
    });
    await greetAndFinish(s);
    const request = vi.spyOn(sessionInternals(s.session).gate, 'request');
    const pushes = () => request.mock.calls.filter(([update]) => update.instructions === true).length;
    const hint = i18n.affect.zh.lines.exhaustedHint;

    s.session.handleClientMessage({ type: 'debug.userText', text: '还行' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).toContain(hint);
    const armed = pushes();
    expect(armed).toBeGreaterThanOrEqual(1);

    s.session.handleClientMessage({ type: 'debug.userText', text: '我下午去公园看人下棋了' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).not.toContain(hint);
    expect(pushes()).toBeGreaterThan(armed);
    s.session.end();
  });

  it('drops the hint once the second short answer has used it', async () => {
    const s = setup({
      i18n,
      affect: affectFixture,
      textClient: { complete: async () => affectCardJson({ emotion: 'neutral', intensity: 1, trend: 'flat', need: 'chat', strategy: 'ask' }) },
    });
    await greetAndFinish(s);
    const hint = i18n.affect.zh.lines.exhaustedHint;
    s.session.handleClientMessage({ type: 'debug.userText', text: '还行' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).toContain(hint);
    s.session.handleClientMessage({ type: 'debug.userText', text: '嗯嗯' });
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionInternals(s.session).instructions()).not.toContain(hint);
    s.session.end();
  });

  it('forgets the open loop and the card on a forget rebuild, so the planner no longer sees them', async () => {
    const s = setup({
      roles: fixedRoleCatalog('P', plannerDirector),
      i18n,
      affect: affectFixture,
      now: () => FIXED_NOW,
      textClient: { complete: async (input) => (input.system === 'DECIDE'
        ? '{"speak":false}'
        : affectCardJson({ emotion: 'sad', intensity: 2, trend: 'flat', need: 'vent', strategy: 'comfort', openLoop: '明天要去医院复查' })) },
    });
    await greetAndFinish(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '明天要去医院复查' });
    await vi.advanceTimersByTimeAsync(10);
    const view = s.session as unknown as {
      planExtras(): Pick<SilenceContext, 'affect' | 'openLoop'>;
      rebuild(reason: string, keepToolTurn?: boolean): Promise<void>;
    };
    expect(view.planExtras().openLoop).toBe('明天要去医院复查');
    void view.rebuild('forget', true);
    expect(view.planExtras().openLoop).toBeUndefined();
    expect(view.planExtras().affect).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    s.session.end();
  });
});
