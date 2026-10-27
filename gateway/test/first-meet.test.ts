import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHARACTER_IDS } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import type { SessionConfig } from '../src/adapters/types.ts';
import type { CharacterRegistry } from '../src/characters/registry.ts';
import type { MemoryStore } from '../src/memory/store.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import { loadAffectConfig } from '../src/session/affect.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session, type SessionDeps, type Transport } from '../src/session/session.ts';
import { shippedCharacters, shippedRoles } from './support/shipped.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const affect = loadAffectConfig(`${root}config/affect.json`);
const script: MockScript = { greeting: '你好呀', followup: '还在吗', fallbackReply: '我在听', turns: [] };

const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup',
  idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
  toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
  greetingMemoryInstruction: 'GM', greetingMemoryText: '又见到您了。',
  greetingNameTexts: ['{name}，又见面了。'],
  silenceDecision: {
    instruction: 'D', speakInstruction: 'SAY {continuation}',
    maxTokens: 128, maxInputChars: 6000, maxReplyChars: 60, temperature: 0.8,
    policy: { timeoutMs: 2000, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
  },
};

/** Card stub: the no-name line names the character and language so the fallback is unambiguous. */
const characters: CharacterRegistry = {
  ids: () => CHARACTER_IDS,
  roleOf: () => 'elder-companion',
  gender: () => 'male',
  name: () => '小凯',
  spokenName: () => '小凯',
  identity: () => 'IDENTITY',
  greetingNoName: (id, language) => `NO-NAME ${id} ${language}`,
  greetingsFirstMeet: () => ['{name}您好，我是小凯，头一回来陪您。', '您好{name}，我叫小凯，以后常来陪您。'],
  voiceFor: () => undefined,
};

const PROFILE = '基本情况：老家在山东';
const NAMED = `称呼：王叔\n${PROFILE}`;
const owned = { ownerId: 'owner-1', agentId: 'agent-1', characterId: 'xiaokai', language: 'zh' } as const;
const FIRST_MEET_LINES = ['王叔您好，我是小凯，头一回来陪您。', '您好王叔，我叫小凯，以后常来陪您。'];

function planner(reply = '{"speak":false}') {
  const inputs: Array<{ stage: string; memorySnapshot: string }> = [];
  const client: TextModelClient = {
    complete: async (input) => {
      inputs.push(JSON.parse(input.user) as { stage: string; memorySnapshot: string });
      return reply;
    },
  };
  return { inputs, client };
}

function open(ctx: SessionContext, client: TextModelClient, overrides: Partial<SessionDeps> = {}) {
  const mock = new MockAdapter({ script, replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
  const session = new Session({
    adapterFactory: () => mock,
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    characters,
    textClient: client,
    ...overrides,
  }, ctx, 'first-meet');
  const creates = vi.spyOn(mock, 'createResponse');
  const transport: Transport = { send: () => {}, sendAudio: () => {} };
  return { session, creates, transport };
}

const greetingCalls = (creates: ReturnType<typeof open>['creates']) =>
  creates.mock.calls.map(([request]) => request).filter((request) => request?.cue === 'greeting');

describe('opening by first meeting and addressing', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('first meeting, no name: the planner sees no memory and the card line is the fallback', async () => {
    const { inputs, client } = planner();
    const s = open({ ...owned, firstMeet: true, memorySnapshot: PROFILE, greetingMemorySnapshot: PROFILE, proactiveMemorySnapshot: PROFILE }, client);
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs).toEqual([expect.objectContaining({ stage: 'greeting', memorySnapshot: '' })]);
    expect(greetingCalls(s.creates)).toEqual([{ cue: 'greeting', instruction: 'G', fallbackText: 'NO-NAME xiaokai zh' }]);
    s.session.end();
  });

  it('first meeting with a name: a first-meet template, never the planner, never "again"', async () => {
    const { inputs, client } = planner('{"speak":true,"text":"王叔，又见面啦，上次聊到京剧"}');
    const s = open({ ...owned, firstMeet: true, memorySnapshot: NAMED, greetingMemorySnapshot: NAMED, proactiveMemorySnapshot: PROFILE }, client);
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs).toEqual([]);
    const [opening] = greetingCalls(s.creates);
    expect(FIRST_MEET_LINES).toContain(opening?.fallbackText);
    expect(opening?.instruction).toBe(opening?.fallbackText);
    expect(greetingCalls(s.creates).some((request) => request?.fallbackText.includes('又见'))).toBe(false);
    s.session.end();
  });

  it('met before, no name: the planner keeps the greeting view and the memory copy is the fallback', async () => {
    const { inputs, client } = planner();
    const s = open({ ...owned, firstMeet: false, memorySnapshot: PROFILE, greetingMemorySnapshot: PROFILE, proactiveMemorySnapshot: PROFILE }, client);
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs).toEqual([expect.objectContaining({ stage: 'greeting', memorySnapshot: PROFILE })]);
    expect(greetingCalls(s.creates)).toEqual([{ cue: 'greeting', instruction: 'GM', fallbackText: '又见到您了。' }]);
    s.session.end();
  });

  it('met before with a name: the safe name template, never the planner (pitfall 5)', async () => {
    const { inputs, client } = planner('{"speak":true,"text":"上次聊到您喜欢听京剧"}');
    const s = open({ ...owned, firstMeet: false, memorySnapshot: NAMED, greetingMemorySnapshot: NAMED, proactiveMemorySnapshot: PROFILE }, client);
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs).toEqual([]);
    expect(greetingCalls(s.creates)).toEqual([{ cue: 'greeting', instruction: '王叔，又见面了。', fallbackText: '王叔，又见面了。' }]);
    s.session.end();
  });

  it('keeps the first-meet line stable so a retried opening repeats the same sentence', () => {
    const s = open({ ...owned, firstMeet: true, greetingMemorySnapshot: NAMED }, planner().client);
    const pick = () => (s.session as unknown as { firstMeetGreeting(): string | undefined }).firstMeetGreeting();
    // Mock after construction so nothing else consumes the stubbed values.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(pick()).toBe(FIRST_MEET_LINES[0]);
    random.mockReturnValue(0.99);
    expect(pick()).toBe(FIRST_MEET_LINES[0]);
    random.mockRestore();
    s.session.end();
  });

  it('keeps Task 7 behavior without a character registry', async () => {
    const { inputs, client } = planner();
    const s = open({ ...owned, firstMeet: true, memorySnapshot: NAMED, greetingMemorySnapshot: NAMED }, client, { characters: undefined });
    await s.session.start(s.transport);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs).toEqual([]);
    expect(greetingCalls(s.creates)).toEqual([{ cue: 'greeting', instruction: '王叔，又见面了。', fallbackText: '王叔，又见面了。' }]);
    s.session.end();
  });

  it('skips the care opening at a first meeting only', async () => {
    const roles = fixedRoleCatalog('P', { ...director, greetingCareTexts: ['{name}，又见面啦。'] });
    for (const firstMeet of [true, false]) {
      const careFollowup = vi.fn(() => undefined);
      const store = { careFollowup } as unknown as MemoryStore;
      const s = open({ ...owned, firstMeet, memorySnapshot: NAMED, greetingMemorySnapshot: NAMED }, planner().client, { roles, store, affect });
      await s.session.start(s.transport);
      expect(careFollowup).toHaveBeenCalledTimes(firstMeet ? 0 : 1);
      s.session.end();
    }
  });
});

describe('characters do not know each other (Q14)', () => {
  it('sends each character only its own name and the unknown-name rule', async () => {
    const shipped = shippedCharacters();
    for (const characterId of CHARACTER_IDS) {
      const configs: SessionConfig[] = [];
      const mock = new MockAdapter({ script });
      const connect = mock.connect.bind(mock);
      vi.spyOn(mock, 'connect').mockImplementation((config) => { configs.push(config); return connect(config); });
      const session = new Session({
        adapterFactory: () => mock,
        summarizer: new MockSummarizer(),
        roles: shippedRoles(),
        characters: shipped,
      }, { characterId, firstMeet: true, language: 'zh' }, `isolation-${characterId}`);
      await session.start({ send: () => {}, sendAudio: () => {} });
      const instructions = configs[0]!.instructions;
      expect(instructions).toContain(shipped.name(characterId, 'zh'));
      expect(instructions).toContain('用户提到你不认识的名字时，当作用户认识的人来接话');
      for (const other of CHARACTER_IDS.filter((id) => id !== characterId)) {
        expect(instructions).not.toContain(shipped.name(other, 'zh'));
      }
      session.end();
    }
  });
});
