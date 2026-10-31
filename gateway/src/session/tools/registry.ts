import { fileURLToPath } from 'node:url';
import { LANGUAGES, type ActionName, type CharacterId, type Language } from '@anyidea/protocol';
import type { SafetyRules } from '../../config.ts';
import { DEFAULT_I18N } from '../../i18n/load.ts';
import type { EvidenceRules, MemoryCopy } from '../../i18n/types.ts';
import type { Logger } from '../../log/logger.ts';
import type { MemoryStore } from '../../memory/store.ts';
import type { TextModelClient } from '../../memory/textClient.ts';
import type { MemoryWorker } from '../../memory/worker.ts';
import { unique } from '../../unique.ts';
import { performActionSpec, type ToolSpec } from '../../adapters/types.ts';
import { ActionRouter } from '../actions.ts';
import type { ConversationLedger } from '../ledger.ts';
import { loadMemoryBudget } from '../pacing.ts';
import type { TurnAccess } from '../turnAccess.ts';
import { consentTool } from './consent.ts';
import { forgetTool } from './forget.ts';
import { listTool } from './list.ts';
import { pinTool } from './pin.ts';
import { recallTool } from './recall.ts';
import { loadWeatherConfig, weatherTool, type WeatherFetch } from './weather.ts';

export type { TurnAccess } from '../turnAccess.ts';

export interface ToolContext {
  ownerId?: string;
  agentId?: string;
  sessionId: string;
  store?: MemoryStore;
  worker?: MemoryWorker;
  /** Optional phrasing model for grounded recall; absent means the direct quote fallback. */
  textClient?: TextModelClient;
  ledger: ConversationLedger;
  actions: ActionRouter;
  now: number;
  /** User line of this turn, when it has already arrived. Not an older row. */
  triggerText?: string;
  /** Server-side character of this session; never from tool arguments. */
  characterId: CharacterId;
  /** This turn's user finals (pin_memory reads the user's own words, never the model's). */
  turn: TurnAccess;
  /** Transcript write gate: declined consent, or the one-time notice has not played yet. */
  memoryGate(): 'ok' | 'declined' | 'notice_pending';
  /** Session child logger (sid/oid/char). Omitted in tests: the stdout default. */
  logger?: Logger;
}

export interface ToolOutcome {
  ok: boolean;
  error?: string;
  text?: string;
  action?: ActionName | null;
  rebuild?: 'forget' | 'decline';
  confirmText?: string;
  /** Grounded line the gateway can speak directly when the adapter cannot continue a tool turn. */
  spokenText?: string;
  /** True when spokenText is backed by a memory hit, not an empty-result line. */
  spokenFound?: boolean;
  /** Session re-renders the snapshot and pinned block, then pushes at the next seam. */
  refreshSnapshot?: boolean;
}

export interface ToolHandler {
  spec: ToolSpec;
  handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Everything one language contributes to the tool registry. */
export interface ToolRegistryOptions {
  language: Language;
  memory: MemoryCopy;
  /** Union skip / question / ack rules, shared across languages. */
  evidence: EvidenceRules;
  /** Union substring vague-recall phrases; exact patterns come from the active language. */
  recentQueries: readonly string[];
  /** Recall phrasing system prompt for this language. */
  recallPrompt: string;
  safety: SafetyRules;
  clipChars: number;
  phraseTimeoutMs: number;
  /** Wait this long for the turn's user final when the transcript is late; omitted = shipped default. */
  recallFinalWaitMs?: number;
  /** Vague-recall candidate window; omitted = gateway/config/memory.json. */
  recentWindow?: number;
  /** Shortest recent-memory line; omitted = gateway/config/memory.json. */
  recentMinChars?: number;
  /** Longest short action request ignored by vague recall; omitted = gateway/config/memory.json. */
  actionCommandMaxChars?: number;
  /** Prefer a session with a statement this long; omitted = gateway/config/memory.json. */
  strongChars?: number;
  /** Test double. Production uses global fetch. */
  weatherFetch?: WeatherFetch;
  /** pin_memory limits for this language; omitted = gateway/config/memory.json. */
  pinLimits?: { maxPerCharacter: number; maxChars: number };
  /** Union of every language's health words; omitted = the shipped i18n packs. */
  healthWords?: readonly string[];
  /** Wait for this turn's user final; omitted = pinFinalWaitMs from gateway/config/memory.json. */
  turnFinalTimeoutMs?: number;
  /** list_memory cap; omitted = gateway/config/memory.json listMaxItems. */
  listMaxItems?: number;
}

function performActionTool(options: ToolRegistryOptions): ToolHandler {
  return {
    spec: performActionSpec(options.memory.performAction),
    handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      const { action, result } = ctx.actions.fromTool(args);
      return Promise.resolve({ ...result, action });
    },
  };
}

/** Recall, forget, pin, list, consent, perform_action, and weather. Unknown names do not throw. */
export class ToolRegistry {
  constructor(private readonly tools: readonly ToolHandler[]) {}

  specs(): ToolSpec[] {
    return this.tools.map((tool) => tool.spec);
  }

  async handle(name: string, args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.find((item) => item.spec.name === name);
    if (!tool) return { ok: false, error: 'unknown_tool' };
    try {
      return await tool.handle(args, ctx);
    } catch {
      return { ok: false, error: 'tool_failed' };
    }
  }
}

/** Read-only defaults from the shipped config; production passes the loaded values explicitly. */
const MEMORY_DEFAULTS = loadMemoryBudget(fileURLToPath(new URL('../../../config/memory.json', import.meta.url)));
const DEFAULT_HEALTH_WORDS = unique(LANGUAGES.flatMap((language) => DEFAULT_I18N.memory[language].healthWords));

/** The caller passes the rendered recall prompt; raw role files carry {{char}} placeholders. */
export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  return new ToolRegistry([
    performActionTool(options),
    recallTool(options.safety, options.clipChars, {
      emptyText: options.memory.recall.emptyText,
      foundPrefix: options.memory.recall.foundPrefix,
      wrapText: options.memory.recall.wrapText,
      recentConfirmText: options.memory.recall.recentConfirmText,
      recentConfirmInstruction: options.memory.recall.recentConfirmInstruction,
      toolDescription: options.memory.recall.toolDescription,
      queryDescription: options.memory.recall.queryDescription,
      skipPatterns: options.evidence.skipPatterns,
      lightAcks: options.evidence.lightAcks,
      questionPatterns: options.evidence.questionPatterns,
      recentQueryPatterns: options.recentQueries,
      recentQueryExactPatterns: options.memory.recall.recentQueryExactPatterns,
      recentQueryLeadingFillers: options.memory.recall.recentQueryLeadingFillers,
      recentQueryTrailingFillers: options.memory.recall.recentQueryTrailingFillers,
      queryFramePatterns: options.memory.recall.queryFramePatterns,
      phraseInstruction: options.recallPrompt,
      phraseMaxChars: options.memory.recall.phraseMaxChars,
      phraseTimeoutMs: options.phraseTimeoutMs,
      ...(options.recentWindow !== undefined ? { recentWindow: options.recentWindow } : {}),
      ...(options.recentMinChars !== undefined ? { recentMinChars: options.recentMinChars } : {}),
      ...(options.actionCommandMaxChars !== undefined ? { actionCommandMaxChars: options.actionCommandMaxChars } : {}),
      ...(options.strongChars !== undefined ? { strongChars: options.strongChars } : {}),
    }, options.recallFinalWaitMs ?? MEMORY_DEFAULTS.recallFinalWaitMs ?? 1_000),
    forgetTool(options.memory.forgetConfirmText, {
      toolDescription: options.memory.recall.forgetToolDescription,
      queryDescription: options.memory.recall.forgetQueryDescription,
    }),
    pinTool({
      copy: options.memory.pin,
      evidence: options.evidence,
      safety: options.safety,
      healthWords: options.healthWords ?? DEFAULT_HEALTH_WORDS,
      maxPerCharacter: options.pinLimits?.maxPerCharacter ?? MEMORY_DEFAULTS.pinMaxPerCharacter,
      maxChars: options.pinLimits?.maxChars ?? MEMORY_DEFAULTS.pinMaxChars[options.language],
      turnFinalTimeoutMs: options.turnFinalTimeoutMs ?? MEMORY_DEFAULTS.pinFinalWaitMs,
    }),
    listTool({
      copy: options.memory.list,
      maxItems: options.listMaxItems ?? MEMORY_DEFAULTS.listMaxItems,
    }),
    consentTool({
      prompt: options.memory.declineConfirmPrompt,
      confirmedText: options.memory.declineConfirmedText,
      toolDescription: options.memory.recall.consentToolDescription,
    }),
    weatherTool(
      options.memory.weather,
      loadWeatherConfig(),
      options.language,
      options.weatherFetch ?? ((url, signal) => fetch(url, { signal })),
    ),
  ]);
}
