import type { ActionName, Language } from '@anyidea/protocol';
import type { SafetyRules } from '../../config.ts';
import type { EvidenceRules, MemoryCopy } from '../../i18n/types.ts';
import type { MemoryStore } from '../../memory/store.ts';
import type { TextModelClient } from '../../memory/textClient.ts';
import type { MemoryWorker } from '../../memory/worker.ts';
import { performActionSpec, type ToolSpec } from '../../adapters/types.ts';
import { ActionRouter } from '../actions.ts';
import type { ConversationLedger } from '../ledger.ts';
import { consentTool } from './consent.ts';
import { forgetTool } from './forget.ts';
import { recallTool } from './recall.ts';
import { loadWeatherConfig, weatherTool, type WeatherFetch } from './weather.ts';

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
  /** Test double. Production uses global fetch. */
  weatherFetch?: WeatherFetch;
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

/** Recall, forget, consent, perform_action, and weather. Unknown names do not throw. */
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

/** The caller passes the rendered recall prompt; raw role files carry {{char}} placeholders. */
export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  return new ToolRegistry([
    performActionTool(options),
    recallTool(options.safety, options.clipChars, {
      emptyText: options.memory.recall.emptyText,
      foundPrefix: options.memory.recall.foundPrefix,
      wrapText: options.memory.recall.wrapText,
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
    }),
    forgetTool(options.memory.forgetConfirmText, {
      toolDescription: options.memory.recall.forgetToolDescription,
      queryDescription: options.memory.recall.forgetQueryDescription,
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
