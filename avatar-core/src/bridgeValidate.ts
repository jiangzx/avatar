import { ACTION_NAMES } from '@anyidea/protocol';
import type { FromFlutter, NativeViewEvent } from './bridge.ts';

/** Gateway hosts the WebView may talk to (dev/loopback/LAN only). Plan 2 adds the cloud host. */
export const GATEWAY_HOST_ALLOWLIST = {
  hosts: ['127.0.0.1', 'localhost', '10.0.2.2'],
  cidrs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
} as const; // TUNABLE
export const MAX_APP_SECRET_LEN = 256; // TUNABLE
export const MAX_DEBUG_TEXT_LEN = 500; // TUNABLE

const AUDIO_PATHS = ['A', 'B'];
const ECHO_MODES = ['true', 'all'];

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((acc, p) => acc * 256 + Number(p), 0);
}

function inCidr(ip: number, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const b = ipv4ToInt(base!);
  if (b === null) return false;
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ip / size) === Math.floor(b / size);
}

function isAllowedGatewayUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const host = u.hostname;
  if ((GATEWAY_HOST_ALLOWLIST.hosts as readonly string[]).includes(host)) return true;
  const ip = ipv4ToInt(host);
  return ip !== null && GATEWAY_HOST_ALLOWLIST.cidrs.some((c) => inCidr(ip, c));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates an untrusted Flutter -> JS message; returns a clean copy or null (fail closed). */
export function parseFromFlutter(raw: unknown): FromFlutter | null {
  if (!isObject(raw)) return null;
  switch (raw.type) {
    case 'config': {
      const { gatewayUrl, appSecret, audioPath, echo, audioMode } = raw;
      if (!isAllowedGatewayUrl(gatewayUrl)) return null;
      if (typeof appSecret !== 'string' || appSecret.length === 0 || appSecret.length > MAX_APP_SECRET_LEN) return null;
      if (typeof audioPath !== 'string' || !AUDIO_PATHS.includes(audioPath)) return null;
      if (echo !== undefined && (typeof echo !== 'string' || !ECHO_MODES.includes(echo))) return null;
      if (audioMode !== undefined && audioMode !== 'native') return null;
      return { type: 'config', gatewayUrl, appSecret, audioPath: audioPath as 'A' | 'B', echo: echo as 'true' | 'all' | undefined, ...(audioMode === 'native' ? { audioMode } : {}) };
    }
    case 'mute':
      return typeof raw.muted === 'boolean' ? { type: 'mute', muted: raw.muted } : null;
    case 'end':
      return { type: 'end' };
    case 'debugText':
      return typeof raw.text === 'string' && raw.text.length <= MAX_DEBUG_TEXT_LEN ? { type: 'debugText', text: raw.text } : null;
    case 'status':
      return typeof raw.status === 'string' ? { type: 'status', status: raw.status } : null;
    case 'state':
      return typeof raw.state === 'string' ? { type: 'state', state: raw.state as Extract<NativeViewEvent, { type: 'state' }>['state'] } : null;
    case 'subtitle':
      return (raw.role === 'user' || raw.role === 'assistant') && typeof raw.text === 'string' && typeof raw.final === 'boolean'
        ? { type: 'subtitle', role: raw.role, text: raw.text, final: raw.final }
        : null;
    case 'response.start':
      return typeof raw.responseSeq === 'number' && Number.isInteger(raw.responseSeq) && raw.responseSeq > 0 && typeof raw.kind === 'string'
        ? { type: 'response.start', responseSeq: raw.responseSeq, kind: raw.kind }
        : null;
    case 'response.end':
    case 'response.cancelled':
      return typeof raw.responseSeq === 'number' && Number.isInteger(raw.responseSeq) && raw.responseSeq > 0 && typeof raw.playedMs === 'number' && Number.isFinite(raw.playedMs) && raw.playedMs >= 0
        ? { type: raw.type as 'response.end' | 'response.cancelled', responseSeq: raw.responseSeq, playedMs: raw.playedMs }
        : null;
    case 'avatar.action':
      return typeof raw.action === 'string' && (ACTION_NAMES as readonly string[]).includes(raw.action) && typeof raw.source === 'string'
        ? { type: 'avatar.action', action: raw.action as Extract<NativeViewEvent, { type: 'avatar.action' }>['action'], source: raw.source }
        : null;
    case 'avatar.emotion':
      return typeof raw.emotion === 'string' ? { type: 'avatar.emotion', emotion: raw.emotion } : null;
    case 'audio.level':
      return typeof raw.rms === 'number' && Number.isFinite(raw.rms) && typeof raw.zcr === 'number' && Number.isFinite(raw.zcr) && typeof raw.dtMs === 'number' && Number.isFinite(raw.dtMs) && raw.dtMs > 0
        ? { type: 'audio.level', rms: raw.rms, zcr: raw.zcr, dtMs: raw.dtMs }
        : null;
    case 'metric':
      return typeof raw.name === 'string' && typeof raw.ms === 'number' && Number.isFinite(raw.ms)
        ? { type: 'metric', name: raw.name, ms: raw.ms }
        : null;
    case 'error':
      return typeof raw.code === 'string' ? { type: 'error', code: raw.code } : null;
    default:
      return null;
  }
}
