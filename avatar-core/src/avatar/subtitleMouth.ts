import type { MouthShape } from '../audio/mouth.ts';

/** One spoken character. Tuned so a burst of subtitle text lasts about as long as speech. */
export const SUBTITLE_CHAR_MS = 180;

const PAUSE = new Set('，。！？、；：…,.!?;');

const OPEN: MouthShape = { jawOpen: 0.72, funnel: 0.08, stretch: 0.12 };
const ROUND: MouthShape = { jawOpen: 0.42, funnel: 0.55, stretch: 0 };
const SPREAD: MouthShape = { jawOpen: 0.34, funnel: 0.02, stretch: 0.62 };
const CLOSED: MouthShape = { jawOpen: 0, funnel: 0, stretch: 0 };

/** Approximate a spoken shape. Chinese has no phonemes here, so characters take turns. */
export function mouthForChar(ch: string): MouthShape {
  if (PAUSE.has(ch)) return CLOSED;
  const code = ch.codePointAt(0) ?? 0;
  const kind = code % 3;
  if (kind === 0) return OPEN;
  if (kind === 1) return ROUND;
  return SPREAD;
}

/** Plays assistant subtitle text one character at a time. */
export class SubtitleMouth {
  private seen = '';
  private queue: string[] = [];
  private wait = 0;

  get pending(): boolean {
    return this.queue.length > 0;
  }

  /** Append newly arrived subtitle text and speak a character when the previous slot has elapsed. */
  feed(text: string): MouthShape | null {
    const extra = text.startsWith(this.seen) ? text.slice(this.seen.length) : text;
    if (!text.startsWith(this.seen)) {
      this.queue = [];
      this.wait = 0;
    }
    this.seen = text;
    for (const ch of extra) {
      if (ch.trim() !== '') this.queue.push(ch);
    }
    return this.poll(0);
  }

  /** Advance by dt milliseconds. Returns a shape only when a new character starts. */
  poll(dtMs: number): MouthShape | null {
    if (this.queue.length === 0) return null;
    this.wait = Math.max(0, this.wait - dtMs);
    if (this.wait > 0) return null;
    const ch = this.queue.shift() ?? '';
    this.wait = SUBTITLE_CHAR_MS;
    return mouthForChar(ch);
  }

  reset(): void {
    this.seen = '';
    this.queue = [];
    this.wait = 0;
  }
}
