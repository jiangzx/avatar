// gateway/scripts/probe-qwen-languages.ts
// Manual multilingual probe. Synthetic prompts/audio only; prints flags and event counts, never transcript text.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-qwen-languages.ts text|audio|switch [--wav-zh f --wav-ja f --wav-en f]
import {
  baseSession,
  probeEnv,
  QwenRaw,
  readWavPcm16,
  sleep,
  userText,
  type Json,
} from './lib/qwen-raw.ts';

const env = probeEnv();
const [mode = '', ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

const TEXTS = {
  zh: '你好，今天天气怎么样？',
  ja: 'こんにちは、今日の天気はどうですか？',
  en: 'Hello, how is the weather today?',
} as const;
type ProbeLanguage = keyof typeof TEXTS;

const INSTRUCTIONS = '你是一个多语言语音助手。用户用什么语言提问，你就用同一种语言简短回答。不要翻译成其他语言。';

function flags(text: string): Json {
  return {
    chars: text.length,
    hiragana: /[\p{Script=Hiragana}]/u.test(text),
    katakana: /[\p{Script=Katakana}]/u.test(text),
    han: /[\p{Script=Han}]/u.test(text),
    latin: /[\p{Script=Latin}]/u.test(text),
  };
}

function open(instructions: string, voice: string): Promise<QwenRaw> {
  return QwenRaw.open({
    apiKey: env.apiKey,
    endpoint: env.endpoint,
    model: env.model,
    session: baseSession(instructions, voice),
  });
}

async function collectText(c: QwenRaw, text: string) {
  return c.collect(() => {
    c.send(userText(text));
    c.send({ type: 'response.create' });
  });
}

async function probeText(): Promise<void> {
  for (const language of ['zh', 'ja', 'en'] as const) {
    const c = await open(INSTRUCTIONS, env.voice);
    const r = await collectText(c, TEXTS[language]);
    c.close();
    out({
      mode: 'text',
      language,
      status: r.status,
      error: r.error,
      reply: flags(r.transcript),
      audioBytes: r.audio.length * 2,
    });
  }
}

async function stream(c: QwenRaw, pcm: Int16Array): Promise<void> {
  for (let o = 0; o < pcm.length; o += 320) {
    c.sendPcm16k(pcm.subarray(o, Math.min(o + 320, pcm.length)));
    await sleep(20);
  }
  const tail = new Int16Array(16000 * 1.5);
  for (let o = 0; o < tail.length; o += 320) {
    c.sendPcm16k(tail.subarray(o, Math.min(o + 320, tail.length)));
    await sleep(20);
  }
}

async function probeAudio(): Promise<void> {
  for (const language of ['zh', 'ja', 'en'] as const) {
    const wav = flag(`wav-${language}`);
    if (!wav) {
      out({ mode: 'audio', language, skipped: 'missing_wav' });
      continue;
    }
    const pcm = readWavPcm16(wav);
    const c = await open(INSTRUCTIONS, env.voice);
    const start = c.events.length;
    await stream(c, pcm);
    await c.waitFor((e) => e.type === 'response.done' || e.type === 'error', 25_000);
    const events = c.events.slice(start).map((e) => e.event);
    const asr = events
      .filter((e) => e.type === 'conversation.item.input_audio_transcription.completed')
      .map((e) => String(e.transcript ?? ''))
      .join(' ');
    const reply = events
      .filter((e) => e.type === 'response.audio_transcript.delta')
      .map((e) => String(e.delta ?? ''))
      .join('');
    const audioBytes = events
      .filter((e) => e.type === 'response.audio.delta')
      .reduce((n, e) => n + Buffer.from(String(e.delta ?? ''), 'base64').length, 0);
    c.close();
    out({
      mode: 'audio',
      language,
      asr: flags(asr),
      reply: flags(reply),
      audioBytes,
      errors: events.filter((e) => e.type === 'error').length,
    });
  }
}

async function probeSwitch(): Promise<void> {
  const c = await open(INSTRUCTIONS, env.voice);
  const run = async (language: ProbeLanguage, instructions: string) => {
    const r = await collectText(c, TEXTS[language]);
    out({ mode: 'switch', language, status: r.status, error: r.error, reply: flags(r.transcript) });
  };
  await run('zh', INSTRUCTIONS);
  c.send({ type: 'session.update', session: baseSession('You must answer only in English. Do not use Chinese or Japanese.', env.voice) });
  const en = await c.waitFor((e) => e.type === 'session.updated' || e.type === 'error', 10_000);
  out({ mode: 'switch', step: 'update_en', updated: en?.type === 'session.updated' });
  await run('en', 'You must answer only in English. Do not use Chinese or Japanese.');
  c.send({ type: 'session.update', session: baseSession('今から日本語だけで答えてください。中国語や英語を使わないでください。', env.voice) });
  const ja = await c.waitFor((e) => e.type === 'session.updated' || e.type === 'error', 10_000);
  out({ mode: 'switch', step: 'update_ja', updated: ja?.type === 'session.updated' });
  await run('ja', '今から日本語だけで答えてください。中国語や英語を使わないでください。');
  c.close();
}

const modes: Record<string, () => Promise<void>> = { text: probeText, audio: probeAudio, switch: probeSwitch };
const run = modes[mode];
if (!run) {
  process.stderr.write('usage: probe-qwen-languages.ts text | audio --wav-zh f --wav-ja f --wav-en f | switch\n');
  process.exit(2);
}
await run();
