// gateway/scripts/probe-emotion-p5-qwen-speech-rate-update.ts
// P5b: does a mid-session session.update{speech_rate} change the next reply?
// Two turns per session; turn 2 either keeps 1.0 (control) or switches to 0.8.
// Run from gateway/: QWEN_MODEL=qwen-audio-3.1-realtime-flash QWEN_TURN_DETECTION=server_vad \
//   node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p5-qwen-speech-rate-update.ts [--runs 2]
import { baseSession, probeEnv, QwenRaw, userText, type Json } from './lib/qwen-raw.ts';

const env = probeEnv();
const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Math.max(1, Number(args[i + 1] ?? fallback)) : fallback;
};
const runs = flag('runs', 2);
const turnDetection = process.env.QWEN_TURN_DETECTION ?? 'semantic_vad';
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

const PERSONA = '你是一位温柔、自然的陪伴助手。请用简短、自然的口语回应用户。';
const SENTENCE = '您别着急，我在这儿陪着您，慢慢说就好。';
const PROMPT = `请只重复这句话，不要添加任何别的内容：${SENTENCE}`;

async function turn(c: QwenRaw): Promise<{ audioMs: number; status: string; error: string | null }> {
  const r = await c.collect(() => {
    c.send(userText(PROMPT));
    c.send({ type: 'response.create' });
  }, 45_000);
  return { audioMs: Math.round(r.audio.length / 24), status: r.status, error: r.error };
}

async function run(control: boolean, i: number): Promise<void> {
  const c = await QwenRaw.open({
    apiKey: env.apiKey,
    endpoint: env.endpoint,
    model: env.model,
    session: baseSession(PERSONA, env.voice, { turn_detection: { type: turnDetection }, speech_rate: 1 }),
  });
  const first = await turn(c);
  const nextRate = control ? 1 : 0.8;
  c.send({ type: 'session.update', session: { speech_rate: nextRate } });
  const ack = await c.waitFor((e) => e.type === 'session.updated' || e.type === 'error', 5_000);
  const second = await turn(c);
  c.close();
  out({ probe: 'p5b', run: i, control, nextRate, ack: ack?.type ?? null, first, ratio: first.audioMs > 0 ? Math.round((second.audioMs / first.audioMs) * 1000) / 1000 : null, second });
}

for (let i = 1; i <= runs; i++) {
  await run(true, i);
  await run(false, i);
}
