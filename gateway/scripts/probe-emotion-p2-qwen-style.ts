// gateway/scripts/probe-emotion-p2-qwen-style.ts
// P2: can Qwen session instructions (and per-response instructions) change the spoken style?
// Fixed synthetic sentence, same voice; prints counts/levels only and writes WAVs for blind listening.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p2-qwen-style.ts [--runs 5] [--per-response-runs 3]
import { mkdirSync, writeFileSync } from 'node:fs';
import { sameText } from './lib/pcm-tools.ts';
import { baseSession, probeEnv, QwenRaw, userText, wavBytes, type Json } from './lib/qwen-raw.ts';

const env = probeEnv();
const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Math.max(1, Number(args[i + 1] ?? fallback)) : fallback;
};
const runs = flag('runs', 5);
const perResponseRuns = flag('per-response-runs', 3);
const dir = '/tmp/avatar-emotion-probe/qwen';
mkdirSync(dir, { recursive: true });
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

const PERSONA = '你是一位温柔、自然的陪伴助手。请用简短、自然的口语回应用户。';
const EMOTION = '对方现在很难过，请用轻柔、放慢、音量低一点的语气说话。';
const INSTRUCTIONS = { A: PERSONA, B: `${PERSONA}\n${EMOTION}` } as const;
const SENTENCE = '您别着急，我在这儿陪着您，慢慢说就好。';
const PROMPT = `请只重复这句话，不要添加任何别的内容：${SENTENCE}`;

interface Row { run: number; ab: 'A' | 'B'; file: string; audioMs: number; chars: number; msPerChar: number | null; rms: number; peak: number; verbatim: boolean; status: string; error: string | null }

function levels(pcm: Int16Array): { rms: number; peak: number } {
  let sum = 0;
  let peak = 0;
  for (const s of pcm) { sum += s * s; peak = Math.max(peak, Math.abs(s)); }
  return { rms: Math.round(Math.sqrt(sum / Math.max(1, pcm.length))), peak };
}

async function runSet(kind: 'session' | 'per-response'): Promise<void> {
  const rows: Row[] = [];
  const total = kind === 'session' ? runs : perResponseRuns;
  for (let i = 1; i <= total; i++) {
    for (const ab of ['A', 'B'] as const) {
      const c = await QwenRaw.open({
        apiKey: env.apiKey,
        endpoint: env.endpoint,
        model: env.model,
        session: baseSession(INSTRUCTIONS[kind === 'session' ? ab : 'A'], env.voice),
      });
      const perResponse = kind === 'per-response' && ab === 'B';
      // Session-level runs use a normal text turn; per-response runs pass the task as response instructions.
      const r = await c.collect(() => {
        if (perResponse) {
          c.send({ type: 'response.create', response: { instructions: `${INSTRUCTIONS.B}\n${PROMPT}` } });
        } else {
          c.send(userText(PROMPT));
          c.send({ type: 'response.create' });
        }
      }, 45_000);
      c.close();
      const audioMs = Math.round(r.audio.length / 24);
      const chars = [...r.transcript.replace(/\s/g, '')].length;
      const lv = levels(r.audio);
      const file = `${dir}/${kind}-${i}-${ab}.wav`;
      if (r.audio.length > 0) writeFileSync(file, wavBytes(r.audio, 24000));
      const row: Row = { run: i, ab, file, audioMs, chars, msPerChar: chars > 0 ? Math.round((audioMs / chars) * 10) / 10 : null, ...lv, verbatim: sameText(r.transcript, SENTENCE), status: r.status, error: r.error };
      rows.push(row);
      out({ probe: 'p2', kind, ...row });
    }
  }
  const avg = (ab: 'A' | 'B', key: 'audioMs' | 'chars' | 'msPerChar' | 'rms' | 'peak') => {
    const r = rows.filter((x) => x.ab === ab && x.audioMs > 0);
    return r.length ? r.reduce((n, x) => n + (x[key] ?? 0), 0) / r.length : 0;
  };
  const pct = (a: number, b: number) => (a === 0 ? null : Math.round(((b - a) / a) * 1000) / 10);
  out({
    probe: 'p2',
    kind,
    summary: {
      A: { audioMs: Math.round(avg('A', 'audioMs')), chars: Math.round(avg('A', 'chars')), msPerChar: Math.round(avg('A', 'msPerChar') * 10) / 10, rms: Math.round(avg('A', 'rms')), peak: Math.round(avg('A', 'peak')) },
      B: { audioMs: Math.round(avg('B', 'audioMs')), chars: Math.round(avg('B', 'chars')), msPerChar: Math.round(avg('B', 'msPerChar') * 10) / 10, rms: Math.round(avg('B', 'rms')), peak: Math.round(avg('B', 'peak')) },
      audioMsPct: pct(avg('A', 'audioMs'), avg('B', 'audioMs')),
      msPerCharPct: pct(avg('A', 'msPerChar'), avg('B', 'msPerChar')),
      rmsPct: pct(avg('A', 'rms'), avg('B', 'rms')),
      peakPct: pct(avg('A', 'peak'), avg('B', 'peak')),
      verbatimA: rows.filter((r) => r.ab === 'A' && r.verbatim).length,
      verbatimB: rows.filter((r) => r.ab === 'B' && r.verbatim).length,
      runs: total,
    },
  });
}

await runSet('session');
await runSet('per-response');
