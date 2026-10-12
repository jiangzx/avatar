export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type AvatarInput =
  | 'userSpeechStart'
  | 'userSpeechEnd'
  | 'firstAudio'
  | 'playbackEnded'
  | 'interrupted'
  | 'cancelled'
  | 'thinkingTimeout';

export function nextState(state: AvatarState, input: AvatarInput): AvatarState {
  switch (input) {
    case 'userSpeechStart':
    case 'interrupted':
      return 'listening';
    case 'userSpeechEnd':
      return state === 'listening' ? 'thinking' : state;
    case 'firstAudio':
      return 'speaking';
    case 'playbackEnded':
      return state === 'speaking' ? 'idle' : state;
    case 'cancelled':
      return state === 'speaking' || state === 'thinking' ? 'idle' : state;
    case 'thinkingTimeout':
      return state === 'thinking' ? 'idle' : state;
  }
}
