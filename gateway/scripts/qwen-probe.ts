// Manual probe for Plan A assumptions 1, 2, 3, 4a, 5. Prompts are synthetic; prints event types, flags, usage.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/qwen-probe.ts <mode> [--wav f] [--voices a,b] [--character id]
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHARACTER_ID, LANGUAGES, isCharacterId } from '@anyidea/protocol';
import { loadCharacterRegistry } from '../src/characters/registry.ts';
import { baseSession, endsWithMeow, instructionVerdict, probeEnv, QwenRaw, readWavPcm16, sleep, userText, writeWav, type InstructionRun, type Json } from './lib/qwen-raw.ts';

const env = probeEnv();
const [mode = '', ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const characterId = flag('character') ?? DEFAULT_CHARACTER_ID;
if (!isCharacterId(characterId)) throw new Error('--character must be a character id');
const NAME = loadCharacterRegistry(fileURLToPath(new URL('../characters', import.meta.url)), LANGUAGES).name(characterId, 'zh');
const open = (session: Json) => QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session });
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function probeInstructions(): Promise<void> {
  const rule = `你叫${NAME}。无论说什么，每一句话的最后都必须加一个字"喵"。`;
  const task = '请用一句话向用户问好。';
  const runs: InstructionRun[] = [];
  for (let i = 1; i <= 3; i++) {
    const c = await open(baseSession(rule, env.voice));
    const a = await c.collect(() => c.send({ type: 'response.create', response: { instructions: task } }));
    const b = await c.collect(() => c.send({ type: 'response.create', response: { instructions: `${rule}\n\n## 本次任务\n${task}` } }));
    const roles = c.events.filter((e) => e.event.type === 'conversation.item.created').map((e) => String(((e.event.item ?? {}) as Json).role ?? '?'));
    c.close();
    const run = { aError: a.error, aMeow: endsWithMeow(a.transcript), bMeow: endsWithMeow(b.transcript), userItems: roles.filter((r) => r === 'user').length };
    runs.push(run);
    out({ mode: 'instructions', run: i, ...run, aStatus: a.status, bStatus: b.status, itemRoles: roles, aTranscript: a.transcript, bTranscript: b.transcript, aUsage: a.usage, bUsage: b.usage });
  }
  out({ mode: 'instructions', verdict: instructionVerdict(runs) });
}

async function probeCap(): Promise<void> {
  const story = '请讲一个三百字左右的故事。';
  const ask = (c: QwenRaw, text: string, response?: Json) => c.collect(() => { c.send(userText(text)); c.send(response ? { type: 'response.create', response } : { type: 'response.create' }); });
  const plain = await open(baseSession(`你是${NAME}，回答简短。`, env.voice));
  const short = await ask(plain, '用一两句话说说今天天气。');
  out({ mode: 'cap', case: 'typical_short_reply', status: short.status, usage: short.usage, chars: short.transcript.length, audioMs: Math.round(short.audio.length / 24) });
  const perResponse = await ask(plain, story, { max_output_tokens: 20 });
  out({ mode: 'cap', case: 'response.max_output_tokens=20', status: perResponse.status, error: perResponse.error, statusDetails: perResponse.statusDetails, usage: perResponse.usage, chars: perResponse.transcript.length });
  plain.close();
  try {
    const capped = await open(baseSession('你是一个讲故事的人。', env.voice, { max_response_output_tokens: 20 }));
    const r = await ask(capped, story);
    out({ mode: 'cap', case: 'session.max_response_output_tokens=20', accepted: true, status: r.status, error: r.error, statusDetails: r.statusDetails, usage: r.usage, chars: r.transcript.length });
    capped.close();
  } catch (error) {
    out({ mode: 'cap', case: 'session.max_response_output_tokens=20', accepted: false, error: (error as Error).message });
  }
}

async function streamPcm(c: QwenRaw, pcm: Int16Array): Promise<void> {
  for (let o = 0; o < pcm.length; o += 320) {
    c.sendPcm16k(pcm.subarray(o, Math.min(o + 320, pcm.length)));
    await sleep(20);
  }
}

async function probeAudio(): Promise<void> {
  const wav = flag('wav');
  if (!wav) throw new Error('--wav <16 kHz mono PCM16 WAV> is required');
  const speech = readWavPcm16(wav);
  const zeros = (ms: number) => new Int16Array((16000 * ms) / 1000);
  const c = await open(baseSession(`你是${NAME}，回答简短。`, env.voice));
  const t0 = c.events.length;
  await streamPcm(c, speech);
  await streamPcm(c, zeros(2000)); // like client zero frames during a filler
  await c.waitFor((e) => e.type === 'response.done', 15_000);
  const phase1 = c.events.slice(t0);
  const t1 = c.events.length;
  await streamPcm(c, zeros(1000));
  await streamPcm(c, speech);
  await streamPcm(c, zeros(2000));
  await c.waitFor((e) => e.type === 'response.done', 15_000);
  const phase2 = c.events.slice(t1);
  c.close();
  const at = (evs: typeof phase1, type: string) => evs.find((e) => e.event.type === type)?.at ?? null;
  const diff = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : null);
  const p1 = {
    speechStarted: at(phase1, 'input_audio_buffer.speech_started'),
    speechStopped: at(phase1, 'input_audio_buffer.speech_stopped'),
    committed: at(phase1, 'input_audio_buffer.committed'),
    partialCount: phase1.filter((e) => e.event.type === 'conversation.item.input_audio_transcription.delta').length,
    firstPartial: at(phase1, 'conversation.item.input_audio_transcription.delta'),
    transcriptCompleted: at(phase1, 'conversation.item.input_audio_transcription.completed'),
    responseCreated: at(phase1, 'response.created'),
    firstAudio: at(phase1, 'response.audio.delta'),
    responseDone: at(phase1, 'response.done'),
  };
  out({ mode: 'audio', phase: 1, ...p1, speechStoppedToFirstAudioMs: diff(p1.firstAudio, p1.speechStopped), completedMinusCreatedMs: diff(p1.transcriptCompleted, p1.responseCreated), types: [...new Set(phase1.map((e) => String(e.event.type)))] });
  out({ mode: 'audio', phase: 2, speechStartedAfterZeros: at(phase2, 'input_audio_buffer.speech_started') !== null, secondResponse: at(phase2, 'response.done') !== null, errors: phase2.filter((e) => e.event.type === 'error').length });
}

async function probeVoices(): Promise<void> {
  const voices = (flag('voices') ?? env.voice).split(',').map((v) => v.trim()).filter(Boolean);
  for (const voice of voices) {
    try {
      const c = await open(baseSession(`你是${NAME}，说话亲切温和。`, voice));
      const r = await c.collect(() => { c.send(userText('请用亲切的语气说：嗯，我想想，您慢慢说。')); c.send({ type: 'response.create' }); });
      c.close();
      const file = `/tmp/qwen-voice-${voice}.wav`;
      writeWav(file, r.audio, 24000);
      out({ mode: 'voices', voice, accepted: true, status: r.status, audioMs: Math.round(r.audio.length / 24), file });
    } catch (error) {
      out({ mode: 'voices', voice, accepted: false, error: (error as Error).message });
    }
  }
}

const modes: Record<string, () => Promise<void>> = { instructions: probeInstructions, cap: probeCap, audio: probeAudio, voices: probeVoices };
const run = modes[mode];
if (!run) {
  process.stderr.write('usage: qwen-probe.ts instructions | cap | audio --wav <file> | voices --voices a,b,c [--character id]\n');
  process.exit(2);
}
await run();
