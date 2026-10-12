import type { ActionName, AudioPath } from '@anyidea/protocol';
import type { EchoMode } from './audio/capture.ts';
import type { AvatarState } from './avatar/stateMachine.ts';

export type ToFlutter =
  | { type: 'ready' }
  | { type: 'subtitle'; role: 'user' | 'assistant'; text: string; final: boolean }
  | { type: 'state'; state: AvatarState }
  | { type: 'metric'; name: string; ms: number }
  | { type: 'status'; status: string }
  | { type: 'diag'; key: string; value: string }
  | { type: 'error'; code: string };

export type NativeViewEvent =
  | { type: 'status'; status: string }
  | { type: 'state'; state: AvatarState }
  | { type: 'subtitle'; role: 'user' | 'assistant'; text: string; final: boolean }
  | { type: 'response.start'; responseSeq: number; kind: string }
  | { type: 'response.end'; responseSeq: number; playedMs: number }
  | { type: 'response.cancelled'; responseSeq: number; playedMs: number }
  | { type: 'avatar.action'; action: ActionName; source: string }
  | { type: 'avatar.emotion'; emotion: string }
  | { type: 'audio.level'; rms: number; zcr: number; dtMs: number }
  | { type: 'metric'; name: string; ms: number }
  | { type: 'error'; code: string };

export type FromFlutter =
  | { type: 'config'; gatewayUrl: string; appSecret: string; audioPath: AudioPath; echo?: EchoMode; audioMode?: 'native' }
  | { type: 'mute'; muted: boolean }
  | { type: 'end' }
  | { type: 'debugText'; text: string }
  | NativeViewEvent;

declare global {
  interface Window {
    FlutterBridge?: { postMessage(message: string): void };
    avatarBridge?: { receive(message: FromFlutter): void };
  }
}

type DevSink = (m: ToFlutter) => void;
let devSink: DevSink | null = null;

export const hasFlutter = (): boolean => typeof window.FlutterBridge?.postMessage === 'function';

export function postToFlutter(m: ToFlutter): void {
  if (window.FlutterBridge) window.FlutterBridge.postMessage(JSON.stringify(m));
  else devSink?.(m);
}

export function onFlutterMessage(handler: (m: FromFlutter) => void): void {
  window.avatarBridge = { receive: handler };
}

/** Desktop debugging: mirror bridge output into the page. */
export function setDevSink(sink: DevSink): void {
  devSink = sink;
}
