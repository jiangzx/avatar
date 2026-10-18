import { fileURLToPath } from 'node:url';
import type { ActionName } from '@anyidea/protocol';
import { loadSafetyConfig } from '../../config.ts';
import type { MemoryStore } from '../../memory/store.ts';
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
  ledger: ConversationLedger;
  actions: ActionRouter;
  now: number;
}

export interface ToolOutcome {
  ok: boolean;
  error?: string;
  text?: string;
  action?: ActionName | null;
  rebuild?: 'forget' | 'decline';
  confirmText?: string;
}

export interface ToolHandler {
  spec: ToolSpec;
  handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

const copy = loadMemoryBudget(fileURLToPath(new URL('../../../config/memory.json', import.meta.url)));
const rules = loadSafetyConfig(fileURLToPath(new URL('../../../config/safety.json', import.meta.url)));

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
    recallTool(rules, copy.recallClipChars),
    forgetTool(copy.forgetConfirmText),
    consentTool(copy.declineConfirmPrompt, copy.declineConfirmedText),
  ]);
}
