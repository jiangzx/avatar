import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Language, ServerMessage } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig } from '../src/adapters/types.ts';
import { loadI18n } from '../src/i18n/load.ts';
import type { SilenceRules } from '../src/i18n/types.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';
import type { MemoryStore } from '../src/memory/store.ts';
import { fixedRoleCatalog, type RoleCatalog } from '../src/roles/catalog.ts';
import { PROMPT_LABELS } from '../src/roles/labels.ts';
import type { SilenceDecisionConfig } from '../src/roles/types.ts';
import { ActionRouter } from '../src/session/actions.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig, SilenceContext } from '../src/session/director.ts';
import { ConversationLedger, MockSummarizer } from '../src/session/ledger.ts';
import { Session, type SessionDeps, type TranscriptWriter, type Transport } from '../src/session/session.ts';
import { createSilencePlanner } from '../src/session/silence.ts';
import { createToolRegistry, type ToolContext } from '../src/session/tools/registry.ts';

const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));

const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting',
  followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle',
  resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: 'ok',
  memoryNoticeInstruction: 'M', memoryNoticeText: 'notice',
};

const silenceDecision: SilenceDecisionConfig = {
  instruction: 'Return the silence decision as JSON.',
  speakInstruction: 'SAY {continuation}',
  maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
  policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
};

/** Records what a real adapter would receive; the test drives the model events itself. */
class FakeAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  readonly verbatimFallback = false;
  readonly supportsUserText = true;
  readonly configs: SessionConfig[] = [];
  readonly pushes: string[] = [];
  readonly requests: ProactiveRequest[] = [];
  private counter = 0;
  private activeId: string | null = null;

  async connect(config: SessionConfig): Promise<void> {
    this.configs.push(config);
  }

  sendAudio(_pcm: Int16Array): void {}

  sendUserText(_text: string): void {}

  updateInstructions(text: string): void {
    this.pushes.push(text);
  }

  createResponse(request?: ProactiveRequest): void {
    if (request) this.requests.push(request);
    this.beginResponse();
  }

  cancelResponse(): void {}

  sendToolResult(_callId: string, _result: unknown): void {}

  injectContextNote(_text: string): void {}

  close(): void {}

  /** Test driver: a model response starts without a proactive request (a user turn). */
  beginResponse(): string {
    const id = `resp-${++this.counter}`;
    this.activeId = id;
    this.emit('responseStarted', id);
    return id;
  }

  /** Test driver: stream the reply text of the response in flight. */
  speak(text: string): string {
    if (!this.activeId) throw new Error('no_active_response');
    this.emit('textDelta', this.activeId, text);
    return this.activeId;
  }

  /** Test driver: the model finished generating; playback still has to end on the client. */
  done(): void {
    if (!this.activeId) throw new Error('no_active_response');
    const id = this.activeId;
    this.activeId = null;
    this.emit('responseDone', id);
  }
}

function memoryStoreStub(input: { addressing?: string[] } = {}): MemoryStore {
  return {
    listFacts: () => (input.addressing ?? []).map((text) => ({ category: 'addressing', text })),
    listProactiveFacts: () => [],
    recentUserMessages: () => [],
  } as unknown as MemoryStore;
}

/** Only what recall_memory reads; rows are synthetic statements. */
function toolStore(rows: readonly { text: string }[]): MemoryStore {
  return { searchMessages: () => [...rows], recentUserMessages: () => [] } as unknown as MemoryStore;
}

const ownedCtx: SessionContext = { ownerId: 'owner-1', agentId: 'agent-1', roleId: 'elder-companion', styleId: 'grandchild' };
const ctxFor = (language: Language): SessionContext => ({ ...ownedCtx, language });

const trilingualPersonas = { zh: 'P-zh', ja: 'P-ja', en: 'P-en' } as const;

function makeSession(
  adapter: FakeAdapter,
  roles: RoleCatalog,
  ctx: SessionContext,
  overrides: Partial<SessionDeps> = {},
  noticePending = false,
) {
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (message) => sent.push(message), sendAudio: () => {} };
  const session = new Session({
    adapterFactory: () => adapter,
    summarizer: new MockSummarizer(),
    roles,
    i18n,
    languageRules: i18n.language,
    ...overrides,
  }, ctx, 'multilingual', noticePending);
  return { session, sent, transport };
}

/** Start in en, finish the greeting, and switch to ja with one explicit whole-utterance request. */
async function startEnAndSwitchToJa() {
  const adapter = new FakeAdapter();
  const roles = fixedRoleCatalog('P-zh', director, {
    languages: ['zh', 'ja', 'en'],
    defaultLanguage: 'en',
    personas: trilingualPersonas,
  });
  const { session, sent, transport } = makeSession(adapter, roles, ctxFor('en'));
  await session.start(transport);
  adapter.done();
  session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
  adapter.emit('userTranscript', '日本語でお願いします', true);
  return { adapter, session, sent, transport };
}

describe('multilingual session', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts in en with the en persona, labels, and tool descriptions', async () => {
    const adapter = new FakeAdapter();
    const roles = fixedRoleCatalog('P-zh', director, {
      languages: ['zh', 'ja', 'en'],
      defaultLanguage: 'en',
      personas: trilingualPersonas,
    });
    const { session, transport } = makeSession(adapter, roles, ctxFor('en'));
    // Seeded history proves connect() uses the en labels, not only the en headers.
    session.ledger.addUser('Hello', 1);
    session.ledger.addAssistant('Hi there', 2);

    await session.start(transport);

    const config = adapter.configs[0]!;
    expect(session.currentLanguage).toBe('en');
    expect(config.instructions).toContain('P-en');
    expect(config.instructions).toContain(`${PROMPT_LABELS.en.user}${PROMPT_LABELS.en.separator}Hello`);
    expect(config.instructions).toContain(`${PROMPT_LABELS.en.assistant}${PROMPT_LABELS.en.separator}Hi there`);
    expect(config.tools.find((tool) => tool.name === 'recall_memory')?.description).toBe(i18n.memory.en.recall.toolDescription);
    expect(config.tools.find((tool) => tool.name === 'perform_action')?.description).toBe(i18n.memory.en.performAction.toolDescription);
    expect(config.tools.find((tool) => tool.name === 'forget_memory')?.description).toBe(i18n.memory.en.recall.forgetToolDescription);
    expect(config.tools.find((tool) => tool.name === 'set_memory_consent')?.description).toBe(i18n.memory.en.recall.consentToolDescription);
    session.end();
  });

  it('switches to ja, holds the push while generating, then pushes ja instructions when playback ends', async () => {
    const { adapter, session } = await startEnAndSwitchToJa();
    expect(session.currentLanguage).toBe('ja');

    adapter.beginResponse();
    expect(adapter.pushes).toHaveLength(0);
    adapter.speak('かしこまりました。');
    adapter.done();
    expect(adapter.pushes).toHaveLength(0);

    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    expect(adapter.pushes).toHaveLength(1);
    expect(adapter.pushes[0]).toContain('P-ja');
    expect(adapter.pushes[0]).toContain(`${PROMPT_LABELS.ja.user}${PROMPT_LABELS.ja.separator}`);

    // The pending flag is consumed by that one push; the next proactive request does not repeat it.
    await vi.advanceTimersByTimeAsync(8_100);
    expect(adapter.pushes).toHaveLength(1);
    expect(adapter.requests.at(-1)?.cue).toBe('followup');
    session.end();
  });

  it('reads a zh-stored addressing line in ja and zh safe greetings', async () => {
    const jaDirector: DirectorConfig = {
      ...director,
      greetingNameTexts: ['{name}、またお会いしましたね。'],
      silenceDecision,
    };
    const jaRoles = fixedRoleCatalog('P-zh', director, {
      languages: ['zh', 'ja', 'en'],
      defaultLanguage: 'ja',
      personas: trilingualPersonas,
      directors: { ja: jaDirector },
    });
    const jaAdapter = new FakeAdapter();
    const ja = makeSession(jaAdapter, jaRoles, ctxFor('ja'), {
      store: memoryStoreStub({ addressing: ['称呼：王叔'] }),
      budget: { totalChars: 8_000, snapshotMaxChars: 600, summaryMaxChars: 800 },
      textClient: { complete: async () => '{"speak":false}' },
    });
    expect(ja.session.context.greetingMemorySnapshot).toBe('呼び方：王叔');
    await ja.session.start(ja.transport);
    expect(jaAdapter.requests[0]).toEqual({
      cue: 'greeting',
      instruction: '王叔、またお会いしましたね。',
      fallbackText: '王叔、またお会いしましたね。',
    });
    ja.session.end();

    const zhDirector: DirectorConfig = {
      ...director,
      greetingNameTexts: ['{name}，又见面了。'],
      silenceDecision,
    };
    const zhRoles = fixedRoleCatalog('P-zh', director, {
      languages: ['zh', 'ja', 'en'],
      defaultLanguage: 'zh',
      personas: trilingualPersonas,
      directors: { zh: zhDirector, ja: jaDirector },
    });
    const zhAdapter = new FakeAdapter();
    const zh = makeSession(zhAdapter, zhRoles, ctxFor('zh'), {
      store: memoryStoreStub({ addressing: ['称呼：王叔'] }),
      budget: { totalChars: 8_000, snapshotMaxChars: 600, summaryMaxChars: 800 },
      textClient: { complete: async () => '{"speak":false}' },
    });
    expect(zh.session.context.greetingMemorySnapshot).toBe('称呼：王叔');
    await zh.session.start(zh.transport);
    expect(zhAdapter.requests[0]).toEqual({
      cue: 'greeting',
      instruction: '王叔，又见面了。',
      fallbackText: '王叔，又见面了。',
    });
    zh.session.end();
  });

  it('verifies a ja memory notice with the ja keywords it was requested in', async () => {
    const jaNotice = 'これからは覚えておきますね。';
    const roles = fixedRoleCatalog('P-zh', director, {
      languages: ['zh', 'ja', 'en'],
      defaultLanguage: 'ja',
      personas: trilingualPersonas,
      directors: { ja: { ...director, memoryNoticeText: jaNotice } },
    });
    const keywords = {
      zh: i18n.memory.zh.noticeKeywords,
      ja: i18n.memory.ja.noticeKeywords,
      en: i18n.memory.en.noticeKeywords,
    };

    const markNotified = vi.fn();
    const adapter = new FakeAdapter();
    const writer: TranscriptWriter = { append: () => 'stored', markNotified };
    const { session, transport } = makeSession(adapter, roles, ctxFor('ja'), { writer, noticeKeywordsByLanguage: keywords }, true);
    await session.start(transport);
    adapter.done();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    expect(adapter.requests.at(-1)).toMatchObject({ cue: 'memoryNotice', fallbackText: jaNotice });
    adapter.speak(jaNotice);
    adapter.done();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    expect(markNotified).toHaveBeenCalledTimes(1);
    session.end();

    // The same notice request with only a zh keyword must not count as verified in ja.
    const missed = vi.fn();
    const zhOnlyAdapter = new FakeAdapter();
    const zhOnly = makeSession(zhOnlyAdapter, roles, ctxFor('ja'), {
      writer: { append: () => 'stored', markNotified: missed },
      noticeKeywordsByLanguage: keywords,
    }, true);
    await zhOnly.session.start(zhOnly.transport);
    zhOnlyAdapter.done();
    zhOnly.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    zhOnlyAdapter.speak('我会记着。');
    zhOnlyAdapter.done();
    zhOnly.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    expect(missed).not.toHaveBeenCalled();
    zhOnly.session.end();
  });

  it('accepts a ja checkin with both parts, rejects one without anytime, and keeps zh unchanged', async () => {
    const context: SilenceContext = {
      stage: 'checkin',
      userText: '今天走了很多路，脚有点酸。',
      assistantText: '今天走了不少地方。',
      previousTexts: [],
      memorySnapshot: '',
    };
    const signal = new AbortController().signal;
    const planner = (line: string, rules: SilenceRules) => createSilencePlanner(
      { complete: async () => JSON.stringify({ speak: true, text: line }) } satisfies TextModelClient,
      silenceDecision,
      rules,
    );

    const jaLine = 'まだ聞こえていますか？急がなくて大丈夫です。いつでもお話しできますよ。';
    expect(await planner(jaLine, i18n.silence.ja)(context, signal)).toEqual({ text: jaLine });
    expect(await planner('まだ聞こえていますか？今日はいい天気ですね。', i18n.silence.ja)(context, signal)).toBeNull();

    const zhLine = '您还在听吗？不着急，您随时想聊都可以。';
    expect(await planner(zhLine, i18n.silence.zh)(context, signal)).toEqual({ text: zhLine });
    expect(await planner('您还在听吗？今天天气不错。', i18n.silence.zh)(context, signal)).toBeNull();
  });

  it('keeps the zh instructions, tool copy, and recall fallbacks unchanged', async () => {
    const adapter = new FakeAdapter();
    const roles = fixedRoleCatalog('P-zh', director, {
      languages: ['zh', 'ja', 'en'],
      defaultLanguage: 'zh',
      personas: trilingualPersonas,
    });
    const { session, transport } = makeSession(adapter, roles, ctxFor('zh'));
    session.ledger.addUser('你好', 1);
    session.ledger.addAssistant('您好', 2);

    await session.start(transport);

    const config = adapter.configs[0]!;
    expect(config.instructions).toContain('P-zh');
    expect(config.instructions).toContain(`${PROMPT_LABELS.zh.user}${PROMPT_LABELS.zh.separator}你好`);
    expect(config.instructions).toContain(`${PROMPT_LABELS.zh.assistant}${PROMPT_LABELS.zh.separator}您好`);
    expect(config.tools.find((tool) => tool.name === 'recall_memory')?.description).toBe(i18n.memory.zh.recall.toolDescription);
    expect(config.tools.find((tool) => tool.name === 'perform_action')?.description).toBe(i18n.memory.zh.performAction.toolDescription);
    expect(config.tools.find((tool) => tool.name === 'forget_memory')?.description).toBe(i18n.memory.zh.recall.forgetToolDescription);
    expect(config.tools.find((tool) => tool.name === 'set_memory_consent')?.description).toBe(i18n.memory.zh.recall.consentToolDescription);
    session.end();

    const toolCtx = (store: MemoryStore): ToolContext => ({
      ownerId: 'owner-1', sessionId: 's1', store, ledger: new ConversationLedger(), actions: new ActionRouter(), now: 1,
    });
    const zh = createToolRegistry({
      language: 'zh',
      memory: i18n.memory.zh,
      evidence: i18n.evidence,
      recentQueries: i18n.recentQueries,
      recallPrompt: 'FIXTURE RECALL',
      safety: i18n.safety,
      clipChars: 80,
      phraseTimeoutMs: 1_500,
    });

    const empty = await zh.handle('recall_memory', { query: '喝茶' }, toolCtx(toolStore([])));
    expect(empty).toMatchObject({
      ok: true,
      spokenFound: false,
      spokenText: i18n.memory.zh.recall.emptyText,
      text: i18n.memory.zh.recall.wrapText,
    });
    const found = await zh.handle('recall_memory', { query: '喝茶' }, toolCtx(toolStore([{ text: '我喜欢喝茶。' }])));
    expect(found.spokenFound).toBe(true);
    expect(found.spokenText).toBe(`${i18n.memory.zh.recall.foundPrefix}我喜欢喝茶。`);
    expect(found.text).toBe(`${i18n.memory.zh.recall.wrapText}\n我喜欢喝茶。`);

    const ja = createToolRegistry({
      language: 'ja',
      memory: i18n.memory.ja,
      evidence: i18n.evidence,
      recentQueries: i18n.recentQueries,
      recallPrompt: 'FIXTURE RECALL',
      safety: i18n.safety,
      clipChars: 80,
      phraseTimeoutMs: 1_500,
    });
    expect(ja.specs().find((spec) => spec.name === 'recall_memory')?.description).toBe(i18n.memory.ja.recall.toolDescription);
    const jaEmpty = await ja.handle('recall_memory', { query: 'ヨガ' }, toolCtx(toolStore([])));
    expect(jaEmpty).toMatchObject({ spokenFound: false, spokenText: i18n.memory.ja.recall.emptyText });
  });
});
