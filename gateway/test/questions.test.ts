import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEvalConfig } from '../src/eval/harness.ts';
import { countQuestions, isQuestion, splitSentences, stripQuoted } from '../src/eval/questions.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const rule = loadEvalConfig(`${root}config/eval.json`).question;

describe('question rule (gateway/config/eval.json)', () => {
  it.each([
    ['您吃饭了吗？', true],
    ['您吃饭了吗', true],
    ['是么。', true],
    ['您在想什么呢', true],
    ['是不是累了呢。', true],
    ['我在呢。', false],
    ['您再给我讲讲嘛', false],
    ['好的！', false],
    ['真好呀～', false],
  ])('%s → %s', (sentence, expected) => {
    expect(isQuestion(sentence, rule)).toBe(expected);
  });

  it('ignores quoted speech', () => {
    expect(stripQuoted('他问「你吃了吗？」我笑了。', rule)).toBe('他问我笑了。');
    expect(countQuestions('他问「你吃了吗？」我笑了。', rule)).toEqual({ sentences: 1, questions: 0 });
  });

  it('splits on sentence punctuation and counts per sentence', () => {
    expect(splitSentences('这样啊，挺好的。今天冷不冷？多穿点！')).toEqual(['这样啊，挺好的。', '今天冷不冷？', '多穿点！']);
    expect(countQuestions('这样啊，挺好的。今天冷不冷？多穿点！', rule)).toEqual({ sentences: 3, questions: 1 });
    expect(countQuestions('', rule)).toEqual({ sentences: 0, questions: 0 });
  });
});
