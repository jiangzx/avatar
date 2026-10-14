import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { DirectorConfig } from './session/director.ts';

export interface GatewayConfig {
  port: number;
  appSecret: string;
  adapter: 'mock' | 'seeduplex';
  seeduplexApiKey?: string;
  seeduplexEndpoint: string;
  seeduplexModel: string;
  seeduplexVoice: string;
  allowDebugText: boolean;
  devOrigins: string[];
  /** MockAdapter speech threshold (RMS, 16-bit). TUNABLE (estimate, env MOCK_SPEECH_THRESHOLD); raise if speaker echo triggers fake turns. */
  mockSpeechThreshold: number;
  /** Maximum time to initialize an upstream model session after a WS claim. */
  sessionStartTimeoutMs: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const appSecret = env.APP_SECRET ?? '';
  if (appSecret.length < 16) throw new Error('APP_SECRET must be set (at least 16 characters)');
  if (/^(change-me|same-as-)/i.test(appSecret)) throw new Error('APP_SECRET must be replaced (template placeholder)');
  const adapter = env.ADAPTER ?? 'mock';
  if (adapter !== 'mock' && adapter !== 'seeduplex') throw new Error(`Unsupported ADAPTER \"${adapter}\"`);
  const seeduplexApiKey = env.SEEDUPLEX_API_KEY;
  if (adapter === 'seeduplex' && !seeduplexApiKey) throw new Error('SEEDUPLEX_API_KEY must be set when ADAPTER=seeduplex');
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PORT must be a valid port number');
  const mockSpeechThreshold = Number(env.MOCK_SPEECH_THRESHOLD ?? 800);
  if (!Number.isInteger(mockSpeechThreshold) || mockSpeechThreshold < 100 || mockSpeechThreshold > 20000) {
    throw new Error('MOCK_SPEECH_THRESHOLD must be an integer between 100 and 20000');
  }
  const sessionStartTimeoutMs = Number(env.SESSION_START_TIMEOUT_MS ?? 10_000);
  if (!Number.isInteger(sessionStartTimeoutMs) || sessionStartTimeoutMs < 100 || sessionStartTimeoutMs > 120_000) {
    throw new Error('SESSION_START_TIMEOUT_MS must be an integer between 100 and 120000');
  }
  return {
    port,
    appSecret,
    adapter,
    ...(seeduplexApiKey ? { seeduplexApiKey } : {}),
    seeduplexEndpoint: env.SEEDUPLEX_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue',
    seeduplexModel: env.SEEDUPLEX_MODEL ?? '1.2.6.1',
    seeduplexVoice: env.SEEDUPLEX_VOICE ?? 'zh_male_xiaotian_jupiter_bigtts',
    allowDebugText: env.ALLOW_DEBUG_TEXT === '1',
    devOrigins: (env.DEV_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    mockSpeechThreshold,
    sessionStartTimeoutMs,
  };
}

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export function makeOriginCheck(devOrigins: string[]): (origin: string) => boolean {
  return (origin) => LOOPBACK_ORIGIN.test(origin) || devOrigins.includes(origin);
}

const DirectorSchema = z.object({
  followupAfterMs: z.number().int().positive(),
  idleNoticeAfterMs: z.number().int().positive(),
  maxConsecutive: z.number().int().min(0),
  maxPerWindow: z.number().int().min(0),
  windowMs: z.number().int().positive(),
  quietPhrases: z.array(z.string().min(1)),
  greetingInstruction: z.string().min(1),
  followupInstruction: z.string().min(1),
  idleNoticeInstruction: z.string().min(1),
  resumeInstruction: z.string().min(1),
});

export function loadDirectorConfig(path: string): DirectorConfig {
  return DirectorSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadPersona(path: string): string {
  return readFileSync(path, 'utf8');
}
