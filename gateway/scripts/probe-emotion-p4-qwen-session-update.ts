// gateway/scripts/probe-emotion-p4-qwen-session-update.ts
// Optional P4 control: Qwen session.update while a reply is streaming (a) and while idle (b).
// Synthetic prompts only; prints event types/timings and marker booleans, never text.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p4-qwen-session-update.ts <a|b|both>
import { baseSession, probeEnv, QwenRaw, userText, type Json } from './lib/qwen-raw.ts';

const env = probeEnv();
const mode = process.argv[2] ?? '';
if (!['a', 'b', 'both'].includes(mode)) throw new Error('usage: probe-emotion-p4-qwen-session-update.ts <a|b|both>');
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

const BASE = '你是一位温柔、自然的陪伴助手。请用简短、自然的口语回应用户。';
const MARKER = '呀嘿';
const RULE = `每句话结尾都必须加上“${MARKER}”两个字。`;
const STORY = '请讲一个五句话左右的小故事。';
const SHORT = '我今天有点累。';

function marker(text: string): boolean { return text.includes(MARKER); }
function textAfter(c: QwenRaw, index: number): string {
  return c.events.slice(index).filter((e) => e.event.type === 'response.audio_transcript.delta').map((e) => String(e.event.delta ?? '')).join('');
}

async function open(): Promise<QwenRaw> {
  return QwenRaw.open({ apiKey: env.apiKey, endpoint: env.endpoint, model: env.model, session: baseSession(BASE, env.voice) });
}

async function caseA(): Promise<void> {
  const c = await open();
  const start = c.events.length;
  const deltaP = c.waitFor((e) => e.type === 'response.audio.delta', 30_000);
  c.send(userText(STORY));
  c.send({ type: 'response.create' });
  const firstDelta = await deltaP;
  const beforeUpdate = c.events.length;
  const sentWall = Date.now();
  c.send({ type: 'session.update', session: { instructions: `${BASE}\n${RULE}` } });
  const ack = await c.waitFor((e) => e.type === 'session.updated' || e.type === 'error', 5_000);
  const ackWall = Date.now();
  const done = await c.waitFor((e) => e.type === 'response.done' || e.type === 'error', 30_000);
  const after = textAfter(c, beforeUpdate);
  const errors = c.events.slice(beforeUpdate).filter((e) => e.event.type === 'error').map((e) => String(((e.event.error ?? {}) as Json).code ?? 'error'));
  // Next turn after the streaming update.
  const beforeNext = c.events.length;
  const next = await c.collect(() => { c.send(userText(SHORT)); c.send({ type: 'response.create' }); }, 30_000);
  const nextText = c.events.slice(beforeNext).filter((e) => e.event.type === 'response.audio_transcript.delta').map((e) => String(e.event.delta ?? '')).join('');
  out({
    probe: 'p4-qwen',
    case: 'a',
    firstDelta: firstDelta !== null,
    ack: ack?.type ?? null,
    ackLatencyMs: ackWall - sentWall,
    currentDone: done?.type === 'response.done',
    currentStatus: (done?.type === 'error' ? 'error' : done?.type === 'response.done' ? 'done' : 'timeout'),
    remainingChars: after.length,
    markerInRemaining: marker(after),
    errors,
    eventTypes: count(c.events.slice(start).map((e) => e.event)),
    nextStatus: next.status,
    nextChars: nextText.length,
    markerInNext: marker(nextText),
  });
  c.close();
}

async function caseB(): Promise<void> {
  const c = await open();
  const first = await c.collect(() => { c.send(userText(SHORT)); c.send({ type: 'response.create' }); }, 30_000);
  const beforeUpdate = c.events.length;
  const sentWall = Date.now();
  c.send({ type: 'session.update', session: { instructions: `${BASE}\n${RULE}` } });
  const ack = await c.waitFor((e) => e.type === 'session.updated' || e.type === 'error', 5_000);
  const ackWall = Date.now();
  const beforeNext = c.events.length;
  const next = await c.collect(() => { c.send(userText(SHORT)); c.send({ type: 'response.create' }); }, 30_000);
  const nextText = c.events.slice(beforeNext).filter((e) => e.event.type === 'response.audio_transcript.delta').map((e) => String(e.event.delta ?? '')).join('');
  out({
    probe: 'p4-qwen',
    case: 'b',
    firstStatus: first.status,
    ack: ack?.type ?? null,
    ackLatencyMs: ackWall - sentWall,
    nextStatus: next.status,
    nextChars: nextText.length,
    markerInNext: marker(nextText),
    eventTypes: count(c.events.slice(beforeUpdate).map((e) => e.event)),
  });
  c.close();
}

function count(events: Json[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const e of events) { const t = String(e.type ?? 'unknown'); m[t] = (m[t] ?? 0) + 1; }
  return m;
}

if (mode === 'a' || mode === 'both') await caseA();
if (mode === 'b' || mode === 'both') await caseB();
