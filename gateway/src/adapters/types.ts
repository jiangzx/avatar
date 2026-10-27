import type { EventEmitter } from 'node:events';
import { ACTION_NAMES } from '@anyidea/protocol';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SessionConfig {
  instructions: string;
  tools: ToolSpec[];
  /** Per-session voice; undefined = the adapter's configured default. */
  voice?: string;
  /** Per-response output token cap; undefined = no cap (see docs/research/qwen-plan-a-validation.md §3). */
  maxOutputTokens?: number;
}

/** What the Director wants said. Qwen speaks from `instruction`; adapters that cannot prompt the model speak `fallbackText`. */
export type ProactiveCue = 'greeting' | 'followup' | 'idleNotice' | 'resume' | 'toolContinue' | 'memoryNotice' | 'contextBridge' | 'restReminder';

/** Cues the Director builds itself. `contextBridge` is spoken by the session; `restReminder` comes from the session's copy. */
export type DirectorCue = Exclude<ProactiveCue, 'contextBridge' | 'restReminder'>;

export interface ProactiveRequest {
  cue: ProactiveCue;
  instruction: string;
  fallbackText: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AdapterEvents = {
  userSpeechStarted: [];
  /** Server-side VAD detected the end of user speech (Qwen `input_audio_buffer.speech_stopped`). */
  userSpeechStopped: [];
  userTranscript: [text: string, final: boolean];
  responseStarted: [id: string];
  audioDelta: [id: string, pcm24k: Int16Array];
  textDelta: [id: string, text: string];
  toolCall: [id: string, callId: string, name: string, args: unknown];
  responseDone: [id: string];
  responseCancelled: [id: string];
  /** Token usage reported when a response completes (Qwen `response.done.response.usage`). */
  responseUsage: [id: string, usage: TokenUsage];
  error: [code: string, retryable: boolean];
  closed: [];
};

/** Model-agnostic realtime speech session. One instance = one upstream model connection. */
export interface RealtimeAdapter extends EventEmitter<AdapterEvents> {
  /** True if the model can trim its own context to the played portion after an interruption. */
  readonly supportsPlaybackTruncate: boolean;
  /** True when createResponse plays fallbackText verbatim (direct TTS, no transcript events). */
  readonly verbatimFallback: boolean;
  /** True when sendUserText starts a real model turn (debug input). */
  readonly supportsUserText: boolean;
  connect(config: SessionConfig): Promise<void>;
  sendAudio(pcm16k: Int16Array): void;
  /** Debug path: treat text as a finished user turn and reply to it. */
  sendUserText(text: string): void;
  updateInstructions(text: string): void;
  /** Move the session to another voice without reconnecting; undefined = the adapter default. */
  updateVoice(voice: string | undefined): void;
  /** One combined session change. Seeduplex sends a single full session.update; Qwen a single partial one. */
  updateSession?(update: { instructions?: string; voice?: { value: string | undefined } }): void;
  createResponse(request?: ProactiveRequest): void;
  cancelResponse(): void;
  sendToolResult(callId: string, result: unknown): void;
  injectContextNote(text: string): void;
  /** Intentional close; must not emit `closed`. */
  close(): void;
}

export type AdapterFactory = () => RealtimeAdapter;

/** perform_action spec in the active language. */
export function performActionSpec(copy: { toolDescription: string; actionDescription: string }): ToolSpec {
  return {
    name: 'perform_action',
    description: copy.toolDescription,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTION_NAMES],
          description: copy.actionDescription,
        },
      },
      required: ['action'],
    },
  };
}
