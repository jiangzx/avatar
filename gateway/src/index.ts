import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, type Language } from '@anyidea/protocol';
import { SeeduplexAdapter } from './adapters/seeduplex.ts';
import { QwenAdapter } from './adapters/qwen.ts';
import { MockAdapter, loadMockScript, loadMockSpeech, withCharacterName } from './adapters/mock.ts';
import { loadConfig, loadIdentityConfig, makeOriginCheck } from './config.ts';
import { expireAdminAudit } from './admin/audit.ts';
import { loadAdminEnv } from './admin/config.ts';
import { createAdminServer } from './admin/server.ts';
import { loadAdminConfig } from './log/adminConfig.ts';
import { createLogLevelControl } from './log/levels.ts';
import { createLogger } from './log/logger.ts';
import { SqliteLogSink, deleteLogsBefore } from './log/sqliteSink.ts';
import { stdoutSink } from './log/stdoutSink.ts';
import { devContextResolver } from './session/context.ts';
import { MockSummarizer } from './session/ledger.ts';
import { QwenSummarizer } from './session/qwenSummarizer.ts';
import { SessionManager } from './session/manager.ts';
import { createGatewayServer } from './server/server.ts';
import { DeviceRegistry, ORPHAN_CLEANUP_INTERVAL_MS } from './identity/registry.ts';
import { createMemoryService } from './identity/memoryService.ts';
import { backfillKanaBigrams } from './memory/backfill.ts';
import { openDatabase } from './memory/db.ts';
import { SqliteMemoryStore } from './memory/store.ts';
import { QwenTextClient, type TextModelClient } from './memory/textClient.ts';
import { TextClientCache, switchingTextClient } from './memory/textClientCache.ts';
import { MemoryWorker, withExtraction } from './memory/worker.ts';
import { SqliteTranscriptWriter } from './memory/writer.ts';
import { SqlitePriceBook, loadPricingBaseline } from './usage/pricing.ts';
import { SqliteUsageRecorder } from './usage/recorder.ts';
import { purgeExpiredUsage } from './usage/retention.ts';
import type { ModelDefaults, Overlay } from './config-store/keys.ts';
import { fixedConfigSource, SqliteConfigStore, type ConfigSource } from './config-store/store.ts';
import { buildConfigSnapshot, type ConfigSnapshot } from './session/configSnapshot.ts';
import { makeSessionFactory } from './session/snapshotDeps.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig();
const adminConfig = loadAdminConfig(`${root}config/admin.json`);
// Device identity (Plan B). MEMORY_DB_PATH unset = dev mode: no registration, no memory, bearers rejected.
const identityConfig = loadIdentityConfig(process.env, fileURLToPath(new URL('../..', import.meta.url)));
const memoryDb = identityConfig.memoryDbPath ? openDatabase(identityConfig.memoryDbPath, { busyTimeoutMs: identityConfig.busyTimeoutMs }) : null;
const store = memoryDb ? new SqliteMemoryStore(memoryDb) : null;
// One level control and one root logger per process; children carry sid/oid/char/seq/job.
const levels = createLogLevelControl(config.logLevel);
const stdout = stdoutSink();
const logSink = memoryDb
  ? new SqliteLogSink({
      db: memoryDb,
      flushMs: adminConfig.logSink.flushMs,
      maxBatch: adminConfig.logSink.maxBatch,
      onError: (code) => stdout.write({ t: Date.now(), level: 'error', event: code, binding: {}, fields: {} }),
    })
  : null;
const logger = createLogger({ sinks: logSink ? [stdout, logSink] : [stdout], levels, strict: config.logStrict });
logger.info('log_sink_ready', { db: logSink !== null, level: config.logLevel });
// One validated snapshot drives startup checks and every new session. Publishing swaps it atomically.
const modelDefaults: ModelDefaults = {
  realtimeEndpoint: config.qwenEndpoint,
  realtimeModel: config.qwenModel,
  textEndpoint: config.summarizerEndpoint,
  summarizerModel: config.summarizerModel,
};
const buildSnapshot = (overlay: Overlay, version: number): ConfigSnapshot => buildConfigSnapshot({
  gatewayRoot: root,
  overlay,
  version,
  ledger: config.ledger,
  sessionStartTimeoutMs: config.sessionStartTimeoutMs,
  models: modelDefaults,
});
// Identity on: the admin can publish overlays. Dev mode: the repo baseline only. An invalid baseline still fails startup.
const configSource: ConfigSource<ConfigSnapshot> | SqliteConfigStore<ConfigSnapshot> = memoryDb
  ? new SqliteConfigStore<ConfigSnapshot>({ db: memoryDb, build: buildSnapshot, logger })
  : fixedConfigSource(buildSnapshot({}, 0));
const boot = configSource.snapshot();
logger.info('config_snapshot', { version: boot.version, characters: boot.characters.ids().length, disabled: boot.disabledCharacters.size });
// Character cards (gateway/characters/): the id set must equal protocol CHARACTER_IDS, or startup fails.
logger.info('characters_loaded', { count: boot.characters.ids().length });
// Instruction room per language. The snapshot's build already validated budgets and cross-checks.
const languageBudgetFields: Record<string, number> = {};
for (const language of LANGUAGES) {
  const budget = boot.budgets.budgets[language];
  const perLanguage = boot.budgets.perLanguage[language];
  if (!budget || !perLanguage) continue;
  languageBudgetFields[`${language}TotalChars`] = budget.totalChars;
  languageBudgetFields[`${language}MinHistoryChars`] = perLanguage.minHistoryChars;
  languageBudgetFields[`${language}AffectMaxChars`] = budget.affectMaxChars ?? 0;
  languageBudgetFields[`${language}PinnedMaxChars`] = budget.pinnedMaxChars ?? 0;
}
logger.info('instruction_budget', {
  totalChars: boot.budgets.budget.totalChars,
  minHistoryChars: boot.budgets.minHistoryChars,
  ledgerCapped: boot.budgets.ledgerCapped,
  ...languageBudgetFields,
});
logger.info('safety_rules', {
  rejectPhrases: boot.i18n.safety.rejectPhrases.length,
  degradePhrases: boot.i18n.safety.degradePhrases.length,
  markPhrases: boot.i18n.safety.markPhrases.length,
  invisibleCodePoints: boot.i18n.safety.invisibleCodePoints.length,
});
const script = loadMockScript(`${root}mock/script.json`);
const speech = loadMockSpeech(`${root}mock/speech-24k.pcm`);
if (!speech) logger.warn('mock_speech_missing', { hint: 'run scripts/make-mock-speech.sh' });
// Validated at every start, even without a DB, so a bad price file fails fast.
const pricingBaseline = loadPricingBaseline(`${root}config/pricing.json`);
const prices = memoryDb ? new SqlitePriceBook(memoryDb, pricingBaseline) : null;
const usage = memoryDb && prices
  ? new SqliteUsageRecorder({ db: memoryDb, prices, logger, flushMs: adminConfig.usageSink.flushMs, maxBatch: adminConfig.usageSink.maxBatch })
  : null;
// Seeduplex is not counted (spec Q9/Q14).
const usageSource = config.adapter === 'qwen'
  ? { adapter: 'qwen' as const, model: config.qwenModel }
  : config.adapter === 'mock' ? { adapter: 'mock' as const, model: 'mock' } : null;
if (store) {
  // This process is the only gateway for the DB: any row still open belongs to a dead process.
  const reconciled = store.closeOpenSessions(Date.now());
  if (reconciled > 0) logger.info('sessions_reconciled', { count: reconciled });
  // One bounded pass over rows written before kana tokens existed. Never log message text.
  const backfilled = backfillKanaBigrams(store, boot.memory.kanaBackfillBatch ?? 500);
  if (backfilled > 0) logger.info('kana_bigram_backfill', { changed: backfilled });
}
const registry = store
  ? new DeviceRegistry({
      store,
      roles: boot.roles,
      characters: boot.characters,
      limits: {
        maxOwners: identityConfig.maxOwners,
        dailyCap: identityConfig.registerDailyCap,
        orphanOwnerDays: identityConfig.orphanOwnerDays,
        orphanCleanupBatch: identityConfig.orphanCleanupBatch,
      },
      continuityGapMs: boot.pacing.restReminder.continuityGapMs,
      adapterName: config.adapter,
      i18n: boot.i18n,
      snapshotMaxChars: () => configSource.snapshot().memory.instructions.snapshotMaxChars,
      logger,
    })
  : null;
logger.info('identity_mode', { enabled: registry !== null, devEndpoints: identityConfig.enableDevEndpoints });
const memoryService = store ? createMemoryService({ store, safety: boot.i18n.safety, logger }) : undefined;
const writer = store ? new SqliteTranscriptWriter(store, boot.i18n.safety, logger) : undefined;
// P3-T4 replaces these two with the SecretStore.
const resolveApiKey = (): string | undefined => config.qwenApiKey;
const apiKeyVersion = (): number => 0;
const textClients = new TextClientCache((settings) => new QwenTextClient({
  apiKey: settings.apiKey,
  endpoint: settings.endpoint,
  model: settings.model,
  logger,
  ...(usage ? { recorder: usage } : {}),
}));
/** Text client for one snapshot; rebuilt when the config version or the Key changes. */
const textClientFor = (snapshot: ConfigSnapshot): TextModelClient | undefined => {
  const apiKey = resolveApiKey();
  if (!apiKey || !snapshot.model.textEndpoint) return undefined;
  return textClients.get(`${snapshot.version}:${apiKeyVersion()}`, { apiKey, endpoint: snapshot.model.textEndpoint, model: snapshot.model.extractModel });
};
const workerClient = textClientFor(boot)
  ? switchingTextClient(() => {
      const client = textClientFor(configSource.snapshot());
      if (!client) throw new Error('extract_unconfigured');
      return client;
    })
  : null;
const worker = store && workerClient
  ? new MemoryWorker({
      store,
      client: workerClient,
      systemPrompts: byLanguage((language) => boot.roles.extractPrompt(language)),
      labels: byLanguage((language) => boot.i18n.memory[language].extractLabels),
      maxTokens: boot.memory.extractMaxTokens ?? 800,
      policy: boot.memory.extractPolicy ?? boot.pacing.policies.summarize,
      transcriptMaxChars: boot.memory.extractTranscriptMaxChars ?? 6_000,
      contextMaxChars: boot.memory.extractContextMaxChars ?? 4_000,
      // Care quotes are stored only while the care feature is on (data minimization).
      quote: { maxChars: boot.affect.care.quoteMaxChars, safety: boot.i18n.safety, evidence: boot.i18n.evidence },
      quoteEnabled: () => configSource.snapshot().affect.enabled,
      logger,
    })
  : null;
if (store && !workerClient) logger.warn('memory_extract_unconfigured');
// Sessions get the text client only for real adapters; Mock runs stay lexicon-only.
logger.info('affect_analyzer', { enabled: boot.affect.enabled && config.adapter !== 'mock' && workerClient !== null });
const manager = new SessionManager(
  makeSessionFactory(configSource, {
    apiKey: resolveApiKey,
    adapter: ({ snapshot, characterId, apiKey }) => config.adapter === 'seeduplex'
      ? new SeeduplexAdapter({ apiKey: config.seeduplexApiKey!, endpoint: config.seeduplexEndpoint, model: config.seeduplexModel, voice: config.seeduplexVoice })
      : config.adapter === 'qwen'
        ? new QwenAdapter({ apiKey: apiKey!, endpoint: snapshot.model.realtimeEndpoint, model: snapshot.model.realtimeModel, voice: config.qwenVoice })
        : new MockAdapter({ script: withCharacterName(script, snapshot.characters.name(characterId, 'zh')), speech, speechThreshold: config.mockSpeechThreshold, paceFactor: config.mockPaceFactor, emitUsage: usage !== null }),
    summarizer: ({ snapshot, apiKey, ctx, sessionId }) => config.summarizer === 'qwen'
      ? new QwenSummarizer({
          apiKey: apiKey!,
          endpoint: snapshot.model.textEndpoint,
          model: snapshot.model.summarizerModel,
          ...(usage ? { recorder: usage, tag: { kind: 'summarize' as const, attribution: { ownerId: ctx.ownerId ?? null, agentId: ctx.agentId ?? null, sessionId, characterId: ctx.characterId } } } : {}),
        })
      : new MockSummarizer(),
    // Sessions get the text client only for real adapters; Mock runs stay lexicon-only.
    textClient: (snapshot) => (config.adapter !== 'mock' ? textClientFor(snapshot) : undefined),
    // Character card voice for the active adapter, then the env default. Seeduplex has no Japanese voice.
    voiceFor: (snapshot, characterId, language) => {
      if (config.adapter === 'qwen') return snapshot.characters.voiceFor(characterId, 'qwen', language) ?? config.qwenVoices[language];
      if (config.adapter === 'seeduplex') {
        return language === 'ja' ? undefined : snapshot.characters.voiceFor(characterId, 'seeduplex', language) ?? config.seeduplexVoices[language];
      }
      return undefined;
    },
  }, {
    ledger: config.ledger,
    confirmWindowMs: config.confirmWindowMs,
    rebuildBackoffBaseMs: config.rebuildBackoffBaseMs,
    rebuildBackoffMaxMs: config.rebuildBackoffMaxMs,
    modelOwnsTurns: config.adapter === 'qwen',
    ...(store ? { store } : {}),
    ...(writer ? { writer } : {}),
    ...(worker ? { worker } : {}),
    logger,
    ...(usage && usageSource ? { usage, usageSource } : {}),
  }),
  config.sessionGraceMs,
  config.sessionUnclaimedMs,
  config.sessionStartTimeoutMs,
  registry ? (worker ? withExtraction(registry.lifecycle, worker) : registry.lifecycle) : undefined,
  logger,
);
const server = createGatewayServer({
  manager,
  appSecret: config.appSecret,
  // Identity on: DeviceRegistry resolves bearers; identity off: dev resolver (no bearer, any character, no memory).
  contextResolver: registry ?? devContextResolver(boot.roles, boot.characters),
  identity: registry ?? undefined,
  registerRateLimit: { max: identityConfig.registerRateLimitMax, windowMs: identityConfig.registerRateLimitWindowMs },
  ...(memoryService ? { memory: memoryService } : {}),
  memoryRateLimit: { max: identityConfig.memoryRateLimitMax, windowMs: identityConfig.memoryRateLimitWindowMs },
  devToken: identityConfig.devToken,
  allowedOrigin: makeOriginCheck(config.devOrigins),
  allowDebugText: config.allowDebugText,
  heartbeatMs: config.wsHeartbeatMs,
  maxFramesPerSecond: config.wsMaxFramesPerSecond,
  maxSessions: config.maxSessions,
  sessionRateLimit: { max: config.sessionRateLimitMax, windowMs: config.sessionRateLimitWindowMs },
  resumeRateLimit: { max: config.resumeRateLimitMax, windowMs: config.resumeRateLimitWindowMs },
  trustProxy: config.trustProxy,
  logger,
  ...(store ? { ownerBanned: (ownerId: string) => store.isOwnerBanned(ownerId) } : {}),
});

server.listen(config.port, '0.0.0.0', () => logger.info('gateway_listening', { port: config.port, adapter: config.adapter }));

// Admin console: same process (single DB writer), loopback only. Opt-in via ADMIN_PORT.
const adminEnv = loadAdminEnv(process.env);
let adminServer: Server | null = null;
if (!adminEnv.enabled) {
  logger.info('admin_disabled', { reason: adminEnv.reason });
} else if (!memoryDb || !store || !prices) {
  logger.info('admin_disabled', { reason: 'memory_db_unset' });
} else {
  const admin = createAdminServer({
    db: memoryDb,
    store,
    manager,
    logger,
    levels,
    prices,
    config: adminConfig,
    passwordHash: adminEnv.passwordHash,
    adapterName: config.adapter,
    staticDir: resolve(root, '..', 'admin', 'dist'),
  });
  adminServer = admin;
  // A busy admin port must not take the voice gateway down (no dead air for the phone).
  admin.on('error', () => {
    logger.error('admin_listen_failed', {});
    adminServer = null;
    try {
      admin.close();
    } catch {
      // The failed listen may have no handle left to close.
    }
  });
  admin.listen(adminEnv.port, '127.0.0.1', () => logger.info('admin_listening', { port: adminEnv.port }));
}

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  manager.shutdown();
  // Stop accepting immediately: draining can take seconds, and a session created during it
  // would miss manager.shutdown() and keep server.close() waiting.
  server.close();
  // Upgraded sockets are not closed by server.close(); closeAllConnections is the last-resort
  // guarantee for connections the manager never tracked (e.g. a mid-upgrade socket).
  server.closeAllConnections();
  adminServer?.close();
  adminServer?.closeAllConnections();
  void (async () => {
    try {
      if (worker) await worker.drain(boot.memory.extractDrainMs ?? 8_000);
    } finally {
      try {
        usage?.close();
      } catch {
        logger.warn('usage_close_failed', {});
      }
      try {
        logSink?.close();
        if (memoryDb?.isOpen) memoryDb.close();
      } catch {
        logger.error('memory_db_close_failed');
      }
      process.exit(0);
    }
  })();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const DAY_MS = 24 * 60 * 60_000;

/** Build a complete per-language record from the same factory. */
function byLanguage<T>(make: (language: Language) => T): Record<Language, T> {
  return Object.fromEntries(LANGUAGES.map((language) => [language, make(language)])) as Record<Language, T>;
}

/** Same daily timer as orphan cleanup. Age and batch come from the current snapshot. */
async function expireTranscripts(): Promise<void> {
  if (!store) return;
  const log = logger.child({ job: 'retention' });
  const current = configSource.snapshot();
  const olderThan = Date.now() - current.memory.retentionDays * DAY_MS;
  const limit = current.memory.retentionBatch;
  for (const ownerId of store.ownerIds()) {
    for (;;) {
      const started = performance.now();
      let deleted: number;
      try {
        deleted = store.deleteExpiredMessages(ownerId, olderThan, limit);
      } catch {
        log.error('memory_retention_failed');
        break;
      }
      log.info('memory_retention_batch', { deleted, ms: Math.round(performance.now() - started) });
      if (deleted < limit) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Quotes older than the care window can never be asked about; drop them even when care is off (data minimization).
    try {
      const cleared = store.clearStaleCareQuotes(ownerId, Date.now() - current.affect.care.maxAgeDays * DAY_MS);
      if (cleared > 0) log.info('care_quote_retention', { cleared });
    } catch {
      log.error('care_quote_retention_failed');
    }
  }
}

/** Usage rows older than retention.usageDays (admin.json), in batches like transcripts. */
async function expireUsage(): Promise<void> {
  if (!memoryDb) return;
  const olderThan = Date.now() - adminConfig.retention.usageDays * DAY_MS;
  const limit = boot.memory.retentionBatch;
  for (;;) {
    const started = performance.now();
    let deleted: number;
    try {
      deleted = purgeExpiredUsage(memoryDb, olderThan, limit);
    } catch {
      logger.warn('usage_retention_failed', {});
      return;
    }
    logger.info('usage_retention_batch', { deleted, ms: Math.round(performance.now() - started) });
    if (deleted < limit) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Admin trace logs: same daily timer, age from admin.json, batch size from memory.json. */
async function expireLogs(): Promise<void> {
  if (!memoryDb) return;
  const cutoff = Date.now() - adminConfig.retention.logDays * DAY_MS;
  const limit = boot.memory.retentionBatch;
  for (;;) {
    let deleted: number;
    try {
      deleted = deleteLogsBefore(memoryDb, cutoff, limit);
    } catch {
      logger.error('log_retention_failed');
      return;
    }
    if (deleted > 0) logger.info('log_retention_batch', { deleted });
    if (deleted < limit) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// Orphan owners (registered, never connected, older than ORPHAN_OWNER_DAYS): at startup, then daily.
// Message retention uses that same timer. Facts and notes are not deleted by age.
if (registry) {
  const runCleanup = () => {
    registry.cleanupOrphans().catch(() => logger.child({ job: 'orphan_cleanup' }).error('orphan_cleanup_failed'));
    void expireTranscripts().catch(() => logger.child({ job: 'retention' }).error('memory_retention_failed'));
    if (memoryDb) {
      try {
        const deleted = expireAdminAudit(memoryDb, Date.now() - adminConfig.retention.auditDays * DAY_MS);
        if (deleted > 0) logger.info('admin_audit_retention', { deleted });
      } catch {
        logger.error('admin_audit_retention_failed', {});
      }
    }
    void expireLogs().catch(() => logger.error('log_retention_failed'));
    void expireUsage().catch(() => logger.warn('usage_retention_failed', {}));
  };
  void runCleanup();
  setInterval(runCleanup, ORPHAN_CLEANUP_INTERVAL_MS).unref();
}
if (worker && store) {
  // Same-owner jobs still run one after another; each job handles one character.
  for (const { ownerId, agentId } of store.agentsPendingExtraction()) void worker.enqueue(ownerId, agentId, 'startup');
}
