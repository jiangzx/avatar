import { describe, expect, it } from 'vitest';
import { nextState, type AvatarInput, type AvatarState } from '../src/avatar/stateMachine.ts';

const run = (inputs: AvatarInput[], from: AvatarState = 'idle') => inputs.reduce(nextState, from);

describe('avatar state machine', () => {
  it('follows a normal turn: listen → think → speak → idle', () => {
    expect(run(['userSpeechStart'])).toBe('listening');
    expect(run(['userSpeechStart', 'userSpeechEnd'])).toBe('thinking');
    expect(run(['userSpeechStart', 'userSpeechEnd', 'firstAudio'])).toBe('speaking');
    expect(run(['userSpeechStart', 'userSpeechEnd', 'firstAudio', 'playbackEnded'])).toBe('idle');
  });

  it('speaks proactively from idle', () => {
    expect(run(['firstAudio'])).toBe('speaking');
  });

  it('barge-in always returns to listening', () => {
    for (const s of ['idle', 'listening', 'thinking', 'speaking'] as AvatarState[]) {
      expect(nextState(s, 'interrupted')).toBe('listening');
      expect(nextState(s, 'userSpeechStart')).toBe('listening');
    }
  });

  it('cancel while the user talks keeps listening; otherwise goes idle', () => {
    expect(nextState('listening', 'cancelled')).toBe('listening');
    expect(nextState('speaking', 'cancelled')).toBe('idle');
    expect(nextState('thinking', 'cancelled')).toBe('idle');
  });

  it('ignores inputs that do not apply', () => {
    expect(nextState('idle', 'userSpeechEnd')).toBe('idle');
    expect(nextState('listening', 'playbackEnded')).toBe('listening');
    expect(nextState('speaking', 'thinkingTimeout')).toBe('speaking');
    expect(nextState('thinking', 'thinkingTimeout')).toBe('idle');
  });

  it('shows thinking while the gateway refreshes its context', () => {
    expect(nextState('idle', 'refreshStart')).toBe('thinking');
    expect(nextState('listening', 'refreshStart')).toBe('thinking');
    expect(nextState('thinking', 'refreshStart')).toBe('thinking');
    // A refresh never cuts off audio that is already playing.
    expect(nextState('speaking', 'refreshStart')).toBe('speaking');
  });

  it('leaves thinking only when the refresh confirms ready', () => {
    expect(nextState('thinking', 'refreshEnd')).toBe('idle');
    expect(nextState('idle', 'refreshEnd')).toBe('idle');
    expect(nextState('listening', 'refreshEnd')).toBe('listening');
    expect(nextState('speaking', 'refreshEnd')).toBe('speaking');
  });
});
