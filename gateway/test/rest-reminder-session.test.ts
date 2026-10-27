import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig } from '../src/adapters/types.ts';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import type { SessionContext } from '../src/session/context.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session } from '../src/session/session.ts';

const characters = loadCharacterRegistry(fileURLToPath(new URL('../characters', import.meta.url)), ['zh', 'ja', 'en']);
const text = DEFAULT_I18N.memory.zh.restReminderText;
const director: DirectorConfig = {
  followupAfterMs: 600_000, idleNoticeAfterMs: 600_000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300_000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting', followupInstruction: 'F', followupText: 'followup',
  idleNoticeInstruction: 'I', idleNoticeText: 'idle', resumeInstruction: 'R', resumeText: 'resume',
  toolContinueInstruction: 'C', toolContinueText: '好。', memoryNoticeInstruction: 'N', memoryNoticeText: '记着。',
  contextAfterMs: 20_000, checkAfterMs: 600_000, leaveAfterMs: 600_000, checkinAfterMs: 600_000,
};

class FakeAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  readonly verbatimFallback = false;
  readonly supportsUserText = true;
  readonly requests: ProactiveRequest[] = [];
  private counter = 0;
  private activeId: string | null = null;
  async connect(_config: SessionConfig): Promise<void> {}
  sendAudio(_pcm: Int16Array): void {}
  sendUserText(_text: string): void {}
  updateInstructions(_text: string): void {}
  updateVoice(_voice: string | undefined): void {}
  createResponse(request?: ProactiveRequest): void {
    if (request) this.requests.push(request);
    const id = `resp-${++this.counter}`;
    this.activeId = id;
    this.emit('responseStarted', id);
  }
  cancelResponse(): void {}
  sendToolResult(_callId: string, _result: unknown): void {}
  injectContextNote(_text: string): void {}
  close(): void {}
  done(): void {
    const id = this.activeId;
    if (!id) throw new Error('no_active_response');
    this.activeId = null;
    this.emit('responseDone', id);
  }
}

const sessions: Session[] = [];
const restReminder = { firstAfterMs: 60_000, everyMs: 60_000, continuityGapMs: 600_000 };

function boot(opts: { continuousSince?: number; reminders?: boolean } = {}) {
  const adapter = new FakeAdapter();
  const sent: ServerMessage[] = [];
  const ctx: SessionContext = {
    characterId: 'xiaonuan',
    firstMeet: false,
    ...(opts.continuousSince !== undefined ? { continuousSince: opts.continuousSince } : {}),
  };
  const session = new Session({
    adapterFactory: () => adapter,
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    characters,
    ...(opts.reminders === false ? {} : { restReminder }),
  }, ctx, `rest-${sessions.length}`);
  sessions.push(session);
  const transport = { send: (msg: ServerMessage) => { sent.push(msg); }, sendAudio: () => {} };
  const reminders = () => adapter.requests.filter((request) => request.cue === 'restReminder');
  return { adapter, session, sent, transport, reminders };
}

async function open(t: ReturnType<typeof boot>): Promise<void> {
  await t.session.start(t.transport);
  t.adapter.done();
  t.session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 0, reason: 'ended' });
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.end();
  vi.useRealTimers();
});

describe('rest reminder in a live session', () => {
  it('counts from the continuous stretch across sessions and takes the waiting silence slot', async () => {
    const t = boot({ continuousSince: 1_000_000 - 50_000 }); // due 10 s after start
    await open(t);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.reminders()).toEqual([]); // owed: the context step is armed for 20 s
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.reminders()).toEqual([{ cue: 'restReminder', instruction: `请直接说下面这句话，不要改写：${text}`, fallbackText: text }]);
    expect(t.adapter.requests.filter((request) => request.cue === 'followup')).toEqual([]);
    expect(t.sent).toContainEqual({ type: 'response.start', responseSeq: 2, kind: 'reminder' });
  });

  it('starts a fresh stretch at session start when the context has no continuity', async () => {
    const t = boot();
    await open(t);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.reminders()).toEqual([]);
    expect(t.adapter.requests.at(-1)?.cue).toBe('followup'); // the normal context step
  });

  it('clears its timer on end()', async () => {
    const t = boot({ continuousSince: 1_000_000 - 50_000 });
    await open(t);
    t.session.end();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.reminders()).toEqual([]);
  });

  it('is off without a restReminder config', async () => {
    const t = boot({ continuousSince: 1_000_000 - 50_000, reminders: false });
    await open(t);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.reminders()).toEqual([]);
  });
});
