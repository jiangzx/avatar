import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActionName } from '@anyidea/protocol';
import { loadSafetyConfig } from '../../config.ts';
import type { MemoryStore } from '../../memory/store.ts';
import type { TextModelClient } from '../../memory/textClient.ts';
import type { MemoryWorker } from '../../memory/worker.ts';
import { PERFORM_ACTION_TOOL, type ToolSpec } from '../../adapters/types.ts';
import { ActionRouter } from '../actions.ts';
import type { ConversationLedger } from '../ledger.ts';
import { loadMemoryBudget } from '../pacing.ts';
import { consentTool } from './consent.ts';
import { forgetTool } from './forget.ts';
import { recallTool } from './recall.ts';

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

const copy = loadMemoryBudget(fileURLToPath(new URL('../../../config/memory.json', import.meta.url)));
const rules = loadSafetyConfig(fileURLToPath(new URL('../../../config/safety.json', import.meta.url)));
const recallPhraseInstruction = readFileSync(fileURLToPath(new URL('../../../roles/_shared/zh/recall.md', import.meta.url)), 'utf8').trim();

function performActionTool(): ToolHandler {
  return {
    spec: PERFORM_ACTION_TOOL,
    handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      const { action, result } = ctx.actions.fromTool(args);
      return Promise.resolve({ ...result, action });
    },
  };
}

/** Recall, forget, consent, and perform_action. Unknown names do not throw. */
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

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry([
    performActionTool(),
    recallTool(rules, copy.recallClipChars, {
      emptyText: copy.recallEmptyText ?? '我这边暂时找不到上次的记录，您想接着说点什么？',
      foundPrefix: copy.recallFoundPrefix ?? '我这边记着，您之前说过：',
      skipPatterns: copy.recallSkipPatterns ?? ['我什么时候', '什么时候说', '没说过', '没讲过', '记错', '记岔', '胡扯', '瞎说', '乱说', '你是不是'],
      lightAcks: copy.lightAcks ?? [],
      recentQueryPatterns: copy.recallRecentQueries ?? ['上次聊过什么', '上次说了什么', '之前聊过什么', '咱们聊过什么', '我们聊过什么', '聊到哪', '还记得上次', '上次咱们'],
      phraseInstruction: recallPhraseInstruction,
      phraseMaxChars: copy.recallPhraseMaxChars ?? 60,
      phraseTimeoutMs: copy.recallPhraseTimeoutMs ?? 1_500,
    }),
    forgetTool(copy.forgetConfirmText),
    consentTool(copy.declineConfirmPrompt, copy.declineConfirmedText),
  ]);
}
