import { z } from 'zod';
import type { MemoryStore } from '../../memory/store.ts';
import { ftsMatch } from './recall.ts';
import type { ToolContext, ToolHandler, ToolOutcome } from './registry.ts';

/** Two characters minimum: a single-character substring can match unrelated facts and notes. */
const ForgetSchema = z.object({ query: z.string().trim().min(2).max(2_000) }).strict();

export function forgetTool(confirmText: string, copy: { toolDescription: string; queryDescription: string }): ToolHandler {
  return {
    spec: {
      name: 'forget_memory',
      description: copy.toolDescription,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: copy.queryDescription } },
        required: ['query'],
      },
    },
    async handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      const parsed = ForgetSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: 'invalid_args' };
      const { store, ownerId, agentId } = ctx;
      if (!store || !ownerId || !agentId) return { ok: false, error: 'memory_unavailable' };
      const query = parsed.data.query;
      // Bump first so an in-flight extraction goes stale (spec §5). A shared hit affects every
      // character's view, so it bumps the owner epoch; a private hit only this agent's.
      const shared = store.listProfileFacts(ownerId).some((row) => row.text.includes(query));
      if (shared) store.bumpOwnerEpoch(ownerId);
      else store.bumpAgentEpoch(ownerId, agentId);
      // Scope: this agent's private rows and pins, plus the shared layer; lines of this agent only.
      const deleted = store.forgetMatches(ownerId, agentId, query, ftsMatch(query, 'all'), ctx.sessionId, ctx.triggerText);
      ctx.ledger.forget(query, ctx.triggerText);
      const total = Object.values(deleted).reduce((sum: number, count) => sum + Number(count), 0);
      // Do not confirm a delete that matched nothing; the model must not claim success.
      if (total === 0) return { ok: false, error: 'not_found' };
      return { ok: true, rebuild: 'forget', confirmText };
    },
  };
}

/**
 * Forget/decline must not wait behind extraction (spec §6): bumping the owner epoch makes every
 * in-flight extraction of this owner return stale, so the synchronous memory change can run now.
 */
export function runAfterEpochBump<T>(store: MemoryStore, ownerId: string, job: () => T): T {
  store.bumpOwnerEpoch(ownerId);
  return job();
}
