import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSharedEmotion } from '../src/i18n/emotion.ts';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import { EmotionTagger, tagEmotion, type Emotion, type EmotionConfig } from '../src/session/emotion.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cfg: EmotionConfig = {
  defaultEmotion: 'happy', debounceMs: 1500, revertAfterMs: 6000, firstSentenceMaxChars: 20,
  priority: ['sad', 'love', 'happy'],
  lexicon: { neutral: [], happy: ['开心', '高兴'], sad: ['难过', '孤单'], love: ['想你', '谢谢你'] },
};

describe('tagEmotion', () => {
  it('maps text to the highest-priority matching emotion', () => {
    expect(tagEmotion('今天真开心', cfg)).toBe('happy');
    expect(tagEmotion('开心是开心，就是有点孤单', cfg)).toBe('sad');
    expect(tagEmotion('谢谢你陪我', cfg)).toBe('love');
    expect(tagEmotion('吃了碗面', cfg)).toBeNull();
  });

  it('ships a valid merged lexicon config', () => {
    const shipped = DEFAULT_I18N.emotion;
    expect(tagEmotion('我今天有点难过', shipped)).toBe('sad');
    expect(tagEmotion('我今天特别开心', shipped)).toBe('happy');
    expect(tagEmotion('孙子可疼我了', shipped)).toBe('love');
    expect(tagEmotion('我心里难过', shipped)).toBe('sad');
    // Shared config keeps timing only; every language pack contributes words.
    expect(loadSharedEmotion(`${root}config/emotion.json`).lexicon).toBeUndefined();
    expect(shipped.lexicon.sad.some((word) => word.includes('悲'))).toBe(true);
    expect(shipped.lexicon.sad).toContain('sad');
  });
});

describe('EmotionTagger', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function make() {
    const out: Emotion[] = [];
    const t = new EmotionTagger(cfg, (e) => out.push(e), () => Date.now());
    return { t, out };
  }

  it('tags the user final transcript, then reverts to the default', () => {
    const { t, out } = make();
    t.onUserFinal('我有点难过');
    expect(out).toEqual(['sad']);
    vi.advanceTimersByTime(6000);
    expect(out).toEqual(['sad', 'happy']);
  });

  it('debounces changes that come too quickly', () => {
    const { t, out } = make();
    t.onUserFinal('我有点难过');
    vi.advanceTimersByTime(500);
    t.onUserFinal('谢谢你');
    expect(out).toEqual(['sad']);
    vi.advanceTimersByTime(1000);
    t.onUserFinal('谢谢你');
    expect(out).toEqual(['sad', 'love']);
  });

  it('tags an assistant reply once, from its first sentence only', () => {
    const { t, out } = make();
    t.onResponseStart(1);
    t.onAssistantDelta(1, '听您这么说我也');
    expect(out).toEqual([]);
    t.onAssistantDelta(1, '挺难过的。不过明天会开心');
    expect(out).toEqual(['sad']);
    vi.advanceTimersByTime(2000);
    t.onAssistantDelta(1, '的！真高兴');
    expect(out).toEqual(['sad']);
  });

  it('stops timers on dispose', () => {
    const { t, out } = make();
    t.onUserFinal('我有点难过');
    t.dispose();
    vi.advanceTimersByTime(10_000);
    expect(out).toEqual(['sad']);
  });
});
