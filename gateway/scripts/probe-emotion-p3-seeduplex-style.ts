// gateway/scripts/probe-emotion-p3-seeduplex-style.ts
// P3: can Seeduplex instructions change the voice style, on (i) passive replies and (ii) direct TTS?
// Synthetic audio/text only. Writes WAVs to /tmp for blind listening; prints counts and levels only.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p3-seeduplex-style.ts <passive|direct|both> [--wav f] [--runs 5]
import { mkdirSync } from 'node:fs';
import WebSocket from 'ws';
import { readWavPcm16, sleep, wavBytes, type Json } from './lib/qwen-raw.ts';

const apiKey = process.env.SEEDUPLEX_API_KEY ?? '';
if (!apiKey) throw new Error('SEEDUPLEX_API_KEY_missing');
const endpoint = process.env.SEEDUPLEX_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const model = process.env.SEEDUPLEX_MODEL ?? '1.2.6.1';
const voice = process.env.SEEDUPLEX_VOICE ?? 'zh_male_xiaotian_jupiter_bigtts';
const args = process.argv.slice(2);
const mode = args[0] ?? '';
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const runs = Math.max(1, Number(flag('runs') ?? 5));
if (!['passive', 'direct', 'both'].includes(mode)) {
  throw new Error('usage: probe-emotion-p3-seeduplex-style.ts <passive|direct|both> [--wav f] [--runs 5]');
}
const dir = '/tmp/avatar-emotion-probe/seeduplex';
mkdirSync(dir, { recursive: true });
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

/** Same persona, only the emotional delivery request differs. */
const PERSONA = '你是一位温柔、自然的陪伴助手。请用简短、自然的口语回应用户。';
const EMOTION = '对方现在很难过，请用轻柔、放慢、音量低一点的语气说话。';
const INSTRUCTIONS = { A: PERSONA, B: `${PERSONA}\n${EMOTION}` } as const;

const PASSIVE_TEXT = '您别着急，我在这儿陪着您，慢慢说就好。';
const DIRECT_TEXT = '您别着急，我在这儿陪着您，慢慢说就好。';

interface Capture { audio: Int16Array; textChars: number; types: Record<string, number>; error: string | null; timedOut: boolean }

function run(instructions: string, opts: { userPcm?: Int16Array; directText?: string }): Promise<Capture> {
  return new Promise((resolve) => {
    const ws = new WebSocket(endpoint, { headers: { 'X-Api-Key': apiKey }, perMessageDeflate: false });
    const chunks: Int16Array[] = [];
    const types: Record<string, number> = {};
    let textChars = 0;
    let error: string | null = null;
    let finished = false;
    let started = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const send = (event: Json) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
    const done = (timedOut = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve({ audio: concat(chunks), textChars, types, error, timedOut });
      try { send({ type: 'session.close', event_id: `probe-${Date.now()}` }); } catch {}
      ws.close();
    };
    const timer = setTimeout(() => done(true), 45_000);
    ws.on('open', () => {
      send({
        type: 'session.create',
        event_id: `probe-${Date.now()}`,
        session: {
          id: 'probe',
          model,
          instructions,
          audio: {
            input: { format: { type: 'pcm', rate: 16000 } },
            output: { format: { type: 'pcm_s16le', rate: 24000 }, voice },
          },
          tools: [],
        },
      });
    });
    ws.on('message', (raw) => {
      let event: Json;
      try { event = JSON.parse(raw.toString()) as Json; } catch { return; }
      const type = typeof event.type === 'string' ? event.type : '';
      types[type] = (types[type] ?? 0) + 1;
      if (type === 'session.created' && !started) {
        started = true;
        if (opts.directText) send({ type: 'speech_text_buffer.commit', event_id: `probe-${Date.now()}`, text: opts.directText });
        else if (opts.userPcm) void stream(opts.userPcm);
      } else if (type === 'response.output_audio.delta' && typeof event.delta === 'string') {
        const b = Buffer.from(event.delta, 'base64');
        const n = b.byteLength - (b.byteLength % 2);
        chunks.push(new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + n)));
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => done(false), 1500);
      } else if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        textChars += event.delta.length;
      } else if (type === 'response.output_audio.done') {
        setTimeout(() => done(false), 400);
      } else if (type === 'error') {
        const e = (event.error ?? {}) as Json;
        error = String(e.code ?? event.code ?? 'upstream_error');
        done(false);
      }
    });
    ws.on('error', () => { error = 'socket_error'; done(false); });
    ws.on('close', () => done(false));

    async function stream(pcm: Int16Array): Promise<void> {
      for (let o = 0; o < pcm.length; o += 320) {
        const chunk = pcm.subarray(o, Math.min(o + 320, pcm.length));
        send({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64') });
        await sleep(20);
      }
      const tail = new Int16Array(16000 * 1.5);
      for (let o = 0; o < tail.length; o += 320) {
        const chunk = tail.subarray(o, Math.min(o + 320, tail.length));
        send({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64') });
        await sleep(20);
      }
      send({ type: 'input_audio_buffer.commit', event_id: `probe-${Date.now()}` });
    }
  });
}

function levels(pcm: Int16Array): { durationMs: number; rms: number; peak: number } {
  let sum = 0;
  let peak = 0;
  for (const s of pcm) { sum += s * s; peak = Math.max(peak, Math.abs(s)); }
  return { durationMs: Math.round((pcm.length / 24000) * 1000), rms: Math.round(Math.sqrt(sum / Math.max(1, pcm.length))), peak };
}

function concat(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function runSet(kind: 'passive' | 'direct', userPcm?: Int16Array): Promise<void> {
  const rows: Array<{ run: number; ab: 'A' | 'B'; file: string; chars: number; durationMs: number; rms: number; peak: number; error: string | null; timedOut: boolean }> = [];
  for (let i = 1; i <= runs; i++) {
    for (const ab of ['A', 'B'] as const) {
      const cap = await run(INSTRUCTIONS[ab], kind === 'direct' ? { directText: DIRECT_TEXT } : { userPcm });
      const lv = levels(cap.audio);
      const file = `${dir}/${kind}-${i}-${ab}.wav`;
      if (cap.audio.length > 0) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(file, wavBytes(cap.audio, 24000));
      }
      const row = { run: i, ab, file, chars: kind === 'passive' ? cap.textChars : DIRECT_TEXT.length, ...lv, error: cap.error, timedOut: cap.timedOut };
      rows.push(row);
      out({ probe: 'p3', kind, ...row, types: cap.types });
    }
  }
  const avg = (ab: 'A' | 'B', key: 'chars' | 'durationMs' | 'rms' | 'peak') => {
    const r = rows.filter((x) => x.ab === ab && x.durationMs > 0);
    return r.length ? r.reduce((n, x) => n + x[key], 0) / r.length : 0;
  };
  const pct = (a: number, b: number) => (a === 0 ? null : Math.round(((b - a) / a) * 1000) / 10);
  out({
    probe: 'p3',
    kind,
    summary: {
      A: { durationMs: Math.round(avg('A', 'durationMs')), rms: Math.round(avg('A', 'rms')), peak: Math.round(avg('A', 'peak')), chars: Math.round(avg('A', 'chars')) },
      B: { durationMs: Math.round(avg('B', 'durationMs')), rms: Math.round(avg('B', 'rms')), peak: Math.round(avg('B', 'peak')), chars: Math.round(avg('B', 'chars')) },
      durationPct: pct(avg('A', 'durationMs'), avg('B', 'durationMs')),
      rmsPct: pct(avg('A', 'rms'), avg('B', 'rms')),
      peakPct: pct(avg('A', 'peak'), avg('B', 'peak')),
      pairs: runs,
    },
  });
}

if (mode === 'passive' || mode === 'both') {
  const wav = flag('wav');
  if (!wav) throw new Error('--wav <16k mono PCM16 WAV> is required for passive mode');
  const userPcm = readWavPcm16(wav);
  await runSet('passive', userPcm);
}
if (mode === 'direct' || mode === 'both') await runSet('direct');
