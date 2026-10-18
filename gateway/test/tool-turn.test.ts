import { describe, expect, it } from 'vitest';
import { ToolTurn } from '../src/session/toolTurn.ts';

const TIMEOUT_MS = 8_000;

function makeTurn() {
  let now = 1_000;
  const turn = new ToolTurn(() => now, TIMEOUT_MS);
  return {
    turn,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('ToolTurn', () => {
  it('is not active until start', () => {
    const { turn } = makeTurn();
    expect(turn.active).toBe(false);
    expect(turn.readyForContinuation()).toBe(false);
    turn.start(7);
    expect(turn.active).toBe(true);
    expect(turn.readyForContinuation()).toBe(false);
  });

  it('is not ready after origin done when audio was seen and playback has not ended', () => {
    const { turn } = makeTurn();
    turn.start(1);
    turn.onOriginAudio();
    turn.onOriginDone();
    expect(turn.readyForContinuation()).toBe(false);
  });

  it('is ready after origin done when no audio was seen', () => {
    const { turn } = makeTurn();
    turn.start(1);
    expect(turn.readyForContinuation()).toBe(false);
    turn.onOriginDone();
    expect(turn.readyForContinuation()).toBe(true);
  });

  it('is ready after audio, origin done, and playback ended', () => {
    const { turn } = makeTurn();
    turn.start(1);
    turn.onOriginAudio();
    turn.onOriginDone();
    expect(turn.readyForContinuation()).toBe(false);
    turn.onOriginPlaybackEnded();
    expect(turn.readyForContinuation()).toBe(true);
  });

  it('returns continuation_audio and clears active after the continuation was requested', () => {
    const { turn } = makeTurn();
    turn.start(3);
    turn.onContinuationRequested();
    expect(turn.onContinuationAudio()).toBe('continuation_audio');
    expect(turn.active).toBe(false);
    expect(turn.readyForContinuation()).toBe(false);
  });

  it('still returns continuation_audio when the continuation was marked started before audio', () => {
    const { turn } = makeTurn();
    turn.start(3);
    turn.onContinuationRequested();
    turn.onContinuationStarted();
    expect(turn.active).toBe(true);
    expect(turn.onContinuationAudio()).toBe('continuation_audio');
    expect(turn.active).toBe(false);
  });

  it('returns continuation_silent when the continuation finishes with no audio', () => {
    const { turn } = makeTurn();
    turn.start(3);
    turn.onContinuationRequested();
    turn.onContinuationStarted();
    expect(turn.onContinuationDone(false)).toBe('continuation_silent');
    expect(turn.active).toBe(false);
  });

  it('returns continuation_audio when the continuation finishes and had audio', () => {
    const { turn } = makeTurn();
    turn.start(3);
    turn.onContinuationRequested();
    expect(turn.onContinuationDone(true)).toBe('continuation_audio');
    expect(turn.active).toBe(false);
  });

  it('returns user_speaking while active and null when idle', () => {
    const { turn } = makeTurn();
    expect(turn.onUserSpeaking()).toBeNull();
    turn.start(4);
    expect(turn.onUserSpeaking()).toBe('user_speaking');
    expect(turn.active).toBe(false);
    expect(turn.onUserSpeaking()).toBeNull();
  });

  it('returns timeout from tick only after timeoutMs', () => {
    const { turn, advance } = makeTurn();
    expect(turn.tick()).toBeNull();
    turn.start(5);
    expect(turn.tick()).toBeNull();
    advance(TIMEOUT_MS - 1);
    expect(turn.tick()).toBeNull();
    expect(turn.active).toBe(true);
    advance(1);
    expect(turn.tick()).toBe('timeout');
    expect(turn.active).toBe(false);
    expect(turn.tick()).toBeNull();
  });

  it('keeps the first deadline when start is called again', () => {
    const { turn, advance } = makeTurn();
    turn.start(1);
    advance(TIMEOUT_MS - 1);
    turn.start(2);
    expect(turn.tick()).toBeNull();
    expect(turn.active).toBe(true);
    advance(1);
    expect(turn.tick()).toBe('timeout');
    expect(turn.active).toBe(false);
  });

  it('ends the turn on cancel and rebuild', () => {
    const cancelled = makeTurn().turn;
    cancelled.start(6);
    expect(cancelled.onCancel()).toBe('cancelled');
    expect(cancelled.active).toBe(false);
    expect(cancelled.onCancel()).toBeNull();

    const rebuilt = makeTurn().turn;
    rebuilt.start(7);
    expect(rebuilt.onRebuild()).toBe('rebuild');
    expect(rebuilt.active).toBe(false);
    expect(rebuilt.onRebuild()).toBeNull();
  });
});
