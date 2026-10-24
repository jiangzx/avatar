import type { Language } from '@anyidea/protocol';
import type { SafetyRules } from '../config.ts';
import { parsePhrase } from '../memory/grounding.ts';
import { scanText } from '../memory/scan.ts';
import type { TextModelClient } from '../memory/textClient.ts';
import { runWithPolicy } from '../reliability/policy.ts';
import { isLow, type AffectCard, type FollowUpConfig } from './affect.ts';

export type FollowUpTrigger = 'share_joy' | 'trend_better' | 'help' | 'low';
export type FollowUpSkipCode =
  | 'crisis' | 'stale' | 'limit' | 'already_asked'
  | 'user_speech' | 'interrupted' | 'ended';

export function followUpTrigger(card: AffectCard, lowIntensity: number): FollowUpTrigger | null {
  if (card.crisis) return null;
  if (isLow(card, lowIntensity)) return 'low';
  if (card.need === 'share_joy') return 'share_joy';
  if (card.trend === 'better') return 'trend_better';
  if (card.need === 'help') return 'help';
  return null;
}

export interface FollowUpGuardInput {
  trigger: FollowUpTrigger;
  cardTurn: number;
  userTurn: number;
  mainReplyHasQuestion: boolean;
  userSpeaking: boolean;
  ended: boolean;
  interrupted: boolean;
  used: number;
  maxPerSession: number;
}

export function followUpSkipCode(input: FollowUpGuardInput): FollowUpSkipCode | null {
  if (input.ended) return 'ended';
  if (input.userSpeaking) return 'user_speech';
  if (input.interrupted) return 'interrupted';
  if (input.used >= input.maxPerSession) return 'limit';
  if (input.cardTurn !== input.userTurn) return 'stale';
  if (input.trigger !== 'low' && input.mainReplyHasQuestion) return 'already_asked';
  return null;
}

export function hasQuestionMark(text: string): boolean {
  return /[?？]/.test(text);
}

export interface FollowUpPlannerInput {
  language: Language;
  trigger: FollowUpTrigger;
  userText: string;
  /** Recent user statements only; never assistant text. */
  recentUserTexts?: readonly string[];
  card: AffectCard;
}
export type FollowUpPlanner = (input: FollowUpPlannerInput, signal: AbortSignal) => Promise<string | null>;

export function createFollowUpPlanner(deps: {
  client: TextModelClient;
  config: FollowUpConfig;
  prompt: (language: Language) => string;
  safety: SafetyRules;
}): FollowUpPlanner {
  return async (input, signal) => {
    const { client, config } = deps;
    const result = await runWithPolicy(
      'empathy_followup',
      { timeoutMs: config.timeoutMs, retries: 0, backoffMs: 0, maxBackoffMs: 0 },
      (timeoutSignal) => client.complete({
        system: deps.prompt(input.language),
        user: JSON.stringify({
          trigger: input.trigger,
          userText: input.userText,
          recentUserTexts: input.recentUserTexts ?? [],
          card: {
            emotion: input.card.emotion,
            intensity: input.card.intensity,
            trend: input.card.trend,
            need: input.card.need,
            strategy: input.card.strategy,
            mismatch: input.card.mismatch,
          },
        }),
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        jsonMode: true,
        signal: AbortSignal.any([signal, timeoutSignal]),
      }),
      { classify: () => 'ignorable' },
    );
    if (!result.ok) return null;
    const text = parsePhrase(result.value);
    if (!text || [...text].length > config.maxChars) return null;
    if (input.trigger === 'low' && hasQuestionMark(text)) return null;
    if (scanText(text, deps.safety) === 'reject') return null;
    return text;
  };
}
