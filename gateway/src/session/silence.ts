import { z } from 'zod';
import { log } from '../log.ts';
import type { TextModelClient } from '../memory/textClient.ts';
import { runWithPolicy } from '../reliability/policy.ts';
import type { SilenceDecisionConfig } from '../roles/types.ts';
import type { SilenceContext, SilencePlan } from './director.ts';

/** Every planned line must keep the content its stage promises; otherwise configured copy is used. */
const GREETING = /您好|你好|又见到|又见面|早上好|上午好|下午好|晚上好|嗨|哈喽|来啦/;
const QUESTION = /[？?]/;
const LISTENING = /还在听|在听|听着|听到|还在吗|在吗/;
const ANYTIME = /随时|都可以|接着聊|想聊/;

function stageContentOk(stage: SilenceContext['stage'], text: string): boolean {
  if (stage === 'greeting') return GREETING.test(text) && QUESTION.test(text);
  // A check-in that stops asking whether the user is there is a new topic, not a check-in.
  if (stage === 'checkin') return text.length <= 30 && LISTENING.test(text) && ANYTIME.test(text);
  if (stage === 'rest') return !QUESTION.test(text);
  return true;
}

/** Optional speech earns a turn only after a validated, current decision. */
export function createSilencePlanner(client: TextModelClient, config: SilenceDecisionConfig) {
  const decisionSchema = z.discriminatedUnion('speak', [
    z.object({ speak: z.literal(false), close: z.boolean().optional() }).strict(),
    z.object({ speak: z.literal(true), text: z.string().trim().min(1).max(config.maxReplyChars) }).strict(),
  ]);
  return async (context: SilenceContext, signal: AbortSignal): Promise<SilencePlan | null> => {
    if (signal.aborted) return null;
    const usedChars = context.userText.length + context.assistantText.length
      + context.previousTexts.reduce((total, text) => total + text.length, 0);
    // The memory snapshot is the largest field and is expendable: keep its leading part within budget.
    const memorySnapshot = context.memorySnapshot.slice(0, Math.max(0, config.maxInputChars - usedChars));
    const input = { ...context, memorySnapshot };
    const inputChars = usedChars + memorySnapshot.length;
    if (inputChars > config.maxInputChars) {
      log('silence_decision_skipped', { code: 'input_budget' });
      return null;
    }
    const result = await runWithPolicy('silence_decision', config.policy, async timeoutSignal => {
      const raw = await client.complete({
        system: config.instruction,
        user: JSON.stringify(input),
        maxTokens: config.maxTokens,
        temperature: config.temperature,
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
    if (decision?.speak && !stageContentOk(context.stage, decision.text)) {
      log('silence_decision_rejected', { stage: context.stage, code: 'stage_content' });
      return null;
    }
    log('silence_decision', { stage: context.stage, outcome: decision?.speak ? 'speak' : 'silent' });
    if (!decision) return null;
    if (decision.speak) return { text: decision.text };
    return decision.close ? { text: null, close: true } : { text: null };
  };
}
