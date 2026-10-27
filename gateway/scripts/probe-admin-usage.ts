// Live probe for the admin plan (P1-T1). Synthetic input only; prints event types, key paths and numbers, never text.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-admin-usage.ts --wav /tmp/probe-16k.wav
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { baseSession, probeEnv, QwenRaw, readWavPcm16, sleep, userText, type Json } from './lib/qwen-raw.ts';
import { expectedAudioTokens, idLikeHeaderNames, idLikePaths, leafShape, usagePaths } from './lib/usage-probe.ts';

const env = probeEnv();
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);
const SYNTHETIC_INSTRUCTIONS = '你是测试助手。每次只用一句很短的中文回答。';
const SYNTHETIC_QUESTION = '请用一句话打个招呼。';
const QWEN_INPUT_AUDIO_TOKENS_PER_SECOND = 7; // official, help.aliyun.com/zh/model-studio/qwen3-8-omni-flash-realtime
const memoryConfig = JSON.parse(readFileSync(fileURLToPath(new URL('../config/memory.json', import.meta.url)), 'utf8')) as { extractModel?: string };

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Realtime text turn: usage shape of response.done. */
async function realtimeText(): Promise<void> {
  const c = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(SYNTHETIC_INSTRUCTIONS, env.voice) });
  const r = await c.collect(() => { c.send(userText(SYNTHETIC_QUESTION)); c.send({ type: 'response.create' }); });
  out({ probe: 'realtime_text', status: r.status, error: r.error, usage: leafShape(r.usage) });
  c.close();
}

/** A1: realtime audio turn. Which events carry usage, and do audio tokens match the per-second rule? */
async function realtimeAudio(wavPath: string): Promise<void> {
  const pcm = readWavPcm16(wavPath);
  const seconds = pcm.length / 16_000;
  const c = await QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(SYNTHETIC_INSTRUCTIONS, env.voice) });
  const done = c.waitFor((e) => e.type === 'response.done' || e.type === 'error', 60_000);
  const frame = 1_600; // 100 ms at 16 kHz
  for (let offset = 0; offset < pcm.length; offset += frame) {
    c.sendPcm16k(pcm.subarray(offset, offset + frame));
    await sleep(100);
  }
  // 1.5 s of silence lets semantic VAD close the turn.
  for (let i = 0; i < 15; i++) { c.sendPcm16k(new Int16Array(frame)); await sleep(100); }
  const final = await done;
  await sleep(2_000); // late events (e.g. transcription usage) still land in c.events
  const carriers = c.events
    .map(({ event }) => ({ type: String(event.type ?? ''), paths: usagePaths(event) }))
    .filter((row) => row.paths.length > 0);
  const response = (final?.response ?? {}) as Json;
  const details = (response.usage as Json | undefined)?.input_tokens_details as Json | undefined;
  out({
    probe: 'realtime_audio',
    seconds: Math.round(seconds * 100) / 100,
    finalType: final?.type ?? 'timeout',
    usageCarriers: carriers,
    usage: leafShape(response.usage),
    expectedInputAudioTokens: expectedAudioTokens(seconds, QWEN_INPUT_AUDIO_TOKENS_PER_SECOND),
    reportedInputAudioTokens: typeof details?.audio_tokens === 'number' ? details.audio_tokens : null,
    eventTypes: [...new Set(c.events.map(({ event }) => String(event.type ?? '')))],
  });
  c.close();
}

/** A4: handshake header names, and the id-like fields of a provoked error event. */
async function realtimeError(): Promise<void> {
  const url = new URL(env.endpoint);
  url.searchParams.set('model', env.model);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${env.apiKey}` }, perMessageDeflate: false });
  // ws emits 'upgrade' and 'open' in the same tick, so both listeners must exist before awaiting.
  const headerNames = await new Promise<string[]>((resolve, reject) => {
    let names: string[] = [];
    ws.once('upgrade', (res) => { names = Object.keys(res.headers); });
    ws.once('open', () => resolve(names));
    ws.once('error', reject);
  });
  const errorEvent = await new Promise<Json | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    ws.on('message', (data) => {
      let e: Json;
      try { e = JSON.parse(data.toString()) as Json; } catch { return; }
      if (e.type === 'error') { clearTimeout(timer); resolve(e); }
    });
    ws.send(JSON.stringify({ type: 'probe.invalid_event' }));
  });
  out({
    probe: 'realtime_error',
    handshakeIdHeaders: idLikeHeaderNames(headerNames),
    errorShape: errorEvent ? leafShape(errorEvent) : null,
    errorIdPaths: errorEvent ? idLikePaths(errorEvent) : [],
  });
  ws.close();
}

/** A5 (+A4 for text): OpenAI-compatible usage shape, id headers, and an error body shape. */
async function textModel(model: string): Promise<void> {
  const endpoint = process.env.QWEN_SUMMARIZER_ENDPOINT ?? '';
  if (!endpoint) throw new Error('QWEN_SUMMARIZER_ENDPOINT must be set (gateway/.env)');
  const call = (body: Json) => fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ok = await call({ model, messages: [{ role: 'system', content: SYNTHETIC_INSTRUCTIONS }, { role: 'user', content: SYNTHETIC_QUESTION }], max_tokens: 30, temperature: 0 });
  const okBody = await ok.json() as Json;
  out({
    probe: 'text_ok',
    model,
    status: ok.status,
    idHeaders: idLikeHeaderNames(ok.headers.keys()),
    bodyIdPaths: idLikePaths(okBody),
    usage: leafShape(okBody.usage),
  });
  const bad = await call({ model: 'probe-invalid-model', messages: [{ role: 'user', content: SYNTHETIC_QUESTION }], max_tokens: 5 });
  const badBody = await bad.json().catch(() => ({})) as Json;
  out({ probe: 'text_error', status: bad.status, idHeaders: idLikeHeaderNames(bad.headers.keys()), bodyIdPaths: idLikePaths(badBody), errorShape: leafShape(badBody) });
}

const wav = argValue('--wav');
if (!wav) throw new Error('usage: probe-admin-usage.ts --wav <16 kHz mono 16-bit wav of a synthetic sentence>');
await realtimeText();
await realtimeAudio(wav);
await realtimeError();
await textModel(memoryConfig.extractModel ?? 'qwen-plus');
await textModel(process.env.QWEN_SUMMARIZER_MODEL ?? 'qwen-flash');
