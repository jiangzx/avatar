// gateway/scripts/probe-emotion-p4-session-update.ts
// P4: what happens when Seeduplex receives a full session.update (a) during reply audio,
// (b) while idle, and (c) twice one second apart? A marker instruction makes compliance observable.
// Synthetic audio only; prints event types/timings and marker booleans, never text.
// Run from gateway/: node --env-file-if-exists=.env --import tsx scripts/probe-emotion-p4-session-update.ts \
//   <seeduplex-a|seeduplex-b|seeduplex-c|all> --wav <16k wav>
import WebSocket from 'ws';
import { readWavPcm16, sleep, type Json } from './lib/qwen-raw.ts';

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
if (!['seeduplex-a', 'seeduplex-b', 'seeduplex-c', 'seeduplex-c1', 'all'].includes(mode)) {
  throw new Error('usage: probe-emotion-p4-session-update.ts <seeduplex-a|seeduplex-b|seeduplex-c|seeduplex-c1|all> --wav <16k wav>');
}
const wav = flag('wav');
if (!wav) throw new Error('--wav <16k mono PCM16 WAV> is required');
const userPcm = readWavPcm16(wav);
const out = (o: Json) => process.stdout.write(`${JSON.stringify(o)}\n`);

const BASE = '你是一位温柔、自然的陪伴助手。请用简短、自然的口语回应用户。';
const SHORT_BASE = `${BASE}\n每次只回答一句话，不要展开。`;
const STORY_BASE = `${BASE}\n请讲一个五句话左右的小故事。`;
const MARKER = '呀嘿';
const MARKER_RULE = `每句话结尾都必须加上“${MARKER}”两个字。`;
const SECOND_MARKER = '喵喵';
const SECOND_RULE = `每句话结尾都必须加上“${SECOND_MARKER}”两个字。`;

interface Ev { at: number; event: Json }

class SeeduplexProbe {
  readonly events: Ev[] = [];
  private ws: WebSocket;
  private readonly t0 = Date.now();
  private counter = 0;
  private listeners: Array<(e: Json) => void> = [];
  private ready: Promise<void>;
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor(instructions: string) {
    this.ws = new WebSocket(endpoint, { headers: { 'X-Api-Key': apiKey }, perMessageDeflate: false });
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('session_create_timeout')), 10_000);
      this.ws.on('open', () => this.send({ type: 'session.create', event_id: this.eventId(), session: this.payload(instructions) }));
      this.ws.on('error', (e) => reject(new Error(`socket_error:${e.message}`)));
      this.ws.on('message', (raw) => {
        let event: Json;
        try { event = JSON.parse(raw.toString()) as Json; } catch { return; }
        this.events.push({ at: Date.now() - this.t0, event });
        if (event.type === 'session.created') { clearTimeout(timer); resolve(); }
        for (const l of [...this.listeners]) l(event);
      });
    });
  }

  async open(): Promise<void> { await this.ready; }

  /** Keep an idle/streaming session alive with 20 ms silence frames, like the client's mic path. */
  startKeepalive(): void {
    if (this.keepalive) return;
    this.keepalive = setInterval(() => {
      const zero = new Int16Array(320);
      this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(zero.buffer).toString('base64') });
    }, 20);
  }

  stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
  }

  send(event: Json): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  update(instructions: string): number {
    const at = Date.now() - this.t0;
    this.send({ type: 'session.update', event_id: this.eventId(), session: this.payload(instructions) });
    return at;
  }

  waitFor(pred: (e: Json) => boolean, timeoutMs: number): Promise<Json | null> {
    return new Promise((resolve) => {
      const on = (e: Json) => { if (!pred(e)) return; clearTimeout(timer); this.off(on); resolve(e); };
      const timer = setTimeout(() => { this.off(on); resolve(null); }, timeoutMs);
      this.listeners.push(on);
    });
  }

  async waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (pred()) return true; await sleep(50); }
    return pred();
  }

  async stream(pcm: Int16Array): Promise<void> {
    for (let o = 0; o < pcm.length; o += 320) {
      const chunk = pcm.subarray(o, Math.min(o + 320, pcm.length));
      this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64') });
      await sleep(20);
    }
    const tail = new Int16Array(16000 * 1.5);
    for (let o = 0; o < tail.length; o += 320) {
      const chunk = tail.subarray(o, Math.min(o + 320, tail.length));
      this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64') });
      await sleep(20);
    }
    this.send({ type: 'input_audio_buffer.commit', event_id: this.eventId() });
  }

  audioSamples(afterAt = 0, responseId?: string): number {
    let n = 0;
    for (const { at, event } of this.events) {
      if (at < afterAt) continue;
      if (responseId && event.response_id !== undefined && event.response_id !== responseId) continue;
      if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') n += Math.floor(Buffer.from(event.delta, 'base64').byteLength / 2);
    }
    return n;
  }

  text(afterAt = 0, responseId?: string): string {
    let s = '';
    for (const { at, event } of this.events) {
      if (at < afterAt) continue;
      if (responseId && event.response_id !== undefined && event.response_id !== responseId) continue;
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') s += event.delta;
    }
    return s;
  }

  types(afterAt = 0): Record<string, number> {
    const m: Record<string, number> = {};
    for (const { at, event } of this.events) {
      if (at < afterAt) continue;
      const t = String(event.type ?? 'unknown');
      m[t] = (m[t] ?? 0) + 1;
    }
    return m;
  }

  errors(afterAt = 0): string[] {
    return this.events.filter(({ at, event }) => at >= afterAt && event.type === 'error').map(({ event }) => {
      const e = (event.error ?? {}) as Json;
      return String(e.code ?? event.code ?? 'upstream_error');
    });
  }

  errorDetails(afterAt = 0): Json[] {
    return this.events.filter(({ at, event }) => at >= afterAt && event.type === 'error').map(({ at, event }) => {
      const e = (event.error ?? {}) as Json;
      return { at, code: e.code ?? event.code ?? null, type: e.type ?? null, param: e.param ?? null, keys: Object.keys(event) };
    });
  }

  close(): void {
    this.stopKeepalive();
    try { this.send({ type: 'session.close', event_id: this.eventId() }); } catch {}
    this.ws.close();
  }

  private payload(instructions: string): Json {
    return { id: 'anyidea', model, instructions, audio: { input: { format: { type: 'pcm', rate: 16000 } }, output: { format: { type: 'pcm_s16le', rate: 24000 }, voice } }, tools: [] };
  }

  private eventId(): string { return `probe-${++this.counter}`; }

  private off(fn: (e: Json) => void): void { this.listeners = this.listeners.filter((l) => l !== fn); }
}

/** Runs one user turn and resolves after audio.done or 30 s; returns whether the turn completed. */
async function turn(s: SeeduplexProbe): Promise<{ done: boolean; timedOut: boolean; doneType: string | null }> {
  const before = s.events.length;
  const doneP = s.waitFor((e) => e.type === 'response.output_audio.done' || e.type === 'response.done', 30_000);
  await s.stream(userPcm);
  const done = await doneP;
  if (done) await sleep(500);
  const started = s.events.slice(before).some((e) => e.event.type === 'response.output_audio.started');
  return { done: done !== null && started, timedOut: done === null, doneType: done ? String(done.type) : null };
}

function eventAt(s: SeeduplexProbe, type: string, afterIndex = 0): number | null {
  const e = s.events.slice(afterIndex).find((x) => x.event.type === type);
  return e ? e.at : null;
}

async function caseA(): Promise<void> {
  const s = new SeeduplexProbe(STORY_BASE);
  await s.open();
  const before = s.events.length;
  const startedP = s.waitFor((e) => e.type === 'response.output_audio.started', 60_000);
  const deltaP = s.waitFor((e) => e.type === 'response.output_audio.delta', 60_000);
  await s.stream(userPcm);
  s.startKeepalive();
  const startedEvent = await startedP;
  const responseId = typeof startedEvent?.response_id === 'string' ? startedEvent.response_id : undefined;
  const firstDelta = await deltaP;
  const firstDeltaAt = firstDelta ? (s.events.find((e) => e.event === firstDelta)?.at ?? null) : null;
  const sentAt = s.update(`${STORY_BASE}\n${MARKER_RULE}`);
  const updated = await s.waitFor((e) => e.type === 'session.updated', 5_000);
  const updatedAt = updated ? eventAt(s, 'session.updated', before) : null;
  await s.waitFor((e) => e.type === 'response.output_audio.done' || e.type === 'response.done', 10_000);
  await sleep(800);
  const afterText = s.text(sentAt, responseId);
  const afterAudio = s.audioSamples(sentAt, responseId);
  const doneEvent = s.events.slice(before).find(({ event }) => (event.type === 'response.output_audio.done' || event.type === 'response.done') && (!responseId || event.response_id === undefined || event.response_id === responseId));
  const doneAt = doneEvent ? doneEvent.at : null;
  const deltaAfter = s.events.filter(({ at, event }) => at >= sentAt && event.type === 'response.output_audio.delta' && (!responseId || event.response_id === undefined || event.response_id === responseId)).length;
  const verdict = s.errors(sentAt).length > 0 ? 'error' : deltaAfter > 0 ? 'continued' : doneAt !== null ? 'ended_after_update' : 'stalled';
  // After the current reply completes, check whether the mid-reply update applies to the next turn.
  let nextTurnStarted = false;
  let nextTurnMarker = false;
  if (doneAt !== null) {
    await sleep(2000);
    const startedP2 = s.waitFor((e) => e.type === 'response.output_audio.started', 20_000);
    const markerP = s.waitFor((e) => e.type === 'response.output_text.delta' && String(e.delta ?? '').includes(MARKER), 20_000);
    await s.stream(userPcm);
    nextTurnStarted = (await startedP2) !== null;
    nextTurnMarker = (await markerP) !== null;
  }
  // After a stalled reply, check whether the session accepts another user turn.
  let recoveryStarted = false;
  let recoveryDone = false;
  let cancelAck = false;
  if (verdict === 'stalled') {
    await sleep(1000);
    s.send({ type: 'response.cancel', event_id: 'probe-cancel' });
    cancelAck = (await s.waitFor((e) => e.type === 'response.canceled', 5_000)) !== null;
    await s.stream(userPcm);
    recoveryStarted = (await s.waitFor((e) => e.type === 'response.output_audio.started', 20_000)) !== null;
    if (recoveryStarted) recoveryDone = (await s.waitFor((e) => e.type === 'response.output_audio.done', 20_000)) !== null;
  }
  out({
    probe: 'p4',
    case: 'a',
    sentAt,
    firstDeltaAt,
    responseId: responseId ?? null,
    sessionUpdated: updated !== null,
    sessionUpdatedLatencyMs: updatedAt !== null ? updatedAt - sentAt : null,
    doneAt,
    doneAfterUpdateMs: doneAt !== null ? doneAt - sentAt : null,
    audioDeltasAfterUpdate: deltaAfter,
    audioMsAfterUpdate: Math.round(afterAudio / 24),
    textCharsAfterUpdate: afterText.length,
    markerInRemaining: afterText.includes(MARKER),
    errors: s.errors(sentAt),
    errorDetails: s.errorDetails(sentAt),
    eventTypesBeforeUpdate: s.types(before),
    eventTypesAfterUpdate: s.types(sentAt),
    verdict,
    nextTurnStarted,
    nextTurnMarker,
    cancelAck,
    recoveryStarted,
    recoveryDone,
    errorsAfterRecovery: s.errors(sentAt),
  });
  s.close();
}

async function caseB(): Promise<void> {
  const marker = flag('marker') ?? MARKER;
  const rule = marker === SECOND_MARKER ? SECOND_RULE : MARKER_RULE;
  const s = new SeeduplexProbe(BASE);
  await s.open();
  const first = await turn(s);
  const sentAt = s.update(`${BASE}\n${rule}`);
  const updated = await s.waitFor((e) => e.type === 'session.updated', 5_000);
  const updatedAt = updated ? s.events.filter((e) => e.event.type === 'session.updated').at(-1)?.at ?? null : null;
  const turnStart = s.events.length;
  const second = await turn(s);
  const secondText = s.events.slice(turnStart).filter((e) => e.event.type === 'response.output_text.delta').map((e) => String(e.event.delta ?? '')).join('');
  out({
    probe: 'p4',
    case: 'b',
    firstTurnDone: first.done,
    firstTurnTimedOut: first.timedOut,
    sentAt,
    sessionUpdated: updated !== null,
    sessionUpdatedLatencyMs: updatedAt !== null ? updatedAt - sentAt : null,
    secondTurnDone: second.done,
    secondTurnTimedOut: second.timedOut,
    secondTurnDoneType: second.doneType,
    secondReplyChars: secondText.length,
    marker,
    markerInSecondReply: secondText.includes(marker),
    errors: s.errors(0),
    errorDetails: s.errorDetails(0),
    eventTypes: s.types(0),
    verdict: secondText.includes(marker) ? 'applied_next_turn' : 'not_applied_next_turn',
  });
  s.close();
}

async function caseC(): Promise<void> {
  const s = new SeeduplexProbe(SHORT_BASE);
  await s.open();
  const warm = await turn(s);
  const firstAt = s.update(`${SHORT_BASE}\n${SECOND_RULE}`);
  await sleep(1000);
  const secondAt = s.update(`${SHORT_BASE}\n${MARKER_RULE}`);
  await sleep(2000);
  const updates = s.events.filter((e) => e.event.type === 'session.updated').map((e) => e.at);
  const turnStart = s.events.length;
  const t = await turn(s);
  const reply = s.events.slice(turnStart).filter((e) => e.event.type === 'response.output_text.delta').map((e) => String(e.event.delta ?? '')).join('');
  out({
    probe: 'p4',
    case: 'c',
    warmTurnDone: warm.done,
    firstUpdateAt: firstAt,
    secondUpdateAt: secondAt,
    sessionUpdatedCount: updates.length,
    sessionUpdatedAt: updates,
    sessionUpdatedGapMs: updates.length >= 2 ? updates[1]! - updates[0]! : null,
    turnDone: t.done,
    turnTimedOut: t.timedOut,
    turnDoneType: t.doneType,
    replyChars: reply.length,
    firstMarkerSeen: reply.includes(SECOND_MARKER),
    secondMarkerSeen: reply.includes(MARKER),
    errors: s.errors(0),
    errorDetails: s.errorDetails(0),
    eventTypes: s.types(0),
    verdict: updates.length < 2 ? 'update_dropped_or_delayed' : reply.includes(MARKER) ? 'second_applied' : reply.includes(SECOND_MARKER) ? 'first_applied' : 'neither_applied',
  });
  s.close();
}


/** Control for case c: one update with the first marker, then one turn. */
async function caseC1(): Promise<void> {
  const s = new SeeduplexProbe(BASE);
  await s.open();
  const sentAt = s.update(`${BASE}\n${SECOND_RULE}`);
  const updated = await s.waitFor((e) => e.type === 'session.updated', 5_000);
  const turnStart = s.events.length;
  const t = await turn(s);
  const reply = s.events.slice(turnStart).filter((e) => e.event.type === 'response.output_text.delta').map((e) => String(e.event.delta ?? '')).join('');
  out({
    probe: 'p4',
    case: 'c1',
    sentAt,
    sessionUpdated: updated !== null,
    sessionUpdatedLatencyMs: updated !== null ? (s.events.find((e) => e.event.type === 'session.updated')?.at ?? 0) - sentAt : null,
    turnDone: t.done,
    turnTimedOut: t.timedOut,
    turnDoneType: t.doneType,
    replyChars: reply.length,
    firstMarkerSeen: reply.includes(SECOND_MARKER),
    secondMarkerSeen: reply.includes(MARKER),
    errors: s.errors(0),
    errorDetails: s.errorDetails(0),
    eventTypes: s.types(0),
    verdict: reply.includes(SECOND_MARKER) ? 'single_update_applied' : 'single_update_not_applied',
  });
  s.close();
}

if (mode === 'seeduplex-a' || mode === 'all') await caseA();
if (mode === 'seeduplex-b' || mode === 'all') await caseB();
if (mode === 'seeduplex-c' || mode === 'all') await caseC();
if (mode === 'seeduplex-c1' || mode === 'all') await caseC1();
