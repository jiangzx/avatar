import { containsPhrase } from '../i18n/text.ts';
import type { AffectCard, AffectConfig } from './affect.ts';

/** Spaces, punctuation and symbols do not count toward a short answer. */
function contentLength(text: string): number {
  return [...text.replace(/[\s\p{P}\p{S}]+/gu, '')].length;
}

/**
 * Session-local topic-exhaustion state (spec §4). The conditional hint is armed one short answer
 * early, so the passive reply to the next short answer already carries it. Memory only, never logged.
 */
export class TopicExhaustion {
  private shortStreak = 0;
  private cooldown = 0;
  private low = false;
  private armedNow = false;
  private armedTotal = 0;
  private revokedTotal = 0;

  constructor(private readonly config: AffectConfig['exhausted']) {}

  get armed(): boolean {
    return this.armedNow;
  }

  /** Times the hint was armed this session (affect_summary.exhaustedArmed). */
  get armedCount(): number {
    return this.armedTotal;
  }

  /** Times real content cancelled an armed hint (affect_summary.exhaustedRevoked). */
  get revokedCount(): number {
    return this.revokedTotal;
  }

  /** Every user final. `light` marks a whole-utterance light reply; short lines are detected here. */
  onFinal(text: string, light: boolean, declinePhrases: readonly string[]): void {
    // A cooldown of N blocks the next N finals (spec §4): this final uses one step and may not arm.
    const cooling = this.cooldown > 0;
    if (cooling) this.cooldown -= 1;
    if (declinePhrases.some((phrase) => containsPhrase(text, phrase))) {
      this.cooldown = this.config.declineCooldownTurns;
      this.shortStreak = 0;
      this.armedNow = false;
      return;
    }
    const short = light || contentLength(text) <= this.config.shortMaxChars;
    if (!short) {
      this.shortStreak = 0;
      if (this.armedNow) {
        this.armedNow = false;
        this.revokedTotal += 1;
      }
      return;
    }
    if (this.armedNow) {
      // The hint was live for this short answer's reply: drop it and cool down.
      this.armedNow = false;
      this.shortStreak = 0;
      this.cooldown = this.config.cooldownTurns;
      return;
    }
    this.shortStreak += 1;
    if (!cooling && this.shortStreak >= this.config.shortStreakTrigger - 1) this.tryArm();
  }

  /** Every accepted card. A low card disarms; topic_exhausted arms early. */
  onCard(card: AffectCard, low: boolean): void {
    this.low = low;
    if (low) {
      this.armedNow = false;
      return;
    }
    if (card.need === 'topic_exhausted') this.tryArm();
  }

  /** Forget/decline: drop the streak and any armed hint. Cooldown and counters stay. */
  reset(): void {
    this.shortStreak = 0;
    this.low = false;
    this.armedNow = false;
  }

  private tryArm(): void {
    if (this.armedNow || this.cooldown > 0 || this.low) return;
    this.armedNow = true;
    this.armedTotal += 1;
  }
}
