import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AI_SAMPLE_RATE, MIC_SAMPLE_RATE } from '@anyidea/protocol';
import type { AdapterEvents, RealtimeAdapter, SessionConfig, ToolSpec } from './types.ts';

export interface QwenOptions { apiKey: string; endpoint: string; model?: string; voice: string; connectTimeoutMs?: number; }
type Json = Record<string, unknown>;

/** Qwen-Omni WebSocket adapter. Audio and event shapes follow the official Realtime API. */
export class QwenAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private responseId: string | null = null;
  private eventCounter = 0;
  private readonly opts: Required<QwenOptions>;
  constructor(options: QwenOptions) {
    super();
    if (!options.apiKey) throw new Error('DASHSCOPE_API_KEY is required');
    this.opts = { model: 'qwen3.8-omni-flash-realtime', connectTimeoutMs: 10000, ...options };
  }
  async connect(config: SessionConfig): Promise<void> {
    const url = new URL(this.opts.endpoint); url.searchParams.set('model', this.opts.model);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.opts.apiKey}` }, perMessageDeflate: false }); this.ws = ws;
    ws.on('message', (data) => this.onMessage(data));
    ws.on('error', () => { if (!this.closed) this.emit('error', 'qwen_socket_error', true); });
    ws.on('close', () => { this.connected = false; if (!this.closed) this.emit('closed'); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('qwen_connect_timeout')); }, this.opts.connectTimeoutMs);
      ws.once('open', () => { clearTimeout(timer); this.connected = true; this.send({ type: 'session.update', session: { modalities: ['text', 'audio'], instructions: config.instructions, turn_detection: null, audio: { input: { format: { type: 'pcm', sample_rate: MIC_SAMPLE_RATE, sample_format: 's16le', channels: 1, packing: 'interleaved', channel_layout: 'mono' } }, output: { voice: this.opts.voice, format: { type: 'pcm', sample_rate: AI_SAMPLE_RATE } } }, tools: config.tools.map(toQwenTool) } }); resolve(); });
      ws.once('error', (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error('qwen_connect_error')); });
    });
  }
  sendAudio(pcm16k: Int16Array): void { if (!this.connected) return; const b = Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength); this.send({ type: 'input_audio_buffer.append', audio: b.toString('base64') }); }
  sendUserText(text: string): void { if (this.connected) this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }); }
  updateInstructions(text: string): void { if (this.connected) this.send({ type: 'session.update', session: { instructions: text } }); }
  createResponse(): void { if (this.connected) this.send({ type: 'response.create' }); }
  cancelResponse(): void { if (this.connected) this.send({ type: 'response.cancel' }); }
  sendToolResult(callId: string, result: unknown): void { if (this.connected) this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } }); }
  injectContextNote(text: string): void { this.sendUserText(text); }
  close(): void { if (this.closed) return; this.closed = true; const ws = this.ws; this.ws = null; ws?.close(); }
  private send(event: Json): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event)); }
  private eventId(): string { return `qwen-${++this.eventCounter}`; }
  private onMessage(data: WebSocket.RawData): void {
    let e: Json; try { e = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Json; } catch { this.emit('error', 'qwen_invalid_json', false); return; }
    const type = typeof e.type === 'string' ? e.type : '';
    if (type === 'session.created' || type === 'session.updated' || type === 'input_audio_buffer.committed') return;
    if (type === 'input_audio_buffer.speech_started') { this.emit('userSpeechStarted'); return; }
    if (type === 'conversation.item.input_audio_transcription.delta') { this.emit('userTranscript', String(e.delta ?? e.text ?? ''), false); return; }
    if (type === 'conversation.item.input_audio_transcription.completed') { this.emit('userTranscript', String(e.transcript ?? e.text ?? ''), true); return; }
    if (type === 'response.audio.started') { this.responseId = this.responseIdFrom(e); this.emit('responseStarted', this.responseId); return; }
    if (type === 'response.audio.delta') { const pcm = decode(e.delta); if (pcm) this.emit('audioDelta', this.responseIdFrom(e), pcm); return; }
    if (type === 'response.audio_transcript.delta' || type === 'response.text.delta') { this.emit('textDelta', this.responseIdFrom(e), String(e.delta ?? '')); return; }
    if (type === 'response.audio.done' || type === 'response.done') { this.emit('responseDone', this.responseIdFrom(e)); return; }
    if (type === 'response.canceled') { this.emit('responseCancelled', this.responseIdFrom(e)); return; }
    if (type === 'response.function_call_arguments.done') { const item = (e.item ?? e) as Json; let args: unknown = {}; try { args = JSON.parse(String(item.arguments ?? '{}')); } catch {} this.emit('toolCall', this.responseIdFrom(e), String(item.call_id ?? ''), String(item.name ?? ''), args); return; }
    if (type === 'error') { const err = e.error as Json | undefined; this.emit('error', String(err?.code ?? 'qwen_error'), true); }
  }
  private responseIdFrom(e: Json): string { return typeof e.response_id === 'string' ? e.response_id : (this.responseId ?? 'unknown'); }
}
function toQwenTool(tool: ToolSpec): Json { return { type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }; }
function decode(value: unknown): Int16Array | null { if (typeof value !== 'string') return null; try { const b = Buffer.from(value, 'base64'); const n = b.byteLength - b.byteLength % 2; return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + n)); } catch { return null; } }
