import { z } from 'zod';
import type { MemoryStore } from '../../memory/store.ts';
import { ftsMatch } from './recall.ts';
import type { ToolContext, ToolHandler, ToolOutcome } from './registry.ts';

/** Two characters minimum: a single-character substring can match unrelated facts and notes. */
const ForgetSchema = z.object({ query: z.string().trim().min(2).max(2_000) }).strict();

export function forgetTool(confirmText: string): ToolHandler {
  return {
    spec: {
      name: 'forget_memory',
      description: '忘掉与查询相关的记忆。调用后用一句话确认，不要复述被忘掉的内容。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '要忘掉的事' } },
        required: ['query'],
      },
    },
    async handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      const parsed = ForgetSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: 'invalid_args' };
      if (!ctx.store || !ctx.ownerId) return { ok: false, error: 'memory_unavailable' };
      const store = ctx.store;
      const ownerId = ctx.ownerId;
      const query = parsed.data.query;
      const sessionId = ctx.sessionId;
      // Forgetting stays precise even though recall accepts any keyword.
      const deleted = runAfterEpochBump(store, ownerId, () => {
        const result = store.forgetMatches(ownerId, query, ftsMatch(query, 'all'), sessionId, ctx.triggerText);
        ctx.ledger.clear();
        return result;
      });
      const total = deleted.messages + deleted.facts + deleted.notes + deleted.episodes + deleted.followups;
      // Do not confirm a delete that matched nothing; the model must not claim success.
      if (total === 0) return { ok: false, error: 'not_found' };
      return { ok: true, rebuild: 'forget', confirmText };
    },
  };
}

/**
 * Forget/decline must not wait behind extraction (spec §6): bumping the epoch makes
 * an in-flight extraction return stale, so the synchronous memory change can run now.
 */
export function runAfterEpochBump<T>(store: MemoryStore, ownerId: string, job: () => T): T {
  store.bumpEpoch(ownerId);
  return job();
}
