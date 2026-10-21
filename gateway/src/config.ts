import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Language } from '@anyidea/protocol';
import type { DirectorConfig } from './roles/types.ts';
import type { LedgerOptions } from './session/ledger.ts';
import { unique } from './unique.ts';

export interface GatewayConfig {
  port: number;
  appSecret: string;
  adapter: 'mock' | 'seeduplex' | 'qwen';
  seeduplexApiKey?: string;
  seeduplexEndpoint: string;
  seeduplexModel: string;
  seeduplexVoice: string;
  seeduplexVoices: Record<'zh' | 'en', string>;
  qwenApiKey?: string;
  qwenEndpoint: string;
  qwenModel: string;
  qwenVoice: string;
  qwenVoices: Record<Language, string>;
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
  resumeRateLimitMax: number;
  resumeRateLimitWindowMs: number;
  /** Trust the first X-Forwarded-For hop; only behind a proxy that overwrites it. */
  trustProxy: boolean;
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
  const seeduplexEndpoint = env.SEEDUPLEX_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
  const qwenEndpoint = env.QWEN_ENDPOINT ?? '';
  const summarizerEndpoint = env.QWEN_SUMMARIZER_ENDPOINT ?? '';
  // Fail at startup, not on the first session, for a wrong scheme or malformed URL.
  if (adapter === 'seeduplex') requireProtocol('SEEDUPLEX_ENDPOINT', seeduplexEndpoint, ['ws:', 'wss:']);
  if (adapter === 'qwen') requireProtocol('QWEN_ENDPOINT', qwenEndpoint, ['ws:', 'wss:']);
  if (summarizer === 'qwen') requireProtocol('QWEN_SUMMARIZER_ENDPOINT', summarizerEndpoint, ['http:', 'https:']);
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
  const resumeRateLimitMax = integerEnv(env, 'RESUME_RATE_LIMIT_MAX', 30, 1, 1_000);
  const resumeRateLimitWindowMs = integerEnv(env, 'RESUME_RATE_LIMIT_WINDOW_MS', 60_000, 100, 60 * 60_000);
  const trustProxy = env.TRUST_PROXY === '1';
  const rebuildBackoffBaseMs = integerEnv(env, 'REBUILD_BACKOFF_BASE_MS', 1_000, 100, 60_000);
  const rebuildBackoffMaxMs = integerEnv(env, 'REBUILD_BACKOFF_MAX_MS', 8_000, 100, 10 * 60_000);
  if (rebuildBackoffMaxMs < rebuildBackoffBaseMs) throw new Error('REBUILD_BACKOFF_MAX_MS must be at least REBUILD_BACKOFF_BASE_MS');
  const qwenVoice = env.QWEN_VOICE ?? 'longanlingxin';
  const qwenVoices: Record<Language, string> = {
    zh: env.QWEN_VOICE_ZH ?? qwenVoice,
    ja: env.QWEN_VOICE_JA ?? 'Tina',
    en: env.QWEN_VOICE_EN ?? 'Tina',
  };
  const seeduplexVoice = env.SEEDUPLEX_VOICE ?? 'zh_male_xiaotian_jupiter_bigtts';
  const seeduplexVoices: Record<'zh' | 'en', string> = {
    zh: env.SEEDUPLEX_VOICE_ZH ?? seeduplexVoice,
    en: env.SEEDUPLEX_VOICE_EN ?? 'en_male_tim_uranus_bigtts',
  };
  return {
    port,
    appSecret,
    adapter,
    ...(seeduplexApiKey ? { seeduplexApiKey } : {}),
    seeduplexEndpoint,
    seeduplexModel: env.SEEDUPLEX_MODEL ?? '1.2.6.1',
    seeduplexVoice: seeduplexVoices.zh,
    seeduplexVoices,
    ...(qwenApiKey ? { qwenApiKey } : {}),
    qwenEndpoint,
    qwenModel: env.QWEN_MODEL ?? 'qwen3.8-omni-flash-realtime',
    qwenVoice: qwenVoices.zh,
    qwenVoices,
    summarizer,
    summarizerEndpoint,
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
    resumeRateLimitMax,
    resumeRateLimitWindowMs,
    trustProxy,
    rebuildBackoffBaseMs,
    rebuildBackoffMaxMs,
  };
}

function requireProtocol(key: string, value: string, protocols: readonly string[]): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${key} must use ${protocols.join(' or ')}`);
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
  silenceDecision: z.object({
    instruction: z.string().min(1),
    speakInstruction: z.string().includes('{continuation}'),
    maxTokens: z.number().int().min(32).max(512),
    maxInputChars: z.number().int().min(100).max(20000),
    maxReplyChars: z.number().int().min(1).max(120),
    temperature: z.number().min(0).max(2),
    variationHints: z.object({
      greeting: z.array(z.string().min(1)).min(1).optional(),
      checkin: z.array(z.string().min(1)).min(1).optional(),
    }).strict().optional(),
    /** Localized prefix for a variation hint; required whenever variationHints is present. */
    variationHintLabel: z.string().min(1).optional(),
    policy: z.object({
      timeoutMs: z.number().int().min(100).max(10000),
      retries: z.literal(0),
      backoffMs: z.literal(0),
      maxBackoffMs: z.literal(0),
    }).strict(),
  }).strict()
    .refine(c => c.maxReplyChars <= c.maxInputChars, { message: 'silence_reply_exceeds_input_budget' })
    .refine(c => c.variationHints === undefined || c.variationHintLabel !== undefined, { message: 'silence_variation_hint_label_missing' })
    .optional(),
  followupAfterMs: z.number().int().positive(),
  idleNoticeAfterMs: z.number().int().positive(),
  maxConsecutive: z.number().int().min(0),
  maxPerWindow: z.number().int().min(0),
  windowMs: z.number().int().positive(),
  companyAfterMs: z.number().int().positive().optional(),
  /** Role catalogs require `{topic}` here; the shared schema only checks the shape is present. */
  topicInstruction: z.string().optional(),
  contextAfterMs: z.number().int().positive().optional(),
  checkAfterMs: z.number().int().positive().optional(),
  leaveAfterMs: z.number().int().positive().optional(),
  checkinAfterMs: z.number().int().positive().optional(),
  restAfterMs: z.number().int().positive().optional(),
  contextInstruction: z.string().min(1).optional(),
  /** Spoken step 1 fallback when the judged continuation is declined. */
  contextText: z.string().min(1).optional(),
  presenceInstruction: z.string().min(1).optional(),
  presenceText: z.string().min(1).optional(),
  openingFollowInstruction: z.string().min(1).optional(),
  openingFollowText: z.string().min(1).optional(),
  memoryFollowText: z.string().min(1).optional(),
  bargeMissInstruction: z.string().min(1).optional(),
  bargeMissText: z.string().min(1).optional(),
  checkInstruction: z.string().min(1).optional(),
  checkText: z.string().min(1).optional(),
  checkContextInstruction: z.string().min(1).optional(),
  checkContextText: z.string().min(1).optional(),
  checkMemoryInstruction: z.string().min(1).optional(),
  checkMemoryText: z.string().min(1).optional(),
  leaveInstruction: z.string().min(1).optional(),
  leaveText: z.string().min(1).optional(),
  checkinInstruction: z.string().min(1).optional(),
  checkinText: z.string().min(1).optional(),
  restInstruction: z.string().min(1).optional(),
  restText: z.string().min(1).optional(),
  lightPhrases: z.array(z.string().min(1)).optional(),
  quietPhrases: z.array(z.string().min(1)),
  greetingInstruction: z.string().min(1),
  greetingText: z.string().min(1),
  /** Opening when a memory snapshot exists. Falls back to the plain greeting. */
  greetingMemoryInstruction: z.string().min(1).optional(),
  greetingMemoryText: z.string().min(1).optional(),
  greetingNameTexts: z.array(z.string().min(1).includes('{name}')).min(1).max(5).optional(),
  /** Retry the opening after it is cut off and the user is already quiet. */
  greetingRetryMs: z.number().int().positive().optional(),
  followupInstruction: z.string().min(1),
  followupText: z.string().min(1),
  idleNoticeInstruction: z.string().min(1),
  idleNoticeText: z.string().min(1),
  resumeInstruction: z.string().min(1),
  resumeText: z.string().min(1),
  toolContinueInstruction: z.string().min(1),
  toolContinueText: z.string().min(1),
  memoryNoticeInstruction: z.string().min(1),
  memoryNoticeText: z.string().min(1),
}).strict();

export function loadDirectorConfig(path: string): DirectorConfig {
  return DirectorSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Device identity and memory store settings (Plan 3 B). Env only; never in files. */
export interface IdentityConfig {
  /** Absolute path outside the repo, or ':memory:'. Undefined = identity disabled (dev mode). */
  memoryDbPath?: string;
  busyTimeoutMs: number;
  maxOwners: number;
  /** Rolling 24 h cap on new owners. */
  registerDailyCap: number;
  registerRateLimitMax: number;
  registerRateLimitWindowMs: number;
  /** Owners that registered but never started a session are deleted after this many days. */
  orphanOwnerDays: number;
  orphanCleanupBatch: number;
  enableDevEndpoints: boolean;
  /** Present only when enableDevEndpoints. */
  devToken?: string;
}

const envInt = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

const IdentityEnvSchema = z.object({
  MEMORY_DB_PATH: z.string().min(1).optional(),
  MEMORY_DB_BUSY_TIMEOUT_MS: envInt(100, 60_000, 5_000),
  MAX_OWNERS: envInt(1, 100_000, 100),
  REGISTER_DAILY_CAP: envInt(1, 10_000, 20),
  REGISTER_RATE_LIMIT_MAX: envInt(1, 1_000, 5),
  REGISTER_RATE_LIMIT_WINDOW_MS: envInt(1_000, 24 * 3_600_000, 3_600_000),
  ORPHAN_OWNER_DAYS: envInt(1, 365, 7),
  ORPHAN_CLEANUP_BATCH: envInt(1, 10_000, 200),
  ENABLE_DEV_ENDPOINTS: z.enum(['0', '1']).default('0'),
  DEV_TOKEN: z.string().optional(),
});

export function loadIdentityConfig(env: Record<string, string | undefined>, repoRoot: string): IdentityConfig {
  const parsed = IdentityEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`${issue.path.join('.')}: ${issue.message}`); // zod messages do not echo input values
  }
  const e = parsed.data;
  const memoryDbPath = e.MEMORY_DB_PATH;
  if (memoryDbPath !== undefined && memoryDbPath !== ':memory:') {
    if (!isAbsolute(memoryDbPath)) throw new Error('MEMORY_DB_PATH must be an absolute path');
    const root = resolve(repoRoot);
    const target = resolve(memoryDbPath);
    if (target === root || target.startsWith(root + sep)) throw new Error('MEMORY_DB_PATH must be outside the repository');
  }
  const enableDevEndpoints = e.ENABLE_DEV_ENDPOINTS === '1';
  const devToken = e.DEV_TOKEN;
  if (enableDevEndpoints) {
    if (!devToken || devToken.length < 24) throw new Error('DEV_TOKEN must be set (at least 24 characters) when ENABLE_DEV_ENDPOINTS=1');
    if (/^(change-me|same-as-)/i.test(devToken)) throw new Error('DEV_TOKEN must be replaced (template placeholder)');
    if (devToken === env.APP_SECRET) throw new Error('DEV_TOKEN must differ from APP_SECRET');
  }
  return {
    ...(memoryDbPath ? { memoryDbPath } : {}),
    busyTimeoutMs: e.MEMORY_DB_BUSY_TIMEOUT_MS,
    maxOwners: e.MAX_OWNERS,
    registerDailyCap: e.REGISTER_DAILY_CAP,
    registerRateLimitMax: e.REGISTER_RATE_LIMIT_MAX,
    registerRateLimitWindowMs: e.REGISTER_RATE_LIMIT_WINDOW_MS,
    orphanOwnerDays: e.ORPHAN_OWNER_DAYS,
    orphanCleanupBatch: e.ORPHAN_CLEANUP_BATCH,
    enableDevEndpoints,
    ...(enableDevEndpoints && devToken ? { devToken } : {}),
  };
}

export { DirectorSchema };

const SingleChar = z.string().regex(/^.$/u);
const DigitChar = z.string().regex(/^[0-9]$/);

/** Shared safety rules: thresholds and code points that do not depend on language. */
export interface SharedSafetyConfig {
  minMaskedDigits: number;
  chineseDigits: Record<string, string>;
  invisibleCodePoints: number[];
}

const SharedSafetyConfigSchema = z.object({
  minMaskedDigits: z.number().int().min(1).max(64),
  chineseDigits: z.record(SingleChar, DigitChar).refine((map) => Object.keys(map).length > 0, { message: 'chineseDigits must not be empty' }),
  invisibleCodePoints: z.array(z.number().int().min(0).max(0x10FFFF)).min(1),
}).strict();

/** Localized phrase lists from config/i18n/<language>/safety.json. */
export interface SafetyPhrases {
  rejectPhrases: readonly string[];
  degradePhrases: readonly string[];
  markPhrases: readonly string[];
}

/** Everything scanText needs: shared thresholds plus every language's phrases. */
export type SafetyRules = SharedSafetyConfig & SafetyPhrases;

export function loadSharedSafety(path: string): SharedSafetyConfig {
  return SharedSafetyConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Shared rules plus localized phrases. Preserves order and drops duplicates across languages. */
export function mergeSafety(shared: SharedSafetyConfig, phrases: SafetyPhrases): SafetyRules {
  return {
    minMaskedDigits: shared.minMaskedDigits,
    chineseDigits: shared.chineseDigits,
    invisibleCodePoints: shared.invisibleCodePoints,
    rejectPhrases: unique(phrases.rejectPhrases),
    degradePhrases: unique(phrases.degradePhrases),
    markPhrases: unique(phrases.markPhrases),
  };
}
