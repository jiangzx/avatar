import type { ResponseKind } from '@anyidea/protocol';
import type { TokenUsage } from '../adapters/types.ts';

/** Content-free numbers for one assistant reply. */
export interface ReplyMetrics {
  seq: number;
  kind: ResponseKind;
  outcome: 'ended' | 'interrupted';
  speechToFirstAudioMs: number | null;
  vadToFirstAudioMs: number | null;
  genMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number;
  replyChars: number;
  errorCode: string | null;
  /** Full provider usage for billing (P1-T9); logs keep only the two totals. */
  usage: TokenUsage | null;
}

interface Open {
  kind: ResponseKind;
  startedAt: number;
  speechStoppedAt: number | null;
  vadSilentAt: number | null;
  firstAudioAt: number | null;
  doneAt: number | null;
  usage: TokenUsage | null;
  toolCalls: number;
  chars: number;
  errorCode: string | null;
}

export function metricFields(m: ReplyMetrics): Record<string, string | number | null> {
  return {
    seq: m.seq,
    kind: m.kind,
    outcome: m.outcome,
    speech_to_first_audio_ms: m.speechToFirstAudioMs,
    vad_to_first_audio_ms: m.vadToFirstAudioMs,
    gen_ms: m.genMs,
    input_tokens: m.inputTokens,
    output_tokens: m.outputTokens,
    tool_calls: m.toolCalls,
    reply_chars: m.replyChars,
    error_code: m.errorCode,
  };
}

/** Collects per-reply timings and usage. One instance per Session. */
export class ReplyMetricsTracker {
  private speechStoppedAt: number | null = null;
  private vadSilentAt: number | null = null;
  private readonly open = new Map<number, Open>();

  constructor(private readonly now: () => number = Date.now) {}

  onSpeechStopped(): void { this.speechStoppedAt = this.now(); }
  onLocalVadSilent(): void { this.vadSilentAt = this.now(); }

  onError(code: string): void {
    for (const o of this.open.values()) o.errorCode = code;
  }

  onResponseStarted(seq: number, kind: ResponseKind): void {
    const userTurn = kind === 'reply';
    this.open.set(seq, {
      kind, startedAt: this.now(),
      speechStoppedAt: userTurn ? this.speechStoppedAt : null,
      vadSilentAt: userTurn ? this.vadSilentAt : null,
      firstAudioAt: null, doneAt: null, usage: null, toolCalls: 0, chars: 0, errorCode: null,
    });
    this.speechStoppedAt = null;
    this.vadSilentAt = null;
  }

  onFirstAudio(seq: number): void {
    const o = this.open.get(seq);
    if (o && o.firstAudioAt === null) o.firstAudioAt = this.now();
  }

  onText(seq: number, chars: number): void { const o = this.open.get(seq); if (o) o.chars += chars; }
  onToolCall(seq: number): void { const o = this.open.get(seq); if (o) o.toolCalls++; }
  onUsage(seq: number, usage: TokenUsage): void { const o = this.open.get(seq); if (o) o.usage = usage; }

  onDone(seq: number): void {
    const o = this.open.get(seq);
    if (o && o.doneAt === null) o.doneAt = this.now();
  }

  finish(seq: number, outcome: 'ended' | 'interrupted'): ReplyMetrics | null {
    const o = this.open.get(seq);
    if (!o) return null;
    this.open.delete(seq);
    const since = (from: number | null) => (from !== null && o.firstAudioAt !== null ? o.firstAudioAt - from : null);
    return {
      seq, kind: o.kind, outcome,
      speechToFirstAudioMs: since(o.speechStoppedAt),
      vadToFirstAudioMs: since(o.vadSilentAt),
      genMs: o.doneAt !== null ? o.doneAt - o.startedAt : null,
      inputTokens: o.usage?.inputTokens ?? null,
      outputTokens: o.usage?.outputTokens ?? null,
      toolCalls: o.toolCalls,
      replyChars: o.chars,
      errorCode: o.errorCode,
      usage: o.usage,
    };
  }
}
