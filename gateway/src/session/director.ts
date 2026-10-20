import type { ResponseKind } from '@anyidea/protocol';
import type { ProactiveCue, ProactiveRequest } from '../adapters/types.ts';
import type { DirectorConfig } from '../roles/types.ts';
import { log } from '../log.ts';

export type { DirectorConfig, TopicCard } from '../roles/types.ts';

export interface SilenceContext {
  stage: PlannedSilenceStep;
  userText: string;
  assistantText: string;
  previousTexts: readonly string[];
}

export interface SilencePlan {
  /** Spoken line. Null means the configured stage copy should be used. */
  text: string | null;
  /** The user clearly ended the conversation; stop the ladder instead of speaking. */
  close?: boolean;
}

export interface DirectorDeps {
  requestResponse(kind: ResponseKind, request: ProactiveRequest): void;
  /** Plans one of the first three silence lines; checkin and rest use configured copy. */
  planSilenceLine?(context: SilenceContext, signal: AbortSignal): SilencePlan | null | Promise<SilencePlan | null>;
  /** Once per quiet stretch, when silence reaches the rest step. */
  onQuietRest?(): void;
}

type SilenceStep = 'context' | 'check' | 'leave' | 'checkin' | 'rest';
type PlannedSilenceStep = Exclude<SilenceStep, 'rest' | 'checkin'>;

/** Agreed defaults when a fixture omits the silence fields. Shipped roles set them in director.json. */
const DEFAULT_CONTEXT_AFTER_MS = 6_000;
const DEFAULT_CHECK_AFTER_MS = 8_000;
const DEFAULT_LEAVE_AFTER_MS = 10_000;
const DEFAULT_CHECKIN_AFTER_MS = 10_000;
/** A few quiet minutes after the final check-in, then one looser line. */
const DEFAULT_REST_AFTER_MS = 180_000;
const DEFAULT_CHECKIN_INSTRUCTION = '用户仍然没有回应。请客气、亲切地轻声问一句用户是否还在听，并说明随时都可以接着聊，不催促、不追问。不超过 30 个字。';
const DEFAULT_CHECKIN_TEXT = '您还在听吗？不着急，您随时想聊都可以，我一直都在。';
const DEFAULT_REST_INSTRUCTION = '用户已经安静了好几分钟。只说「你可以先自己放空一会儿，不用急着回我。」不要提问，不要再起话题。';
const DEFAULT_REST_TEXT = '你可以先自己放空一会儿，不用急着回我。';
const DEFAULT_GREETING_RETRY_MS = 800;
/** If a barge-in never becomes a real utterance, say so. Do not fall through to 「我在」. */
const DEFAULT_BARGE_REPLY_WAIT_MS = 2_500;
const DEFAULT_BARGE_MISS_INSTRUCTION = '刚才那一下听不清，不是一句完整的话。请只说：没听清，您再说一遍。不要接被打断的内容。';
const DEFAULT_BARGE_MISS_TEXT = '没听清，您再说一遍。';
const DEFAULT_LIGHT = ['嗯', '哦', '好', '行', '好的', '嗯嗯', '我知道了', '知道了', '知道啦', '明白了', '明白啦'] as const;

interface SilenceCopy {
  contextAfterMs: number;
  checkAfterMs: number;
  leaveAfterMs: number;
  checkinAfterMs: number;
  contextInstruction: string;
  contextText: string;
  presenceInstruction: string;
  presenceText: string;
  checkInstruction: string;
  checkText: string;
  checkContextInstruction?: string;
  checkContextText: string;
  checkMemoryInstruction?: string;
  checkMemoryText?: string;
  leaveInstruction: string;
  leaveText: string;
  checkinInstruction: string;
  checkinText: string;
  restAfterMs: number;
  restInstruction: string;
  restText: string;
  lightPhrases: readonly string[];
}

/** Controls proactive speech: greeting, the silence ladder, and reconnect. */
export class Director {
  private timer: NodeJS.Timeout | null = null;
  private history: number[] = [];
  private quiet = false;
  private muted = false;
  private paused = false;
  private stopped = false;
  private userSpeaking = false;
  private aiBusy = false;
  private hadContent = false;
  private left = false;
  /** The short leave has been said. Further silence waits, then one looser line. */
  private eased = false;
  private lightHold = false;
  private next: SilenceStep = 'context';
  /** Last substantive thing the user said. Step 1 may quote only this, never the assistant. */
  private lastContent = '';
  private lastAnswer = '';
  /** Lines already spoken in the current silence ladder, so the planner can avoid repeats. */
  private ladderTexts: string[] = [];
  private decision: AbortController | null = null;
  private silentStretch = false;
  /** True after the opening line has played to the end. Until then, do not say the presence line. */
  private opened = false;
  private hasMemory = false;
  /** The user cut in. Do not resume the script until their reply has finished. */
  private bargeIn = false;
  /** Silence step whose playback is in flight, or the memory notice. */
  private pending: SilenceStep | 'notice' | 'repair' | 'resume' | null = null;
  /** Still owe the one-time memory notice in this session. */
  private noticePending: boolean;
  /** The notice was cut off. Say it again at the next idle moment. */
  private noticeRetry = false;
  /** The rest step already enqueued extraction for this quiet stretch. */
  private restNoticed = false;

  constructor(
    private readonly cfg: DirectorConfig,
    private readonly deps: DirectorDeps,
    noticePending = false,
    private readonly restAfterMs?: number,
  ) {
    this.noticePending = noticePending;
  }

  onSessionStart(hasMemory = false): void {
    this.hasMemory = hasMemory;
    this.deps.requestResponse('greeting', this.greetingRequest());
  }

  /** Local VAD state from the client. */
  onUserSpeech(speaking: boolean): void {
    const wasSpeaking = this.userSpeaking;
    this.userSpeaking = speaking;
    if (speaking) {
      if (this.aiBusy || this.pending !== null) this.bargeIn = true;
      this.clear();
      if (this.pending !== 'notice') this.pending = null;
    } else if (wasSpeaking) {
      if (this.bargeIn) {
        // The word often ends before playback has stopped. Keep the hold.
        if (!this.aiBusy) this.armBargeReplyWait();
        return;
      }
      if (this.noticeRetry && !this.aiBusy) {
        this.requestMemoryNotice();
        return;
      }
      if (this.opened) this.arm();
      else this.armOpening();
    }
  }

  /** Any sign of the user engaging (model-side speech, transcripts). */
  onUserActivity(): void {
    this.clear();
    if (this.pending !== 'notice') this.pending = null;
    if (this.bargeIn && !this.aiBusy) this.armBargeReplyWait();
  }

  onUserFinal(text: string): void {
    if (this.cfg.quietPhrases.some((p) => text.includes(p))) {
      this.quiet = true;
      this.clear();
      if (this.pending !== 'notice') this.pending = null;
      // A cut-off notice still has to be said. Quiet phrases do not cancel it.
      if (this.noticeRetry && !this.aiBusy && !this.userSpeaking && !this.stopped && !this.muted && !this.paused) {
        this.requestMemoryNotice();
      }
      return;
    }
    const key = normalizeUtterance(text);
    if (!key) return;
    this.clear();
    if (this.pending !== 'notice') this.pending = null;
    if (this.isLight(key)) {
      if (this.left) return;
      if (this.hadContent) {
        this.waitQuietly();
        return;
      }
      if (this.eased) {
        this.next = 'rest';
        if (!this.aiBusy) this.arm();
        return;
      }
      this.lightHold = true;
      this.next = 'leave';
      if (!this.aiBusy) this.arm();
      return;
    }
    this.quiet = false;
    this.hadContent = true;
    this.lastContent = text.trim();
    this.lastAnswer = '';
    this.ladderTexts = [];
    this.silentStretch = false;
    this.lightHold = false;
    this.left = false;
    this.eased = false;
    this.restNoticed = false;
    this.next = 'context';
    if (this.bargeIn && !this.aiBusy) this.armBargeReplyWait();
  }

  /** A new assistant response started: the silence timer no longer applies. */
  onAiTurnStarted(): void {
    this.aiBusy = true;
    this.bargeIn = false;
    this.clear();
  }

  /** The line was cut off. A real barge-in waits for the reply; a false cut repeats the step. */
  onAssistantInterrupted(): void {
    this.aiBusy = false;
    if (this.pending === 'notice') {
      this.pending = null;
      this.noticeRetry = true;
    }
    if (this.stopped || this.muted || this.paused) return;
    if (this.userSpeaking) return;
    if (this.noticeRetry) {
      if (this.bargeIn) {
        this.armBargeReplyWait();
        return;
      }
      this.requestMemoryNotice();
      return;
    }
    if (this.quiet || this.left) return;
    this.pending = null;
    if (this.bargeIn) {
      this.armBargeReplyWait();
      return;
    }
    if (!this.opened) {
      this.armOpening();
      return;
    }
    this.arm();
  }

  /** Playback ended for the notice. The only path that clears the obligation. */
  onNoticePlayed(): void {
    this.noticePending = false;
    this.noticeRetry = false;
    // Keep playback ownership until onAiTurnEnded consumes it.
  }

  /** The notice was not started, or its seq was cancelled before playback ended. */
  onNoticeMissed(): void {
    if (!this.noticePending) return;
    this.noticeRetry = true;
    if (this.pending === 'notice') this.pending = null;
  }

  onAiTurnEnded(assistantText?: string): void {
    this.aiBusy = false;
    const openingJustFinished = !this.opened;
    this.opened = true;
    this.bargeIn = false;
    const hardStop = this.stopped || this.muted || this.paused || this.userSpeaking;
    if (hardStop) {
      // A requested notice is not finished just because this turn stopped.
      if (this.noticePending) this.noticeRetry = true;
      if (this.pending === 'notice') this.pending = null;
      return;
    }
    const done = this.pending;
    this.pending = null;
    if (done === null && assistantText !== undefined) this.lastAnswer = assistantText;
    if (this.noticePending && (this.noticeRetry || openingJustFinished || done === 'notice')) {
      this.requestMemoryNotice();
      return;
    }
    if (this.quiet || this.left) return;
    if (done === 'repair' || (done === 'resume' && this.hadContent) || this.silentStretch) {
      this.waitQuietly();
      return;
    }
    if (done === 'rest') {
      this.left = true;
      this.lightHold = false;
      return;
    }
    if (done === 'leave') {
      this.lightHold = false;
      if (this.hadContent) {
        // After real chat, one final polite check-in before a longer quiet stretch.
        this.next = 'checkin';
        this.arm();
        return;
      }
      this.eased = true;
      this.next = 'rest';
      this.arm();
      return;
    }
    if (done === 'checkin') {
      this.eased = true;
      this.next = 'rest';
      this.arm();
      return;
    }
    if (done === 'context' && this.lightHold) {
      this.next = 'leave';
      this.arm();
      return;
    }
    if (done === 'context') {
      this.next = 'check';
      this.arm();
      return;
    }
    if (done === 'check') {
      this.next = 'leave';
      this.arm();
      return;
    }
    if (this.eased) {
      this.next = 'rest';
      this.arm();
      return;
    }
    this.next = this.lightHold ? 'leave' : 'context';
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
    if (this.pending === 'notice') this.noticeRetry = true;
    this.pending = null;
    if (!this.blocked() && this.takeSpeechSlot()) {
      this.pending = 'resume';
      this.deps.requestResponse('followup', this.request('resume'));
    }
  }

  /** One memory notice after the opening. Does not use the proactive frequency cap. */
  requestMemoryNotice(): void {
    if (this.stopped || this.muted || this.paused || this.userSpeaking) {
      this.noticeRetry = true;
      return;
    }
    this.clear();
    this.noticeRetry = false;
    this.pending = 'notice';
    const c = this.cfg;
    this.deps.requestResponse('followup', {
      cue: 'memoryNotice',
      instruction: c.memoryNoticeInstruction,
      fallbackText: c.memoryNoticeText,
    });
  }

  /** Unpause after a tool turn. Not the reconnect announcement. */
  releasePause(rearm: boolean): void {
    this.paused = false;
    if (rearm) this.onAiTurnEnded();
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  /** Repeats the opening after a cut-off, instead of the empty-state presence line. */
  private armOpening(): void {
    this.clear();
    if (this.blocked() || this.left || this.opened) return;
    const wait = this.cfg.greetingRetryMs ?? DEFAULT_GREETING_RETRY_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.blocked() || this.left || this.opened) return;
      this.deps.requestResponse('greeting', this.greetingRequest());
    }, wait);
  }

  private greetingRequest(): ProactiveRequest {
    const c = this.cfg;
    if (this.hasMemory && c.greetingMemoryInstruction && c.greetingMemoryText) {
      return { cue: 'greeting', instruction: c.greetingMemoryInstruction, fallbackText: c.greetingMemoryText };
    }
    return { cue: 'greeting', instruction: c.greetingInstruction, fallbackText: c.greetingText };
  }

  /** A noise barge-in. If no real reply starts, say it was not heard. */
  private armBargeReplyWait(): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.bargeIn) return;
      this.bargeIn = false;
      if (this.stopped || this.muted || this.paused || this.userSpeaking) return;
      if (this.noticeRetry) {
        this.requestMemoryNotice();
        return;
      }
      if (this.quiet || this.left) return;
      const c = this.cfg;
      this.pending = 'repair';
      this.deps.requestResponse('followup', {
        cue: 'followup',
        instruction: c.bargeMissInstruction ?? DEFAULT_BARGE_MISS_INSTRUCTION,
        fallbackText: c.bargeMissText ?? DEFAULT_BARGE_MISS_TEXT,
      });
    }, DEFAULT_BARGE_REPLY_WAIT_MS);
  }

  /** Starts the timer for the current silence step. Each delay begins when the previous line has finished. */
  private arm(): void {
    this.clear();
    if (this.blocked() || this.left) return;
    const step = this.next;
    this.timer = setTimeout(() => this.fire(step), this.delayFor(step));
  }

  private fire(step: SilenceStep): void {
    this.timer = null;
    if (this.blocked() || this.left) return;
    if (step === 'rest' && !this.restNoticed) {
      this.restNoticed = true;
      this.deps.onQuietRest?.();
    }
    if (this.silentStretch) {
      this.left = true;
      return;
    }
    // After real chat the first three stages are planned; the fourth is a fixed, configured
    // check-in, because a topic-continuation planner tends to keep talking instead of asking
    // whether the user is still there. A failed plan falls back to the configured copy.
    if (step !== 'rest' && step !== 'checkin' && this.hadContent && this.deps.planSilenceLine) {
      this.planSilenceLine(step);
      return;
    }
    this.requestSilenceStep(step);
  }

  /** Plan one stage before requesting audio. A cancelled plan can never speak. */
  private planSilenceLine(step: PlannedSilenceStep): void {
    const controller = new AbortController();
    this.decision = controller;
    const accept = (plan: SilencePlan | null) => {
      if (this.decision !== controller || controller.signal.aborted || this.blocked() || this.left) return;
      this.decision = null;
      if (plan?.close) {
        // The user clearly ended the conversation: no fallback copy, no later stages.
        this.left = true;
        return;
      }
      const text = plan?.text?.trim();
      if (!text) {
        // A declined or failed plan still speaks the configured stage copy.
        this.requestSilenceStep(step);
        return;
      }
      this.pending = step;
      this.rememberLadderText(text);
      this.deps.requestResponse('followup', {
        cue: 'followup',
        instruction: (this.cfg.silenceDecision?.speakInstruction ?? this.silence().contextInstruction)
          .replaceAll('{utterance}', this.lastContent)
          .replaceAll('{continuation}', JSON.stringify(text)),
        fallbackText: text,
      });
    };
    const failed = () => {
      if (this.decision !== controller) return;
      log('silence_decision_failed', { code: 'decision_error' });
      accept(null);
    };
    try {
      const result = this.deps.planSilenceLine?.({
        stage: step,
        userText: this.lastContent,
        assistantText: this.lastAnswer,
        previousTexts: [...this.ladderTexts],
      }, controller.signal) ?? null;
      if (result instanceof Promise) void result.then(accept, failed);
      else accept(result);
    } catch {
      failed();
    }
  }

  private requestSilenceStep(step: SilenceStep): void {
    this.pending = step;
    const request = this.silenceRequest(step);
    if (this.hadContent && step !== 'rest') this.rememberLadderText(request.fallbackText);
    this.deps.requestResponse('followup', request);
  }

  private rememberLadderText(text: string): void {
    this.ladderTexts.push(text);
    if (this.ladderTexts.length > 3) this.ladderTexts.shift();
  }

  /** Keep the memory rest hook without filling the silence with speech. */
  private waitQuietly(): void {
    this.silentStretch = true;
    this.next = 'rest';
    if (!this.aiBusy) this.arm();
  }

  private delayFor(step: SilenceStep): number {
    const s = this.silence();
    if (step === 'context') return s.contextAfterMs;
    if (step === 'check') return s.checkAfterMs;
    if (step === 'leave') return s.leaveAfterMs;
    if (step === 'checkin') return s.checkinAfterMs;
    return s.restAfterMs;
  }

  private silenceRequest(step: SilenceStep): ProactiveRequest {
    const s = this.silence();
    if (step === 'context' && this.hadContent) {
      return {
        cue: 'followup',
        instruction: s.contextInstruction
          .replaceAll('{utterance}', this.lastContent)
          .replaceAll('{continuation}', s.contextText),
        fallbackText: s.contextText,
      };
    }
    if (step === 'context') return this.openingFollow(s);
    if (step === 'check') return this.checkRequest(s);
    if (step === 'checkin') return { cue: 'followup', instruction: s.checkinInstruction, fallbackText: s.checkinText };
    if (step === 'rest') return { cue: 'followup', instruction: s.restInstruction, fallbackText: s.restText };
    return { cue: 'followup', instruction: s.leaveInstruction, fallbackText: s.leaveText };
  }

  /** 「您还方便吗」plus one line of the actual context. Do not invent a topic. */
  private checkRequest(s: SilenceCopy): ProactiveRequest {
    if (this.hadContent && s.checkContextInstruction) {
      return {
        cue: 'followup',
        instruction: s.checkContextInstruction.replaceAll('{utterance}', this.lastContent),
        fallbackText: s.checkContextText,
      };
    }
    if (!this.hadContent && this.hasMemory && s.checkMemoryInstruction && s.checkMemoryText) {
      return { cue: 'followup', instruction: s.checkMemoryInstruction, fallbackText: s.checkMemoryText };
    }
    return { cue: 'followup', instruction: s.checkInstruction, fallbackText: s.checkText };
  }

  private openingFollow(s: SilenceCopy): ProactiveRequest {
    const c = this.cfg;
    if (c.openingFollowInstruction && c.openingFollowText) {
      const fallback = this.hasMemory && c.memoryFollowText ? c.memoryFollowText : c.openingFollowText;
      return { cue: 'followup', instruction: c.openingFollowInstruction, fallbackText: fallback };
    }
    return { cue: 'followup', instruction: s.presenceInstruction, fallbackText: s.presenceText };
  }

  private silence(): SilenceCopy {
    const c = this.cfg;
    return {
      contextAfterMs: c.contextAfterMs ?? DEFAULT_CONTEXT_AFTER_MS,
      checkAfterMs: c.checkAfterMs ?? DEFAULT_CHECK_AFTER_MS,
      leaveAfterMs: c.leaveAfterMs ?? DEFAULT_LEAVE_AFTER_MS,
      checkinAfterMs: c.checkinAfterMs ?? DEFAULT_CHECKIN_AFTER_MS,
      contextInstruction: c.contextInstruction ?? c.followupInstruction,
      contextText: c.contextText ?? c.followupText,
      presenceInstruction: c.presenceInstruction ?? c.idleNoticeInstruction,
      presenceText: c.presenceText ?? c.idleNoticeText,
      checkInstruction: c.checkInstruction ?? c.followupInstruction,
      checkText: c.checkText ?? c.followupText,
      checkContextInstruction: c.checkContextInstruction,
      checkContextText: c.checkContextText ?? c.checkText ?? c.followupText,
      checkMemoryInstruction: c.checkMemoryInstruction,
      checkMemoryText: c.checkMemoryText,
      leaveInstruction: c.leaveInstruction ?? c.idleNoticeInstruction,
      leaveText: c.leaveText ?? c.idleNoticeText,
      checkinInstruction: c.checkinInstruction ?? DEFAULT_CHECKIN_INSTRUCTION,
      checkinText: c.checkinText ?? DEFAULT_CHECKIN_TEXT,
      restAfterMs: this.restAfterMs ?? c.restAfterMs ?? DEFAULT_REST_AFTER_MS,
      restInstruction: c.restInstruction ?? DEFAULT_REST_INSTRUCTION,
      restText: c.restText ?? DEFAULT_REST_TEXT,
      lightPhrases: c.lightPhrases ?? DEFAULT_LIGHT,
    };
  }

  private isLight(key: string): boolean {
    return this.silence().lightPhrases.some((p) => normalizeUtterance(p) === key);
  }

  private blocked(): boolean {
    return this.stopped || this.quiet || this.muted || this.paused || this.userSpeaking;
  }

  private request(cue: ProactiveCue): ProactiveRequest {
    const c = this.cfg;
    switch (cue) {
      case 'greeting': return { cue, instruction: c.greetingInstruction, fallbackText: c.greetingText };
      case 'followup': return { cue, instruction: c.followupInstruction, fallbackText: c.followupText };
      case 'idleNotice': return { cue, instruction: c.idleNoticeInstruction, fallbackText: c.idleNoticeText };
      case 'resume': return { cue, instruction: c.resumeInstruction, fallbackText: c.resumeText };
      case 'toolContinue': return { cue, instruction: c.toolContinueInstruction, fallbackText: c.toolContinueText };
      case 'memoryNotice': return { cue, instruction: c.memoryNoticeInstruction, fallbackText: c.memoryNoticeText };
    }
  }

  /** Resume announcements still use the window. Silence steps do not. */
  private takeSpeechSlot(): boolean {
    const now = Date.now();
    this.history = this.history.filter((t) => now - t < this.cfg.windowMs);
    if (this.history.length >= this.cfg.maxPerWindow) return false;
    this.history.push(now);
    return true;
  }

  private clear(): void {
    this.decision?.abort();
    this.decision = null;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Drops whitespace and sentence punctuation so "嗯。" is the same utterance as "嗯". */
function normalizeUtterance(text: string): string {
  return text.trim().replace(/[\s。！？!?，,、.~～…]+/gu, '');
}
