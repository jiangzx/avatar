// Live probe: node --env-file-if-exists=gateway/.env --import tsx docs/testing/plan4-qwen-session-update-probe.mjs
// One combined instructions+voice update on an idle Qwen session must not error and must keep the session usable.
import { QwenAdapter } from '../../gateway/src/adapters/qwen.ts';
import { loadConfig } from '../../gateway/src/config.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // Same defaults as production: QwenOptions.voice is required and its default lives in loadConfig, not the adapter.
  const config = loadConfig({ ...process.env, ADAPTER: 'qwen' });
  if (!config.qwenApiKey) throw new Error('probe_env_missing');
  const adapter = new QwenAdapter({
    apiKey: config.qwenApiKey,
    endpoint: config.qwenEndpoint,
    model: config.qwenModel,
    voice: config.qwenVoices.zh,
  });
  const errors = [];
  let started = 0;
  let audioBytes = 0;
  let done = 0;
  adapter.on('error', (code) => errors.push(code));
  adapter.on('responseStarted', () => { started += 1; });
  adapter.on('audioDelta', (_id, pcm) => { audioBytes += pcm.byteLength; });
  adapter.on('responseDone', () => { done += 1; });
  await adapter.connect({ instructions: '你是一个简短回答的助手。', tools: [] });
  if (!adapter.updateSession) throw new Error('updateSession_missing');
  adapter.updateSession({ instructions: '你是一个简短回答的助手，每次只说一句。', voice: { value: config.qwenVoices.zh } });
  await sleep(2_000);
  adapter.createResponse({ cue: 'greeting', instruction: '请用一句话打个招呼。', fallbackText: '你好。' });
  for (let i = 0; i < 40 && done === 0; i++) await sleep(250);
  adapter.close();
  console.log(JSON.stringify({ errors, started, audio: audioBytes > 0, done }));
  process.exit(errors.length === 0 && started > 0 && audioBytes > 0 && done > 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'probe_failed' }));
  process.exit(1);
});
