import type { ResponseKind } from '@anyidea/protocol';

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
}

export interface DirectorDeps {
  requestResponse(kind: ResponseKind, instructions: string): void;
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

  constructor(
    private readonly cfg: DirectorConfig,
    private readonly deps: DirectorDeps,
  ) {}

  onSessionStart(): void {
    this.deps.requestResponse('greeting', this.cfg.greetingInstruction);
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
    if (!this.blocked() && this.takeSpeechSlot()) this.deps.requestResponse('followup', this.cfg.resumeInstruction);
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
    const instruction = isLast ? this.cfg.idleNoticeInstruction : this.cfg.followupInstruction;
    this.timer = setTimeout(() => this.fire(instruction), delay);
  }

  private blocked(): boolean {
    return this.stopped || this.quiet || this.muted || this.paused || this.userSpeaking;
  }

  private fire(instruction: string): void {
    this.timer = null;
    if (this.blocked()) return;
    if (!this.takeSpeechSlot()) return;
    this.consecutive++;
    this.deps.requestResponse('followup', instruction);
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
