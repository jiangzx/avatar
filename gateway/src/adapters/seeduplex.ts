import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AI_SAMPLE_RATE, MIC_SAMPLE_RATE } from '@anyidea/protocol';
import type { AdapterEvents, ProactiveRequest, RealtimeAdapter, SessionConfig, ToolSpec } from './types.ts';

export interface SeeduplexOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  voice: string;
  connectTimeoutMs?: number;
  inputFrameMs?: number;
}

type Json = Record<string, unknown>;

export class SeeduplexAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  /** speech_text_buffer.commit synthesizes fallbackText directly; no transcript follows. */
  readonly verbatimFallback = true;
  private ws: WebSocket | null = null;
  private closed = false;
  private connected = false;
  private responseId: string | null = null;
  private responseStarted = new Set<string>();
  private connectTimer: NodeJS.Timeout | null = null;
  private initialization: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private inputRemainder = new Int16Array(0);
  private eventCounter = 0;
  private instructions = '';
  private tools: ToolSpec[] = [];
  private voice = '';
  private readonly opts: Required<Pick<SeeduplexOptions, 'endpoint' | 'model' | 'voice' | 'connectTimeoutMs' | 'inputFrameMs'>> & Pick<SeeduplexOptions, 'apiKey'>;

  constructor(options: SeeduplexOptions) {
    super();
    if (!options.apiKey) throw new Error('SEEDUPLEX_API_KEY is required');
    this.opts = { endpoint: options.endpoint ?? 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', model: options.model ?? '1.2.6.1', voice: options.voice, connectTimeoutMs: options.connectTimeoutMs ?? 10000, inputFrameMs: options.inputFrameMs ?? 20, apiKey: options.apiKey };
  }

  async connect(config: SessionConfig): Promise<void> {
    if (this.ws || this.closed) throw new Error('adapter_not_connectable');
    this.instructions = config.instructions;
    this.tools = config.tools;
    this.voice = config.voice ?? this.opts.voice;
    await new Promise<void>((resolve, reject) => {
      this.initialization = { resolve, reject };
      const ws = new WebSocket(this.opts.endpoint, { headers: { 'X-Api-Key': this.opts.apiKey }, perMessageDeflate: false });
      this.ws = ws;
      ws.on('message', (data) => { if (!this.closed) this.onMessage(data); });
      ws.on('error', () => {
        if (this.initialization) this.failInitialization('seeduplex_connect_error');
        else if (!this.closed) this.emit('error', 'upstream_socket_error', true);
      });
      ws.on('close', () => {
        this.connected = false;
        if (this.initialization) this.failInitialization('seeduplex_connect_closed');
        else if (!this.closed) this.emit('closed');
      });
      this.connectTimer = setTimeout(() => this.failInitialization('seeduplex_connect_timeout'), this.opts.connectTimeoutMs);
      ws.once('open', () => { if (!this.closed) this.sendSessionCreate(); });
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

  sendAudio(pcm16k: Int16Array): void {
    if (!this.connected || this.closed) return;
    const merged = new Int16Array(this.inputRemainder.length + pcm16k.length);
    merged.set(this.inputRemainder); merged.set(pcm16k, this.inputRemainder.length);
    const samples = Math.max(1, Math.round(MIC_SAMPLE_RATE * this.opts.inputFrameMs / 1000));
    let offset = 0;
    while (offset + samples <= merged.length) { this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(merged.subarray(offset, offset + samples).buffer, merged.subarray(offset, offset + samples).byteOffset, samples * 2).toString('base64') }); offset += samples; }
    this.inputRemainder = merged.slice(offset);
  }

  /** Keep the upstream session alive when the client stops microphone capture. */
  setInputMuted(muted: boolean): void {
    if (this.connected) this.send({ type: muted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit', event_id: this.eventId() });
  }

  sendUserText(text: string): void { if (this.connected) this.send({ type: 'speech_text_buffer.commit', event_id: this.eventId(), text }); }
  updateInstructions(text: string): void { this.instructions = text; if (this.connected) this.send({ type: 'session.update', event_id: this.eventId(), session: this.sessionPayload() }); }
  createResponse(request?: ProactiveRequest): void {
    // High-risk tool/proactive path: read docs/project/roadmap.md "记忆与回忆：已踩过的坑" before changing.
    // speech_text_buffer.commit is direct TTS; committing the Director prompt would speak it verbatim.
    if (this.connected && request?.fallbackText) this.send({ type: 'speech_text_buffer.commit', event_id: this.eventId(), text: request.fallbackText });
  }
  cancelResponse(): void { if (this.connected) this.send({ type: 'response.cancel', event_id: this.eventId() }); }
  sendToolResult(callId: string, result: unknown): void { if (this.connected) this.send({ type: 'conversation.item.create', event_id: this.eventId(), items: [{ type: 'message', role: 'tool', call_id: callId, content: [{ type: 'input_text', text: JSON.stringify(result) }] }] }); }
  injectContextNote(text: string): void { if (this.connected) this.send({ type: 'conversation.item.create', event_id: this.eventId(), items: [{ type: 'message', role: 'assistant', content: [{ type: 'input_text', text }] }] }); }
  close(): void { if (this.closed) return; this.closed = true; this.connected = false; this.failInitialization('seeduplex_connect_closed'); this.clearConnectTimer(); const ws = this.ws; this.ws = null; if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'session.close', event_id: this.eventId() })); } catch {} ws.close(); } else ws?.terminate(); }

  private sessionPayload(): Json { return { id: 'anyidea', model: this.opts.model, instructions: this.instructions, audio: { input: { format: { type: 'pcm', rate: MIC_SAMPLE_RATE } }, output: { format: { type: 'pcm_s16le', rate: AI_SAMPLE_RATE }, voice: this.voice } }, tools: this.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters })) }; }
  private sendSessionCreate(): void { this.send({ type: 'session.create', event_id: this.eventId(), session: this.sessionPayload() }); }
  private send(event: Json): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event)); }
  private eventId(): string { return `anyidea-${++this.eventCounter}`; }
  private clearConnectTimer(): void { if (this.connectTimer) clearTimeout(this.connectTimer); this.connectTimer = null; }
  private onMessage(data: WebSocket.RawData): void {
    let event: Json;
    try { event = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Json; } catch { this.emit('error', 'upstream_invalid_json', false); return; }
    const type = typeof event.type === 'string' ? event.type : '';
    switch (type) {
      case 'session.created': {
        if (this.initialization) {
          const initialization = this.initialization;
          this.initialization = null;
          this.clearConnectTimer();
          this.connected = true;
          initialization.resolve();
        }
        break;
      }
      case 'session.updated': break;
      case 'conversation.item.input_audio_transcription.started': this.emit('userSpeechStarted'); break;
      case 'conversation.item.input_audio_transcription.delta': this.emit('userTranscript', typeof event.delta === 'string' ? event.delta : '', false); break;
      case 'conversation.item.input_audio_transcription.completed': this.emit('userTranscript', typeof event.transcript === 'string' ? event.transcript : (typeof event.text === 'string' ? event.text : ''), true); break;
      case 'response.output_audio.started': { const id = this.responseIdFrom(event); this.responseId = id; this.responseStarted.add(id); this.emit('responseStarted', id); break; }
      case 'response.output_audio.delta': { const id = this.responseId ?? this.responseIdFrom(event); const pcm = decodePcm16(event.delta); if (pcm) this.emit('audioDelta', id, pcm); break; }
      case 'response.output_text.delta': { const id = this.responseId ?? this.responseIdFrom(event); if (typeof event.delta === 'string') this.emit('textDelta', id, event.delta); break; }
      case 'response.output_audio.done': { const id = this.responseIdFrom(event); this.emit('responseDone', id); break; }
      case 'response.canceled': { const id = this.responseIdFrom(event); this.emit('responseCancelled', id); if (this.responseId === id) this.responseId = null; break; }
      case 'response.function_call_arguments.done': { const id = this.responseIdFrom(event); const items = Array.isArray(event.items) ? event.items : []; for (const item of items) { const x = item as Json; let args: unknown = {}; try { args = JSON.parse(typeof x.arguments === 'string' ? x.arguments : '{}'); } catch {} this.emit('toolCall', id, String(x.call_id ?? ''), String(x.name ?? ''), args); } break; }
      case 'error': if (this.initialization) { this.failInitialization('seeduplex_session_rejected'); break; } this.emit('error', String((event.error as Json | undefined)?.code ?? event.code ?? 'upstream_error'), true); break;
      case 'session.closed': break;
      default: break;
    }
  }
  private responseIdFrom(event: Json): string { return typeof event.response_id === 'string' ? event.response_id : (this.responseId ?? 'unknown'); }
}

function decodePcm16(value: unknown): Int16Array | null {
  if (typeof value !== 'string') return null;
  try { const b = Buffer.from(value, 'base64'); const even = b.byteLength - (b.byteLength % 2); return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + even)); } catch { return null; }
}
