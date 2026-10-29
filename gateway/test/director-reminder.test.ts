import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { ResponseKind } from '@anyidea/protocol';
import { loadDirectorConfig } from '../src/config.ts';
import type { ProactiveRequest } from '../src/adapters/types.ts';
import { Director, type DirectorDeps, type SilenceContext } from '../src/session/director.ts';

const base = loadDirectorConfig(
  fileURLToPath(new URL('../roles/elder-companion/zh/director.json', import.meta.url)),
);
const cfg = {
  ...base,
  contextInstruction: 'READ {continuation}',
  contextAfterMs: 6_000,
  checkAfterMs: 8_000,
  leaveAfterMs: 10_000,
  checkinAfterMs: 10_000,
  restAfterMs: 180_000,
};
const reminder: ProactiveRequest = { cue: 'restReminder', instruction: '请直接说下面这句话，不要改写：R', fallbackText: 'R' };

function setup(opts: { planner?: DirectorDeps['planProactiveLine']; withReminder?: boolean } = {}) {
  const calls: Array<{ kind: ResponseKind; request: ProactiveRequest }> = [];
  const d = new Director(cfg, {
    requestResponse: (kind, request) => { calls.push({ kind, request }); },
    ...(opts.withReminder === false ? {} : { restReminderRequest: () => reminder }),
    ...(opts.planner ? { planProactiveLine: opts.planner } : {}),
  });
  /** A real exchange: the ladder then waits for its context step. */
  const answer = () => {
    d.onUserFinal('今天走了很多路，脚有点酸。');
    d.onAiTurnStarted();
    d.onAiTurnEnded('今天走了不少地方。');
  };
  const reminders = () => calls.filter((call) => call.request.cue === 'restReminder');
  return { d, calls, answer, reminders };
}

describe('rest reminder in the Director', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('takes the slot of the waiting silence step, then restarts the chain from context', async () => {
    const s = setup();
    s.answer();
    s.d.onRestReminderDue();
    expect(s.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.calls).toEqual([{ kind: 'reminder', request: reminder }]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('R');
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.calls[1]!.request.fallbackText).toBe(cfg.contextText);
    s.d.stop();
  });

  it('counts as the last assistant line for the planner, but never as a previous ladder text', async () => {
    const contexts: SilenceContext[] = [];
    const s = setup({ planner: (context) => { contexts.push(context); return null; } });
    s.answer();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded(cfg.contextText);
    s.d.onRestReminderDue(); // the check step is waiting: the reminder takes it
    await vi.advanceTimersByTimeAsync(cfg.checkAfterMs);
    expect(s.calls.at(-1)).toEqual({ kind: 'reminder', request: reminder });
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('R');
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    const last = contexts.at(-1)!;
    expect(last.stage).toBe('context');
    expect(last.assistantText).toBe('R');
    expect(last.previousTexts).toContain(cfg.contextText);
    expect(last.previousTexts).not.toContain('R');
    s.d.stop();
  });

  it('waits while a reply is playing, then speaks in the next gap', async () => {
    const s = setup();
    s.answer();
    s.d.onAiTurnStarted();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.reminders()).toEqual([]);
    s.d.onAiTurnEnded('今天天气不错。');
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(1);
    s.d.stop();
  });

  it('waits while the user is speaking', async () => {
    const s = setup();
    s.answer();
    s.d.onUserSpeech(true);
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.reminders()).toEqual([]);
    s.d.onUserSpeech(false);
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(1);
    s.d.stop();
  });

  it('waits through a tool turn (paused) and speaks after the release', async () => {
    const s = setup();
    s.answer();
    s.d.pause();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.reminders()).toEqual([]);
    s.d.releasePause(true);
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(1);
    s.d.stop();
  });

  it('speaks at once when the chain is quiet, and stays quiet afterwards', async () => {
    const s = setup();
    const quiet = cfg.quietPhrases[0];
    expect(quiet).toBeTruthy();
    s.answer();
    s.d.onUserFinal(quiet!);
    s.d.onRestReminderDue();
    expect(s.calls).toEqual([{ kind: 'reminder', request: reminder }]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('R');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.calls).toHaveLength(1);
    s.d.stop();
  });

  it('owes a refused reminder again and retries at the next slot', async () => {
    const s = setup();
    s.answer();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(1);
    s.d.onReminderMissed(); // the session refused it (a reply was still live)
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(2);
    s.d.stop();
  });

  it('does not repeat a reminder the user cut off', async () => {
    const s = setup();
    s.answer();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    s.d.onAiTurnStarted();
    s.d.onUserSpeech(true);
    s.d.onAssistantInterrupted();
    s.d.onUserSpeech(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.reminders()).toHaveLength(1);
    s.d.stop();
  });

  it('never speaks before the opening has played', async () => {
    const s = setup();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.calls).toEqual([]);
    s.d.onAiTurnStarted();
    s.d.onAiTurnEnded('greeting');
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toHaveLength(1);
    s.d.stop();
  });

  it('is a no-op without a reminder source', async () => {
    const s = setup({ withReminder: false });
    s.answer();
    s.d.onRestReminderDue();
    await vi.advanceTimersByTimeAsync(cfg.contextAfterMs);
    expect(s.reminders()).toEqual([]);
    s.d.stop();
  });
});
