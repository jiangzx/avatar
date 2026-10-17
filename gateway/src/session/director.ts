import type { ResponseKind } from '@anyidea/protocol';
import type { ProactiveCue, ProactiveRequest } from '../adapters/types.ts';
import type { DirectorConfig } from '../roles/types.ts';

export type { DirectorConfig, TopicCard } from '../roles/types.ts';

export interface DirectorDeps {
  requestResponse(kind: ResponseKind, request: ProactiveRequest): void;
}

/** Controls proactive speech: greeting, silence follow-ups, and how often the assistant may speak first. */
export class Director {
  private timer: NodeJS.Timeout | null = null;
  private consecutive = 0;
  private history: number[] = [];
  private quiet = false;
  private muted = false;
  private paused = false;
  private stopped = false;
  private userSpeaking = false;
  private topicIndex = 0;

  constructor(
    private readonly cfg: DirectorConfig,
    private readonly deps: DirectorDeps,
  ) {}

  onSessionStart(): void {
    this.deps.requestResponse('greeting', this.request('greeting'));
  }

  /** Local VAD state from the client. */
  onUserSpeech(speaking: boolean): void {
    const wasSpeaking = this.userSpeaking;
    this.userSpeaking = speaking;
    if (speaking) this.onUserActivity();
    else if (wasSpeaking) this.arm(); // if no reply starts (false interruption, nothing recognized), follow up later
  }

  /** Any sign of the user engaging (model-side speech, transcripts). */
  onUserActivity(): void {
    this.clear();
    this.consecutive = 0;
  }

  onUserFinal(text: string): void {
    this.onUserActivity();
    if (this.cfg.quietPhrases.some((p) => text.includes(p))) this.quiet = true;
  }

  /** A new assistant response started: the silence timer no longer applies. */
  onAiTurnStarted(): void {
    this.clear();
  }

  onAiTurnEnded(): void {
    this.arm();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.clear();
  }

  pause(): void {
    this.paused = true;
    this.clear();
  }

  resume(): void {
    this.paused = false;
    this.consecutive = 0;
    if (!this.blocked() && this.takeSpeechSlot()) this.deps.requestResponse('followup', this.request('resume'));
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  /** Starts the silence timer: first a follow-up, then (if still silent) the idle notice. */
  private arm(): void {
    this.clear();
    if (this.blocked() || this.consecutive >= this.cfg.maxConsecutive) return;
    const isLast = this.consecutive === this.cfg.maxConsecutive - 1;
    const delay = this.consecutive === 0 ? this.cfg.followupAfterMs : this.cfg.idleNoticeAfterMs;
    const cue: ProactiveCue = isLast ? 'idleNotice' : 'followup';
    this.timer = setTimeout(() => this.fire(cue), delay);
  }

  private blocked(): boolean {
    return this.stopped || this.quiet || this.muted || this.paused || this.userSpeaking;
  }

  private fire(cue: ProactiveCue): void {
    this.timer = null;
    if (this.blocked()) return;
    if (!this.takeSpeechSlot()) return;
    this.consecutive++;
    this.deps.requestResponse('followup', this.request(cue));
  }

  private request(cue: ProactiveCue): ProactiveRequest {
    const c = this.cfg;
    switch (cue) {
      case 'greeting': return { cue, instruction: c.greetingInstruction, fallbackText: c.greetingText };
      case 'followup': return this.topicRequest() ?? { cue, instruction: c.followupInstruction, fallbackText: c.followupText };
      case 'idleNotice': return { cue, instruction: c.idleNoticeInstruction, fallbackText: c.idleNoticeText };
      case 'resume': return { cue, instruction: c.resumeInstruction, fallbackText: c.resumeText };
    }
  }

  /** Next topic card, round-robin within the session; null when the role has none. */
  private topicRequest(): ProactiveRequest | null {
    const { topics, topicInstruction } = this.cfg;
    if (!topics || topics.length === 0 || !topicInstruction) return null;
    const card = topics[this.topicIndex++ % topics.length]!;
    return { cue: 'followup', instruction: topicInstruction.replaceAll('{topic}', card.prompt), fallbackText: card.fallbackText };
  }

  private takeSpeechSlot(): boolean {
    const now = Date.now();
    this.history = this.history.filter((t) => now - t < this.cfg.windowMs);
    if (this.history.length >= this.cfg.maxPerWindow) return false;
    this.history.push(now);
    return true;
  }

  private clear(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
