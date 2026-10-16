import { describe, expect, it } from 'vitest';
import { SUBTITLE_CHAR_MS, SubtitleMouth, mouthForChar } from '../src/avatar/subtitleMouth.ts';

describe('SubtitleMouth', () => {
  it('opens on the first character and waits before the next', () => {
    const mouth = new SubtitleMouth();
    const first = mouth.feed('你');
    expect(first?.jawOpen).toBeGreaterThan(0.3);
    mouth.feed('你啊');
    expect(mouth.poll(SUBTITLE_CHAR_MS - 1)).toBeNull();
    const second = mouth.poll(1);
    expect(second).not.toBeNull();
    expect(second).not.toEqual(first);
  });

  it('closes on punctuation and ignores repeated text', () => {
    expect(mouthForChar('。')).toEqual({ jawOpen: 0, funnel: 0, stretch: 0 });
    const mouth = new SubtitleMouth();
    mouth.feed('好。');
    expect(mouth.poll(SUBTITLE_CHAR_MS)).toEqual({ jawOpen: 0, funnel: 0, stretch: 0 });
    expect(mouth.feed('好。')).toBeNull();
  });

  it('starts over when the subtitle is replaced', () => {
    const mouth = new SubtitleMouth();
    mouth.feed('你好');
    const restarted = mouth.feed('嗯');
    expect(restarted?.jawOpen).toBeGreaterThan(0);
    expect(mouth.pending).toBe(false);
  });
});
