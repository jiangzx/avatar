import { z } from 'zod';
import type { MemoryStore } from '../../memory/store.ts';
import type { MemoryWorker } from '../../memory/worker.ts';
import { ftsMatch } from './recall.ts';
import type { ToolContext, ToolHandler, ToolOutcome } from './registry.ts';

const ForgetSchema = z.object({ query: z.string().min(1).max(2_000) }).strict();

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
      await enqueueThenBump(ctx.worker, store, ownerId, async () => {
        store.forgetMatches(ownerId, query, ftsMatch(query), sessionId);
        ctx.ledger.clear();
      });
      return { ok: true, rebuild: 'forget', confirmText };
    },
  };
}

/** Enqueue the wipe, then bump the epoch so an in-flight extract returns stale. */
export async function enqueueThenBump(
  worker: MemoryWorker | undefined,
  store: MemoryStore,
  ownerId: string,
  job: () => Promise<void>,
): Promise<void> {
  if (!worker) {
    store.bumpEpoch(ownerId);
    await job();
    return;
  }
  const id = worker.enqueue(ownerId, job);
  store.bumpEpoch(ownerId);
  await worker.waitForJob(id);
}
