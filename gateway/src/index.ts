import { fileURLToPath } from 'node:url';
import { SeeduplexAdapter } from './adapters/seeduplex.ts';
import { QwenAdapter } from './adapters/qwen.ts';
import { MockAdapter, loadMockScript, loadMockSpeech } from './adapters/mock.ts';
import { loadConfig, loadDirectorConfig, loadPersona, makeOriginCheck } from './config.ts';
import { log } from './log.ts';
import { MockSummarizer } from './session/ledger.ts';
import { QwenSummarizer } from './session/qwenSummarizer.ts';
import { SessionManager } from './session/manager.ts';
import { Session } from './session/session.ts';
import { createGatewayServer } from './server/server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = loadConfig();
const director = loadDirectorConfig(`${root}config/director.json`);
const persona = loadPersona(`${root}prompts/persona.md`);
const script = loadMockScript(`${root}mock/script.json`);
const speech = loadMockSpeech(`${root}mock/speech-24k.pcm`);
if (!speech) log('mock_speech_missing', { hint: 'run scripts/make-mock-speech.sh' });
// Lets the mock answer each Director instruction with the matching scripted line (idle notice, resume line, ...).
const instructionReplies = new Map([
  [director.greetingInstruction, script.greeting],
  [director.followupInstruction, script.followup],
  [director.idleNoticeInstruction, script.idleNotice ?? script.followup],
  [director.resumeInstruction, script.resume ?? script.followup],
]);
const proactiveTexts = new Map([
  [director.greetingInstruction, director.greetingText],
  [director.followupInstruction, director.followupText],
  [director.idleNoticeInstruction, director.idleNoticeText],
  [director.resumeInstruction, director.resumeText],
]);

const manager = new SessionManager(
  () =>
    new Session({
      adapterFactory: () => config.adapter === 'seeduplex'
        ? new SeeduplexAdapter({ apiKey: config.seeduplexApiKey!, endpoint: config.seeduplexEndpoint, model: config.seeduplexModel, voice: config.seeduplexVoice, proactiveTexts })
        : config.adapter === 'qwen'
          ? new QwenAdapter({ apiKey: config.qwenApiKey!, endpoint: config.qwenEndpoint, model: config.qwenModel, voice: config.qwenVoice })
          : new MockAdapter({ script, speech, instructionReplies, speechThreshold: config.mockSpeechThreshold, paceFactor: config.mockPaceFactor }),
      summarizer: config.summarizer === 'qwen'
        ? new QwenSummarizer({ apiKey: config.qwenApiKey!, endpoint: config.summarizerEndpoint, model: config.summarizerModel })
        : new MockSummarizer(),
      persona,
      director,
      ledger: config.ledger,
      confirmWindowMs: config.confirmWindowMs,
      rebuildBackoffBaseMs: config.rebuildBackoffBaseMs,
      rebuildBackoffMaxMs: config.rebuildBackoffMaxMs,
      modelOwnsTurns: config.adapter === 'qwen',
    }),
  config.sessionGraceMs,
  config.sessionUnclaimedMs,
  config.sessionStartTimeoutMs,
);
const server = createGatewayServer({
  manager,
  appSecret: config.appSecret,
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
