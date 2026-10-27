import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig } from '../src/adapters/types.ts';
import { loadI18n } from '../src/i18n/load.ts';
import { ownerShortId } from '../src/log/ownerId.ts';
import { runWithPolicy } from '../src/reliability/policy.ts';
import { fixedRoleCatalog } from '../src/roles/catalog.ts';
import type { DirectorConfig } from '../src/session/director.ts';
import { MockSummarizer } from '../src/session/ledger.ts';
import { SessionManager } from '../src/session/manager.ts';
import { Session, type Transport } from '../src/session/session.ts';
import { sessionLogBinding } from '../src/session/logBinding.ts';
import { captureLogger } from './helpers/logCapture.ts';

const i18n = loadI18n(fileURLToPath(new URL('../config', import.meta.url)));
const director: DirectorConfig = {
  followupAfterMs: 8000, idleNoticeAfterMs: 25000, maxConsecutive: 2, maxPerWindow: 3, windowMs: 300000,
  quietPhrases: [], greetingInstruction: 'G', greetingText: 'greeting',
  followupInstruction: 'F', followupText: 'followup', idleNoticeInstruction: 'I', idleNoticeText: 'idle',
  resumeInstruction: 'R', resumeText: 'resume', toolContinueInstruction: 'C', toolContinueText: 'ok',
  memoryNoticeInstruction: 'M', memoryNoticeText: 'notice',
};

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
  createResponse(_request?: ProactiveRequest): void { this.activeId = `resp-${++this.counter}`; this.emit('responseStarted', this.activeId); }
  cancelResponse(): void {}
  sendToolResult(_callId: string, _result: unknown): void {}
  injectContextNote(_text: string): void {}
  close(): void {}
  done(): void { const id = this.activeId!; this.activeId = null; this.emit('responseDone', id); }
}

const ctx = { ownerId: 'owner-1', agentId: 'agent-1', characterId: 'xiaonuan' as const, firstMeet: false };

async function startedWith(logger: ReturnType<typeof captureLogger>['logger']) {
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
    logger,
  }, ctx, 'sess-1');
  await session.start(transport);
  return { adapter, session };
}

describe('session logging', () => {
  it('binds sid, short oid and character to every session line, and seq to reply lines', async () => {
    const cap = captureLogger();
    const { adapter, session } = await startedWith(cap.logger);
    adapter.done();
    session.handleClientMessage({ type: 'playback.stopped', responseSeq: 1, playedMs: 300, reason: 'ended' });
    session.end();
    const bound = { sid: 'sess-1', oid: ownerShortId('owner-1'), char: 'xiaonuan' };
    expect(cap.lines.length).toBeGreaterThan(0);
    for (const line of cap.lines) expect(line.binding).toMatchObject(bound);
    expect(cap.events('response_start')).toEqual([expect.objectContaining({ level: 'info', binding: { ...bound, seq: 1 }, fields: { kind: 'greeting' } })]);
    const metrics = cap.events('reply_metrics');
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.binding.seq).toBe(1);
    expect(metrics[0]!.fields).not.toHaveProperty('seq');
    expect(metrics[0]!.fields).toHaveProperty('reply_chars');
  });

  it('logs upstream errors at the level of their class, with the request id', async () => {
    const cap = captureLogger();
    const { adapter, session } = await startedWith(cap.logger);
    adapter.emit('error', 'qwen_session_rejected', false, { requestId: 'evt-1' });
    expect(cap.events('upstream_error').map((l) => [l.level, l.fields])).toEqual([
      ['error', { source: 'realtime', code: 'qwen_session_rejected', class: 'fatal', upstream_request_id: 'evt-1' }],
    ]);
    expect(cap.events('adapter_error')).toEqual([]);
    session.end();
  });

  it('builds the binding from the session context only', () => {
    expect(sessionLogBinding('s', { characterId: 'xiaokai' })).toEqual({ sid: 's', char: 'xiaokai' });
    expect(sessionLogBinding('s', { ownerId: 'o', characterId: 'xiaokai' })).toEqual({ sid: 's', oid: ownerShortId('o'), char: 'xiaokai' });
  });
});

describe('manager logging', () => {
  it('binds the session to its create and destroy lines', () => {
    const cap = captureLogger();
    const stub = { flush() {}, end() {} } as unknown as Session;
    const manager = new SessionManager(() => stub, 60_000, 300_000, 10_000, undefined, cap.logger);
    const { sessionId } = manager.create(ctx);
    manager.end(sessionId);
    const bound = { sid: sessionId, oid: ownerShortId('owner-1'), char: 'xiaonuan' };
    expect(cap.events('session_created')).toEqual([expect.objectContaining({ level: 'info', binding: bound, fields: { sessions: 1 } })]);
    expect(cap.events('session_destroyed')).toEqual([expect.objectContaining({ level: 'info', binding: bound, fields: { reason: 'client_end', sessions: 0 } })]);
  });
});

describe('policy logging', () => {
  it('logs through the injected logger with levels by class', async () => {
    const cap = captureLogger();
    const spec = { timeoutMs: 1_000, retries: 1, backoffMs: 0, maxBackoffMs: 0 };
    await runWithPolicy('t', spec, async () => { throw new Error('upstream_busy'); }, { sleep: async () => {}, logger: cap.logger });
    await runWithPolicy('t', spec, async () => { throw new Error('bad_request'); }, { classify: () => 'fatal', logger: cap.logger });
    await runWithPolicy('t', spec, async () => { throw new Error('duplicate'); }, { classify: () => 'ignorable', logger: cap.logger });
    expect(cap.lines.map((l) => [l.level, l.event])).toEqual([
      ['warn', 'policy_retry'],
      ['warn', 'policy_failed'],
      ['error', 'policy_failed'],
      ['info', 'policy_ignored'],
    ]);
  });
});
