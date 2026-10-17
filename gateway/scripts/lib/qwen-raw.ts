import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

export type Json = Record<string, unknown>;

export interface ResponseCapture {
  status: string;
  transcript: string;
  audio: Int16Array;
  usage: Json | null;
  statusDetails: unknown;
  error: string | null;
}

/** Minimal raw Qwen realtime client for manual probes. Never used by the gateway runtime. */
export class QwenRaw {
  readonly events: Array<{ at: number; event: Json }> = [];
  private ws: WebSocket | null = null;
  private readonly t0 = Date.now();
  private listeners: Array<(e: Json) => void> = [];

  static async open(opts: { apiKey: string; endpoint: string; model: string; session: Json; timeoutMs?: number }): Promise<QwenRaw> {
    const c = new QwenRaw();
    const url = new URL(opts.endpoint);
    url.searchParams.set('model', opts.model);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${opts.apiKey}` }, perMessageDeflate: false });
    c.ws = ws;
    ws.on('message', (data) => {
      let e: Json;
      try { e = JSON.parse(data.toString()) as Json; } catch { return; }
      c.events.push({ at: Date.now() - c.t0, event: e });
      for (const l of [...c.listeners]) l(e);
    });
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    ws.on('error', () => { /* later socket errors surface as waitFor/collect timeouts */ });
    c.send({ type: 'session.update', session: opts.session });
    const ack = await c.waitFor((e) => e.type === 'session.updated' || e.type === 'error', opts.timeoutMs ?? 10_000);
    if (!ack || ack.type === 'error') {
      c.close();
      throw new Error(`session_rejected:${errorCode(ack)}`);
    }
    return c;
  }

  send(event: Json): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  sendPcm16k(pcm: Int16Array): void {
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') });
  }

  waitFor(pred: (e: Json) => boolean, timeoutMs: number): Promise<Json | null> {
    return new Promise((resolve) => {
      const on = (e: Json) => {
        if (!pred(e)) return;
        clearTimeout(timer);
        this.off(on);
        resolve(e);
      };
      const timer = setTimeout(() => { this.off(on); resolve(null); }, timeoutMs);
      this.listeners.push(on);
    });
  }

  /** Registers a collector, runs `trigger` (e.g. send response.create), and resolves at response.done or error. */
  collect(trigger: () => void, timeoutMs = 30_000): Promise<ResponseCapture> {
    return new Promise((resolve) => {
      const chunks: Int16Array[] = [];
      let transcript = '';
      const finish = (rest: Pick<ResponseCapture, 'status' | 'usage' | 'statusDetails' | 'error'>) => {
        clearTimeout(timer);
        this.off(on);
        resolve({ ...rest, transcript, audio: concat(chunks) });
      };
      const on = (e: Json) => {
        if (e.type === 'response.audio.delta' && typeof e.delta === 'string') chunks.push(decodePcm(e.delta));
        else if (e.type === 'response.audio_transcript.delta' && typeof e.delta === 'string') transcript += e.delta;
        else if (e.type === 'response.done') {
          const r = (e.response ?? {}) as Json;
          finish({ status: String(r.status ?? 'unknown'), usage: (r.usage as Json | undefined) ?? null, statusDetails: r.status_details ?? null, error: null });
        } else if (e.type === 'error') finish({ status: 'error', usage: null, statusDetails: null, error: errorCode(e) });
      };
      const timer = setTimeout(() => finish({ status: 'timeout', usage: null, statusDetails: null, error: 'timeout' }), timeoutMs);
      this.listeners.push(on);
      trigger();
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private off(fn: (e: Json) => void): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
}

/** Mirrors the session.update payload of gateway/src/adapters/qwen.ts. */
export function baseSession(instructions: string, voice: string, extra: Json = {}): Json {
  return {
    modalities: ['text', 'audio'],
    instructions,
    turn_detection: { type: 'semantic_vad', silence_duration_ms: 800 },
    input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
    audio: {
      input: { format: { type: 'pcm', sample_rate: 16000, sample_format: 's16le', channels: 1, packing: 'interleaved', channel_layout: 'mono' } },
      output: { voice, format: { type: 'pcm', sample_rate: 24000 } },
    },
    ...extra,
  };
}

export function userText(text: string): Json {
  return { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
}

export function probeEnv(env: Record<string, string | undefined> = process.env): { apiKey: string; endpoint: string; model: string; voice: string } {
  const apiKey = env.DASHSCOPE_API_KEY ?? '';
  const endpoint = env.QWEN_ENDPOINT ?? '';
  if (!apiKey || !endpoint) throw new Error('DASHSCOPE_API_KEY and QWEN_ENDPOINT must be set (gateway/.env)');
  return { apiKey, endpoint, model: env.QWEN_MODEL ?? 'qwen3.8-omni-flash-realtime', voice: env.QWEN_VOICE ?? 'longanlingxin' };
}

export function errorCode(e: Json | null): string {
  const err = (e?.error ?? {}) as Json;
  return String(err.code ?? err.type ?? 'unknown');
}

export function endsWithMeow(text: string): boolean {
  return text.replace(/[\s。！？!?，,.~～]+$/u, '').endsWith('喵');
}

export interface InstructionRun { aError: string | null; aMeow: boolean; bMeow: boolean; userItems: number }

/** a = response.create with only the per-response task; b = full session rule + task. */
export function instructionVerdict(runs: InstructionRun[]): 'replace' | 'append' | 'unsupported' | 'inconclusive' {
  if (runs.some((r) => r.aError !== null)) return 'unsupported';
  const meowA = runs.filter((r) => r.aMeow).length;
  if (meowA === runs.length) return 'append';
  if (meowA === 0 && runs.every((r) => r.bMeow)) return 'replace';
  return 'inconclusive';
}

export function wavBytes(pcm: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export function parseWavPcm16(buf: Buffer): Int16Array {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('wav_invalid');
  let off = 12;
  let pcm16 = false;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') pcm16 = buf.readUInt16LE(off + 8) === 1 && buf.readUInt16LE(off + 22) === 16;
    if (id === 'data') {
      if (!pcm16) throw new Error('wav_not_pcm16');
      const end = Math.min(buf.length, off + 8 + size);
      const bytes = buf.subarray(off + 8, end - ((end - off - 8) % 2));
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('wav_no_data');
}

export function readWavPcm16(path: string): Int16Array {
  return parseWavPcm16(readFileSync(path));
}

export function writeWav(path: string, pcm: Int16Array, sampleRate: number): void {
  writeFileSync(path, wavBytes(pcm, sampleRate));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodePcm(b64: string): Int16Array {
  const b = Buffer.from(b64, 'base64');
  const n = b.byteLength - (b.byteLength % 2);
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + n));
}

function concat(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
