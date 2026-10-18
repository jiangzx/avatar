import { z } from 'zod';
import { enqueueThenBump } from './forget.ts';
import type { ToolContext, ToolHandler, ToolOutcome } from './registry.ts';

const ConsentSchema = z.object({
  granted: z.enum(['granted', 'declined']),
  confirmed: z.boolean(),
}).strict();

export function consentTool(prompt: string, confirmedText: string): ToolHandler {
  return {
    spec: {
      name: 'set_memory_consent',
      description: '设置是否记住以后的聊天。拒绝时必须先复述确认，用户再次确认后才带 confirmed=true 调用。',
      parameters: {
        type: 'object',
        properties: {
          granted: { type: 'string', enum: ['granted', 'declined'] },
          confirmed: { type: 'boolean' },
        },
        required: ['granted', 'confirmed'],
      },
    },
    async handle(args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
      const parsed = ConsentSchema.safeParse(args);
      if (!parsed.success) return { ok: false, error: 'invalid_args' };
      if (!ctx.store || !ctx.ownerId) return { ok: false, error: 'memory_unavailable' };
      const store = ctx.store;
      const ownerId = ctx.ownerId;
      if (parsed.data.granted === 'granted') {
        store.setConsent(ownerId, 'granted', ctx.now);
        return { ok: true };
      }
      if (!parsed.data.confirmed) return { ok: true, confirmText: prompt };
      const stored = await enqueueThenBump(ctx.worker, store, ownerId, async () => {
        store.wipeOwnerMemory(ownerId);
        ctx.ledger.clear();
      });
      if (!stored) return { ok: false, error: 'forget_failed' };
      return { ok: true, rebuild: 'decline', confirmText: confirmedText };
    },
  };
}
