import { z } from 'zod';
import { log } from '../log.ts';
import type { TextModelClient } from '../memory/textClient.ts';
import { runWithPolicy } from '../reliability/policy.ts';
import type { SilenceDecisionConfig } from '../roles/types.ts';
import type { SilenceContext } from './director.ts';

/** Optional speech earns a turn only after a validated, current decision. */
export function createSilencePlanner(client: TextModelClient, config: SilenceDecisionConfig) {
  const decisionSchema = z.discriminatedUnion('speak', [
    z.object({ speak: z.literal(false) }).strict(),
    z.object({ speak: z.literal(true), text: z.string().trim().min(1).max(config.maxReplyChars) }).strict(),
  ]);
  return async (context: SilenceContext, signal: AbortSignal): Promise<string | null> => {
    if (signal.aborted) return null;
    if (!context.userText.trim() || !context.assistantText.trim()) {
      log('silence_decision_skipped', { code: 'incomplete_exchange' });
      return null;
    }
    if (context.userText.length + context.assistantText.length > config.maxInputChars) {
      log('silence_decision_skipped', { code: 'input_budget' });
      return null;
    }
    const result = await runWithPolicy('silence_decision', config.policy, async timeoutSignal => {
      const raw = await client.complete({
        system: config.instruction,
        user: JSON.stringify(context),
        maxTokens: config.maxTokens,
        signal: AbortSignal.any([signal, timeoutSignal]),
      });
      if (signal.aborted) throw new Error('silence_cancelled');
      try {
        return decisionSchema.parse(JSON.parse(raw));
      } catch {
        throw new Error('silence_invalid_response');
      }
    }, { classify: () => signal.aborted ? 'ignorable' : 'fatal' });
    if (signal.aborted) return null;
    const decision = result.ok ? result.value : null;
    log('silence_decision', { outcome: decision?.speak ? 'speak' : 'silent' });
    return decision?.speak ? decision.text : null;
  };
}
