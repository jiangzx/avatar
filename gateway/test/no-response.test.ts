import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig } from '../src/adapters/types.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { Session, type Transport } from '../src/session/session.ts';

const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));

const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting',
  followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle',
  resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: 'ok',
  memoryNoticeInstruction: 'M', memoryNoticeText: 'notice',
};

/** Answers nothing by itself except proactive requests; the test plays the model. */
class QuietAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  readonly verbatimFallback = false;
  readonly supportsUserText = true;
  private counter = 0;
  private activeId: string | null = null;
  async connect(_config: SessionConfig): Promise<void> {}
  sendAudio(_pcm: Int16Array): void {}
  sendUserText(_text: string): void {}
  updateInstructions(_text: string): void {}
  updateVoice(_voice: string | undefined): void {}
  createResponse(_request?: ProactiveRequest): void { this.begin(); }
  cancelResponse(): void {}
  sendToolResult(_callId: string, _result: unknown): void {}
  injectContextNote(_text: string): void {}
  close(): void {}
  begin(): void {
    this.activeId = `resp-${++this.counter}`;
    this.emit('responseStarted', this.activeId);
  }
  done(): void {
    const id = this.activeId!;
    this.activeId = null;
    this.emit('responseDone', id);
  }
}

const USER_LINE = '我今天去公园散步了';

async function started() {
  const adapter = new QuietAdapter();
  const sent: ServerMessage[] = [];
  const transport: Transport = { send: (message) => sent.push(message), sendAudio: () => {} };
  const session = new Session({
    adapterFactory: () => adapter,
    summarizer: new MockSummarizer(),
    roles: fixedRoleCatalog('P', director),
    i18n,
    languageRules: i18n.language,
    push: { minIntervalMs: 0, noResponseAfterMs: 5_000 },
  }, { characterId: 'xiaonuan', firstMeet: false }, 'no-response');
  await session.start(transport);
  adapter.done(); // greeting
  session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
  return { adapter, session };
}

describe('no_response_after_final', () => {
  let lines: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    lines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const reports = () => lines.filter((line) => line.includes('"no_response_after_final"'));

  it('logs once, content-free, when a substantive final gets no response', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.emit('userTranscript', USER_LINE, true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(reports()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports()).toHaveLength(1);
    expect(JSON.parse(reports()[0]!)).toMatchObject({ event: 'no_response_after_final', sinceFinalMs: 5_000 });
    expect(reports()[0]).not.toContain(USER_LINE);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toHaveLength(1);
    session.end();
  });

  it('is cancelled by response.start', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.emit('userTranscript', USER_LINE, true);
    await vi.advanceTimersByTimeAsync(1_000);
    adapter.begin();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
    session.end();
  });

  it('is cancelled when the user speaks again', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.emit('userTranscript', USER_LINE, true);
    await vi.advanceTimersByTimeAsync(1_000);
    session.handleClientMessage({ type: 'vad', state: 'speaking', t: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
    session.end();
  });

  it('is cancelled when the session ends', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.emit('userTranscript', USER_LINE, true);
    session.end();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
  });

  it('does not time a light reply', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.emit('userTranscript', '嗯', true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
    session.end();
  });

  it('does not time a final that arrives while a reply is live', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.begin();
    adapter.emit('userTranscript', USER_LINE, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
    session.end();
  });

  it('does not time a final whose reply already started after the speaking edge', async () => {
    const { adapter, session } = await started();
    adapter.emit('userSpeechStarted');
    adapter.begin(); // Qwen: response.created before the transcript is final
    adapter.done();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 2, playedMs: 300, reason: 'ended' });
    adapter.emit('userTranscript', USER_LINE, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reports()).toEqual([]);
    session.end();
  });
});
