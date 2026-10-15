import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { DirectorConfig } from './session/director.ts';
import type { LedgerOptions } from './session/ledger.ts';

export interface GatewayConfig {
  port: number;
  appSecret: string;
  adapter: 'mock' | 'seeduplex' | 'qwen';
  seeduplexApiKey?: string;
  seeduplexEndpoint: string;
  seeduplexModel: string;
  seeduplexVoice: string;
  qwenApiKey?: string;
  qwenEndpoint: string;
  qwenModel: string;
  qwenVoice: string;
  summarizer: 'mock' | 'qwen';
  summarizerEndpoint: string;
  summarizerModel: string;
  allowDebugText: boolean;
  devOrigins: string[];
  /** MockAdapter speech threshold (RMS, 16-bit). TUNABLE (estimate, env MOCK_SPEECH_THRESHOLD); raise if speaker echo triggers fake turns. */
  mockSpeechThreshold: number;
  /** MockAdapter playback speed multiplier. TUNABLE (env MOCK_PACE_FACTOR). */
  mockPaceFactor: number;
  /** Maximum time to initialize an upstream model session after a WS claim. */
  sessionStartTimeoutMs: number;
  confirmWindowMs: number;
  ledger: LedgerOptions;
  sessionGraceMs: number;
  sessionUnclaimedMs: number;
  wsHeartbeatMs: number;
  wsMaxFramesPerSecond: number;
  maxSessions: number;
  sessionRateLimitMax: number;
  sessionRateLimitWindowMs: number;
  rebuildBackoffBaseMs: number;
  rebuildBackoffMaxMs: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const appSecret = env.APP_SECRET ?? '';
  if (appSecret.length < 16) throw new Error('APP_SECRET must be set (at least 16 characters)');
  if (/^(change-me|same-as-)/i.test(appSecret)) throw new Error('APP_SECRET must be replaced (template placeholder)');
  const adapter = env.ADAPTER ?? 'mock';
  if (adapter !== 'mock' && adapter !== 'seeduplex' && adapter !== 'qwen') throw new Error(`Unsupported ADAPTER \"${adapter}\"`);
  const seeduplexApiKey = env.SEEDUPLEX_API_KEY;
  if (adapter === 'seeduplex' && !seeduplexApiKey) throw new Error('SEEDUPLEX_API_KEY must be set when ADAPTER=seeduplex');
  const qwenApiKey = env.DASHSCOPE_API_KEY;
  if (adapter === 'qwen' && !qwenApiKey) throw new Error('DASHSCOPE_API_KEY must be set when ADAPTER=qwen');
  if (adapter === 'qwen' && !env.QWEN_ENDPOINT) throw new Error('QWEN_ENDPOINT must be set when ADAPTER=qwen');
  const summarizer = env.SUMMARIZER ?? 'mock';
  if (summarizer !== 'mock' && summarizer !== 'qwen') throw new Error(`Unsupported SUMMARIZER \"${summarizer}\"`);
  if (summarizer === 'qwen' && !qwenApiKey) throw new Error('DASHSCOPE_API_KEY must be set when SUMMARIZER=qwen');
  if (summarizer === 'qwen' && !env.QWEN_SUMMARIZER_ENDPOINT) throw new Error('QWEN_SUMMARIZER_ENDPOINT must be set when SUMMARIZER=qwen');
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PORT must be a valid port number');
  const mockSpeechThreshold = Number(env.MOCK_SPEECH_THRESHOLD ?? 800);
  if (!Number.isInteger(mockSpeechThreshold) || mockSpeechThreshold < 100 || mockSpeechThreshold > 20000) {
    throw new Error('MOCK_SPEECH_THRESHOLD must be an integer between 100 and 20000');
  }
  const mockPaceFactor = Number(env.MOCK_PACE_FACTOR ?? 2);
  if (!Number.isFinite(mockPaceFactor) || mockPaceFactor <= 0 || mockPaceFactor > 4) {
    throw new Error('MOCK_PACE_FACTOR must be a number greater than 0 and at most 4');
  }
  const sessionStartTimeoutMs = Number(env.SESSION_START_TIMEOUT_MS ?? 10_000);
  if (!Number.isInteger(sessionStartTimeoutMs) || sessionStartTimeoutMs < 100 || sessionStartTimeoutMs > 120_000) {
    throw new Error('SESSION_START_TIMEOUT_MS must be an integer between 100 and 120000');
  }
  const confirmWindowMs = integerEnv(env, 'CONFIRM_WINDOW_MS', 300, 50, 5_000);
  const ledger = {
    keepRecentTurns: integerEnv(env, 'LEDGER_KEEP_RECENT_TURNS', 8, 1, 100),
    summarizeAfterTurns: integerEnv(env, 'LEDGER_SUMMARIZE_AFTER_TURNS', 16, 1, 200),
    summarizeAfterTokens: integerEnv(env, 'LEDGER_SUMMARIZE_AFTER_TOKENS', 6_000, 100, 100_000),
  };
  const sessionGraceMs = integerEnv(env, 'SESSION_GRACE_MS', 60_000, 100, 10 * 60_000);
  const sessionUnclaimedMs = integerEnv(env, 'SESSION_UNCLAIMED_MS', 5 * 60_000, 100, 30 * 60_000);
  const wsHeartbeatMs = integerEnv(env, 'WS_HEARTBEAT_MS', 10_000, 100, 5 * 60_000);
  const wsMaxFramesPerSecond = integerEnv(env, 'WS_MAX_FRAMES_PER_SECOND', 100, 1, 500);
  const maxSessions = integerEnv(env, 'MAX_SESSIONS', 100, 1, 10_000);
  const sessionRateLimitMax = integerEnv(env, 'SESSION_RATE_LIMIT_MAX', 10, 1, 1_000);
  const sessionRateLimitWindowMs = integerEnv(env, 'SESSION_RATE_LIMIT_WINDOW_MS', 60_000, 100, 60 * 60_000);
  const rebuildBackoffBaseMs = integerEnv(env, 'REBUILD_BACKOFF_BASE_MS', 1_000, 100, 60_000);
  const rebuildBackoffMaxMs = integerEnv(env, 'REBUILD_BACKOFF_MAX_MS', 8_000, 100, 10 * 60_000);
  if (rebuildBackoffMaxMs < rebuildBackoffBaseMs) throw new Error('REBUILD_BACKOFF_MAX_MS must be at least REBUILD_BACKOFF_BASE_MS');
  return {
    port,
    appSecret,
    adapter,
    ...(seeduplexApiKey ? { seeduplexApiKey } : {}),
    seeduplexEndpoint: env.SEEDUPLEX_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue',
    seeduplexModel: env.SEEDUPLEX_MODEL ?? '1.2.6.1',
    seeduplexVoice: env.SEEDUPLEX_VOICE ?? 'zh_male_xiaotian_jupiter_bigtts',
    ...(qwenApiKey ? { qwenApiKey } : {}),
    qwenEndpoint: env.QWEN_ENDPOINT ?? '',
    qwenModel: env.QWEN_MODEL ?? 'qwen3.8-omni-flash-realtime',
    qwenVoice: env.QWEN_VOICE ?? 'longanlingxin',
    summarizer,
    summarizerEndpoint: env.QWEN_SUMMARIZER_ENDPOINT ?? '',
    summarizerModel: env.QWEN_SUMMARIZER_MODEL ?? 'qwen-flash',
    allowDebugText: env.ALLOW_DEBUG_TEXT === '1',
    devOrigins: (env.DEV_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    mockSpeechThreshold,
    mockPaceFactor,
    sessionStartTimeoutMs,
    confirmWindowMs,
    ledger,
    sessionGraceMs,
    sessionUnclaimedMs,
    wsHeartbeatMs,
    wsMaxFramesPerSecond,
    maxSessions,
    sessionRateLimitMax,
    sessionRateLimitWindowMs,
    rebuildBackoffBaseMs,
    rebuildBackoffMaxMs,
  };
}

function integerEnv(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  return value;
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
  greetingText: z.string().min(1),
  followupInstruction: z.string().min(1),
  followupText: z.string().min(1),
  idleNoticeInstruction: z.string().min(1),
  idleNoticeText: z.string().min(1),
  resumeInstruction: z.string().min(1),
  resumeText: z.string().min(1),
});

export function loadDirectorConfig(path: string): DirectorConfig {
  return DirectorSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadPersona(path: string): string {
  return readFileSync(path, 'utf8');
}
