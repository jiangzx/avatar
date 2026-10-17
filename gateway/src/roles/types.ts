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
  quietPhrases: string[];
  greetingInstruction: string;
  greetingText: string;
  followupInstruction: string;
  followupText: string;
  idleNoticeInstruction: string;
  idleNoticeText: string;
  resumeInstruction: string;
  resumeText: string;
  /** Silence-topic template; `{topic}` is replaced by the card prompt. */
  topicInstruction?: string;
  topics?: readonly TopicCard[];
}
