// gateway/scripts/probe-seeduplex-languages.ts
// Manual multilingual probe. Synthetic audio only; prints flags and event counts, never transcripts.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-languages.ts <zh|en|ja|switch> --wav <16k wav> [--wav2 f] [--voice2 en_voice]
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { readWavPcm16, sleep, type Json } from './lib/qwen-raw.ts';

const apiKey = process.env.SEEDUPLEX_API_KEY ?? '';
if (!apiKey) throw new Error('SEEDUPLEX_API_KEY_missing');
const endpoint = process.env.SEEDUPLEX_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const model = process.env.SEEDUPLEX_MODEL ?? '1.2.6.1';
const defaultVoice = process.env.SEEDUPLEX_VOICE ?? 'zh_male_xiaotian_jupiter_bigtts';
const mode = process.argv[2] ?? '';
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function assertWav16kMono(path: string): void {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('wav_invalid');
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      if (off + 24 > buf.length) throw new Error('wav_fmt_truncated');
      if (buf.readUInt16LE(off + 8) !== 1 || buf.readUInt16LE(off + 10) !== 1 || buf.readUInt32LE(off + 12) !== 16000 || buf.readUInt16LE(off + 22) !== 16) {
        throw new Error('wav_not_16k_mono_pcm16');
      }
      return;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('wav_fmt_missing');
}

const wav = flag('wav');
if (!wav) throw new Error('usage: probe-seeduplex-languages.ts <zh|en|ja|switch> --wav <16k wav> [--wav2 f] [--voice2 en_voice]');
assertWav16kMono(wav);
const speech = readWavPcm16(wav);
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

function flags(text: string): Json {
  return {
    chars: text.length,
    hiragana: /[\p{Script=Hiragana}]/u.test(text),
    katakana: /[\p{Script=Katakana}]/u.test(text),
    han: /[\p{Script=Han}]/u.test(text),
    latin: /[\p{Script=Latin}]/u.test(text),
  };
}

interface RunResult {
  updated: boolean;
  errors: number;
  timedOut: boolean;
  asr: string;
  reply: string;
  audioBytes: number;
  types: Record<string, number>;
}

function runOnce(opts: {
  voice: string;
  instructions: string;
  pcm: Int16Array;
  switchTo?: { voice: string; instructions: string; pcm: Int16Array };
}): Promise<RunResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(endpoint, { headers: { 'X-Api-Key': apiKey }, perMessageDeflate: false });
    const types: Record<string, number> = {};
    let asr = '';
    let reply = '';
    let audioBytes = 0;
    let errors = 0;
    let updated = false;
    let phase: 'first' | 'switch' | 'second' = 'first';
    let finished = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve({ updated, errors, timedOut, asr, reply, audioBytes, types });
      ws.close();
    };
    const send = (event: Json) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    };
    const stream = async (pcm: Int16Array) => {
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
    };
    ws.on('message', (raw) => {
      let event: Json;
      try { event = JSON.parse(raw.toString()) as Json; } catch { return; }
      const type = typeof event.type === 'string' ? event.type : '';
      types[type] = (types[type] ?? 0) + 1;
      if (type === 'session.created') void stream(opts.pcm);
      else if (type === 'conversation.item.input_audio_transcription.completed') asr += String(event.transcript ?? event.text ?? '');
      else if (type === 'response.output_text.delta') reply += String(event.delta ?? '');
      else if (type === 'response.output_audio.delta' && typeof event.delta === 'string') audioBytes += Buffer.from(event.delta, 'base64').length;
      else if (type === 'error') { errors++; done(); }
      else if (type === 'session.updated') {
        updated = true;
        if (phase === 'switch' && opts.switchTo) {
          phase = 'second';
          void stream(opts.switchTo.pcm);
        }
      } else if (type === 'response.output_audio.done') {
        if (phase === 'first' && opts.switchTo) {
          phase = 'switch';
          send({
            type: 'session.update',
            event_id: `probe-${Date.now()}`,
            session: {
              id: 'probe',
              model,
              instructions: opts.switchTo.instructions,
              audio: {
                input: { format: { type: 'pcm', rate: 16000 } },
                output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: opts.switchTo.voice },
              },
              tools: [],
            },
          });
        } else {
          setTimeout(done, 300);
        }
      }
    });
    ws.on('error', () => { errors++; done(); });
    ws.on('close', () => done());
    ws.on('open', () => {
      send({
        type: 'session.create',
        event_id: `probe-${Date.now()}`,
        session: {
          id: 'probe',
          model,
          instructions: opts.instructions,
          audio: {
            input: { format: { type: 'pcm', rate: 16000 } },
            output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: opts.voice },
          },
          tools: [],
        },
      });
      timer = setTimeout(() => { timedOut = true; done(); }, 30_000);
    });
  });
}

const instructions: Record<string, string> = {
  zh: '请用中文自然、简短地回答用户。',
  en: 'Answer the user in English, briefly and naturally.',
  ja: 'ユーザーに日本語で短く自然に答えてください。',
};
const voice = mode === 'en' ? (process.env.SEEDUPLEX_VOICE_EN ?? 'en_male_tim_uranus_bigtts') : defaultVoice;
const instructionsFor = mode === 'switch' ? instructions.zh : (instructions[mode] ?? instructions.zh);
const wav2 = flag('wav2');
if (wav2) assertWav16kMono(wav2);
const switchTo = mode === 'switch' && wav2
  ? { voice: flag('voice2') ?? process.env.SEEDUPLEX_VOICE_EN ?? 'en_male_tim_uranus_bigtts', instructions: instructions.en, pcm: readWavPcm16(wav2) }
  : undefined;
const result = await runOnce({ voice, instructions: instructionsFor, pcm: speech, ...(switchTo ? { switchTo } : {}) });
out({
  mode,
  voice,
  targetVoice: switchTo?.voice ?? null,
  updated: result.updated,
  timedOut: result.timedOut,
  errors: result.errors,
  asr: flags(result.asr),
  reply: flags(result.reply),
  audioBytes: result.audioBytes,
  types: result.types,
});
