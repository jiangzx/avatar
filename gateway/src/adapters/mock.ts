import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { AI_SAMPLE_RATE, MIC_SAMPLE_RATE } from '@anyidea/protocol';
import { rmsInt16 } from '../audio.ts';
import type { AdapterEvents, ProactiveCue, ProactiveRequest, RealtimeAdapter, SessionConfig, TokenUsage } from './types.ts';

export interface MockTurn {
  /** If set, `sendUserText` picks this turn when the text contains it. */
  match?: string;
  /** Transcript emitted when a spoken turn is detected (turns are used in order). */
  user: string;
  reply: string;
  tool?: { name: string; args: unknown };
}

export interface MockScript {
  greeting: string;
  followup: string;
  /** Optional lines for the Director's idle notice and resume cues. */
  idleNotice?: string;
  resume?: string;
  /** Optional line for a tool-turn continuation. Falls back to followup. */
  toolContinue?: string;
  /** Optional line for the memory notice. Falls back to followup. */
  memoryNotice?: string;
  fallbackReply: string;
  turns: MockTurn[];
}

export interface MockOptions {
  script: MockScript;
  /** 24 kHz PCM16 played back as reply audio; synthetic tone if absent. */
  speech?: Int16Array;
  speechThreshold?: number;
  endSilenceMs?: number;
  replyDelayMs?: number;
  /** Reply duration per character. */
  charMs?: number;
  chunkMs?: number;
  /** >1 sends audio faster than real time, like real models do. */
  paceFactor?: number;
  /** Silence before the next reply after a started response is cancelled. TUNABLE. */
  cancelGapMs?: number;
  /** Emit a synthetic, estimated responseUsage before responseDone (admin pipeline without a model key). */
  emitUsage?: boolean;
}

/** Keeps a cancelled reply from flowing straight into the next clip. TUNABLE. */
export const MOCK_CANCEL_GAP_MS = 400;

interface ActiveResponse {
  id: string;
  timer: NodeJS.Timeout | null;
  started: boolean;
}

export class MockAdapter extends EventEmitter<AdapterEvents> implements RealtimeAdapter {
  readonly supportsPlaybackTruncate = false;
  readonly verbatimFallback = false;
  readonly supportsUserText = true;
  instructions = '';
  voice: string | undefined;
  readonly notes: string[] = [];
  readonly toolResults: Array<{ callId: string; result: unknown }> = [];
  /** Every combined session change, in order (tests assert the push gate). */
  readonly sessionUpdates: Array<{ instructions?: string; voice?: { value: string | undefined } }> = [];

  private turnIndex = 0;
  private speaking = false;
  private silentMs = 0;
  private responseCounter = 0;
  private createCount = 0;
  private active: ActiveResponse | null = null;
  private speechOffset = 0;
  private cancelGapSamples = 0;
  private closed = false;

  constructor(private readonly opts: MockOptions) {
    super();
  }

  async connect(config: SessionConfig): Promise<void> {
    this.instructions = config.instructions;
    this.voice = config.voice;
  }

  sendAudio(pcm16k: Int16Array): void {
    if (this.closed) return;
    const frameMs = (pcm16k.length / MIC_SAMPLE_RATE) * 1000;
    if (rmsInt16(pcm16k) >= (this.opts.speechThreshold ?? 800)) {
      this.silentMs = 0;
      if (!this.speaking) {
        this.speaking = true;
        this.emit('userSpeechStarted');
      }
      return;
    }
    if (!this.speaking) return;
    this.silentMs += frameMs;
    if (this.silentMs >= (this.opts.endSilenceMs ?? 800)) {
      this.speaking = false;
      this.silentMs = 0;
      this.onSpokenTurnEnd();
    }
  }

  sendUserText(text: string): void {
    const turn = this.opts.script.turns.find((t) => t.match !== undefined && text.includes(t.match));
    this.scheduleReply(turn ? turn.reply : this.opts.script.fallbackReply, turn?.tool);
  }

  updateInstructions(text: string): void {
    this.instructions = text;
  }

  updateVoice(voice: string | undefined): void {
    this.voice = voice;
  }

  updateSession(update: { instructions?: string; voice?: { value: string | undefined } }): void {
    this.sessionUpdates.push({ ...update });
    if (update.instructions !== undefined) this.instructions = update.instructions;
    if (update.voice) this.voice = update.voice.value;
  }

  createResponse(request?: ProactiveRequest): void {
    const s = this.opts.script;
    const byCue: Record<ProactiveCue, string> = {
      greeting: s.greeting,
      followup: s.followup,
      idleNotice: s.idleNotice ?? s.followup,
      resume: s.resume ?? s.followup,
      toolContinue: s.toolContinue ?? s.followup,
      memoryNotice: s.memoryNotice ?? s.followup,
      // The bridge line is not scripted: the session passes the configured line.
      contextBridge: request?.fallbackText ?? s.followup,
      // Not scripted either: the session passes the configured reminder line.
      restReminder: request?.fallbackText ?? s.followup,
    };
    const text = request ? byCue[request.cue] : this.createCount === 0 ? s.greeting : s.followup;
    this.createCount++;
    this.scheduleReply(text);
  }

  cancelResponse(): void {
    this.cancelActive();
  }

  sendToolResult(callId: string, result: unknown): void {
    this.toolResults.push({ callId, result });
  }

  injectContextNote(text: string): void {
    this.notes.push(text);
  }

  close(): void {
    this.cancelActive();
    this.closed = true;
  }

  /** Test helper: behave like an upstream connection that dropped. */
  simulateDrop(): void {
    this.cancelActive();
    this.closed = true;
    this.emit('error', 'mock_drop', true);
    this.emit('closed');
  }

  private onSpokenTurnEnd(): void {
    const turns = this.opts.script.turns;
    const turn = turns.length > 0 ? turns[this.turnIndex++ % turns.length] : undefined;
    if (!turn) {
      this.scheduleReply(this.opts.script.fallbackReply);
      return;
    }
    this.emit('userTranscript', turn.user.slice(0, Math.ceil(turn.user.length / 2)), false);
    this.emit('userTranscript', turn.user, true);
    this.scheduleReply(turn.reply, turn.tool);
  }

  private scheduleReply(text: string, tool?: MockTurn['tool']): void {
    if (this.closed) return;
    this.cancelActive();
    const handle: ActiveResponse = { id: `mock-${++this.responseCounter}`, timer: null, started: false };
    this.active = handle;
    handle.timer = setTimeout(() => this.streamReply(handle, text, tool), this.opts.replyDelayMs ?? 300);
  }

  private streamReply(handle: ActiveResponse, text: string, tool?: MockTurn['tool']): void {
    if (this.active !== handle) return;
    handle.started = true;
    this.emit('responseStarted', handle.id);
    if (tool) this.emit('toolCall', handle.id, `call-${handle.id}`, tool.name, tool.args);
    const chunkMs = this.opts.chunkMs ?? 100;
    const totalMs = Math.max(chunkMs, text.length * (this.opts.charMs ?? 220));
    const chunks = Math.ceil(totalMs / chunkMs);
    const pace = this.opts.paceFactor ?? 2;
    let i = 0;
    let sentChars = 0;
    const tick = () => {
      if (this.active !== handle) return;
      if (i >= chunks) {
        this.active = null;
        if (this.opts.emitUsage) this.emit('responseUsage', handle.id, this.syntheticUsage(text, totalMs));
        this.emit('responseDone', handle.id);
        return;
      }
      this.emit('audioDelta', handle.id, this.nextSpeech(chunkMs));
      const targetChars = Math.min(text.length, Math.round(((i + 1) / chunks) * text.length));
      if (targetChars > sentChars) {
        this.emit('textDelta', handle.id, text.slice(sentChars, targetChars));
        sentChars = targetChars;
      }
      i++;
      handle.timer = setTimeout(tick, chunkMs / pace);
    };
    tick();
  }

  /** Deterministic fake counts: ~2 instruction chars per token, 1 token per reply char, 12.5 audio tokens per second. */
  private syntheticUsage(text: string, totalMs: number): TokenUsage {
    const inputTextTokens = Math.ceil(this.instructions.length / 2);
    const outputTextTokens = text.length;
    const outputAudioTokens = Math.round((totalMs / 1000) * 12.5);
    return {
      inputTokens: inputTextTokens,
      outputTokens: outputTextTokens + outputAudioTokens,
      inputTextTokens,
      outputTextTokens,
      outputAudioTokens,
      estimated: true,
    };
  }

  private cancelActive(): void {
    const a = this.active;
    if (!a) return;
    if (a.timer) clearTimeout(a.timer);
    this.active = null;
    if (!a.started) return;
    const gapMs = this.opts.cancelGapMs ?? MOCK_CANCEL_GAP_MS;
    this.cancelGapSamples = Math.max(0, Math.round((gapMs / 1000) * AI_SAMPLE_RATE));
    this.speechOffset += this.cancelGapSamples + 1;
    this.emit('responseCancelled', a.id);
  }

  private nextSpeech(ms: number): Int16Array {
    const n = Math.round((ms / 1000) * AI_SAMPLE_RATE);
    const out = new Int16Array(n);
    const src = this.opts.speech;
    for (let k = 0; k < n; k++) {
      if (this.cancelGapSamples > 0) {
        out[k] = 0;
        this.cancelGapSamples--;
        continue;
      }
      if (src && src.length > 0) {
        out[k] = src[this.speechOffset % src.length]!;
      } else {
        const t = this.speechOffset / AI_SAMPLE_RATE;
        const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
        out[k] = Math.round(6000 * envelope * Math.sin(2 * Math.PI * 180 * t));
      }
      this.speechOffset++;
    }
    return out;
  }
}

/** The Mock script is zh only: fill {{char}} with the session character's zh name. Returns a copy. */
export function withCharacterName(script: MockScript, name: string): MockScript {
  const fill = (text: string): string => text.replaceAll('{{char}}', name);
  const filled: MockScript = {
    ...script,
    greeting: fill(script.greeting),
    followup: fill(script.followup),
    fallbackReply: fill(script.fallbackReply),
    turns: script.turns.map((turn) => ({ ...turn, reply: fill(turn.reply) })),
  };
  if (script.idleNotice !== undefined) filled.idleNotice = fill(script.idleNotice);
  if (script.resume !== undefined) filled.resume = fill(script.resume);
  if (script.toolContinue !== undefined) filled.toolContinue = fill(script.toolContinue);
  if (script.memoryNotice !== undefined) filled.memoryNotice = fill(script.memoryNotice);
  return filled;
}

export function loadMockScript(path: string): MockScript {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('MOCK_SCRIPT_INVALID');
  }
  if (!isMockScript(value)) throw new Error('MOCK_SCRIPT_INVALID');
  return value;
}

function isMockScript(value: unknown): value is MockScript {
  if (!value || typeof value !== 'object') return false;
  const script = value as Partial<MockScript>;
  if (![script.greeting, script.followup, script.fallbackReply].every((v) => typeof v === 'string' && v.length > 0)) return false;
  if (!Array.isArray(script.turns)) return false;
  return script.turns.every((turn) => {
    if (!turn || typeof turn !== 'object') return false;
    const t = turn as Partial<MockTurn>;
    if (typeof t.user !== 'string' || t.user.length === 0 || typeof t.reply !== 'string' || t.reply.length === 0) return false;
    if (t.match !== undefined && typeof t.match !== 'string') return false;
    if (t.tool === undefined) return true;
    return !!t.tool && typeof t.tool === 'object' && typeof t.tool.name === 'string' && t.tool.name.length > 0 && 'args' in t.tool;
  });
}

export function loadMockSpeech(path: string): Int16Array | undefined {
  if (!existsSync(path)) return undefined;
  const buf = readFileSync(path);
  const even = buf.byteLength - (buf.byteLength % 2);
  return new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + even));
}
