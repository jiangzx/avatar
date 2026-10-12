import { describe, expect, it } from 'vitest';
import { SubtitleTracker } from '../src/subtitles.ts';

describe('SubtitleTracker', () => {
  it('accumulates deltas per response', () => {
    const t = new SubtitleTracker();
    expect(t.onDelta(1, '你好')).toBe('你好');
    expect(t.onDelta(1, '呀')).toBe('你好呀');
    expect(t.onDelta(2, '嗯')).toBe('嗯');
  });

  it('truncates to what was heard and then freezes', () => {
    const t = new SubtitleTracker();
    t.onDelta(1, '一二三四五六七八九十');
    t.onAudio(1, 24000); // 1000 ms received
    expect(t.truncate(1, 500)).toBe('一二三四五');
    expect(t.onDelta(1, '后面的')).toBeNull();
    expect(t.truncate(1, 900)).toBe('一二三四五'); // second cancel signal keeps the first result
  });

  it('reset() lets a new session reuse sequence numbers', () => {
    const t = new SubtitleTracker();
    t.onDelta(1, '旧会话');
    t.truncate(1, 0);
    t.reset();
    expect(t.onDelta(1, '新会话')).toBe('新会话');
  });
});
