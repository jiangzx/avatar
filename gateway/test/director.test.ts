import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseKind } from '@anyidea/protocol';
import { Director, type DirectorConfig } from '../src/session/director.ts';

const cfg: DirectorConfig = {
  followupAfterMs: 8000,
  idleNoticeAfterMs: 25000,
  maxConsecutive: 2,
  maxPerWindow: 3,
  windowMs: 300000,
  quietPhrases: ['别说了'],
  greetingInstruction: 'G',
  greetingText: 'greeting',
  followupInstruction: 'F',
  followupText: 'followup',
  idleNoticeInstruction: 'I',
  idleNoticeText: 'idle',
  resumeInstruction: 'R',
  resumeText: 'resume',
};

function make(c: DirectorConfig = cfg) {
  const calls: Array<[ResponseKind, string]> = [];
  const d = new Director(c, { requestResponse: (k, i) => calls.push([k, i]) });
  return { d, calls };
}

describe('Director', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('greets on session start', () => {
    const { d, calls } = make();
    d.onSessionStart();
    expect(calls).toEqual([['greeting', 'G']]);
  });

  it('follows up once, then posts an idle notice, then stays quiet', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(7999);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([['followup', 'F']]);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(25000);
    expect(calls).toEqual([['followup', 'F'], ['followup', 'I']]);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    expect(calls).toHaveLength(2);
  });

  it('user activity cancels the timer and resets the sequence', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(5000);
    d.onUserActivity();
    vi.advanceTimersByTime(10000);
    expect(calls).toEqual([]);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(8000);
    expect(calls).toEqual([['followup', 'F']]);
  });

  it('never fires while the user is speaking', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(1000);
    d.onUserSpeech(true);
    d.onAiTurnEnded(); // e.g. a short reply ended while user keeps talking
    vi.advanceTimersByTime(30000);
    expect(calls).toEqual([]);
    d.onUserSpeech(false);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(8000);
    expect(calls).toEqual([['followup', 'F']]);
  });

  it('stops following up after a quiet phrase', () => {
    const { d, calls } = make();
    d.onUserFinal('你先别说了好吗');
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
  });

  it('respects the per-window limit', () => {
    const { d, calls } = make({ ...cfg, maxConsecutive: 10, maxPerWindow: 2, idleNoticeAfterMs: 8000 });
    for (let i = 0; i < 4; i++) {
      d.onAiTurnEnded();
      vi.advanceTimersByTime(8000);
    }
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(300000);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(8000);
    expect(calls).toHaveLength(3);
  });

  it('is silent while muted or paused, and announces on resume', () => {
    const { d, calls } = make();
    d.setMuted(true);
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    d.setMuted(false);
    d.pause();
    d.onAiTurnEnded();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
    d.resume();
    expect(calls).toEqual([['followup', 'R']]);
  });

  it('follows up when the user goes quiet and no reply starts (e.g. a false interruption)', () => {
    const { d, calls } = make();
    d.onUserSpeech(true);
    d.onUserSpeech(false);
    vi.advanceTimersByTime(8000);
    expect(calls).toEqual([['followup', 'F']]);
  });

  it('a starting AI turn cancels the pending follow-up', () => {
    const { d, calls } = make();
    d.onUserSpeech(true);
    d.onUserSpeech(false);
    vi.advanceTimersByTime(1500);
    d.onAiTurnStarted();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
  });

  it('does not announce the resume line after a quiet request', () => {
    const { d, calls } = make();
    d.onUserFinal('别说了');
    d.pause();
    d.resume();
    expect(calls).toEqual([]);
  });

  it('applies the per-window limit to resume announcements', () => {
    const { d, calls } = make({ ...cfg, maxPerWindow: 1 });
    d.pause();
    d.resume();
    d.pause();
    d.resume();
    expect(calls).toEqual([['followup', 'R']]);
  });

  it('does nothing after stop', () => {
    const { d, calls } = make();
    d.onAiTurnEnded();
    d.stop();
    vi.advanceTimersByTime(60000);
    expect(calls).toEqual([]);
  });
});
