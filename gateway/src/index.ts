import { fileURLToPath } from 'node:url';
import { SeeduplexAdapter } from './adapters/seeduplex.ts';
import { QwenAdapter } from './adapters/qwen.ts';
import { MockAdapter, loadMockScript, loadMockSpeech } from './adapters/mock.ts';
import { loadConfig, loadIdentityConfig, loadSafetyConfig, makeOriginCheck } from './config.ts';
import { loadRoleCatalog } from './roles/fileCatalog.ts';
import { log } from './log.ts';
import { loadMemoryBudget, loadPacing, validateBudgets } from './session/pacing.ts';
import { devContextResolver } from './session/context.ts';
import { MockSummarizer } from './session/ledger.ts';
import { QwenSummarizer } from './session/qwenSummarizer.ts';
import { SessionManager } from './session/manager.ts';
import { Session } from './session/session.ts';
import { createGatewayServer } from './server/server.ts';
import { DeviceRegistry, ORPHAN_CLEANUP_INTERVAL_MS } from './identity/registry.ts';
import { openDatabase } from './memory/db.ts';
import { SqliteMemoryStore } from './memory/store.ts';
import { loadEmotionConfig } from './session/emotion.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig();
// File-backed roles (Plan A): gateway/roles/<role>/ + gateway/roles/_shared/.
const roles = loadRoleCatalog(`${root}roles`);
const pacing = loadPacing(`${root}config/pacing.json`);
const memory = loadMemoryBudget(`${root}config/memory.json`);
const budgetReport = validateBudgets(pacing, memory, config.ledger, roles.pairs().map((p) => roles.buildPersona(p.roleId, p.styleId)));
log('instruction_budget', { totalChars: budgetReport.budget.totalChars, minHistoryChars: budgetReport.minHistoryChars, ledgerCapped: budgetReport.ledgerCapped });
const emotion = loadEmotionConfig(`${root}config/emotion.json`);
const safety = loadSafetyConfig(`${root}config/safety.json`);
log('safety_rules', {
  rejectPhrases: safety.rejectPhrases.length,
  degradePhrases: safety.degradePhrases.length,
  markPhrases: safety.markPhrases.length,
  invisibleCodePoints: safety.invisibleCodePoints.length,
});
const script = loadMockScript(`${root}mock/script.json`);
const speech = loadMockSpeech(`${root}mock/speech-24k.pcm`);
if (!speech) log('mock_speech_missing', { hint: 'run scripts/make-mock-speech.sh' });
// Device identity (Plan B). MEMORY_DB_PATH unset = dev mode: no registration, no memory, bearers rejected.
const identityConfig = loadIdentityConfig(process.env, fileURLToPath(new URL('../..', import.meta.url)));
const memoryDb = identityConfig.memoryDbPath ? openDatabase(identityConfig.memoryDbPath, { busyTimeoutMs: identityConfig.busyTimeoutMs }) : null;
const registry = memoryDb
  ? new DeviceRegistry({
      store: new SqliteMemoryStore(memoryDb),
      roles,
      limits: {
        maxOwners: identityConfig.maxOwners,
        dailyCap: identityConfig.registerDailyCap,
        orphanOwnerDays: identityConfig.orphanOwnerDays,
        orphanCleanupBatch: identityConfig.orphanCleanupBatch,
      },
    })
  : null;
log('identity_mode', { enabled: registry !== null, devEndpoints: identityConfig.enableDevEndpoints });
const manager = new SessionManager(
  (ctx, sessionId) =>
    new Session({
      adapterFactory: () => config.adapter === 'seeduplex'
        ? new SeeduplexAdapter({ apiKey: config.seeduplexApiKey!, endpoint: config.seeduplexEndpoint, model: config.seeduplexModel, voice: config.seeduplexVoice })
        : config.adapter === 'qwen'
          ? new QwenAdapter({ apiKey: config.qwenApiKey!, endpoint: config.qwenEndpoint, model: config.qwenModel, voice: config.qwenVoice })
          : new MockAdapter({ script, speech, speechThreshold: config.mockSpeechThreshold, paceFactor: config.mockPaceFactor }),
      summarizer: config.summarizer === 'qwen'
        ? new QwenSummarizer({ apiKey: config.qwenApiKey!, endpoint: config.summarizerEndpoint, model: config.summarizerModel })
        : new MockSummarizer(),
      roles,
      ledger: config.ledger,
      confirmWindowMs: config.confirmWindowMs,
      rebuildBackoffBaseMs: config.rebuildBackoffBaseMs,
      rebuildBackoffMaxMs: config.rebuildBackoffMaxMs,
      modelOwnsTurns: config.adapter === 'qwen',
      budget: budgetReport.budget,
      modelContextTokenLimit: pacing.rebuild.contextChars,
      rebuildTriggerRatio: pacing.rebuild.triggerRatio,
      rebuildAfterTurns: pacing.rebuild.afterTurns,
      summarizePolicy: pacing.policies.summarize,
      ...(pacing.output.maxTokens !== null ? { maxOutputTokens: pacing.output.maxTokens } : {}),
      tailGuardMs: pacing.tailGuardMs,
      toolTurnTimeoutMs: memory.toolTurnTimeoutMs,
      emotion,
    }, ctx, sessionId),
  config.sessionGraceMs,
  config.sessionUnclaimedMs,
  config.sessionStartTimeoutMs,
  registry?.lifecycle,
);
const server = createGatewayServer({
  manager,
  appSecret: config.appSecret,
  // Identity on: DeviceRegistry resolves bearers; identity off: dev resolver (no bearer, default role/style).
  contextResolver: registry ?? devContextResolver(roles),
  identity: registry ?? undefined,
  registerRateLimit: { max: identityConfig.registerRateLimitMax, windowMs: identityConfig.registerRateLimitWindowMs },
  devToken: identityConfig.devToken,
  allowedOrigin: makeOriginCheck(config.devOrigins),
  allowDebugText: config.allowDebugText,
  heartbeatMs: config.wsHeartbeatMs,
  maxFramesPerSecond: config.wsMaxFramesPerSecond,
  maxSessions: config.maxSessions,
  sessionRateLimit: { max: config.sessionRateLimitMax, windowMs: config.sessionRateLimitWindowMs },
});

server.listen(config.port, '0.0.0.0', () => log('gateway_listening', { port: config.port, adapter: config.adapter }));

const shutdown = () => {
  manager.shutdown();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Orphan owners (registered, never connected, older than ORPHAN_OWNER_DAYS): at startup, then daily.
if (registry) {
  const runCleanup = () => registry.cleanupOrphans().catch(() => log('orphan_cleanup_failed', {}));
  void runCleanup();
  setInterval(runCleanup, ORPHAN_CLEANUP_INTERVAL_MS).unref();
}
// Registered after `shutdown`, so it runs after manager.shutdown() wrote the session end times.
const closeMemoryDb = () => {
  if (memoryDb?.isOpen) memoryDb.close();
};
process.on('SIGINT', closeMemoryDb);
process.on('SIGTERM', closeMemoryDb);
