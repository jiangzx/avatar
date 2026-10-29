import { describe, expect, it } from 'vitest';
import { findUngrounded, mentionsMaterial } from '../src/session/proactive/grounding.ts';

describe('findUngrounded', () => {
  const material = ['我后天上午要去医院复查腰，心里有点打鼓。'];

  it('passes a line that only reuses the material', () => {
    expect(findUngrounded('陈叔，明天就去复查腰了吧？别太打鼓。', material)).toEqual({ titles: [], numbers: [] });
  });

  it('flags quoted titles and numbers that are not in the material', () => {
    expect(findUngrounded('复查完去听《锁麟囊》吧，九点出门，带上2号的单子。', material)).toEqual({ titles: ['锁麟囊'], numbers: ['九点', '2'] });
  });

  it('keeps titles and numbers that the material itself has', () => {
    expect(findUngrounded('您说过「复查腰」，三天后就知道结果了。', ['医生让我三天后来拿「复查腰」的片子'])).toEqual({ titles: [], numbers: [] });
  });

  it('does not treat common words with 一 as numbers', () => {
    expect(findUngrounded('我一直记着呢，咱们一起等结果。', material)).toEqual({ titles: [], numbers: [] });
  });
});

describe('mentionsMaterial', () => {
  it('needs at least two shared CJK bigrams with one material line', () => {
    expect(mentionsMaterial('明天去医院复查吗？', ['我后天上午要去医院复查腰'])).toBe(true);
    expect(mentionsMaterial('今天天气真好。', ['我后天上午要去医院复查腰'])).toBe(false);
    expect(mentionsMaterial('今天天气真好。', [])).toBe(false);
  });
});
