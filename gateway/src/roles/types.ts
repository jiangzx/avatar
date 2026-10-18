/** A light conversation starter used for the first silence follow-up. */
export interface TopicCard {
  id: string;
  prompt: string;
  fallbackText: string;
}

export interface DirectorConfig {
  followupAfterMs: number;
  idleNoticeAfterMs: number;
  maxConsecutive: number;
  maxPerWindow: number;
  windowMs: number;
  /** After maxConsecutive quick beats, keep offering a light topic at this interval. Absent means stay quiet. */
  companyAfterMs?: number;
  /** Silence step 1, after playback ends. Default 5000 when omitted. */
  contextAfterMs?: number;
  /** Silence step 2. Default 10000 when omitted. */
  checkAfterMs?: number;
  /** Silence step 3, and the wait after a light reply. Default 10000 when omitted. */
  leaveAfterMs?: number;
  /** After the short leave, wait this long still silent, then one looser line. Default 180000. */
  restAfterMs?: number;
  /** Step 1 when the user has said something concrete. The model writes the question from context. */
  contextInstruction?: string;
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
}
