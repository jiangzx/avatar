// Manual probe: content-free timing of Seeduplex reply audio deltas for a synthetic voice turn.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-seeduplex-timing.ts <16k mono wav> [runs]
import WebSocket from 'ws';
import { readWavPcm16, sleep, type Json } from './lib/qwen-raw.ts';

const apiKey = process.env.SEEDUPLEX_API_KEY ?? '';
if (!apiKey) throw new Error('SEEDUPLEX_API_KEY_missing');
const wav = process.argv[2];
if (!wav) throw new Error('usage: probe-seeduplex-timing.ts <16k mono wav> [runs]');
const runs = Math.max(1, Number(process.argv[3] ?? 3));
const speech = readWavPcm16(wav);
const zeros = (ms: number) => new Int16Array((16000 * ms) / 1000);
const endpoint = process.env.SEEDUPLEX_ENDPOINT ?? 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const model = process.env.SEEDUPLEX_MODEL ?? '1.2.6.1';
const voice = process.env.SEEDUPLEX_VOICE ?? 'zh_male_xiaotian_jupiter_bigtts';
const out = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(o)}\n`);

function runOnce(): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(endpoint, { headers: { 'X-Api-Key': apiKey }, perMessageDeflate: false });
    const types = new Map<string, number>();
    let deltaCount = 0;
    let audioSamples = 0;
    let textChars = 0;
    let responseStartedAt: number | null = null;
    let firstDeltaAt: number | null = null;
    let lastDeltaAt: number | null = null;
    let speechEndedAt: number | null = null;
    const gaps: number[] = [];
    let finish: (why: string) => void = () => {};
    let finished = false;

    const done = (why: string) => {
      if (finished) return;
      finished = true;
      finish(why);
    };
    finish = (why: string) => {
      resolve();
      ws.close();
      const slow = gaps.map((gapMs, i) => ({ i: i + 1, gapMs })).filter((g) => g.gapMs >= 150);
      out({
        why,
        types: Object.fromEntries(types),
        deltas: deltaCount,
        audioMs: Math.round(audioSamples / 24),
        textChars,
        firstDeltaAfterSpeechEndMs: speechEndedAt !== null && firstDeltaAt !== null ? firstDeltaAt - speechEndedAt : null,
        responseStartToFirstDeltaMs: responseStartedAt !== null && firstDeltaAt !== null ? firstDeltaAt - responseStartedAt : null,
        maxGapMs: gaps.length ? Math.max(...gaps) : 0,
        gapsOver150Count: slow.length,
        gapsOver150Ms: slow.slice(0, 12),
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
      } else if (type === 'response.output_audio.started') {
        responseStartedAt = Date.now();
      } else if (type === 'response.output_audio.delta' && typeof event.delta === 'string') {
        const bytes = Buffer.from(event.delta, 'base64');
        const now = Date.now();
        deltaCount++;
        audioSamples += Math.floor(bytes.length / 2);
        if (firstDeltaAt === null) firstDeltaAt = now;
        else if (lastDeltaAt !== null) gaps.push(now - lastDeltaAt);
        lastDeltaAt = now;
      } else if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        textChars += event.delta.length;
      } else if (type === 'response.output_audio.done') {
        setTimeout(() => done('audio_done'), 500);
      } else if (type === 'error') {
        done('error');
      }
    });
    ws.on('error', () => done('socket_error'));
    ws.on('close', () => done('closed'));

    async function streamSpeech(): Promise<void> {
      for (let o = 0; o < speech.length; o += 320) {
        send({ type: 'input_audio_buffer.append', audio: Buffer.from(speech.subarray(o, Math.min(o + 320, speech.length)).buffer, speech.subarray(o, Math.min(o + 320, speech.length)).byteOffset, Math.min(320, speech.length - o) * 2).toString('base64') });
        await sleep(20);
      }
      speechEndedAt = Date.now();
      send({ type: 'input_audio_buffer.commit', event_id: `probe-${Date.now()}` });
      const tail = zeros(1500);
      for (let o = 0; o < tail.length; o += 320) {
        send({ type: 'input_audio_buffer.append', audio: Buffer.from(tail.subarray(o, Math.min(o + 320, tail.length)).buffer, tail.subarray(o, Math.min(o + 320, tail.length)).byteOffset, Math.min(320, tail.length - o) * 2).toString('base64') });
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
          instructions: '请自然、简短地回答用户，两三句话即可。',
          audio: {
            input: { format: { type: 'pcm', rate: 16000 } },
            output: { format: { type: 'pcm_s16le', rate: 24000 }, voice },
          },
          tools: [],
        },
      });
      setTimeout(() => done('timeout'), 20_000);
    });
  });
}

for (let i = 1; i <= runs; i++) {
  out({ run: i });
  await runOnce();
}
