import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import type { ProactiveRequest, SessionConfig } from '../src/adapters/types.ts';
import { loadI18n } from '../src/i18n/load.ts';
import type { MemoryStore } from '../src/memory/store.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import { shippedRoles as shippedRolesLoader } from './support/shipped.ts';
import { loadAffectConfig } from '../src/session/affect.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session, type Transport } from '../src/session/session.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const i18n = loadI18n(`${root}config`);
const shipped = loadAffectConfig(`${root}config/affect.json`);
const affect = { ...shipped, enabled: true, care: { ...shipped.care, maxAgeDays: 7, timeoutMs: 1_500, maxChars: { zh: 40, ja: 50, en: 120 } } };
const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;
const QUOTE = '我明天去医院复查腰';
const CARE = '复查的腰怎么样了？';

const script: MockScript = { greeting: '你好呀', followup: '还在吗', memoryNotice: '我会记着', fallbackReply: '我在听', turns: [] };

const zhDirector: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup',
  idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
  toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
  greetingNameTexts: ['{name}，又见面了。'],
  greetingCareTexts: ['{name}，又见面啦。', '您好呀，{name}。'],
  silenceDecision: {
    instruction: 'D', speakInstruction: 'SAY {continuation}',
    maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
    policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
  },
};
const enDirector: DirectorConfig = { ...zhDirector, greetingNameTexts: ['{name}, good to see you again.'], greetingCareTexts: ['Hello, {name}.'] };
const roles = fixedRoleCatalog('P', zhDirector, { languages: ['zh', 'en'], defaultLanguage: 'zh', directors: { zh: zhDirector, en: enDirector } });

type Followup = { id: string; quote: string; createdAt: number };

/** Only what the opening reads: the stored name and the care followup. */
function storeStub(followup: Followup | undefined | 'throws') {
  const careFollowup = vi.fn(() => {
    if (followup === 'throws') throw new Error('sqlite_busy');
    return followup;
  });
  const closeCareFollowup = vi.fn();
  const store = {
    listProfileFacts: () => [{ id: 'p1', category: 'addressing', text: '称呼：王叔' }],
    listAgentFacts: () => [],
    listPinned: () => [],
    recentUserMessages: () => [],
    careFollowup,
    closeCareFollowup,
  } as unknown as MemoryStore;
  return { store, careFollowup, closeCareFollowup };
}

/** The care call is recognized by the fixture care prompt; the silence planner always declines. */
function careClient(reply: () => Promise<string>) {
  const careCalls: Array<{ user: string; signal: AbortSignal }> = [];
  const client: TextModelClient = {
    complete: (input) => {
      if (input.system !== 'FIXTURE CARE') return Promise.resolve('{"speak":false}');
      careCalls.push({ user: input.user, signal: input.signal });
      return reply();
    },
  };
  return { client, careCalls };
}

function setup(store: MemoryStore, client: TextModelClient) {
  const requests: ProactiveRequest[] = [];
  const instructions: string[] = [];
  const session = new Session({
    adapterFactory: () => {
      const m = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
      const create = m.createResponse.bind(m);
      m.createResponse = (request?: ProactiveRequest) => {
        if (request) requests.push(request);
        create(request);
      };
      const connect = m.connect.bind(m);
      m.connect = (config: SessionConfig) => {
        instructions.push(config.instructions);
        return connect(config);
      };
      return m;
    },
    summarizer: new MockSummarizer(),
    roles,
    textClient: client,
    store,
    budget: { totalChars: 8_000, snapshotMaxChars: 600, summaryMaxChars: 800 },
    i18n,
    affect,
  }, { ownerId: 'owner-1', agentId: 'agent-1', roleId: 'elder-companion', styleId: 'grandchild', language: 'zh' }, 'care-session');
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (m) => sent.push(m), sendAudio: () => {} };
  const greetings = () => requests.filter((request) => request.cue === 'greeting');
  const greetingStarts = () => sent.filter((m) => m.type === 'response.start' && m.kind === 'greeting');
  return { session, transport, greetings, greetingStarts, instructions };
}

const say = (text: string): ProactiveRequest => ({ cue: 'greeting', instruction: text, fallbackText: text });

describe('care opening', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens with the care line and closes the followup on the first response.start', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { store, careFollowup, closeCareFollowup } = storeStub({ id: 'fu-1', quote: QUOTE, createdAt: NOW - 2 * DAY });
    const { client, careCalls } = careClient(async () => JSON.stringify({ text: CARE }));
    const s = setup(store, client);
    await s.session.start(s.transport);
    expect(careFollowup).toHaveBeenCalledWith('owner-1', 'agent-1', 'care-session', NOW, 7 * DAY);
    expect(JSON.parse(careCalls[0]!.user)).toEqual({ userLine: QUOTE, daysAgo: 2 });
    expect(s.greetings()).toEqual([say(`王叔，又见面啦。${CARE}`)]);
    expect(closeCareFollowup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(s.greetingStarts()).toHaveLength(1);
    expect(closeCareFollowup).toHaveBeenCalledTimes(1);
    expect(closeCareFollowup).toHaveBeenCalledWith('owner-1', 'fu-1', NOW + 50);
    // The quote is generator input only; it never reaches the realtime instructions.
    expect(s.instructions.some((text) => text.includes(QUOTE))).toBe(false);
    s.session.end();
  });

  it('greets exactly as before, without waiting, when nothing is open', async () => {
    const { store, closeCareFollowup } = storeStub(undefined);
    const { client, careCalls } = careClient(() => new Promise<string>(() => {}));
    const s = setup(store, client);
    await s.session.start(s.transport);
    expect(careCalls).toHaveLength(0);
    expect(s.greetings()).toEqual([say('王叔，又见面了。')]);
    await vi.advanceTimersByTimeAsync(60);
    expect(closeCareFollowup).not.toHaveBeenCalled();
    s.session.end();
  });

  it('greets normally when the store read fails', async () => {
    const { store } = storeStub('throws');
    const { client, careCalls } = careClient(async () => JSON.stringify({ text: CARE }));
    const s = setup(store, client);
    await s.session.start(s.transport);
    expect(careCalls).toHaveLength(0);
    expect(s.greetings()).toEqual([say('王叔，又见面了。')]);
    s.session.end();
  });

  it('waits for a care line that arrives inside the window', async () => {
    let release!: (raw: string) => void;
    const { store } = storeStub({ id: 'fu-1', quote: QUOTE, createdAt: NOW - DAY });
    const { client } = careClient(() => new Promise<string>((resolve) => { release = resolve; }));
    const s = setup(store, client);
    const start = s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.greetings()).toEqual([]);
    release(JSON.stringify({ text: CARE }));
    await start;
    expect(s.greetings()).toHaveLength(1);
    expect(s.greetings()[0]!.fallbackText.endsWith(CARE)).toBe(true);
    s.session.end();
  });

  it('waits at most care.timeoutMs from start, then greets normally and keeps the followup open', async () => {
    const { store, closeCareFollowup } = storeStub({ id: 'fu-1', quote: QUOTE, createdAt: NOW - DAY });
    const { client, careCalls } = careClient(() => new Promise<string>(() => {}));
    const s = setup(store, client);
    let started = false;
    const start = s.session.start(s.transport).then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(started).toBe(false);
    expect(s.greetings()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await start;
    expect(careCalls[0]!.signal.aborted).toBe(true);
    expect(s.greetings()).toEqual([say('王叔，又见面了。')]);
    await vi.advanceTimersByTimeAsync(60);
    expect(closeCareFollowup).not.toHaveBeenCalled();
    s.session.end();
  });

  it('falls back to the plain greeting when the care line is not grounded', async () => {
    const { store, closeCareFollowup } = storeStub({ id: 'fu-1', quote: QUOTE, createdAt: NOW - DAY });
    const { client } = careClient(async () => JSON.stringify({ text: '复查的腰好点没？《养生堂》看了吗' }));
    const s = setup(store, client);
    await s.session.start(s.transport);
    expect(s.greetings()).toEqual([say('王叔，又见面了。')]);
    await vi.advanceTimersByTimeAsync(60);
    expect(closeCareFollowup).not.toHaveBeenCalled();
    s.session.end();
  });

  it('drops a care line composed in another language', async () => {
    let release!: (raw: string) => void;
    const { store, closeCareFollowup } = storeStub({ id: 'fu-1', quote: QUOTE, createdAt: NOW - DAY });
    const { client } = careClient(() => new Promise<string>((resolve) => { release = resolve; }));
    const s = setup(store, client);
    const start = s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    s.session.setInitialLanguage('en');
    release(JSON.stringify({ text: CARE }));
    await start;
    expect(s.greetings()).toEqual([say('王叔, good to see you again.')]);
    await vi.advanceTimersByTimeAsync(60);
    expect(closeCareFollowup).not.toHaveBeenCalled();
    s.session.end();
  });

  it('repeats the same composed care opening when the opening is retried, and closes once', async () => {
    const { store, closeCareFollowup } = storeStub({ id: 'fu-1', quote: QUOTE, createdAt: NOW - DAY });
    const { client } = careClient(async () => JSON.stringify({ text: CARE }));
    const s = setup(store, client);
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(60);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 100, reason: 'interrupted' });
    await vi.advanceTimersByTimeAsync(900);
    const sent = s.greetings();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]!.fallbackText.endsWith(CARE)).toBe(true);
    expect(closeCareFollowup).toHaveBeenCalledTimes(1);
    s.session.end();
  });

  it('neither repeats nor drops the opening when the user talks during the wait', async () => {
    let release!: (raw: string) => void;
    const { store, closeCareFollowup } = storeStub({ id: 'fu-1', quote: QUOTE, createdAt: NOW - DAY });
    const { client } = careClient(() => new Promise<string>((resolve) => { release = resolve; }));
    const s = setup(store, client);
    const start = s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 100 });
    await vi.advanceTimersByTimeAsync(200);
    s.session.handleClientMessage({ type: 'vad', state: 'silent', t: 300 });
    // armOpening retries at 1100 ms; that opening starts at 1150 ms.
    await vi.advanceTimersByTimeAsync(850);
    release(JSON.stringify({ text: CARE }));
    await start;
    await vi.advanceTimersByTimeAsync(100);
    expect(s.greetingStarts()).toHaveLength(1);
    expect(s.greetings()).toEqual([say('王叔，又见面了。')]);
    expect(closeCareFollowup).not.toHaveBeenCalled();

    // The late care line must not replace the plain opening on a retry.
    const start1 = s.greetingStarts().at(-1) as { responseSeq: number };
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: start1.responseSeq, playedMs: 100, reason: 'interrupted' });
    await vi.advanceTimersByTimeAsync(900);
    expect(s.greetings()).toEqual([say('王叔，又见面了。'), say('王叔，又见面了。')]);
    expect(closeCareFollowup).not.toHaveBeenCalled();
    s.session.end();
  });
});

describe('shipped care opening config', () => {
  it('has three greetingCareTexts with {name} and no question in every language', () => {
    const shippedRoles = shippedRolesLoader();
    for (const language of ['zh', 'ja', 'en'] as const) {
      const texts = shippedRoles.director('xiaonuan', language).greetingCareTexts ?? [];
      expect(texts).toHaveLength(3);
      for (const text of texts) {
        expect(text).toContain('{name}');
        expect(text).not.toMatch(/[？?]/);
      }
    }
  });
});
