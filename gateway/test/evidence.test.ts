import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadI18n } from '../src/i18n/load.ts';
import { isMemoryEvidence, type EvidenceRules } from '../src/memory/evidence.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const i18n = loadI18n(`${root}config`);
const rules = i18n.evidence;

const patterns = ['我什么时候', '上次聊到', '聊到哪', '上次咱们'];
const zh = (skipPatterns: readonly string[] = patterns, lightAcks: readonly string[] = []): EvidenceRules => ({
  questionPatterns: rules.questionPatterns,
  skipPatterns,
  lightAcks,
});

describe('memory evidence', () => {
  it('rejects recall questions with or without a question mark', () => {
    expect(isMemoryEvidence('上次聊到哪儿了。', zh())).toBe(false);
    expect(isMemoryEvidence('上次聊到哪儿了？', zh())).toBe(false);
    expect(isMemoryEvidence('上次咱们聊过什么？', zh())).toBe(false);
  });

  it('keeps a declarative user statement', () => {
    expect(isMemoryEvidence('我记得我之前看过一部电影叫咒怨。', zh())).toBe(true);
  });

  it('drops a light acknowledgement only when it is the whole utterance', () => {
    const skip = zh(['我什么时候'], ['好的', '我知道了']);
    expect(isMemoryEvidence('好的', skip)).toBe(false);
    expect(isMemoryEvidence('好的。', skip)).toBe(false);
    expect(isMemoryEvidence('好的，我平时喜欢听京剧。', skip)).toBe(true);
    expect(isMemoryEvidence('我知道了，我孙子在上大学。', skip)).toBe(true);
  });

  it('rejects questions whose question mark was dropped', () => {
    expect(isMemoryEvidence('你吃饭了吗。', zh())).toBe(false);
    expect(isMemoryEvidence('上次那个电影叫什么来着。', zh())).toBe(false);
  });

  it('rejects ja/en questions but keeps statements', () => {
    expect(isMemoryEvidence('お茶が好きだと言いましたか', rules)).toBe(false);
    expect(isMemoryEvidence('Did I say I like tea?', rules)).toBe(false);
    expect(isMemoryEvidence('Did I say I like tea', rules)).toBe(false);
    expect(isMemoryEvidence('私は毎朝お茶を飲みます。', rules)).toBe(true);
    expect(isMemoryEvidence('I like watching old movies.', rules)).toBe(true);
  });

  it('drops whole-utterance ja/en acknowledgements only', () => {
    expect(isMemoryEvidence('はい', rules)).toBe(false);
    expect(isMemoryEvidence('okay', rules)).toBe(false);
    expect(isMemoryEvidence('はい、私はお茶が好きです。', rules)).toBe(true);
    expect(isMemoryEvidence('Okay, I like tea.', rules)).toBe(true);
  });

  it('drops case-insensitive English whole-utterance acks', () => {
    expect(isMemoryEvidence('Okay', rules)).toBe(false);
    expect(isMemoryEvidence('Yes', rules)).toBe(false);
    expect(isMemoryEvidence('Okay, I like tea.', rules)).toBe(true);
  });

  it('does only the question-mark check when no rules are configured', () => {
    expect(isMemoryEvidence('你吃饭了吗。')).toBe(true);
    expect(isMemoryEvidence('你吃饭了吗？')).toBe(false);
    expect(isMemoryEvidence('   ')).toBe(false);
  });
});
