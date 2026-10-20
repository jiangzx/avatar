import { z } from 'zod';
import { log } from '../log.ts';
import type { TextModelClient } from '../memory/textClient.ts';
import { runWithPolicy } from '../reliability/policy.ts';
import type { SilenceDecisionConfig } from '../roles/types.ts';
import type { SilenceContext, SilencePlan } from './director.ts';

/** Optional speech earns a turn only after a validated, current decision. */
export function createSilencePlanner(client: TextModelClient, config: SilenceDecisionConfig) {
  const decisionSchema = z.discriminatedUnion('speak', [
    z.object({ speak: z.literal(false), close: z.boolean().optional() }).strict(),
    z.object({ speak: z.literal(true), text: z.string().trim().min(1).max(config.maxReplyChars) }).strict(),
  ]);
  return async (context: SilenceContext, signal: AbortSignal): Promise<SilencePlan | null> => {
    if (signal.aborted) return null;
    if (!context.userText.trim()) {
      log('silence_decision_skipped', { code: 'incomplete_exchange' });
      return null;
    }
    const inputChars = context.userText.length + context.assistantText.length
      + context.previousTexts.reduce((total, text) => total + text.length, 0);
    if (inputChars > config.maxInputChars) {
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
    log('silence_decision', { stage: context.stage, outcome: decision?.speak ? 'speak' : 'silent' });
    if (!decision) return null;
    if (decision.speak) return { text: decision.text };
    return decision.close ? { text: null, close: true } : { text: null };
  };
}
