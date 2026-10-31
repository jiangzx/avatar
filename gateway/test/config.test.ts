import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('rejects the removed Seeduplex adapter', () => {
    expect(() => loadConfig({ APP_SECRET: 'x'.repeat(16), ADAPTER: 'seeduplex' })).toThrow('Unsupported ADAPTER "seeduplex"');
  });

  it('parses defaults and dev origins', () => {
    const c = loadConfig({ APP_SECRET: 'x'.repeat(16), DEV_ORIGINS: 'http://localhost:5173, http://a.test' });
    expect(c).toEqual({ port: 8787, appSecret: 'x'.repeat(16), adapter: 'mock', qwenEndpoint: '', qwenModel: 'qwen-audio-3.1-realtime-flash', qwenVoice: 'longanlingxin', qwenVoices: { zh: 'longanlingxin', ja: 'Tina', en: 'Tina' }, summarizer: 'mock', summarizerEndpoint: '', summarizerModel: 'qwen-flash', allowDebugText: false, devOrigins: ['http://localhost:5173', 'http://a.test'], mockSpeechThreshold: 800, mockPaceFactor: 2, sessionStartTimeoutMs: 10000, confirmWindowMs: 300, ledger: { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6000 }, sessionGraceMs: 60000, sessionUnclaimedMs: 300000, wsHeartbeatMs: 10000, wsMaxFramesPerSecond: 100, maxSessions: 100, sessionRateLimitMax: 10, sessionRateLimitWindowMs: 60000, resumeRateLimitMax: 30, resumeRateLimitWindowMs: 60000, trustProxy: false, rebuildBackoffBaseMs: 1000, rebuildBackoffMaxMs: 8000, logLevel: 'info', logStrict: false });
  });

  it('parses LOG_LEVEL and turns on strict log checks only in test and development', () => {
    const base = { APP_SECRET: 'x'.repeat(16) };
    expect(loadConfig({ ...base, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'loud' })).toThrow('Unsupported LOG_LEVEL "loud"');
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).logStrict).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).logStrict).toBe(true);
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).logStrict).toBe(false);
    expect(loadConfig(base).logStrict).toBe(false);
  });

  it('parses per-language voice maps with zh fallbacks', () => {
    const c = loadConfig({
      APP_SECRET: 'x'.repeat(16),
      QWEN_VOICE: 'qwen-zh',
      QWEN_VOICE_JA: 'Tina',
    });
    expect(c.qwenVoices).toEqual({ zh: 'qwen-zh', ja: 'Tina', en: 'Tina' });
    expect(c.qwenVoice).toBe('qwen-zh');
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

  it('parses resume and proxy tunables', () => {
    const c = loadConfig({ APP_SECRET: 'x'.repeat(16), RESUME_RATE_LIMIT_MAX: '5', RESUME_RATE_LIMIT_WINDOW_MS: '1000', TRUST_PROXY: '1' });
    expect(c.resumeRateLimitMax).toBe(5);
    expect(c.resumeRateLimitWindowMs).toBe(1000);
    expect(c.trustProxy).toBe(true);
  });

  it('rejects unknown director keys', () => {
    const cfg = JSON.parse(readFileSync(join(root, 'roles/elder-companion/zh/director.json'), 'utf8')) as Record<string, unknown>;
    expect(() => DirectorSchema.parse(cfg)).not.toThrow();
    expect(() => DirectorSchema.parse({ ...cfg, typoKey: true })).toThrow();
  });

  it('validates endpoint protocols at startup', () => {
    const base = { APP_SECRET: 'x'.repeat(16) };
    expect(() => loadConfig({ ...base, ADAPTER: 'qwen', DASHSCOPE_API_KEY: 'k', QWEN_ENDPOINT: 'https://workspace.example/realtime' })).toThrow(/QWEN_ENDPOINT/);
    expect(() => loadConfig({ ...base, ADAPTER: 'qwen', DASHSCOPE_API_KEY: 'k', QWEN_ENDPOINT: 'not a url' })).toThrow(/QWEN_ENDPOINT/);
    expect(() => loadConfig({ ...base, SUMMARIZER: 'qwen', DASHSCOPE_API_KEY: 'k', QWEN_SUMMARIZER_ENDPOINT: 'wss://workspace.example/chat' })).toThrow(/QWEN_SUMMARIZER_ENDPOINT/);
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
    for (const [key, value] of [['CONFIRM_WINDOW_MS', '0'], ['LEDGER_KEEP_RECENT_TURNS', '0'], ['LEDGER_SUMMARIZE_AFTER_TURNS', '-1'], ['LEDGER_SUMMARIZE_AFTER_TOKENS', 'nope'], ['SESSION_GRACE_MS', '99'], ['SESSION_UNCLAIMED_MS', '99'], ['WS_HEARTBEAT_MS', '99'], ['WS_MAX_FRAMES_PER_SECOND', '0'], ['MAX_SESSIONS', '0'], ['SESSION_RATE_LIMIT_MAX', '0'], ['SESSION_RATE_LIMIT_WINDOW_MS', '99'], ['RESUME_RATE_LIMIT_MAX', '0'], ['RESUME_RATE_LIMIT_WINDOW_MS', '99'], ['REBUILD_BACKOFF_BASE_MS', '99'], ['REBUILD_BACKOFF_MAX_MS', '99']] as const) {
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
    const d = loadDirectorConfig(`${root}roles/elder-companion/zh/director.json`);
    expect(d.maxConsecutive).toBe(2);
    expect(d.maxPerWindow).toBe(8);
    expect(d.companyAfterMs).toBe(45000);
    expect(d.contextAfterMs).toBe(6000);
    expect(d.checkAfterMs).toBe(6000);
    expect(d.leaveAfterMs).toBe(6000);
    expect(d.checkinAfterMs).toBe(6000);
    expect(d.restAfterMs).toBe(180000);
    expect(d.presenceText).toBe('我在');
    expect(d.checkText).toBe('您还方便吗，称呼不急，您方便的时候再说就好。');
    expect(d.checkContextInstruction).toContain('{utterance}');
    expect(d.checkContextInstruction).not.toContain('我在');
    expect(d.contextText).toBe('您想接着聊点什么？我听着呢。');
    expect(d.checkContextText).toBe('您想聊点别的也行，我在这儿陪着您。');
    expect(d.leaveText).toBe('我先安静一会儿，想聊随时喊我。');
    expect(d.checkinInstruction).toContain('是否还在听');
    expect(d.checkinText).toBe('您还在听吗？不着急，您随时想聊都可以，我一直都在。');
    expect(d.restText).toBe('你可以先自己放空一会儿，不用急着回我。');
    expect(d.leaveInstruction).not.toContain('你想说话我就在');
    expect(d.restInstruction).not.toContain('你想说话我就在');
    expect(d.lightPhrases).toEqual(['嗯', '哦', '好', '行', '好的', '嗯嗯', '我知道了', '知道了', '知道啦', '明白了', '明白啦']);
    expect(d.greetingText).toContain('{{char}}');
    expect(d.greetingMemoryInstruction).toContain('记忆');
    // A new session greets first and then asks.
    expect(d.greetingMemoryText?.startsWith('您好')).toBe(true);
    expect(d.greetingMemoryText).toContain('？');
    expect(d.greetingRetryMs).toBe(800);
    // No bare acknowledgement fallback and no name on every proactive line.
    expect(d.toolContinueText).not.toMatch(/^[好嗯哦行啊]/);
    expect(d.toolContinueInstruction).toContain('应答词');
    expect(d.openingFollowText).toBe('您要是方便，告诉我怎么称呼您就好。');
    expect(d.openingFollowInstruction).toContain('称呼');
    expect(d.bargeMissText).toBe('没听清，您再说一遍。');
    expect(d.presenceText).toBe('我在');
  });

  it('ships ja/en directors with zh timings and localized fixed lines', () => {
    const zh = loadDirectorConfig(`${root}roles/elder-companion/zh/director.json`);
    const ja = loadDirectorConfig(`${root}roles/elder-companion/ja/director.json`);
    const en = loadDirectorConfig(`${root}roles/elder-companion/en/director.json`);
    for (const field of ['followupAfterMs', 'idleNoticeAfterMs', 'maxConsecutive', 'maxPerWindow', 'windowMs', 'companyAfterMs', 'contextAfterMs', 'checkAfterMs', 'leaveAfterMs', 'checkinAfterMs', 'restAfterMs', 'greetingRetryMs'] as const) {
      expect(ja[field]).toBe(zh[field]);
      expect(en[field]).toBe(zh[field]);
    }
    for (const d of [ja, en]) {
      expect(d.topicInstruction).toContain('{topic}');
      expect(d.greetingNameTexts).toHaveLength(3);
      for (const text of d.greetingNameTexts ?? []) expect(text).toContain('{name}');
    }
    expect(ja.quietPhrases).toEqual(['やめて', '静かにして', '黙って', '話さないで', '静かに']);
    expect(en.quietPhrases).toEqual(['be quiet', 'stop talking', 'quiet please', "don't talk", 'silence']);
    expect(ja.lightPhrases).toEqual(['うん', 'はい', 'ええ', 'そうですね', 'わかりました', 'なるほど']);
    expect(en.lightPhrases).toEqual(['okay', 'ok', 'yes', 'yeah', 'I see', 'got it', 'alright']);

    expect(ja.greetingText).toBe('こんにちは、{{charSpoken}}です。お話ししに来ました。どうお呼びすればいいですか？');
    expect(ja.greetingMemoryText).toBe('こんにちは、またお会いできましたね。今日は何をお話ししましょうか？');
    expect(ja.followupText).toBe('ゆっくりで大丈夫ですよ。ここにいますから。');
    expect(ja.contextText).toBe('続きがあれば、聞いていますよ。');
    expect(ja.idleNoticeText).toBe('ここにいますよ。急がなくて大丈夫です。');
    expect(ja.resumeText).toBe('さっきネットが少し切れましたね。続きを話しましょう。');
    expect(ja.toolContinueText).toBe('じゃあ、続きを話しましょう。');
    expect(ja.memoryNoticeText).toBe('これからお話ししたことは覚えておきますね。次にまた続きを話せますから。');
    expect(ja.presenceText).toBe('ここにいます');
    expect(ja.openingFollowText).toBe('お名前を聞かせていただけたらうれしいです。');
    expect(ja.memoryFollowText).toBe('ゆっくりで大丈夫です。そばにいますね。');
    expect(ja.bargeMissText).toBe('うまく聞き取れませんでした。もう一度言ってください。');
    expect(ja.checkText).toBe('お名前のことは急がなくて大丈夫ですよ。');
    expect(ja.checkContextText).toBe('別のお話でも大丈夫ですよ。ここにいますから。');
    expect(ja.checkMemoryText).toBe('さっきのお話、急がなくて大丈夫です。話したくなったら聞かせてください。');
    expect(ja.leaveText).toBe('少し静かにしますね。話したくなったら呼んでください。');
    expect(ja.checkinText).toBe('まだ聞こえていますか？急がなくて大丈夫です。いつでもお話しできますよ。');
    expect(ja.restText).toBe('しばらくご自分でゆっくりしてください。急いで返事をしなくて大丈夫です。');

    expect(en.greetingText).toBe("Hello, I'm {{char}}. I came to keep you company. What should I call you?");
    expect(en.greetingMemoryText).toBe("Hello, it's good to see you again. What would you like to talk about today?");
    expect(en.followupText).toBe("Take your time. I'm right here.");
    expect(en.contextText).toBe("If you'd like to keep talking, I'm listening.");
    expect(en.idleNoticeText).toBe("I'm here. No rush at all.");
    expect(en.resumeText).toBe("The connection dropped for a moment. Let's pick up where we left off.");
    expect(en.toolContinueText).toBe("Let's keep going.");
    expect(en.memoryNoticeText).toBe("I'll remember what we talk about, so we can pick it up next time.");
    expect(en.presenceText).toBe("I'm here");
    expect(en.openingFollowText).toBe("Whenever you're ready, just tell me what to call you.");
    expect(en.memoryFollowText).toBe("Take your time. I'm right here with you.");
    expect(en.bargeMissText).toBe("I didn't quite catch that. Could you say it again?");
    expect(en.checkText).toBe("There's no rush about your name. Whenever you're comfortable.");
    expect(en.checkContextText).toBe("We can talk about something else too. I'm here with you.");
    expect(en.checkMemoryText).toBe("That earlier thing can wait. Tell me whenever you feel like it.");
    expect(en.leaveText).toBe("I'll be quiet for a little while. Call me whenever you'd like to talk.");
    expect(en.checkinText).toBe("Are you still there? No rush—we can talk anytime.");
    expect(en.restText).toBe("Take some time for yourself. No need to reply.");

    // Check-in limits follow maxCheckinChars (en 80, ja 60), not the zh 30.
    expect(en.checkinInstruction).toContain('80 characters');
    expect(ja.checkinInstruction).toContain('60 文字');

    // English copy carries no Chinese characters; Japanese copy is not the Chinese text.
    const enText = JSON.stringify(en);
    expect(enText).not.toMatch(/[一-鿿]/);
    expect(JSON.stringify(ja)).not.toContain('您');
  });

  it('rejects an invalid director config', () => {
    expect(() => loadDirectorConfig(`${root}package.json`)).toThrow();
  });
});

describe('identity config', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const base = { APP_SECRET: 'x'.repeat(16) };

  it('defaults to dev mode with conservative limits', () => {
    expect(loadIdentityConfig(base, repoRoot)).toEqual({
      busyTimeoutMs: 5000, maxOwners: 100, registerDailyCap: 20, registerRateLimitMax: 5, registerRateLimitWindowMs: 3_600_000,
      memoryRateLimitMax: 60, memoryRateLimitWindowMs: 60_000,
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
