import { fileURLToPath } from 'node:url';
import { SeeduplexAdapter } from './adapters/seeduplex.ts';
import { QwenAdapter } from './adapters/qwen.ts';
import { MockAdapter, loadMockScript, loadMockSpeech } from './adapters/mock.ts';
import { loadConfig, makeOriginCheck } from './config.ts';
import { loadRoleCatalog } from './roles/fileCatalog.ts';
import { log } from './log.ts';
import { loadMemoryBudget, loadPacing, validateBudgets } from './session/pacing.ts';
import { devContextResolver } from './session/context.ts';
import { MockSummarizer } from './session/ledger.ts';
import { QwenSummarizer } from './session/qwenSummarizer.ts';
import { SessionManager } from './session/manager.ts';
import { Session } from './session/session.ts';
import { createGatewayServer } from './server/server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig();
// File-backed roles (Plan A): gateway/roles/<role>/ + gateway/roles/_shared/.
const roles = loadRoleCatalog(`${root}roles`);
const pacing = loadPacing(`${root}config/pacing.json`);
const budgetReport = validateBudgets(pacing, loadMemoryBudget(`${root}config/memory.json`), config.ledger, roles.pairs().map((p) => roles.buildPersona(p.roleId, p.styleId)));
log('instruction_budget', { totalChars: budgetReport.budget.totalChars, minHistoryChars: budgetReport.minHistoryChars, ledgerCapped: budgetReport.ledgerCapped });
const script = loadMockScript(`${root}mock/script.json`);
const speech = loadMockSpeech(`${root}mock/speech-24k.pcm`);
if (!speech) log('mock_speech_missing', { hint: 'run scripts/make-mock-speech.sh' });
const manager = new SessionManager(
  (ctx) =>
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
    }, ctx),
  config.sessionGraceMs,
  config.sessionUnclaimedMs,
  config.sessionStartTimeoutMs,
);
const server = createGatewayServer({
  manager,
  appSecret: config.appSecret,
  // Wiring point: Plan B swaps in the MemoryStore-backed resolver here.
  contextResolver: devContextResolver(roles),
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
