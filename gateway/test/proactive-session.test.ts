import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig } from '../src/adapters/types.ts';
import { loadDirectorConfig } from '../src/config.ts';
import { loadI18n } from '../src/i18n/load.ts';
import type { Logger } from '../src/log/logger.ts';
import type { MemoryStore, ThreadRecord } from '../src/memory/store.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { loadProactivity } from '../src/session/proactive/config.ts';
import { speakLineRequest } from '../src/session/proactive/render.ts';
import { Session } from '../src/session/session.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const i18n = loadI18n(`${root}config`);
const proactivity = loadProactivity(`${root}config/proactivity.json`);
const shipped = loadDirectorConfig(`${root}roles/elder-companion/zh/director.json`);
const director = { ...shipped, topics: [{ id: 'meal', prompt: '今天吃了什么好吃的', fallbackText: '您今天吃了点什么好吃的？' }] };
const AFTERNOON = Date.parse('2026-11-03T15:00:00+08:00');
const DAY = 86_400_000;

class FakeAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  readonly verbatimFallback = false;
  readonly supportsUserText = true;
  readonly requests: ProactiveRequest[] = [];
  readonly connects: SessionConfig[] = [];
  /** Swallow the next proactive request: no response.created (fallback test). */
  silentNext = false;
  private counter = 0;
  private activeId: string | null = null;
  async connect(config: SessionConfig): Promise<void> { this.connects.push(config); }
  sendAudio(): void {}
  sendUserText(): void {}
  updateInstructions(): void {}
  updateVoice(): void {}
  createResponse(request?: ProactiveRequest): void {
    if (request) this.requests.push(request);
    if (this.silentNext) { this.silentNext = false; return; }
    this.start();
  }
  /** A response the model starts on its own (the passive reply). */
  start(): string {
    const id = `resp-${++this.counter}`;
    this.activeId = id;
    this.emit('responseStarted', id);
    return id;
  }
  say(text: string): void { this.emit('textDelta', this.activeId!, text); }
  done(): void { const id = this.activeId!; this.activeId = null; this.emit('responseDone', id); }
  cancelResponse(): void {}
  sendToolResult(): void {}
  injectContextNote(): void {}
  close(): void {}
}

function fakeStore(over: Record<string, unknown> = {}) {
  return {
    getOwner: vi.fn(() => ({ id: 'o1', memoryConsent: 'granted', notifiedAt: 1 })),
    listProfileFacts: vi.fn(() => [{ id: 'p1', category: 'addressing', text: '称呼：王叔' }]),
    listAgentFacts: vi.fn(() => []),
    listPinned: vi.fn(() => []),
    recentUserMessages: vi.fn(() => [] as Array<{ text: string }>),
    getProactiveTier: vi.fn((): string | undefined => undefined),
    setProactiveTier: vi.fn(),
    proactiveStats: vi.fn(() => []),
    recordProactiveOutcome: vi.fn(),
    proactiveDaily: vi.fn(() => 0),
    incrementProactiveDaily: vi.fn(() => 1),
    listOpenThreads: vi.fn(() => [] as ThreadRecord[]),
    markThreadMentioned: vi.fn(() => true),
    closeThread: vi.fn(() => true),
    listMoodSummaries: vi.fn(() => []),
    relationshipStats: vi.fn(() => ({ firstMetAt: null, sessions: 0, totalMinutes: 0, activeDays: 0, lastSessionAt: null, hourHistogram: Array(24).fill(0) })),
    recentFallbackLines: vi.fn(() => [] as number[]),
    recordFallbackLine: vi.fn(),
    proactiveLastAt: vi.fn(() => null),
    ...over,
  };
}

const sessions: Session[] = [];

function boot(store = fakeStore()) {
  const adapter = new FakeAdapter();
  const sent: ServerMessage[] = [];
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  const session = new Session({
    adapterFactory: () => adapter,
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    store: store as unknown as MemoryStore,
    budget: { totalChars: 8_000, snapshotMaxChars: 600, summaryMaxChars: 800 },
    i18n,
    proactivity,
    logger: logger as unknown as Logger,
  }, { ownerId: 'o1', agentId: 'a1', characterId: 'xiaonuan', firstMeet: false, language: 'zh' }, `proactive-${sessions.length}`);
  sessions.push(session);
  const transport = { send: (msg: ServerMessage) => { sent.push(msg); }, sendAudio: () => {} };
  let seq = 0;
  const played = (reason: 'ended' | 'interrupted' = 'ended') =>
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: ++seq, playedMs: 0, reason });
  const open = async () => {
    await session.start(transport);
    adapter.done();
    played();
    await vi.advanceTimersByTimeAsync(0);
  };
  const userTurn = async (text: string, reply = '嗯，挺好的。') => {
    adapter.emit('userTranscript', text, true);
    adapter.start();
    adapter.say(reply);
    adapter.done();
    played();
    await vi.advanceTimersByTimeAsync(0);
  };
  const followups = () => adapter.requests.filter((r) => r.cue === 'followup');
  return { adapter, session, sent, logger, store, open, userTurn, played, followups };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AFTERNOON);
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.end();
  vi.useRealTimers();
});

describe('silence ladder through the decision engine', () => {
  it('continues the user’s own statement at the context step, counts it and checks what was said', async () => {
    const t = boot();
    await t.open();
    await t.userTurn('我家那盆君子兰今年还没开花。');
    await vi.advanceTimersByTimeAsync(director.contextAfterMs!);
    const line = t.followups().at(-1)!;
    expect(line.instruction).toContain('【我家那盆君子兰今年还没开花。】');
    expect(t.sent).toContainEqual({ type: 'response.start', responseSeq: 3, kind: 'followup' });
    expect(t.store.incrementProactiveDaily).toHaveBeenCalledWith('o1', 'a1', '2026-11-03');
    t.adapter.say('君子兰不开花别着急，您记得按时吃药。');
    t.adapter.done();
    t.played();
    expect(t.logger.warn).toHaveBeenCalledWith('proactive_grounding_violation', expect.objectContaining({ kind: 'continueThread', violationKind: 'health' }));
    await t.userTurn('是啊，我昨天还给它换了盆土。');
    expect(t.store.recordProactiveOutcome).toHaveBeenCalledWith('o1', 'a1', 'continueThread', 'accepted', expect.any(Number));
  });

  it('reads the fallback line once when the model does not start in time', async () => {
    const t = boot();
    await t.open();
    await t.userTurn('我家那盆君子兰今年还没开花。');
    t.adapter.silentNext = true;
    await vi.advanceTimersByTimeAsync(director.contextAfterMs!);
    const first = t.followups().at(-1)!;
    await vi.advanceTimersByTimeAsync(proactivity.fallbackAfterMs - 1);
    expect(t.followups()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.followups().at(-1)).toEqual(speakLineRequest(director.intents!, first.fallbackText));
    expect(t.logger.warn).toHaveBeenCalledWith('proactive_fallback', { kind: 'continueThread', code: 'no_audio' });
    expect(t.sent).toContainEqual({ type: 'response.start', responseSeq: 3, kind: 'followup' });
  });

  it('stays quiet through context, check and leave in the quiet tier, then checks in', async () => {
    const t = boot(fakeStore({ getProactiveTier: vi.fn(() => 'quiet') }));
    await t.open();
    await t.userTurn('我家那盆君子兰今年还没开花。');
    await vi.advanceTimersByTimeAsync(director.contextAfterMs! + director.checkAfterMs! + director.leaveAfterMs!);
    expect(t.followups()).toEqual([]);
    await vi.advanceTimersByTimeAsync(director.checkinAfterMs!);
    expect(t.followups()).toHaveLength(1);
    expect(director.fallbacks!.presenceCheck).toContain(t.followups()[0]!.fallbackText);
  });

  it('puts the health quote in the greeting only', async () => {
    const quote = '我有高血压，这几天量着有点高。';
    const thread: ThreadRecord = { id: 't1', kind: 'concern', quote, dueAt: AFTERNOON, sensitive: true, mentionCount: 0, lastMentionedAt: null, createdAt: AFTERNOON - 3 * DAY, sourceSessionId: 's-old' };
    const t = boot(fakeStore({ listOpenThreads: vi.fn(() => [thread]) }));
    await t.open();
    const opening = t.adapter.requests.find((r) => r.cue === 'greeting')!;
    expect(opening.instruction).toContain(`【${quote}】`);
    expect(opening.instruction).toContain(director.intents!.withCare);
    expect(opening.fallbackText.startsWith('王叔')).toBe(true);
    expect(director.fallbacks!.threadSensitive.some((line) => opening.fallbackText.endsWith(line))).toBe(true);
    expect(t.store.markThreadMentioned).toHaveBeenCalledWith('o1', 't1', expect.any(Number));
    const standing = t.adapter.connects.map((c) => c.instructions).join('\n');
    expect(standing).not.toContain('高血压');
  });

  it('writes nothing across sessions when memory was declined', async () => {
    const t = boot(fakeStore({ getOwner: vi.fn(() => ({ id: 'o1', memoryConsent: 'declined', notifiedAt: 1 })) }));
    await t.open();
    await t.userTurn('我家那盆君子兰今年还没开花。');
    await vi.advanceTimersByTimeAsync(director.contextAfterMs!);
    expect(t.followups()).toHaveLength(1);
    expect(t.store.incrementProactiveDaily).not.toHaveBeenCalled();
  });

  it('stops the ladder after a goodbye', async () => {
    const t = boot();
    await t.open();
    await t.userTurn('好了，我去睡了，明天再聊。', '好的，晚安。');
    await vi.advanceTimersByTimeAsync(director.contextAfterMs! + director.checkAfterMs! + director.leaveAfterMs! + director.checkinAfterMs!);
    expect(t.followups()).toEqual([]);
  });
});

describe('opening through the decision engine (P4)', () => {
  const MORNING = Date.parse('2026-11-03T08:30:00+08:00');
  const quote = '我后天上午要去公园参加合唱团演出。';
  const event = (sensitive: boolean, text = quote): ThreadRecord => ({
    id: 't1', kind: 'event', quote: text, dueAt: MORNING - 5 * 3_600_000, sensitive, mentionCount: 0,
    lastMentionedAt: null, createdAt: MORNING - 2 * DAY, sourceSessionId: 's-old',
  });
  const greetings = (t: ReturnType<typeof boot>) => t.adapter.requests.filter((r) => r.cue === 'greeting');

  it('opens on a due event with the name and the locked quote, as a greeting', async () => {
    vi.setSystemTime(MORNING);
    const t = boot(fakeStore({ listOpenThreads: vi.fn(() => [event(false)]) }));
    await t.session.start({ send: (m: ServerMessage) => { t.sent.push(m); }, sendAudio: () => {} });
    const opening = greetings(t)[0]!;
    expect(opening.instruction).toContain('「王叔」');
    expect(opening.instruction).toContain(`【${quote}】`);
    expect(t.sent).toContainEqual({ type: 'response.start', responseSeq: 1, kind: 'greeting' });
    expect(t.store.markThreadMentioned).toHaveBeenCalledWith('o1', 't1', expect.any(Number));
  });

  it('reads a composed line for a health event', async () => {
    vi.setSystemTime(MORNING);
    const t = boot(fakeStore({ listOpenThreads: vi.fn(() => [event(true, '我后天上午去医院复查腰。')]) }));
    await t.session.start({ send: (m: ServerMessage) => { t.sent.push(m); }, sendAudio: () => {} });
    const opening = greetings(t)[0]!;
    expect(opening.instruction).toContain('【我后天上午去医院复查腰。】');
    expect(opening.instruction).toContain(director.intents!.withCare);
    expect(opening.fallbackText.startsWith('王叔')).toBe(true);
    expect(director.fallbacks!.threadSensitive.some((line) => opening.fallbackText.endsWith(line))).toBe(true);
    const standing = t.adapter.connects.map((c) => c.instructions).join('\n');
    expect(standing).not.toContain('复查');
  });

  it('reads the fallback opening once when the model does not start in time', async () => {
    vi.setSystemTime(AFTERNOON);
    const t = boot();
    t.adapter.silentNext = true;
    await t.session.start({ send: (m: ServerMessage) => { t.sent.push(m); }, sendAudio: () => {} });
    expect(greetings(t)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(proactivity.fallbackAfterMs);
    expect(greetings(t)).toHaveLength(2);
    expect(greetings(t)[1]!.instruction).toContain(director.greetingNameTexts![0]!.replaceAll('{name}', '王叔'));
    expect(t.sent).toContainEqual({ type: 'response.start', responseSeq: 1, kind: 'greeting' });
  });
});

describe('familiarity tone (open item 2)', () => {
  const statsOf = (sessions: number, activeDays: number) => ({ firstMetAt: 1, sessions, totalMinutes: 0, activeDays, lastSessionAt: 1, hourHistogram: Array(24).fill(0) });

  it('adds the tone for this character’s familiarity to every instruction', async () => {
    const t = boot(fakeStore({ relationshipStats: vi.fn(() => statsOf(3, 2)) }));
    await t.open();
    expect(t.adapter.connects[0]!.instructions).toContain(director.familiarityTones!.familiar);
    expect(t.adapter.connects[0]!.instructions).not.toContain(director.familiarityTones!.new);
  });

  it('a new acquaintance gets the new tone', async () => {
    const t = boot();
    await t.open();
    expect(t.adapter.connects[0]!.instructions).toContain(director.familiarityTones!.new);
  });
});

describe('no text planner anywhere (P4-T5)', () => {
  it('a first meeting without a name opens with the configured instruction, and no text model is called', async () => {
    const complete = vi.fn(async () => '{"speak":true,"text":"不应出现"}');
    const adapter = new FakeAdapter();
    const session = new Session({
      adapterFactory: () => adapter,
      summarizer: new MockSummarizer(),
      roles: fixedRoleCatalog('P', director),
      textClient: { complete },
      i18n,
      proactivity,
    }, { characterId: 'xiaonuan', firstMeet: true, language: 'zh' }, 'no-planner');
    sessions.push(session);
    await session.start({ send: () => {}, sendAudio: () => {} });
    expect(adapter.requests[0]).toEqual({ cue: 'greeting', instruction: director.greetingInstruction, fallbackText: director.greetingText });
    adapter.done();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 0, reason: 'ended' });
    await vi.advanceTimersByTimeAsync(director.contextAfterMs! + director.checkAfterMs!);
    expect(adapter.requests.length).toBeGreaterThanOrEqual(2);
    expect(complete).not.toHaveBeenCalled();
  });
});

