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
    expect(c).toEqual({ port: 8787, appSecret: 'x'.repeat(16), adapter: 'mock', seeduplexEndpoint: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', seeduplexModel: '1.2.6.1', seeduplexVoice: 'zh_male_xiaotian_jupiter_bigtts', qwenEndpoint: '', qwenModel: 'qwen3.8-omni-flash-realtime', qwenVoice: 'longanlingxin', allowDebugText: false, devOrigins: ['http://localhost:5173', 'http://a.test'], mockSpeechThreshold: 800, sessionStartTimeoutMs: 10000 });
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

  it('validates the mock speech threshold', () => {
    expect(loadConfig({ APP_SECRET: 'x'.repeat(16), MOCK_SPEECH_THRESHOLD: '1500' }).mockSpeechThreshold).toBe(1500);
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), MOCK_SPEECH_THRESHOLD: 'loud' })).toThrow(/MOCK_SPEECH_THRESHOLD/);
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
