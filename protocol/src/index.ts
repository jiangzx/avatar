export const FRAME_MIC = 0x01;
export const FRAME_AI = 0x02;
export const MIC_SAMPLE_RATE = 16000;
export const AI_SAMPLE_RATE = 24000;
/** 20 ms of 16 kHz audio. */
export const MIC_FRAME_SAMPLES = 320;

export type ActionName = 'wave' | 'nod' | 'smile' | 'turn' | 'heart';
export const ACTION_NAMES: readonly ActionName[] = ['wave', 'nod', 'smile', 'turn', 'heart'];
export type ResponseKind = 'reply' | 'greeting' | 'followup';
export type AudioPath = 'A' | 'B';

export interface SessionTokens {
  sessionId: string;
  connectToken: string;
  resumeToken: string;
}

export type ClientMessage =
  | { type: 'session.start'; clientInfo: { platform: string; audioPath: AudioPath } }
  | { type: 'session.resume'; sessionId: string }
  | { type: 'vad'; state: 'speaking' | 'silent'; t: number }
  | { type: 'playback.progress'; responseSeq: number; playedMs: number }
  | { type: 'playback.stopped'; responseSeq: number; playedMs: number; reason: 'interrupted' | 'ended' }
  | { type: 'client.mute'; muted: boolean }
  | { type: 'debug.userText'; text: string }
  | { type: 'session.end' };

export type ServerMessage =
  | { type: 'session.ready'; sessionId: string }
  | { type: 'session.resumed'; lastResponseSeq: number }
  | { type: 'response.start'; responseSeq: number; kind: ResponseKind }
  | { type: 'response.end'; responseSeq: number }
  | { type: 'response.cancelled'; responseSeq: number }
  | { type: 'transcript.user'; text: string; final: boolean }
  | { type: 'transcript.assistant'; responseSeq: number; text: string }
  | { type: 'avatar.action'; action: ActionName; source: 'tool' | 'keyword' }
  | { type: 'avatar.emotion'; emotion: string }
  | { type: 'metric'; name: string; ms: number }
  | { type: 'error'; code: string; retryable: boolean };

export interface AudioFrame {
  kind: number;
  responseSeq: number;
  pcm: Int16Array;
}

const HEADER_BYTES = 5;

export function encodeAudioFrame(kind: number, responseSeq: number, pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + pcm.length * 2);
  const view = new DataView(out.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, responseSeq >>> 0, false);
  for (let i = 0; i < pcm.length; i++) view.setInt16(HEADER_BYTES + i * 2, pcm[i], true);
  return out;
}

export function decodeAudioFrame(buf: Uint8Array): AudioFrame | null {
  if (buf.byteLength < HEADER_BYTES || (buf.byteLength - HEADER_BYTES) % 2 !== 0) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const kind = view.getUint8(0);
  if (kind !== FRAME_MIC && kind !== FRAME_AI) return null;
  const responseSeq = view.getUint32(1, false);
  const n = (buf.byteLength - HEADER_BYTES) / 2;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = view.getInt16(HEADER_BYTES + i * 2, true);
  return { kind, responseSeq, pcm };
}

/**
 * Approximates the part of an assistant reply the user actually heard:
 * text received so far × (played audio / received audio).
 */
export function truncateByPlayback(text: string, playedMs: number, receivedAudioMs: number): string {
  if (receivedAudioMs <= 0 || playedMs <= 0) return '';
  const ratio = Math.min(1, playedMs / receivedAudioMs);
  return text.slice(0, Math.round(text.length * ratio));
}
