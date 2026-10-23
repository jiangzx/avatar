// High-risk silence contract: read docs/project/roadmap.md "记忆与回忆：已踩过的坑" before changing.
import { z } from 'zod';
import { containsPhrase } from '../i18n/text.ts';
import type { SilenceRules } from '../i18n/types.ts';
import { log } from '../log.ts';
import type { TextModelClient } from '../memory/textClient.ts';
import { runWithPolicy } from '../reliability/policy.ts';
import type { SilenceDecisionConfig } from '../roles/types.ts';
import type { SilenceContext, SilencePlan } from './director.ts';

const QUESTION = /[？?]/;

/** Every planned line must keep the content its stage promises; otherwise configured copy is used. */
function stageContentOk(stage: SilenceContext['stage'], text: string, rules: SilenceRules): boolean {
  if (stage === 'greeting') return rules.greeting.some((phrase) => containsPhrase(text, phrase)) && QUESTION.test(text);
  // A check-in that stops asking whether the user is there is a new topic, not a check-in.
  if (stage === 'checkin') {
    return text.length <= rules.maxCheckinChars
      && rules.listening.some((phrase) => containsPhrase(text, phrase))
      && rules.anytime.some((phrase) => containsPhrase(text, phrase));
  }
  if (stage === 'rest') return !QUESTION.test(text);
  return true;
}

/** JSON mode should give bare JSON; tolerate a code fence or stray prose around it. */
function parseDecisionJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
}

/** A per-call structural angle keeps the same stage from always sounding the same. */
function variationHint(config: SilenceDecisionConfig, context: SilenceContext): string | null {
  const hints = context.stage === 'greeting'
    ? (context.memorySnapshot ? config.variationHints?.greeting : undefined)
    : context.stage === 'checkin' ? config.variationHints?.checkin : undefined;
  if (!hints || hints.length === 0) return null;
  return hints[Math.floor(Math.random() * hints.length)] ?? null;
}

/** Optional speech earns a turn only after a validated, current decision. */
export function createSilencePlanner(client: TextModelClient, config: SilenceDecisionConfig, rules: SilenceRules) {
  const decisionSchema = z.discriminatedUnion('speak', [
    z.object({ speak: z.literal(false), close: z.boolean().optional() }).strict(),
    z.object({ speak: z.literal(true), text: z.string().trim().min(1).max(config.maxReplyChars) }).strict(),
  ]);
  return async (context: SilenceContext, signal: AbortSignal): Promise<SilencePlan | null> => {
    if (signal.aborted) return null;
    // Plan extras are small and always sent whole; they count before the snapshot gets its share.
    const extraChars = (context.affect ? JSON.stringify(context.affect).length : 0)
      + (context.openLoop?.length ?? 0)
      + (context.timeOfDay?.length ?? 0)
      + (context.season?.length ?? 0)
      + (context.solarTerm?.length ?? 0);
    const usedChars = context.userText.length + context.assistantText.length
      + context.previousTexts.reduce((total, text) => total + text.length, 0)
      + extraChars;
    // The memory snapshot is the largest field and is expendable: keep its leading part within budget.
    const memorySnapshot = context.memorySnapshot.slice(0, Math.max(0, config.maxInputChars - usedChars));
    const input = { ...context, memorySnapshot };
    const inputChars = usedChars + memorySnapshot.length;
    if (inputChars > config.maxInputChars) {
      log('silence_decision_skipped', { code: 'input_budget' });
      return null;
    }
    const hint = variationHint(config, context);
    const system = hint
      ? `${config.instruction}\n${config.variationHintLabel ?? ''}${hint}`
      : config.instruction;
    const result = await runWithPolicy('silence_decision', config.policy, async timeoutSignal => {
      const raw = await client.complete({
        system,
        user: JSON.stringify(input),
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        jsonMode: true,
        signal: AbortSignal.any([signal, timeoutSignal]),
      });
      if (signal.aborted) throw new Error('silence_cancelled');
      try {
        return decisionSchema.parse(parseDecisionJson(raw));
      } catch {
        throw new Error('silence_invalid_response');
      }
    }, { classify: () => signal.aborted ? 'ignorable' : 'fatal' });
    if (signal.aborted) return null;
    const decision = result.ok ? result.value : null;
    if (decision?.speak && !stageContentOk(context.stage, decision.text, rules)) {
      log('silence_decision_rejected', { stage: context.stage, code: 'stage_content' });
      return null;
    }
    log('silence_decision', { stage: context.stage, outcome: decision?.speak ? 'speak' : 'silent' });
    if (!decision) return null;
    if (decision.speak) return { text: decision.text };
    return decision.close ? { text: null, close: true } : { text: null };
  };
}
