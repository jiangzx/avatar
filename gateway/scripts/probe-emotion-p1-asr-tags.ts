// gateway/scripts/probe-emotion-p1-asr-tags.ts
// P1: does Qwen Omni expose emotion metadata on input-audio transcription events?
// Synthetic audio only. Prints event structure with every text/audio value redacted.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p1-asr-tags.ts \
//   --case happy=/tmp/happy-1.wav --case sad=/tmp/sad-1.wav --case neutral=/tmp/neutral-1.wav
import { baseSession, probeEnv, QwenRaw, readWavPcm16, sleep, type Json } from './lib/qwen-raw.ts';

const env = probeEnv();
const args = process.argv.slice(2);
const cases: Array<{ expected: string; file: string }> = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--case') continue;
  const spec = args[i + 1] ?? '';
  const eq = spec.indexOf('=');
  if (eq <= 0) throw new Error(`bad --case value: ${spec}`);
  cases.push({ expected: spec.slice(0, eq), file: spec.slice(eq + 1) });
  i++;
}
if (cases.length === 0) throw new Error('usage: probe-emotion-p1-asr-tags.ts --case <expected>=<16k wav> [...]');

const CONTENT_KEYS = new Set(['transcript', 'text', 'delta', 'audio', 'arguments', 'output', 'content']);
const EMOTION_KEY = /emotion|emo_|affect|prosody|paraling|sentiment|tone|style|annotation|tag|label/i;
const SAFE_SHORT = 48;
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

/** Returns a copy with transcript/text/audio values replaced by a size marker. */
function redact(value: unknown, key = '', depth = 0): unknown {
  if (depth > 8) return '<depth>';
  if (typeof value === 'string') {
    if (key === 'type') return value;
    if (CONTENT_KEYS.has(key) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value) || value.length > SAFE_SHORT) {
      return `<redacted:${value.length}>`;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, key, depth + 1));
  if (typeof value === 'object') {
    const o: Json = {};
    for (const [k, v] of Object.entries(value as Json)) o[k] = redact(v, k, depth + 1);
    return o;
  }
  return '<unknown>';
}

interface Hit { eventType: string; path: string; value: unknown; at: number }

function emotionHits(event: Json, at: number, base = ''): Hit[] {
  const hits: Hit[] = [];
  const eventType = String(event.type ?? 'unknown');
  const walk = (value: unknown, key: string, path: string, depth: number) => {
    if (depth > 8) return;
    if (key && EMOTION_KEY.test(key)) hits.push({ eventType, path: path || key, value: redact(value, key), at });
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, key, `${path}[${i}]`, depth + 1));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Json)) walk(v, k, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(event, base, base, 0);
  return hits;
}

async function stream(c: QwenRaw, pcm: Int16Array): Promise<void> {
  for (let o = 0; o < pcm.length; o += 320) {
    c.sendPcm16k(pcm.subarray(o, Math.min(o + 320, pcm.length)));
    await sleep(20);
  }
  const tail = new Int16Array(16000 * 2);
  for (let o = 0; o < tail.length; o += 320) {
    c.sendPcm16k(tail.subarray(o, Math.min(o + 320, tail.length)));
    await sleep(20);
  }
}

async function runCase(label: string, expected: string, file: string): Promise<void> {
  const pcm = readWavPcm16(file);
  const c = await QwenRaw.open({
    apiKey: env.apiKey,
    endpoint: env.endpoint,
    model: env.model,
    session: baseSession('请自然、简短地回应用户。', env.voice),
  });
  const startIndex = c.events.length;
  await stream(c, pcm);
  const terminal = await c.waitFor(
    (e) => e.type === 'conversation.item.input_audio_transcription.completed' || e.type === 'error',
    25_000,
  );
  // Emotion metadata may arrive after the ASR final event.
  await sleep(4000);
  const events = c.events.slice(startIndex);
  c.close();

  const completed = events.find((e) => e.event.type === 'conversation.item.input_audio_transcription.completed');
  const completedAt = completed?.at ?? null;
  const hits: Hit[] = [];
  for (const { at, event } of events) for (const hit of emotionHits(event, at)) hits.push(hit);
  const byType = new Map<string, Json>();
  for (const { event } of events) {
    const type = String(event.type ?? 'unknown');
    if (!byType.has(type)) byType.set(type, redact(event) as Json);
  }
  const tags = hits.map((h) => ({
    event: h.eventType,
    path: h.path,
    value: h.value,
    at: h.at,
    deltaMs: completedAt === null ? null : h.at - completedAt,
  }));
  const expectedHit = tags.some((t) => String(t.value).toLowerCase().includes(expected.toLowerCase()));
  out({
    probe: 'p1',
    case: label,
    expected,
    audioMs: Math.round(pcm.length / 16),
    asrCompleted: completed !== undefined,
    terminal: terminal?.type ?? null,
    error: events.find((e) => e.event.type === 'error')?.event ?? null,
    eventTypes: [...byType.keys()],
    redactedEvents: [...byType.entries()].map(([type, event]) => ({ type, event })),
    emotionHits: hits.map((h) => h.path),
    tags,
    expectedLabelSeen: expectedHit,
  });
}

for (let i = 0; i < cases.length; i++) {
  const { expected, file } = cases[i]!;
  try {
    await runCase(`${expected}-${i + 1}`, expected, file);
  } catch (error) {
    out({ probe: 'p1', case: `${expected}-${i + 1}`, expected, file, error: (error as Error).message });
  }
}
