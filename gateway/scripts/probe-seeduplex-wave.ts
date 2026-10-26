// Manual synthetic probe: content-free analysis of Seeduplex reply audio.
// Distinguishes transport gaps (delta arrival) from silence inside the synthesized waveform.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-wave.ts <16k mono wav> [runs]
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { DEFAULT_CHARACTER_ID, LANGUAGES, isCharacterId } from '@anyidea/protocol';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { loadRoleCatalog } from '../src/roles/fileCatalog.ts';
import { readWavPcm16, sleep, type Json } from './lib/qwen-raw.ts';

const apiKey = process.env.SEEDUPLEX_API_KEY ?? '';
if (!apiKey) throw new Error('SEEDUPLEX_API_KEY_missing');
const wav = process.argv[2];
if (!wav) throw new Error('usage: probe-seeduplex-wave.ts <16k mono wav> [runs]');
const runs = Math.max(1, Number(process.argv[3] ?? 1));
const speech = readWavPcm16(wav);
const zeros = (ms: number) => new Int16Array((16000 * ms) / 1000);
const endpoint = process.env.SEEDUPLEX_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const model = process.env.SEEDUPLEX_MODEL ?? '1.2.6.1';
const voice = process.env.SEEDUPLEX_VOICE ?? 'zh_male_xiaotian_jupiter_bigtts';
const root = fileURLToPath(new URL('..', import.meta.url));
const character = process.env.PROBE_CHARACTER ?? DEFAULT_CHARACTER_ID;
if (!isCharacterId(character)) throw new Error('PROBE_CHARACTER must be a character id');
const persona = loadRoleCatalog(`${root}roles`, loadCharacterRegistry(`${root}characters`, LANGUAGES)).buildPersona(character, 'zh');
const out = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(o)}\n`);

/** Concatenates 24 kHz mono PCM and reports silence runs below an energy gate. */
function analyzeWave(parts: Int16Array[]): Record<string, unknown> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const win = 480; // 20 ms at 24 kHz
  const rms: number[] = [];
  for (let o = 0; o + win <= all.length; o += win) {
    let sum = 0;
    for (let i = o; i < o + win; i++) sum += all[i]! * all[i]!;
    rms.push(Math.sqrt(sum / win));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const gate = Math.max(60, p95 * 0.02);
  const runs: { startMs: number; ms: number }[] = [];
  let runStart = -1;
  for (let i = 0; i <= rms.length; i++) {
    const silent = i < rms.length && (rms[i] ?? 0) < gate;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      runs.push({ startMs: runStart * 20, ms: (i - runStart) * 20 });
      runStart = -1;
    }
  }
  const firstSpeechMs = (() => {
    const i = rms.findIndex((v) => v >= gate);
    return i < 0 ? null : i * 20;
  })();
  const internal = runs.filter((r) => r.startMs > 0 && r.ms >= 120);
  const long = runs.filter((r) => r.ms >= 250);
  return {
    audioMs: Math.round(total / 24),
    rmsGate: Math.round(gate),
    firstSpeechMs,
    leadingSilenceMs: runs.find((r) => r.startMs === 0)?.ms ?? 0,
    silenceRunsOver250Ms: long.slice(0, 12),
    firstInternalSilenceOver200Ms: internal.find((r) => r.ms >= 200) ?? null,
    speechEndSilenceMs: (() => {
      const last = [...rms].reverse().findIndex((v) => v >= gate);
      return last < 0 ? null : last * 20;
    })(),
  };
}

function runOnce(): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(endpoint, { headers: { 'X-Api-Key': apiKey }, perMessageDeflate: false });
    const types = new Map<string, number>();
    const parts: Int16Array[] = [];
    let deltaCount = 0;
    let audioSamples = 0;
    let text = '';
    let firstDeltaAt: number | null = null;
    let lastDeltaAt: number | null = null;
    const gaps: number[] = [];
    let finished = false;

    const done = (why: string) => {
      if (finished) return;
      finished = true;
      resolve();
      ws.close();
      const slow = gaps.map((gap, i) => ({ i: i + 1, gapMs: gap })).filter((g) => g.gapMs >= 150);
      out({
        why,
        types: Object.fromEntries(types),
        deltas: deltaCount,
        audioMs: Math.round(audioSamples / 24),
        textChars: text.length,
        firstAckSingleChar: /^[好嗯哦行啊]([，。！？,.!?~～]|$)/.test(text),
        arrival: {
          maxGapMs: gaps.length ? Math.max(...gaps) : 0,
          gapsOver150Count: slow.length,
          gapsOver150Ms: slow.slice(0, 12),
        },
        wave: analyzeWave(parts),
      });
    };

    const send = (event: Json) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
    ws.on('message', (raw) => {
      let event: Json;
      try { event = JSON.parse(raw.toString()) as Json; } catch { return; }
      const type = typeof event.type === 'string' ? event.type : '';
      types.set(type, (types.get(type) ?? 0) + 1);
      if (type === 'session.created') {
        void streamSpeech();
      } else if (type === 'response.output_audio.delta' && typeof event.delta === 'string') {
        const bytes = Buffer.from(event.delta, 'base64');
        const pcm = new Int16Array(bytes.length / 2);
        for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
        parts.push(pcm);
        const now = Date.now();
        deltaCount++;
        audioSamples += pcm.length;
        if (firstDeltaAt === null) firstDeltaAt = now;
        else if (lastDeltaAt !== null) gaps.push(now - lastDeltaAt);
        lastDeltaAt = now;
      } else if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta;
      } else if (type === 'response.output_audio.done') {
        setTimeout(() => done('audio_done'), 300);
      } else if (type === 'error') {
        done('error');
      }
    });
    ws.on('error', () => done('socket_error'));
    ws.on('close', () => done('closed'));

    async function streamSpeech(): Promise<void> {
      for (let o = 0; o < speech.length; o += 320) {
        const frame = speech.subarray(o, Math.min(o + 320, speech.length));
        send({ type: 'input_audio_buffer.append', audio: Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString('base64') });
        await sleep(20);
      }
      send({ type: 'input_audio_buffer.commit', event_id: `probe-${Date.now()}` });
      const tail = zeros(1500);
      for (let o = 0; o < tail.length; o += 320) {
        const frame = tail.subarray(o, Math.min(o + 320, tail.length));
        send({ type: 'input_audio_buffer.append', audio: Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString('base64') });
        await sleep(20);
      }
    }

    ws.on('open', () => {
      send({
        type: 'session.create',
        event_id: `probe-${Date.now()}`,
        session: {
          id: 'probe',
          model,
          instructions: persona,
          audio: {
            input: { format: { type: 'pcm', rate: 16000 } },
            output: { format: { type: 'pcm_s16le', rate: 24000 }, voice },
          },
          tools: [],
        },
      });
      setTimeout(() => done('timeout'), 25_000);
    });
  });
}

for (let i = 1; i <= runs; i++) {
  out({ run: i });
  await runOnce();
}
