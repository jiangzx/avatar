import { describe, expect, it } from 'vitest';
import { isMemoryEvidence } from '../src/memory/evidence.ts';

const patterns = ['我什么时候', '上次聊到', '聊到哪', '上次咱们'];

describe('memory evidence', () => {
  it('rejects recall questions with or without a question mark', () => {
    expect(isMemoryEvidence('上次聊到哪儿了。', patterns)).toBe(false);
    expect(isMemoryEvidence('上次聊到哪儿了？', patterns)).toBe(false);
    expect(isMemoryEvidence('上次咱们聊过什么？', patterns)).toBe(false);
  });

  it('keeps a declarative user statement', () => {
    expect(isMemoryEvidence('我记得我之前看过一部电影叫咒怨。', patterns)).toBe(true);
  });

  it('drops a light acknowledgement only when it is the whole utterance', () => {
    const skip = ['我什么时候'];
    const light = ['好的', '我知道了'];
    expect(isMemoryEvidence('好的', skip, light)).toBe(false);
    expect(isMemoryEvidence('好的。', skip, light)).toBe(false);
    expect(isMemoryEvidence('好的，我平时喜欢听京剧。', skip, light)).toBe(true);
    expect(isMemoryEvidence('我知道了，我孙子在上大学。', skip, light)).toBe(true);
  });

  it('rejects questions whose question mark was dropped', () => {
    expect(isMemoryEvidence('你吃饭了吗。', patterns)).toBe(false);
    expect(isMemoryEvidence('上次那个电影叫什么来着。', patterns)).toBe(false);
  });
});
