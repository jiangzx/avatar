import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AI_SAMPLE_RATE, MIC_SAMPLE_RATE } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig, TokenUsage, ToolSpec } from './types.ts';

export interface QwenOptions { apiKey: string; endpoint: string; model?: string; voice: string; connectTimeoutMs?: number; }
type Json = Record<string, unknown>;

export type ResponseInstructionMode = 'replace' | 'append' | 'item';
/**
 * How response.create `instructions` behave on Qwen: 'replace' overrides session instructions,
 * 'append' adds to them, 'item' = unsupported, fall back to a labeled item.
 * 'item' is the fallback pending the probe (unverified, no real calls made); see docs/blockers.md #12.
 */
export const RESPONSE_INSTRUCTIONS: ResponseInstructionMode = 'item';
/** Label for the fallback path so the model does not read the item as something the user said. */
export const SYSTEM_NOTE_PREFIX = '（系统提示，非用户发言）';

export function proactiveEvents(mode: ResponseInstructionMode, sessionInstructions: string, request: ProactiveRequest): Json[] {
  switch (mode) {
    case 'replace':
      return [{ type: 'response.create', response: { instructions: `${sessionInstructions}\n\n## 本次任务\n${request.instruction}` } }];
    case 'append':
      return [{ type: 'response.create', response: { instructions: request.instruction } }];
    case 'item':
      return [
        { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${SYSTEM_NOTE_PREFIX}${request.instruction}` }] } },
        { type: 'response.create' },
      ];
  }
}

/** Qwen-Omni WebSocket adapter. Audio and event shapes follow the official Realtime API. */
export class QwenAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  readonly verbatimFallback = false;
  readonly supportsUserText = true;
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private responseId: string | null = null;
  private instructions = '';
  private voice = '';
  private eventCounter = 0;
  private completedResponses = new Set<string>();
  private startedResponses = new Set<string>();
  private initialization: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private readonly opts: Required<QwenOptions>;
  constructor(options: QwenOptions) {
    super();
    if (!options.apiKey) throw new Error('DASHSCOPE_API_KEY is required');
    this.opts = { model: 'qwen3.8-omni-flash-realtime', connectTimeoutMs: 10000, ...options };
  }
  async connect(config: SessionConfig): Promise<void> {
    if (this.ws || this.closed) throw new Error('adapter_not_connectable');
    this.instructions = config.instructions;
    this.voice = config.voice ?? this.opts.voice;
    const url = new URL(this.opts.endpoint); url.searchParams.set('model', this.opts.model);
    await new Promise<void>((resolve, reject) => {
      this.initialization = { resolve, reject };
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.opts.apiKey}` }, perMessageDeflate: false }); this.ws = ws;
      ws.on('message', (data) => { if (!this.closed) this.onMessage(data); });
      ws.on('error', () => {
        if (this.initialization) this.failInitialization('qwen_connect_error');
        else if (!this.closed) this.emit('error', 'qwen_socket_error', true);
      });
      ws.on('close', () => {
        this.connected = false;
        if (this.initialization) this.failInitialization('qwen_connect_closed');
        else if (!this.closed) this.emit('closed');
      });
      this.connectTimer = setTimeout(() => this.failInitialization('qwen_connect_timeout'), this.opts.connectTimeoutMs);
      ws.once('open', () => { if (!this.closed) this.send({ type: 'session.update', session: { modalities: ['text', 'audio'], instructions: config.instructions, turn_detection: { type: 'semantic_vad', silence_duration_ms: 800 }, input_audio_transcription: { model: 'qwen3-asr-flash-realtime' }, audio: { input: { format: { type: 'pcm', sample_rate: MIC_SAMPLE_RATE, sample_format: 's16le', channels: 1, packing: 'interleaved', channel_layout: 'mono' } }, output: { voice: this.voice, format: { type: 'pcm', sample_rate: AI_SAMPLE_RATE } } }, tools: config.tools.map(toQwenTool), ...(config.maxOutputTokens !== undefined ? { max_response_output_tokens: config.maxOutputTokens } : {}) } }); });
    });
  }

  private failInitialization(code: string): void {
    const initialization = this.initialization;
    if (!initialization) return;
    this.initialization = null;
    this.clearConnectTimer();
    initialization.reject(new Error(code));
    this.close();
  }
  sendAudio(pcm16k: Int16Array): void { if (!this.connected) return; const b = Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength); this.send({ type: 'input_audio_buffer.append', audio: b.toString('base64') }); }
  sendUserText(text: string): void {
    if (!this.connected) return;
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.createResponse();
  }
  updateInstructions(text: string): void {
    this.instructions = text;
    if (this.connected) this.send({ type: 'session.update', session: { instructions: text } });
  }
  /** Voice updates apply to the next response; a partial session.update is accepted (probe 2026-10-21). */
  updateVoice(voice: string | undefined): void {
    this.voice = voice ?? this.opts.voice;
    if (this.connected) this.send({ type: 'session.update', session: { audio: { output: { voice: this.voice } } } });
  }
  /** One partial session.update with only the changed fields; same keys as the connect payload. */
  updateSession(update: { instructions?: string; voice?: { value: string | undefined } }): void {
    const session: Json = {};
    if (update.instructions !== undefined) {
      this.instructions = update.instructions;
      session.instructions = update.instructions;
    }
    if (update.voice) {
      this.voice = update.voice.value ?? this.opts.voice;
      session.audio = { output: { voice: this.voice } };
    }
    if (this.connected && Object.keys(session).length > 0) this.send({ type: 'session.update', session });
  }
  createResponse(request?: ProactiveRequest): void {
    if (!this.connected) return;
    if (!request) { this.send({ type: 'response.create' }); return; }
    for (const event of proactiveEvents(RESPONSE_INSTRUCTIONS, this.instructions, request)) this.send(event);
  }
  cancelResponse(): void { if (this.connected) this.send({ type: 'response.cancel' }); }
  sendToolResult(callId: string, result: unknown): void {
    if (!this.connected) return;
    // The session owns the one instructed continuation. A bare response.create here would race it
    // and cut the first reply mid-playback.
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
  }
  /** Interruption notes reach Qwen through session instructions (Session.pushInstructions), never as a user item. */
  injectContextNote(_text: string): void {}
  close(): void { if (this.closed) return; this.closed = true; this.connected = false; this.failInitialization('qwen_connect_closed'); this.clearConnectTimer(); const ws = this.ws; this.ws = null; ws?.close(); }
  private send(event: Json): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event)); }
  private eventId(): string { return `qwen-${++this.eventCounter}`; }
  private onMessage(data: WebSocket.RawData): void {
    let e: Json; try { e = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Json; } catch { this.emit('error', 'qwen_invalid_json', false); return; }
    const type = typeof e.type === 'string' ? e.type : '';
    if (type === 'session.created') return;
    if (type === 'session.updated') {
      if (this.initialization) {
        const initialization = this.initialization;
        this.initialization = null;
        this.clearConnectTimer();
        this.connected = true;
        initialization.resolve();
      }
      return;
    }
    if (type === 'input_audio_buffer.committed') return;
    if (type === 'input_audio_buffer.speech_started') { this.emit('userSpeechStarted'); return; }
    if (type === 'input_audio_buffer.speech_stopped') { this.emit('userSpeechStopped'); return; }
    if (type === 'conversation.item.input_audio_transcription.delta') { this.emit('userTranscript', String(e.delta ?? e.text ?? ''), false); return; }
    if (type === 'conversation.item.input_audio_transcription.completed') { this.emit('userTranscript', String(e.transcript ?? e.text ?? ''), true); return; }
    if (type === 'response.audio.started') {
      const id = this.responseIdFrom(e);
      if (this.startedResponses.has(id)) return;
      this.startedResponses.add(id);
      this.responseId = id;
      this.completedResponses.delete(id);
      this.emit('responseStarted', id);
      return;
    }
    if (type === 'response.created') {
      const nested = e.response as Json | undefined;
      const id = typeof nested?.id === 'string' ? nested.id : this.responseIdFrom(e);
      if (this.startedResponses.has(id)) return;
      this.startedResponses.add(id);
      this.responseId = id;
      this.completedResponses.delete(id);
      this.emit('responseStarted', id);
      return;
    }
    if (type === 'response.audio.delta') { const pcm = decode(e.delta); if (pcm) this.emit('audioDelta', this.responseIdFrom(e), pcm); return; }
    if (type === 'response.audio_transcript.delta' || type === 'response.text.delta') { this.emit('textDelta', this.responseIdFrom(e), String(e.delta ?? '')); return; }
    if (type === 'response.audio.done' || type === 'response.done') {
      const id = this.responseIdFrom(e);
      const nested = e.response as Json | undefined;
      if (type === 'response.done') {
        const usage = parseUsage(nested?.usage);
        if (usage) this.emit('responseUsage', id, usage);
      }
      if (type === 'response.done' && nested?.status === 'cancelled') {
        this.completedResponses.delete(id);
        this.emit('responseCancelled', id);
        return;
      }
      if (!this.completedResponses.has(id)) { this.completedResponses.add(id); this.emit('responseDone', id); }
      return;
    }
    if (type === 'response.canceled') { const id = this.responseIdFrom(e); this.completedResponses.delete(id); this.emit('responseCancelled', id); return; }
    if (type === 'response.function_call_arguments.done') { const item = (e.item ?? e) as Json; let args: unknown = {}; try { args = JSON.parse(String(item.arguments ?? '{}')); } catch {} this.emit('toolCall', this.responseIdFrom(e), String(item.call_id ?? ''), String(item.name ?? ''), args); return; }
    if (type === 'error') {
      const err = e.error as Json | undefined;
      const requestId = qwenErrorRequestId(e);
      if (this.initialization) this.failInitialization('qwen_session_rejected');
      else this.emit('error', String(err?.code ?? err?.type ?? 'qwen_error'), true, requestId ? { requestId } : undefined);
    }
  }
  private responseIdFrom(e: Json): string { return typeof e.response_id === 'string' ? e.response_id : (this.responseId ?? 'unknown'); }
  private clearConnectTimer(): void { if (this.connectTimer) clearTimeout(this.connectTimer); this.connectTimer = null; }
}
function toQwenTool(tool: ToolSpec): Json { return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }; }
function decode(value: unknown): Int16Array | null { if (typeof value !== 'string') return null; try { const b = Buffer.from(value, 'base64'); const n = b.byteLength - b.byteLength % 2; return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + n)); } catch { return null; } }

function parseUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Json;
  if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null;
  const usage: TokenUsage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
  // Qwen documents input_tokens_details; the OpenAI spelling is accepted too.
  const input = detailsOf(u.input_tokens_details ?? u.input_token_details);
  const output = detailsOf(u.output_tokens_details ?? u.output_token_details);
  if (input.text !== undefined) usage.inputTextTokens = input.text;
  if (input.audio !== undefined) usage.inputAudioTokens = input.audio;
  if (input.cached !== undefined) usage.cachedTokens = input.cached;
  if (output.text !== undefined) usage.outputTextTokens = output.text;
  if (output.audio !== undefined) usage.outputAudioTokens = output.audio;
  return usage;
}

function detailsOf(raw: unknown): { text?: number; audio?: number; cached?: number } {
  if (!raw || typeof raw !== 'object') return {};
  const d = raw as Json;
  const pick = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return { text: pick(d.text_tokens), audio: pick(d.audio_tokens), cached: pick(d.cached_tokens) };
}

/** The only id path a Qwen error event carries (P1-T1 probe A4). Never reads the message. */
export function qwenErrorRequestId(event: Json): string | undefined {
  const value = event.event_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
