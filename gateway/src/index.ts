import { fileURLToPath } from 'node:url';
import { LANGUAGES, type CharacterId, type Language } from '@anyidea/protocol';
import { SeeduplexAdapter } from './adapters/seeduplex.ts';
import { QwenAdapter } from './adapters/qwen.ts';
import { MockAdapter, loadMockScript, loadMockSpeech, withCharacterName } from './adapters/mock.ts';
import { loadConfig, loadIdentityConfig, makeOriginCheck } from './config.ts';
import { loadCharacterRegistry } from './characters/registry.ts';
import { loadRoleCatalog } from './roles/fileCatalog.ts';
import { missingRoleLanguages } from './roles/catalog.ts';
import { loadAdminConfig } from './log/adminConfig.ts';
import { createLogLevelControl } from './log/levels.ts';
import { createLogger } from './log/logger.ts';
import { SqliteLogSink, deleteLogsBefore } from './log/sqliteSink.ts';
import { stdoutSink } from './log/stdoutSink.ts';
import { loadAffectConfig } from './session/affect.ts';
import { loadMemoryBudget, loadPacing, validateBudgets } from './session/pacing.ts';
import { checkAffectBudgets } from './session/affectRender.ts';
import { devContextResolver } from './session/context.ts';
import { MockSummarizer } from './session/ledger.ts';
import { QwenSummarizer } from './session/qwenSummarizer.ts';
import { SessionManager } from './session/manager.ts';
import { Session } from './session/session.ts';
import { createGatewayServer } from './server/server.ts';
import { DeviceRegistry, ORPHAN_CLEANUP_INTERVAL_MS } from './identity/registry.ts';
import { createMemoryService } from './identity/memoryService.ts';
import { backfillKanaBigrams } from './memory/backfill.ts';
import { openDatabase } from './memory/db.ts';
import { SqliteMemoryStore } from './memory/store.ts';
import { QwenTextClient } from './memory/textClient.ts';
import { MemoryWorker, withExtraction } from './memory/worker.ts';
import { SqliteTranscriptWriter } from './memory/writer.ts';
import { loadI18n } from './i18n/load.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig();
const adminConfig = loadAdminConfig(`${root}config/admin.json`);
// Device identity (Plan B). MEMORY_DB_PATH unset = dev mode: no registration, no memory, bearers rejected.
const identityConfig = loadIdentityConfig(process.env, fileURLToPath(new URL('../..', import.meta.url)));
const memoryDb = identityConfig.memoryDbPath ? openDatabase(identityConfig.memoryDbPath, { busyTimeoutMs: identityConfig.busyTimeoutMs }) : null;
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
// Character cards (gateway/characters/): the id set must equal protocol CHARACTER_IDS, or startup fails.
const characters = loadCharacterRegistry(`${root}characters`, LANGUAGES);
logger.info('characters_loaded', { count: characters.ids().length });
// File-backed roles (M1): gateway/roles/<role>/<language>/ + gateway/roles/_shared/<language>/.
const roles = loadRoleCatalog(`${root}roles`, characters);
for (const characterId of characters.ids()) {
  const roleId = characters.roleOf(characterId);
  const missingLanguages = missingRoleLanguages(roles, roleId, LANGUAGES);
  if (missingLanguages.length > 0) throw new Error(`role_languages_incomplete:${roleId}:${missingLanguages.join(',')}`);
}
const pacing = loadPacing(`${root}config/pacing.json`);
const memory = loadMemoryBudget(`${root}config/memory.json`);
const i18n = loadI18n(`${root}config`);
const affect = loadAffectConfig(`${root}config/affect.json`);
const personasByLanguage: Partial<Record<Language, string[]>> = {};
for (const pair of roles.characterLanguagePairs()) {
  (personasByLanguage[pair.language] ??= []).push(roles.buildPersona(pair.characterId, pair.language));
}
const budgetReport = validateBudgets(pacing, memory, config.ledger, personasByLanguage);
// Every language's longest affect render must fit its reserved room; otherwise refuse to start.
checkAffectBudgets(budgetReport.budgets, i18n.affect);
const languageBudgetFields: Record<string, number> = {};
for (const language of LANGUAGES) {
  const budget = budgetReport.budgets[language];
  const perLanguage = budgetReport.perLanguage[language];
  if (!budget || !perLanguage) continue;
  languageBudgetFields[`${language}TotalChars`] = budget.totalChars;
  languageBudgetFields[`${language}MinHistoryChars`] = perLanguage.minHistoryChars;
  languageBudgetFields[`${language}AffectMaxChars`] = budget.affectMaxChars ?? 0;
  languageBudgetFields[`${language}PinnedMaxChars`] = budget.pinnedMaxChars ?? 0;
}
logger.info('instruction_budget', {
  totalChars: budgetReport.budget.totalChars,
  minHistoryChars: budgetReport.minHistoryChars,
  ledgerCapped: budgetReport.ledgerCapped,
  ...languageBudgetFields,
});
for (const pair of roles.characterLanguagePairs()) {
  const keywords = i18n.memory[pair.language].noticeKeywords;
  const text = roles.director(pair.characterId, pair.language).memoryNoticeText;
  if (!keywords.some((keyword) => text.includes(keyword))) {
    throw new Error(`memory_notice_keyword_missing:${pair.characterId}:${pair.language}`);
  }
}
logger.info('safety_rules', {
  rejectPhrases: i18n.safety.rejectPhrases.length,
  degradePhrases: i18n.safety.degradePhrases.length,
  markPhrases: i18n.safety.markPhrases.length,
  invisibleCodePoints: i18n.safety.invisibleCodePoints.length,
});
const script = loadMockScript(`${root}mock/script.json`);
const speech = loadMockSpeech(`${root}mock/speech-24k.pcm`);
if (!speech) logger.warn('mock_speech_missing', { hint: 'run scripts/make-mock-speech.sh' });
const store = memoryDb ? new SqliteMemoryStore(memoryDb) : null;
if (store) {
  // This process is the only gateway for the DB: any row still open belongs to a dead process.
  const reconciled = store.closeOpenSessions(Date.now());
  if (reconciled > 0) logger.info('sessions_reconciled', { count: reconciled });
  // One bounded pass over rows written before kana tokens existed. Never log message text.
  const backfilled = backfillKanaBigrams(store, memory.kanaBackfillBatch ?? 500);
  if (backfilled > 0) logger.info('kana_bigram_backfill', { changed: backfilled });
}
const registry = store
  ? new DeviceRegistry({
      store,
      roles,
      characters,
      limits: {
        maxOwners: identityConfig.maxOwners,
        dailyCap: identityConfig.registerDailyCap,
        orphanOwnerDays: identityConfig.orphanOwnerDays,
        orphanCleanupBatch: identityConfig.orphanCleanupBatch,
      },
      continuityGapMs: pacing.restReminder.continuityGapMs,
      i18n,
      logger,
    })
  : null;
logger.info('identity_mode', { enabled: registry !== null, devEndpoints: identityConfig.enableDevEndpoints });
const memoryService = store ? createMemoryService({ store, safety: i18n.safety, logger }) : undefined;
const writer = store ? new SqliteTranscriptWriter(store, i18n.safety, logger) : undefined;
const textClient = config.qwenApiKey && config.summarizerEndpoint
  ? new QwenTextClient({
      apiKey: config.qwenApiKey,
      endpoint: config.summarizerEndpoint,
      model: memory.extractModel ?? 'qwen-plus',
      logger,
    })
  : null;
const worker = store && textClient
  ? new MemoryWorker({
      store,
      client: textClient,
      systemPrompts: byLanguage((language) => roles.extractPrompt(language)),
      labels: byLanguage((language) => i18n.memory[language].extractLabels),
      maxTokens: memory.extractMaxTokens ?? 800,
      policy: memory.extractPolicy ?? pacing.policies.summarize,
      transcriptMaxChars: memory.extractTranscriptMaxChars ?? 6_000,
      contextMaxChars: memory.extractContextMaxChars ?? 4_000,
      // Care quotes are stored only while the care feature is on (data minimization).
      ...(affect.enabled ? { quote: { maxChars: affect.care.quoteMaxChars, safety: i18n.safety, evidence: i18n.evidence } } : {}),
      logger,
    })
  : null;
// session.start() may wait up to care.timeoutMs for the care line; it must fit inside the start timeout.
if (affect.enabled && affect.care.timeoutMs >= config.sessionStartTimeoutMs) {
  throw new Error(`care_timeout_exceeds_session_start: ${affect.care.timeoutMs} >= ${config.sessionStartTimeoutMs}`);
}
if (store && !textClient) logger.warn('memory_extract_unconfigured');
// Sessions get the text client only for real adapters; Mock runs stay lexicon-only.
logger.info('affect_analyzer', { enabled: affect.enabled && config.adapter !== 'mock' && textClient !== null });
const manager = new SessionManager(
  (ctx, sessionId, noticePending = false) =>
    new Session({
      logger,
      adapterFactory: () => config.adapter === 'seeduplex'
        ? new SeeduplexAdapter({ apiKey: config.seeduplexApiKey!, endpoint: config.seeduplexEndpoint, model: config.seeduplexModel, voice: config.seeduplexVoice })
        : config.adapter === 'qwen'
          ? new QwenAdapter({ apiKey: config.qwenApiKey!, endpoint: config.qwenEndpoint, model: config.qwenModel, voice: config.qwenVoice })
          : new MockAdapter({ script: withCharacterName(script, characters.name(ctx.characterId, 'zh')), speech, speechThreshold: config.mockSpeechThreshold, paceFactor: config.mockPaceFactor }),
      summarizer: config.summarizer === 'qwen'
        ? new QwenSummarizer({ apiKey: config.qwenApiKey!, endpoint: config.summarizerEndpoint, model: config.summarizerModel })
        : new MockSummarizer(),
      roles,
      characters,
      ledger: config.ledger,
      ...(config.adapter !== 'mock' && textClient ? { textClient } : {}),
      confirmWindowMs: config.confirmWindowMs,
      rebuildBackoffBaseMs: config.rebuildBackoffBaseMs,
      rebuildBackoffMaxMs: config.rebuildBackoffMaxMs,
      modelOwnsTurns: config.adapter === 'qwen',
      voiceFor: (language) => adapterVoice(ctx.characterId, language),
      budget: budgetReport.budget,
      budgets: budgetReport.budgets,
      i18n,
      ...(memory.recallClipChars !== undefined ? { recallClipChars: memory.recallClipChars } : {}),
      ...(memory.recallPhraseTimeoutMs !== undefined ? { recallPhraseTimeoutMs: memory.recallPhraseTimeoutMs } : {}),
      noticeKeywordsByLanguage: Object.fromEntries(
        LANGUAGES.map((language) => [language, i18n.memory[language].noticeKeywords]),
      ) as Record<Language, readonly string[]>,
      modelContextTokenLimit: pacing.rebuild.contextChars,
      rebuildTriggerRatio: pacing.rebuild.triggerRatio,
      rebuildAfterTurns: pacing.rebuild.afterTurns,
      summarizePolicy: pacing.policies.summarize,
      ...(pacing.output.maxTokens !== null ? { maxOutputTokens: pacing.output.maxTokens } : {}),
      tailGuardMs: pacing.tailGuardMs,
      slim: pacing.slim,
      push: pacing.push,
      restReminder: pacing.restReminder,
      toolTurnTimeoutMs: memory.toolTurnTimeoutMs,
      pin: { maxPerCharacter: memory.pinMaxPerCharacter, maxChars: memory.pinMaxChars, finalWaitMs: memory.pinFinalWaitMs },
      listMaxItems: memory.listMaxItems,
      emotion: i18n.emotion,
      affect,
      languageRules: i18n.language,
      ...(store ? { store } : {}),
      ...(writer ? { writer } : {}),
      ...(worker ? {
        worker,
        extractEveryUserTurns: memory.extractEveryUserTurns ?? 10,
        extractSilenceMs: memory.extractSilenceMs ?? 180_000,
      } : {}),
    }, ctx, sessionId, noticePending),
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
  contextResolver: registry ?? devContextResolver(roles, characters),
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
});

server.listen(config.port, '0.0.0.0', () => logger.info('gateway_listening', { port: config.port, adapter: config.adapter }));

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
  void (async () => {
    try {
      if (worker) await worker.drain(memory.extractDrainMs ?? 8_000);
    } finally {
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

/** Character card voice for the active adapter, then the env default. Seeduplex has no Japanese voice. */
function adapterVoice(characterId: CharacterId, language: Language): string | undefined {
  if (config.adapter === 'qwen') return characters.voiceFor(characterId, 'qwen', language) ?? config.qwenVoices[language];
  if (config.adapter === 'seeduplex') {
    return language === 'ja' ? undefined : characters.voiceFor(characterId, 'seeduplex', language) ?? config.seeduplexVoices[language];
  }
  return undefined;
}

/** Same daily timer as orphan cleanup. Age and batch come from memory.json. */
async function expireTranscripts(): Promise<void> {
  if (!store) return;
  const log = logger.child({ job: 'retention' });
  const olderThan = Date.now() - memory.retentionDays * DAY_MS;
  const limit = memory.retentionBatch;
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
      const cleared = store.clearStaleCareQuotes(ownerId, Date.now() - affect.care.maxAgeDays * DAY_MS);
      if (cleared > 0) log.info('care_quote_retention', { cleared });
    } catch {
      log.error('care_quote_retention_failed');
    }
  }
}

/** Admin trace logs: same daily timer, age from admin.json, batch size from memory.json. */
async function expireLogs(): Promise<void> {
  if (!memoryDb) return;
  const cutoff = Date.now() - adminConfig.retention.logDays * DAY_MS;
  for (;;) {
    let deleted: number;
    try {
      deleted = deleteLogsBefore(memoryDb, cutoff, memory.retentionBatch);
    } catch {
      logger.error('log_retention_failed');
      return;
    }
    if (deleted > 0) logger.info('log_retention_batch', { deleted });
    if (deleted < memory.retentionBatch) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// Orphan owners (registered, never connected, older than ORPHAN_OWNER_DAYS): at startup, then daily.
// Message retention uses that same timer. Facts and notes are not deleted by age.
if (registry) {
  const runCleanup = () => {
    registry.cleanupOrphans().catch(() => logger.child({ job: 'orphan_cleanup' }).error('orphan_cleanup_failed'));
    void expireTranscripts().catch(() => logger.child({ job: 'retention' }).error('memory_retention_failed'));
    void expireLogs().catch(() => logger.error('log_retention_failed'));
  };
  void runCleanup();
  setInterval(runCleanup, ORPHAN_CLEANUP_INTERVAL_MS).unref();
}
if (worker && store) {
  // Same-owner jobs still run one after another; each job handles one character.
  for (const { ownerId, agentId } of store.agentsPendingExtraction()) void worker.enqueue(ownerId, agentId, 'startup');
}
