import type { PolicySpec } from '../reliability/policy.ts';

/** What a proactive line is for; each has one zh purpose sentence (spec 意图渲染). */
export const INTENT_PURPOSES = ['threadEventBefore', 'threadEventAfter', 'threadConcern', 'threadPlan',
  'moodCheckNow', 'moodCheckEarlier', 'routineMorning', 'routineNoon', 'routineEvening', 'routineNight',
  'continueThread', 'interestTopic', 'humanConnection', 'selfShare', 'presenceCheck', 'restQuiet', 'greetingPlain'] as const;
export type IntentPurpose = (typeof INTENT_PURPOSES)[number];

/** Fallback line groups; threadSensitive is spoken instead of rendering a health thread (2026-10-29). */
export const FALLBACK_KEYS = ['threadFollowup', 'threadSensitive', 'moodCheck', 'routine', 'continueThread',
  'interestTopic', 'humanConnection', 'selfShare', 'presenceCheck', 'restQuiet'] as const;
export type FallbackKey = (typeof FALLBACK_KEYS)[number];

/** Plan-A instruction fragments (P3-T0 probe). Repo only; never in the admin console. */
export interface IntentCopy {
  frame: string;
  /** Opening frame (P4): {maxChars} {name} {purpose}. Says the name once, then the purpose. */
  opening: string;
  withQuote: string;
  withTopic: string;
  withoutMaterial: string;
  noQuestion: string;
  speakLine: string;
  purposes: Record<IntentPurpose, string>;
  tones: { new: string; familiar: string; oldFriend: string; explore: string; comfort: string; suggest: string };
  /** When the user said it; justNow = this session; days[i] is (i + 2) days ago. */
  saidWhen: { justNow: string; today: string; yesterday: string; days: readonly string[]; lastWeek: string; earlier: string };
}

export type FallbackGroups = Record<FallbackKey, readonly string[]>;

export interface SilenceDecisionConfig {
  instruction: string;
  speakInstruction: string;
  maxTokens: number;
  maxInputChars: number;
  maxReplyChars: number;
  /** Sampling temperature for spoken lines; higher values vary the phrasing. */
  temperature: number;
  /** Structural angles that push phrasing apart; hints only, never spoken verbatim. */
  variationHints?: {
    greeting?: readonly string[];
    checkin?: readonly string[];
  };
  /** Localized label placed before a variation hint in the planner system prompt. */
  variationHintLabel?: string;
  policy: PolicySpec;
}

/** A light conversation starter used for the first silence follow-up. */
export interface TopicCard {
  id: string;
  prompt: string;
  fallbackText: string;
}

export interface DirectorConfig {
  silenceDecision?: SilenceDecisionConfig;
  followupAfterMs: number;
  idleNoticeAfterMs: number;
  maxConsecutive: number;
  maxPerWindow: number;
  windowMs: number;
  /** After maxConsecutive quick beats, keep offering a light topic at this interval. Absent means stay quiet. */
  companyAfterMs?: number;
  /** Silence step 1, after playback ends. Default 6000 when omitted. */
  contextAfterMs?: number;
  /** Silence step 2. Default 8000 when omitted. */
  checkAfterMs?: number;
  /** Silence step 3. Default 10000 when omitted. */
  leaveAfterMs?: number;
  /** Silence step 4, the final polite check-in. Default 10000 when omitted. */
  checkinAfterMs?: number;
  /** After the final check-in, wait this long still silent, then one looser line. Default 180000. */
  restAfterMs?: number;
  /** Legacy/test template. Production uses silenceDecision.speakInstruction. */
  contextInstruction?: string;
  /** Step 1 spoken fallback when the judged continuation is declined. Defaults to followupText. */
  contextText?: string;
  /** Step 1 when the user has not said anything concrete. */
  presenceInstruction?: string;
  presenceText?: string;
  /** First silence line after the opening, before the user has said anything. */
  openingFollowInstruction?: string;
  openingFollowText?: string;
  /** Same moment, when a memory snapshot exists. */
  memoryFollowText?: string;
  /** Spoken when a barge-in is not a real utterance. */
  bargeMissInstruction?: string;
  bargeMissText?: string;
  /** Step 2 when the user has not spoken yet. */
  checkInstruction?: string;
  checkText?: string;
  /** Step 2 when the user has said something. `{utterance}` is their last line. */
  checkContextInstruction?: string;
  checkContextText?: string;
  /** Step 2 when a memory snapshot exists but this call has no user line yet. */
  checkMemoryInstruction?: string;
  checkMemoryText?: string;
  /** Short leave after tens of seconds. Gives the user room to not reply. */
  leaveInstruction?: string;
  leaveText?: string;
  /** Final polite check-in: are you still there, chat any time. */
  checkinInstruction?: string;
  checkinText?: string;
  /** Looser line after a few quiet minutes. Then proactive speech stops. */
  restInstruction?: string;
  restText?: string;
  /** Whole utterances that mean the user is still here. */
  lightPhrases?: readonly string[];
  quietPhrases: string[];
  greetingInstruction: string;
  greetingText: string;
  /** Opening when a memory snapshot exists. */
  greetingMemoryInstruction?: string;
  greetingMemoryText?: string;
  /** Safe opening variants when only the name is known; `{name}` is replaced. */
  greetingNameTexts?: readonly string[];
  /** Care opening heads; `{name}` is replaced and the generated care line follows. No question here. */
  greetingCareTexts?: readonly string[];
  /** How long to wait before repeating an opening that was cut off. */
  greetingRetryMs?: number;
  followupInstruction: string;
  followupText: string;
  idleNoticeInstruction: string;
  idleNoticeText: string;
  resumeInstruction: string;
  resumeText: string;
  /** Spoken after a tool action, once the origin reply has finished playing. */
  toolContinueInstruction: string;
  toolContinueText: string;
  /** One-time memory notice after the opening, when the owner has not been told. */
  memoryNoticeInstruction: string;
  memoryNoticeText: string;
  /** Silence-topic template; `{topic}` is replaced by the card prompt. */
  topicInstruction?: string;
  topics?: readonly TopicCard[];
  /** Proactive intent instructions (P3). Present together with `fallbacks`; absent = configured stage copy. */
  intents?: IntentCopy;
  /** Fallback line groups, at least five lines each; admin-editable. */
  fallbacks?: FallbackGroups;
}
