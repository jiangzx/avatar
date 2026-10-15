import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDirectorConfig, loadPersona, makeOriginCheck } from '../src/config.ts';

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

  it('loads the shipped director config and persona', () => {
    const d = loadDirectorConfig(`${root}config/director.json`);
    expect(d.maxConsecutive).toBe(2);
    expect(loadPersona(`${root}prompts/persona.md`)).toContain('perform_action');
  });

  it('rejects an invalid director config', () => {
    expect(() => loadDirectorConfig(`${root}package.json`)).toThrow();
  });
});
