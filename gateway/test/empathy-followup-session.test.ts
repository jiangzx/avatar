import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import { MockAdapter, type MockScript } from '../src/adapters/mock.ts';
import type { ProactiveRequest } from '../src/adapters/types.ts';
import type { TextModelClient } from '../src/memory/textClient.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import { loadAffectConfig, type AffectCard } from '../src/session/affect.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session, type Transport } from '../src/session/session.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const affect = loadAffectConfig(`${root}config/affect.json`);
const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup',
  idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
  toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
};

const happyCard: AffectCard = { emotion: 'happy', intensity: 2, trend: 'flat', need: 'share_joy', strategy: 'affirm', mismatch: false, crisis: false };
const lowCard: AffectCard = { emotion: 'sad', intensity: 2, trend: 'flat', need: 'vent', strategy: 'comfort', mismatch: false, crisis: false };
const crisisCard: AffectCard = { ...lowCard, crisis: true };

const script = (reply: string): MockScript => ({ greeting: '你好呀', followup: '还在吗', fallbackReply: reply, turns: [] });

function setup(reply: string, card: AffectCard, followUp: string) {
  const requests: ProactiveRequest[] = [];
  const client: TextModelClient = {
    complete: async (input) => {
      if (input.system === 'FIXTURE AFFECT') return JSON.stringify(card);
      if (input.system === 'FIXTURE FOLLOWUP') return JSON.stringify({ text: followUp });
      return '{"speak":false}';
    },
  };
  const session = new Session({
    adapterFactory: () => {
      const m = new MockAdapter({ script: script(reply), replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
      const create = m.createResponse.bind(m);
      m.createResponse = (request?: ProactiveRequest) => {
        if (request) requests.push(request);
        create(request);
      };
      return m;
    },
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    textClient: client,
    affect,
  }, { roleId: 'elder-companion', styleId: 'grandchild', language: 'zh' });
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (m) => sent.push(m), sendAudio: () => {} };
  return { session, transport, requests, sent };
}

async function startAndFinishGreeting(s: ReturnType<typeof setup>) {
  await s.session.start(s.transport);
  await vi.advanceTimersByTimeAsync(1000);
  s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
}

async function sayAndFinishMain(s: ReturnType<typeof setup>, text: string, seq = 2) {
  s.session.handleClientMessage({ type: 'debug.userText', text });
  // Long enough for the mock reply to finish generating (charMs 100, up to 9 chars).
  await vi.advanceTimersByTimeAsync(1000);
  s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: seq, playedMs: 300, reason: 'ended' });
  await vi.advanceTimersByTimeAsync(0);
}

const followUps = (s: ReturnType<typeof setup>) => s.requests.filter((r) => r.cue === 'followup');

describe('empathy follow-up session', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('requests one follow-up after the main reply playback ends', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    expect(followUps(s)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(1);
    expect(followUps(s)[0]?.fallbackText).toBe('后来呢？');
    expect(followUps(s)[0]?.instruction).toContain('后来呢？');
  });

  it('does not follow up in a crisis', async () => {
    const s = setup('我在听。', crisisCard, '我陪您坐一会儿。');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '活着真没意思');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(0);
  });

  it('does not follow up when the main reply already asked a question', async () => {
    const s = setup('您孙子考的哪个学校？', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(0);
  });

  it('cancels a pending follow-up when the user speaks again', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    s.session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(0);
  });

  it('does not follow up twice in one session', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 300, reason: 'ended' });
    await sayAndFinishMain(s, '他考的是本校。', 4);
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(1);
  });
});
