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

const script = (reply: string, turns: MockScript['turns'] = []): MockScript => ({ greeting: '你好呀', followup: '还在吗', fallbackReply: reply, turns });

function setup(reply: string, card: AffectCard, followUp: string, turns: MockScript['turns'] = []) {
  const requests: ProactiveRequest[] = [];
  const adapters: MockAdapter[] = [];
  const client: TextModelClient = {
    complete: async (input) => {
      if (input.system === 'FIXTURE AFFECT') return JSON.stringify(card);
      if (input.system === 'FIXTURE FOLLOWUP') return JSON.stringify({ text: followUp });
      return '{"speak":false}';
    },
  };
  const session = new Session({
    adapterFactory: () => {
      const m = new MockAdapter({ script: script(reply, turns), replyDelayMs: 50, charMs: 100, chunkMs: 100, paceFactor: 1 });
      adapters.push(m);
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
  return { session, transport, requests, sent, adapters };
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

  it('still follows up when the reply starts before the final transcript', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    const adapter = s.adapters[0]!;
    // Qwen can start speaking before the ASR final for that utterance arrives.
    adapter.emit('responseStarted', 'early-reply');
    adapter.emit('textDelta', 'early-reply', '孙子真争气。');
    adapter.emit('userTranscript', '孙子考上研究生了', true);
    await vi.advanceTimersByTimeAsync(10); // the card and its plan arrive while the reply is live
    adapter.emit('responseDone', 'early-reply');
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(0);
    expect(followUps(s)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(1);
    expect(followUps(s)[0]?.fallbackText).toBe('后来呢？');
  });

  it('does not follow up after a tool continuation', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？', [
      { match: '挥', user: '跟我挥挥手', reply: '好呀', tool: { name: 'perform_action', args: { action: 'wave' } } },
    ]);
    await startAndFinishGreeting(s);
    s.session.handleClientMessage({ type: 'debug.userText', text: '跟我挥挥手' });
    await vi.advanceTimersByTimeAsync(1000); // origin reply, tool call, then the continuation (seq 3)
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 100, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(0);
  });

  it('does not spend the one-shot when the session ends before the delay', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    s.session.end();
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    spy.mockRestore();
    expect(followUps(s)).toHaveLength(0);
    const spoken = chunks
      .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
      .filter((event) => event?.event === 'empathy_followup' && event.outcome === 'spoken');
    expect(spoken).toHaveLength(0);
  });

  it('does not spend the one-shot when a rebuild cancels delivery', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    s.adapters[0]!.simulateDrop();
    await vi.advanceTimersByTimeAsync(0); // the replacement adapter connects
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(0);
    // A later reply in the same session must still get the one follow-up.
    await sayAndFinishMain(s, '他又拿了奖学金', 3);
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(1);
  });

  it('sends a low companionship sentence without a question', async () => {
    const s = setup('我在听。', lowCard, '我陪您坐一会儿。');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '心里空落落的');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    const request = followUps(s)[0];
    expect(request?.fallbackText).toBe('我陪您坐一会儿。');
    expect(request?.fallbackText).not.toMatch(/[?？]/);
    expect(request?.instruction).toContain('我陪您坐一会儿。');
  });

  it('drops a low follow-up that contains a question', async () => {
    const s = setup('我在听。', lowCard, '您想说说吗？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '心里空落落的');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(0);
  });

  it('builds the Qwen instruction from the planned line and keeps it as the Seeduplex fallback', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    const request = followUps(s)[0];
    expect(request).toMatchObject({ cue: 'followup', fallbackText: '后来呢？' });
    expect(request?.instruction).toContain('后来呢？');
    expect(request?.instruction).toContain('FIXTURE FOLLOWUP SPEAK');
  });

  it('re-arms the Director silence ladder after the follow-up ends', async () => {
    const s = setup('孙子真争气。', happyCard, '后来呢？');
    await startAndFinishGreeting(s);
    await sayAndFinishMain(s, '孙子考上研究生了');
    await vi.advanceTimersByTimeAsync(affect.followup.delayMs + 10);
    expect(followUps(s)).toHaveLength(1);
    // Let the follow-up finish generating (charMs 100), then end its playback; the Director
    // silence ladder must still arm. Advancing past the first step (6s default) proves it.
    await vi.advanceTimersByTimeAsync(1000);
    s.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 3, playedMs: 300, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(8000);
    const ladder = followUps(s).filter((r) => r.fallbackText === 'followup');
    expect(ladder.length).toBeGreaterThanOrEqual(1);
  });
});
