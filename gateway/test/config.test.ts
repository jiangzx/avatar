import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectorSchema, loadConfig, loadDirectorConfig, loadIdentityConfig, makeOriginCheck } from '../src/config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('config', () => {
  it('requires a strong APP_SECRET', () => {
    expect(() => loadConfig({ APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
  });

  it('rejects template placeholder secrets without echoing them', () => {
    for (const v of ['change-me-to-a-random-32-char-string', 'CHANGE-ME-xxxxxxxxxxxxxxxx', 'same-as-gateway-APP_SECRET']) {
      expect(() => loadConfig({ APP_SECRET: v })).toThrow(/APP_SECRET/);
      try { loadConfig({ APP_SECRET: v }); } catch (e) { expect((e as Error).message).not.toContain(v); }
    }
  });

  it('only accepts the mock adapter in Plan 1', () => {
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), ADAPTER: 'seeduplex' })).toThrow(/ADAPTER/);
  });

  it('parses defaults and dev origins', () => {
    const c = loadConfig({ APP_SECRET: 'x'.repeat(16), DEV_ORIGINS: 'http://localhost:5173, http://a.test' });
    expect(c).toEqual({ port: 8787, appSecret: 'x'.repeat(16), adapter: 'mock', seeduplexEndpoint: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', seeduplexModel: '1.2.6.1', seeduplexVoice: 'zh_male_xiaotian_jupiter_bigtts', qwenEndpoint: '', qwenModel: 'qwen3.8-omni-flash-realtime', qwenVoice: 'longanlingxin', summarizer: 'mock', summarizerEndpoint: '', summarizerModel: 'qwen-flash', allowDebugText: false, devOrigins: ['http://localhost:5173', 'http://a.test'], mockSpeechThreshold: 800, mockPaceFactor: 2, sessionStartTimeoutMs: 10000, confirmWindowMs: 300, ledger: { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6000 }, sessionGraceMs: 60000, sessionUnclaimedMs: 300000, wsHeartbeatMs: 10000, wsMaxFramesPerSecond: 100, maxSessions: 100, sessionRateLimitMax: 10, sessionRateLimitWindowMs: 60000, rebuildBackoffBaseMs: 1000, rebuildBackoffMaxMs: 8000 });
  });

  it('requires a key only when Seeduplex is explicitly selected', () => {
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), ADAPTER: 'seeduplex' })).toThrow(/SEEDUPLEX_API_KEY/);
    const c = loadConfig({ APP_SECRET: 'x'.repeat(16), ADAPTER: 'seeduplex', SEEDUPLEX_API_KEY: 'test-key', SEEDUPLEX_VOICE: 'test-voice' });
    expect(c.adapter).toBe('seeduplex');
    expect(c.seeduplexApiKey).toBe('test-key');
    expect(c.seeduplexVoice).toBe('test-voice');
  });

  it('requires Qwen endpoint and key only when Qwen is explicitly selected', () => {
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), ADAPTER: 'qwen' })).toThrow(/DASHSCOPE_API_KEY/);
    const c = loadConfig({ APP_SECRET: 'x'.repeat(16), ADAPTER: 'qwen', DASHSCOPE_API_KEY: 'test-key', QWEN_ENDPOINT: 'wss://workspace.example/realtime' });
    expect(c.adapter).toBe('qwen');
    expect(c.qwenEndpoint).toContain('workspace.example');
  });

  it('requires an explicit text endpoint only when Qwen summarizer is selected', () => {
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), SUMMARIZER: 'qwen' })).toThrow(/DASHSCOPE_API_KEY/);
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), SUMMARIZER: 'qwen', DASHSCOPE_API_KEY: 'test-key' })).toThrow(/QWEN_SUMMARIZER_ENDPOINT/);
    const c = loadConfig({ APP_SECRET: 'x'.repeat(16), SUMMARIZER: 'qwen', DASHSCOPE_API_KEY: 'test-key', QWEN_SUMMARIZER_ENDPOINT: 'https://workspace.example/compatible-mode/v1/chat/completions' });
    expect(c.summarizer).toBe('qwen');
    expect(c.summarizerModel).toBe('qwen-flash');
  });

  it('validates the mock speech threshold', () => {
    expect(loadConfig({ APP_SECRET: 'x'.repeat(16), MOCK_SPEECH_THRESHOLD: '1500' }).mockSpeechThreshold).toBe(1500);
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), MOCK_SPEECH_THRESHOLD: 'loud' })).toThrow(/MOCK_SPEECH_THRESHOLD/);
  });

  it('validates the mock playback pace factor', () => {
    expect(loadConfig({ APP_SECRET: 'x'.repeat(16), MOCK_PACE_FACTOR: '0.5' }).mockPaceFactor).toBe(0.5);
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), MOCK_PACE_FACTOR: '0' })).toThrow(/MOCK_PACE_FACTOR/);
  });

  it('parses session and websocket hardening tunables', () => {
    const c = loadConfig({ APP_SECRET: 'x'.repeat(16), CONFIRM_WINDOW_MS: '450', LEDGER_KEEP_RECENT_TURNS: '6', LEDGER_SUMMARIZE_AFTER_TURNS: '12', LEDGER_SUMMARIZE_AFTER_TOKENS: '5000', SESSION_GRACE_MS: '30000', SESSION_UNCLAIMED_MS: '120000', WS_HEARTBEAT_MS: '5000', WS_MAX_FRAMES_PER_SECOND: '80', MAX_SESSIONS: '12', SESSION_RATE_LIMIT_MAX: '4', SESSION_RATE_LIMIT_WINDOW_MS: '30000', REBUILD_BACKOFF_BASE_MS: '200', REBUILD_BACKOFF_MAX_MS: '5000' });
    expect(c.confirmWindowMs).toBe(450);
    expect(c.ledger).toEqual({ keepRecentTurns: 6, summarizeAfterTurns: 12, summarizeAfterTokens: 5000 });
    expect(c.sessionGraceMs).toBe(30000);
    expect(c.sessionUnclaimedMs).toBe(120000);
    expect(c.wsHeartbeatMs).toBe(5000);
    expect(c.wsMaxFramesPerSecond).toBe(80);
    expect(c.maxSessions).toBe(12);
    expect(c.sessionRateLimitMax).toBe(4);
    expect(c.sessionRateLimitWindowMs).toBe(30000);
    expect(c.rebuildBackoffBaseMs).toBe(200);
    expect(c.rebuildBackoffMaxMs).toBe(5000);
  });

  it('rejects invalid hardening tunables', () => {
    for (const [key, value] of [['CONFIRM_WINDOW_MS', '0'], ['LEDGER_KEEP_RECENT_TURNS', '0'], ['LEDGER_SUMMARIZE_AFTER_TURNS', '-1'], ['LEDGER_SUMMARIZE_AFTER_TOKENS', 'nope'], ['SESSION_GRACE_MS', '99'], ['SESSION_UNCLAIMED_MS', '99'], ['WS_HEARTBEAT_MS', '99'], ['WS_MAX_FRAMES_PER_SECOND', '0'], ['MAX_SESSIONS', '0'], ['SESSION_RATE_LIMIT_MAX', '0'], ['SESSION_RATE_LIMIT_WINDOW_MS', '99'], ['REBUILD_BACKOFF_BASE_MS', '99'], ['REBUILD_BACKOFF_MAX_MS', '99']] as const) {
      expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), [key]: value })).toThrow(key);
    }
  });

  it('allows loopback app origins and listed dev origins only', () => {
    const ok = makeOriginCheck(['http://localhost:5173']);
    expect(ok('http://127.0.0.1:39123')).toBe(true);
    expect(ok('http://localhost:5173')).toBe(true);
    expect(ok('http://127.0.0.1.evil.com:1')).toBe(false);
    expect(ok('https://example.com')).toBe(false);
  });

  it('loads the shipped role director config through the shared schema', () => {
    const d = loadDirectorConfig(`${root}roles/elder-companion/director.json`);
    expect(d.maxConsecutive).toBe(2);
    expect(d.maxPerWindow).toBe(8);
    expect(d.companyAfterMs).toBe(45000);
    expect(d.contextAfterMs).toBe(6000);
    expect(d.checkAfterMs).toBe(8000);
    expect(d.leaveAfterMs).toBe(10000);
    expect(d.checkinAfterMs).toBe(10000);
    expect(d.restAfterMs).toBe(180000);
    expect(d.presenceText).toBe('我在');
    expect(d.checkText).toBe('您还方便吗，称呼不急，您方便的时候再说就好。');
    expect(d.checkContextInstruction).toContain('{utterance}');
    expect(d.checkContextInstruction).not.toContain('我在');
    expect(d.checkContextText).toBe('您还方便吗，刚才那件事先放着，不急着回。');
    expect(d.leaveText).toBe('我先安静一会儿，想聊随时喊我。');
    expect(d.checkinInstruction).toContain('是否还在听');
    expect(d.checkinText).toBe('您还在听吗？不着急，您随时想聊都可以，我一直都在。');
    expect(d.restText).toBe('你可以先自己放空一会儿，不用急着回我。');
    expect(d.leaveInstruction).not.toContain('你想说话我就在');
    expect(d.restInstruction).not.toContain('你想说话我就在');
    expect(d.lightPhrases).toEqual(['嗯', '哦', '好', '行', '好的', '嗯嗯', '我知道了', '知道了', '知道啦', '明白了', '明白啦']);
    expect(d.greetingText).toContain('小暖');
    expect(d.greetingMemoryInstruction).toContain('记忆');
    // A new session greets first and then asks.
    expect(d.greetingMemoryText?.startsWith('您好')).toBe(true);
    expect(d.greetingMemoryText).toContain('？');
    expect(d.silenceDecision?.temperature).toBe(0.8);
    expect(d.silenceDecision?.instruction).toContain('greeting');
    expect(d.silenceDecision?.instruction).toContain('checkin');
    expect(d.greetingRetryMs).toBe(800);
    expect(d.openingFollowText).toBe('您要是方便，告诉我怎么称呼您就好。');
    expect(d.openingFollowInstruction).toContain('称呼');
    expect(d.bargeMissText).toBe('没听清，您再说一遍。');
    expect(d.presenceText).toBe('我在');
  });

  it('rejects an invalid director config', () => {
    expect(() => loadDirectorConfig(`${root}package.json`)).toThrow();
  });

  it('rejects optional speech retries and a speak template that cannot carry the approved line', () => {
    const cfg = loadDirectorConfig(`${root}roles/elder-companion/director.json`);
    const decision = cfg.silenceDecision!;
    expect(() => DirectorSchema.parse({ ...cfg, silenceDecision: {
      ...decision, policy: { ...decision.policy, retries: 1 },
    } })).toThrow();
    expect(() => DirectorSchema.parse({ ...cfg, silenceDecision: {
      ...decision, speakInstruction: 'generic presence',
    } })).toThrow();
    expect(() => DirectorSchema.parse({ ...cfg, silenceDecision: {
      ...decision, temperature: 3,
    } })).toThrow();
  });
});

describe('identity config', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const base = { APP_SECRET: 'x'.repeat(16) };

  it('defaults to dev mode with conservative limits', () => {
    expect(loadIdentityConfig(base, repoRoot)).toEqual({
      busyTimeoutMs: 5000, maxOwners: 100, registerDailyCap: 20, registerRateLimitMax: 5, registerRateLimitWindowMs: 3_600_000,
      orphanOwnerDays: 7, orphanCleanupBatch: 200, enableDevEndpoints: false,
    });
  });

  it('accepts an absolute database path outside the repository, or :memory:', () => {
    expect(loadIdentityConfig({ ...base, MEMORY_DB_PATH: '/tmp/avatar-memory/memory.db' }, repoRoot).memoryDbPath).toBe('/tmp/avatar-memory/memory.db');
    expect(loadIdentityConfig({ ...base, MEMORY_DB_PATH: ':memory:' }, repoRoot).memoryDbPath).toBe(':memory:');
  });

  it('rejects relative or in-repo database paths', () => {
    for (const p of ['memory.db', join(repoRoot, 'gateway', 'memory.db'), repoRoot]) {
      expect(() => loadIdentityConfig({ ...base, MEMORY_DB_PATH: p }, repoRoot)).toThrow(/MEMORY_DB_PATH/);
    }
  });

  it('parses identity limits', () => {
    const c = loadIdentityConfig({ ...base, MEMORY_DB_BUSY_TIMEOUT_MS: '2000', MAX_OWNERS: '3', REGISTER_DAILY_CAP: '2', REGISTER_RATE_LIMIT_MAX: '4', REGISTER_RATE_LIMIT_WINDOW_MS: '60000', ORPHAN_OWNER_DAYS: '30', ORPHAN_CLEANUP_BATCH: '50' }, repoRoot);
    expect([c.busyTimeoutMs, c.maxOwners, c.registerDailyCap, c.registerRateLimitMax, c.registerRateLimitWindowMs, c.orphanOwnerDays, c.orphanCleanupBatch]).toEqual([2000, 3, 2, 4, 60000, 30, 50]);
  });

  it('rejects invalid identity limits naming the variable', () => {
    for (const [key, value] of [['MAX_OWNERS', '0'], ['REGISTER_DAILY_CAP', 'x'], ['REGISTER_RATE_LIMIT_MAX', '0'], ['REGISTER_RATE_LIMIT_WINDOW_MS', '99'], ['ORPHAN_OWNER_DAYS', '0'], ['ORPHAN_CLEANUP_BATCH', '0'], ['MEMORY_DB_BUSY_TIMEOUT_MS', '99'], ['ENABLE_DEV_ENDPOINTS', 'yes']] as const) {
      expect(() => loadIdentityConfig({ ...base, [key]: value }, repoRoot)).toThrow(key);
    }
  });

  it('requires a strong, distinct DEV_TOKEN only when dev endpoints are enabled, without echoing it', () => {
    expect(loadIdentityConfig({ ...base, DEV_TOKEN: 'ignored-when-disabled' }, repoRoot).devToken).toBeUndefined();
    const shared = 'a-shared-secret-0123456789ab';
    for (const env of <Array<Record<string, string>>>[
      { ...base, ENABLE_DEV_ENDPOINTS: '1' },
      { ...base, ENABLE_DEV_ENDPOINTS: '1', DEV_TOKEN: 'short-dev-token' },
      { ...base, ENABLE_DEV_ENDPOINTS: '1', DEV_TOKEN: 'change-me-0123456789abcdefgh' },
      { APP_SECRET: shared, ENABLE_DEV_ENDPOINTS: '1', DEV_TOKEN: shared },
    ]) {
      expect(() => loadIdentityConfig(env, repoRoot)).toThrow(/DEV_TOKEN/);
      try { loadIdentityConfig(env, repoRoot); } catch (e) { if (env.DEV_TOKEN) expect((e as Error).message).not.toContain(env.DEV_TOKEN); }
    }
    const ok = loadIdentityConfig({ ...base, ENABLE_DEV_ENDPOINTS: '1', DEV_TOKEN: 'dev-token-0123456789abcdef' }, repoRoot);
    expect(ok.enableDevEndpoints).toBe(true);
    expect(ok.devToken).toBe('dev-token-0123456789abcdef');
  });
});
