import { fileURLToPath } from 'node:url';
import { LANGUAGES, type Language } from '@anyidea/protocol';
import { SeeduplexAdapter } from './adapters/seeduplex.ts';
import { QwenAdapter } from './adapters/qwen.ts';
import { MockAdapter, loadMockScript, loadMockSpeech } from './adapters/mock.ts';
import { loadConfig, loadIdentityConfig, makeOriginCheck } from './config.ts';
import { loadRoleCatalog } from './roles/fileCatalog.ts';
import { DEFAULT_ROLE, missingRoleLanguages } from './roles/catalog.ts';
import { log } from './log.ts';
import { loadMemoryBudget, loadPacing, validateBudgets } from './session/pacing.ts';
import { devContextResolver } from './session/context.ts';
import { MockSummarizer } from './session/ledger.ts';
import { QwenSummarizer } from './session/qwenSummarizer.ts';
import { SessionManager } from './session/manager.ts';
import { Session } from './session/session.ts';
import { createGatewayServer } from './server/server.ts';
import { DeviceRegistry, ORPHAN_CLEANUP_INTERVAL_MS } from './identity/registry.ts';
import { backfillKanaBigrams } from './memory/backfill.ts';
import { openDatabase } from './memory/db.ts';
import { SqliteMemoryStore } from './memory/store.ts';
import { QwenTextClient } from './memory/textClient.ts';
import { MemoryWorker, withExtraction } from './memory/worker.ts';
import { SqliteTranscriptWriter } from './memory/writer.ts';
import { loadI18n } from './i18n/load.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig();
// File-backed roles (M1): gateway/roles/<role>/<language>/ + gateway/roles/_shared/<language>/.
const roles = loadRoleCatalog(`${root}roles`);
const missingLanguages = missingRoleLanguages(roles, DEFAULT_ROLE, LANGUAGES);
if (missingLanguages.length > 0) throw new Error(`role_languages_incomplete:${DEFAULT_ROLE}:${missingLanguages.join(',')}`);
const pacing = loadPacing(`${root}config/pacing.json`);
const memory = loadMemoryBudget(`${root}config/memory.json`);
const i18n = loadI18n(`${root}config`);
const personasByLanguage: Partial<Record<Language, string[]>> = {};
for (const pair of roles.languagePairs()) {
  (personasByLanguage[pair.language] ??= []).push(roles.buildPersona(pair.roleId, pair.styleId, pair.language));
}
const budgetReport = validateBudgets(pacing, memory, config.ledger, personasByLanguage);
const languageBudgetFields: Record<string, number> = {};
for (const language of LANGUAGES) {
  const budget = budgetReport.budgets[language];
  const perLanguage = budgetReport.perLanguage[language];
  if (!budget || !perLanguage) continue;
  languageBudgetFields[`${language}TotalChars`] = budget.totalChars;
  languageBudgetFields[`${language}MinHistoryChars`] = perLanguage.minHistoryChars;
}
log('instruction_budget', {
  totalChars: budgetReport.budget.totalChars,
  minHistoryChars: budgetReport.minHistoryChars,
  ledgerCapped: budgetReport.ledgerCapped,
  ...languageBudgetFields,
});
for (const pair of roles.languagePairs()) {
  const keywords = i18n.memory[pair.language].noticeKeywords;
  const text = roles.director(pair.roleId, pair.language).memoryNoticeText;
  if (!keywords.some((keyword) => text.includes(keyword))) {
    throw new Error(`memory_notice_keyword_missing:${pair.roleId}:${pair.language}`);
  }
}
log('safety_rules', {
  rejectPhrases: i18n.safety.rejectPhrases.length,
  degradePhrases: i18n.safety.degradePhrases.length,
  markPhrases: i18n.safety.markPhrases.length,
  invisibleCodePoints: i18n.safety.invisibleCodePoints.length,
});
const script = loadMockScript(`${root}mock/script.json`);
const speech = loadMockSpeech(`${root}mock/speech-24k.pcm`);
if (!speech) log('mock_speech_missing', { hint: 'run scripts/make-mock-speech.sh' });
// Device identity (Plan B). MEMORY_DB_PATH unset = dev mode: no registration, no memory, bearers rejected.
const identityConfig = loadIdentityConfig(process.env, fileURLToPath(new URL('../..', import.meta.url)));
const memoryDb = identityConfig.memoryDbPath ? openDatabase(identityConfig.memoryDbPath, { busyTimeoutMs: identityConfig.busyTimeoutMs }) : null;
const store = memoryDb ? new SqliteMemoryStore(memoryDb) : null;
if (store) {
  // This process is the only gateway for the DB: any row still open belongs to a dead process.
  const reconciled = store.closeOpenSessions(Date.now());
  if (reconciled > 0) log('sessions_reconciled', { count: reconciled });
  // One bounded pass over rows written before kana tokens existed. Never log message text.
  const backfilled = backfillKanaBigrams(store, memory.kanaBackfillBatch ?? 500);
  if (backfilled > 0) log('kana_bigram_backfill', { changed: backfilled });
}
const registry = store
  ? new DeviceRegistry({
      store,
      roles,
      limits: {
        maxOwners: identityConfig.maxOwners,
        dailyCap: identityConfig.registerDailyCap,
        orphanOwnerDays: identityConfig.orphanOwnerDays,
        orphanCleanupBatch: identityConfig.orphanCleanupBatch,
      },
      i18n,
    })
  : null;
log('identity_mode', { enabled: registry !== null, devEndpoints: identityConfig.enableDevEndpoints });
const writer = store ? new SqliteTranscriptWriter(store, i18n.safety) : undefined;
const textClient = config.qwenApiKey && config.summarizerEndpoint
  ? new QwenTextClient({
      apiKey: config.qwenApiKey,
      endpoint: config.summarizerEndpoint,
      model: memory.extractModel ?? 'qwen-plus',
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
    })
  : null;
if (store && !textClient) log('memory_extract_unconfigured', {});
const manager = new SessionManager(
  (ctx, sessionId, noticePending = false) =>
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
      ...(config.adapter !== 'mock' && textClient ? { textClient } : {}),
      confirmWindowMs: config.confirmWindowMs,
      rebuildBackoffBaseMs: config.rebuildBackoffBaseMs,
      rebuildBackoffMaxMs: config.rebuildBackoffMaxMs,
      modelOwnsTurns: config.adapter === 'qwen',
      voiceFor: (language) => {
        if (config.adapter === 'qwen') return config.qwenVoices[language];
        if (config.adapter === 'seeduplex') return language === 'ja' ? undefined : config.seeduplexVoices[language];
        return undefined;
      },
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
      toolTurnTimeoutMs: memory.toolTurnTimeoutMs,
      emotion: i18n.emotion,
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
  resumeRateLimit: { max: config.resumeRateLimitMax, windowMs: config.resumeRateLimitWindowMs },
  trustProxy: config.trustProxy,
});

server.listen(config.port, '0.0.0.0', () => log('gateway_listening', { port: config.port, adapter: config.adapter }));

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
        if (memoryDb?.isOpen) memoryDb.close();
      } catch {
        log('memory_db_close_failed', {});
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

/** Same daily timer as orphan cleanup. Age and batch come from memory.json. */
async function expireTranscripts(): Promise<void> {
  if (!store) return;
  const olderThan = Date.now() - memory.retentionDays * DAY_MS;
  const limit = memory.retentionBatch;
  for (const ownerId of store.ownerIds()) {
    for (;;) {
      const started = performance.now();
      let deleted: number;
      try {
        deleted = store.deleteExpiredMessages(ownerId, olderThan, limit);
      } catch {
        log('memory_retention_failed', {});
        break;
      }
      log('memory_retention_batch', { deleted, ms: Math.round(performance.now() - started) });
      if (deleted < limit) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

// Orphan owners (registered, never connected, older than ORPHAN_OWNER_DAYS): at startup, then daily.
// Message retention uses that same timer. Facts and notes are not deleted by age.
if (registry) {
  const runCleanup = () => {
    registry.cleanupOrphans().catch(() => log('orphan_cleanup_failed', {}));
    void expireTranscripts().catch(() => log('memory_retention_failed', {}));
  };
  void runCleanup();
  setInterval(runCleanup, ORPHAN_CLEANUP_INTERVAL_MS).unref();
}
if (worker && store) {
  for (const ownerId of store.ownersPendingExtraction()) void worker.extractOwner(ownerId, 'startup');
}
