import type { TokenUsage } from '../adapters/types.ts';

/** Which kind of model call a usage row belongs to. */
export type UsageKind = 'realtime_reply' | 'memory_extract' | 'summarize' | 'care' | 'affect' | 'silence_plan' | 'recall_wrap';

/** Who a call is billed to. Null fields mean "system" (no owner or session). */
export interface UsageAttribution { ownerId: string | null; agentId: string | null; sessionId: string | null; characterId: string | null }

export const SYSTEM_ATTRIBUTION: UsageAttribution = Object.freeze({ ownerId: null, agentId: null, sessionId: null, characterId: null });

export interface UsageRecord {
  kind: UsageKind;
  adapter: 'qwen' | 'mock' | 'text';
  model: string;
  usage: TokenUsage | null;
  attribution: UsageAttribution;
  firstAudioMs?: number | null;
  genMs?: number | null;
  errorCode?: string | null;
  ts?: number;
}

/** Content-free usage sink. record() must never throw. */
export interface UsageRecorder { record(record: UsageRecord): void; flush(): void }

export interface UsageTag { kind: UsageKind; attribution: UsageAttribution }
