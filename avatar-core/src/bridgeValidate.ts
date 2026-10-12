import type { FromFlutter } from './bridge.ts';

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
      const { gatewayUrl, appSecret, audioPath, echo } = raw;
      if (!isAllowedGatewayUrl(gatewayUrl)) return null;
      if (typeof appSecret !== 'string' || appSecret.length === 0 || appSecret.length > MAX_APP_SECRET_LEN) return null;
      if (typeof audioPath !== 'string' || !AUDIO_PATHS.includes(audioPath)) return null;
      if (echo !== undefined && (typeof echo !== 'string' || !ECHO_MODES.includes(echo))) return null;
      return { type: 'config', gatewayUrl, appSecret, audioPath: audioPath as 'A' | 'B', echo: echo as 'true' | 'all' | undefined };
    }
    case 'mute':
      return typeof raw.muted === 'boolean' ? { type: 'mute', muted: raw.muted } : null;
    case 'end':
      return { type: 'end' };
    case 'debugText':
      return typeof raw.text === 'string' && raw.text.length <= MAX_DEBUG_TEXT_LEN ? { type: 'debugText', text: raw.text } : null;
    default:
      return null;
  }
}
