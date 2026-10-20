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
});
