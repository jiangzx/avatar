// gateway/scripts/probe-emotion-p5-qwen-speech-rate.ts
// P5: does the realtime model's speech_rate actually change the rendered audio?
// Fixed synthetic sentence, same voice/instructions; prints duration/level metrics only.
// Run from gateway/: QWEN_MODEL=qwen-audio-3.1-realtime-flash QWEN_TURN_DETECTION=server_vad \
//   node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p5-qwen-speech-rate.ts [--runs 2]
import { mkdirSync, writeFileSync } from 'node:fs';
import { baseSession, probeEnv, QwenRaw, userText, wavBytes, type Json } from './lib/qwen-raw.ts';

const env = probeEnv();
const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Math.max(1, Number(args[i + 1] ?? fallback)) : fallback;
};
const runs = flag('runs', 2);
const turnDetection = process.env.QWEN_TURN_DETECTION ?? 'semantic_vad';
const rates = (process.env.QWEN_SPEECH_RATES ?? '1.0,0.8,0.6')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0.5 && n <= 2);
const dir = '/tmp/avatar-emotion-probe/qwen';
mkdirSync(dir, { recursive: true });
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

const PERSONA = '你是一位温柔、自然的陪伴助手。请用简短、自然的口语回应用户。';
const SENTENCE = '您别着急，我在这儿陪着您，慢慢说就好。';
const PROMPT = `请只重复这句话，不要添加任何别的内容：${SENTENCE}`;

interface Row { rate: number; run: number; file: string; audioMs: number; chars: number; msPerChar: number | null; rms: number; peak: number; status: string; error: string | null }

function levels(pcm: Int16Array): { rms: number; peak: number } {
  let sum = 0;
  let peak = 0;
  for (const s of pcm) { sum += s * s; peak = Math.max(peak, Math.abs(s)); }
  return { rms: Math.round(Math.sqrt(sum / Math.max(1, pcm.length))), peak };
}

const rows: Row[] = [];
for (const rate of rates) {
  for (let i = 1; i <= runs; i++) {
    const c = await QwenRaw.open({
      apiKey: env.apiKey,
      endpoint: env.endpoint,
      model: env.model,
      session: baseSession(PERSONA, env.voice, {
        turn_detection: { type: turnDetection },
        speech_rate: rate,
      }),
    });
    const r = await c.collect(() => {
      c.send(userText(PROMPT));
      c.send({ type: 'response.create' });
    }, 45_000);
    c.close();
    const audioMs = Math.round(r.audio.length / 24);
    const chars = [...r.transcript.replace(/\s/g, '')].length;
    const file = `${dir}/speech-rate-${rate}-${i}.wav`;
    if (r.audio.length > 0) writeFileSync(file, wavBytes(r.audio, 24000));
    const row: Row = {
      rate,
      run: i,
      file,
      audioMs,
      chars,
      msPerChar: chars > 0 ? Math.round((audioMs / chars) * 10) / 10 : null,
      ...levels(r.audio),
      status: r.status,
      error: r.error,
    };
    rows.push(row);
    out({ probe: 'p5', ...row });
  }
}

const base = rows.find((r) => r.rate === 1 && r.audioMs > 0);
out({
  probe: 'p5',
  summary: rates.map((rate) => {
    const ok = rows.filter((r) => r.rate === rate && r.audioMs > 0);
    const avg = (key: 'audioMs' | 'msPerChar' | 'rms' | 'peak') =>
      ok.length ? Math.round(ok.reduce((n, x) => n + (x[key] ?? 0), 0) / ok.length) : 0;
    const audioMs = avg('audioMs');
    return {
      rate,
      runs: ok.length,
      audioMs,
      msPerChar: avg('msPerChar'),
      rms: avg('rms'),
      peak: avg('peak'),
      audioMsPctVs1: base && rate !== 1 && base.audioMs > 0 ? Math.round(((audioMs - base.audioMs) / base.audioMs) * 1000) / 10 : null,
    };
  }),
});
