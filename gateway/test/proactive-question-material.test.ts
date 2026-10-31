import { describe, expect, it } from 'vitest';
import type { EvidenceRules } from '../src/memory/evidence.ts';
import type { AgentFactRow, PinnedRow, ProfileFactRow, ThreadRecord } from '../src/memory/store.ts';
import type { IntentCopy } from '../src/roles/types.ts';
import {
  factChoices,
  pickMemoryMaterial,
  pickQuestionMaterial,
  pickTopicMaterial,
  statementKey,
  type FactChoice,
  type MemoryMaterialInput,
} from '../src/session/proactive/questionMaterial.ts';

const NOW = Date.parse('2026-11-03T08:30:00+08:00');
const DAY = 86_400_000;
const evidence: EvidenceRules = { questionPatterns: [], skipPatterns: ['没说过'], lightAcks: ['好的'] };
const saidWords: IntentCopy['saidWhen'] = {
  justNow: '刚才', today: '今天', yesterday: '昨天',
  days: ['前天', '三天前', '四天前', '五天前', '六天前'], lastWeek: '上周', earlier: '之前',
};
const rules = {
  switchPhrases: ['换个话题'],
  topicDeclinePhrases: ['不感兴趣'],
  factKeywords: ['喜欢', '茶', '花', '家里'],
  factBlockKeywords: ['病', '医院', '年龄'],
};

const thread = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: 't1', kind: 'concern', quote: '我最近喜欢上了听戏。', dueAt: NOW, sensitive: false,
  mentionCount: 0, lastMentionedAt: null, createdAt: NOW - 2 * DAY, sourceSessionId: 's1', ...over,
});
const fact = (over: Partial<FactChoice> = {}): FactChoice => ({
  id: 'f1', text: '老人喜欢喝茶。', category: 'preference', source: 'fact', sensitive: false, ...over,
});
const input = (over: Partial<MemoryMaterialInput> = {}): MemoryMaterialInput => ({
  now: NOW,
  threads: [],
  facts: [],
  statements: [],
  avoided: new Set(),
  healthWords: ['医院', '血压'],
  evidence,
  rules,
  factCategories: ['preference', 'person', 'other', 'profile'],
  saidWords,
  minStatementChars: 5,
  mentioned: new Set(),
  ...over,
});

describe('statementKey', () => {
  it('is stable across whitespace and punctuation differences, and hides the text', () => {
    expect(statementKey('我今天去了公园。')).toBe(statementKey('  我今天去了公园  '));
    expect(statementKey('我今天去了公园。')).not.toBe(statementKey('我昨天去了公园。'));
    expect(statementKey('我今天去了公园。')).toMatch(/^stmt:[0-9a-f]{64}$/);
    expect(statementKey('我今天去了公园。')).not.toContain('公园');
  });
});

describe('factChoices', () => {
  it('keeps profile rows, pins and agent facts, and drops addressing', () => {
    const profile: ProfileFactRow[] = [
      { id: 'p1', category: 'addressing', text: '称呼：张阿姨' },
      { id: 'p2', category: 'profile', text: '老人喜欢养花。' },
    ];
    const pins: PinnedRow[] = [{ id: 'pin1', text: '老人喜欢听老歌。', sensitive: false, createdAt: NOW }];
    const facts: AgentFactRow[] = [{ id: 'a1', category: 'person', text: '老人有个孙女。', sensitive: false }];
    expect(factChoices(profile, facts, pins)).toEqual([
      { id: 'p2', text: '老人喜欢养花。', category: 'profile', source: 'fact', sensitive: false },
      { id: 'pin1', text: '老人喜欢听老歌。', category: 'pin', source: 'pin', sensitive: false },
      { id: 'a1', text: '老人有个孙女。', category: 'person', source: 'fact', sensitive: false },
    ]);
  });
});

describe('pickMemoryMaterial', () => {
  it('prefers an open thread quote over facts and statements', () => {
    const got = pickMemoryMaterial(input({
      threads: [thread()],
      facts: [fact()],
      statements: [{ text: '我今天去了公园。', saidAt: NOW - DAY }],
    }));
    expect(got).toMatchObject({ source: 'memory', form: 'quote', key: 'thread:t1', said: '前天' });
  });

  it('skips sensitive, mentioned, avoided and health threads', () => {
    expect(pickMemoryMaterial(input({ threads: [thread({ sensitive: true })], facts: [fact()] }))).toMatchObject({ key: 'fact:f1' });
    expect(pickMemoryMaterial(input({ threads: [thread()], mentioned: new Set(['t1']) }))).toBeNull();
    expect(pickMemoryMaterial(input({ threads: [thread()], avoided: new Set(['thread:t1']) }))).toBeNull();
    expect(pickMemoryMaterial(input({ threads: [thread({ quote: '我最近总去医院。' })] }))).toBeNull();
    expect(pickMemoryMaterial(input({ threads: [thread({ quote: '我最近喜欢听戏吗？' })] }))).toBeNull();
  });

  it('selects topic-like facts only', () => {
    // preference without a keyword is allowed by category
    expect(pickMemoryMaterial(input({ facts: [fact({ text: '老人喜欢散步。' })] }))).toMatchObject({ key: 'fact:f1', form: 'topic' });
    // profile / other / pins need a keyword
    expect(pickMemoryMaterial(input({ facts: [fact({ category: 'profile', text: '老人住在北京。' })] }))).toBeNull();
    expect(pickMemoryMaterial(input({ facts: [fact({ category: 'profile', text: '老人喜欢养花。' })] }))).toMatchObject({ key: 'fact:f1' });
    expect(pickMemoryMaterial(input({ facts: [fact({ category: 'other', text: '老人每天买菜。' })] }))).toBeNull();
    expect(pickMemoryMaterial(input({ facts: [fact({ source: 'pin', category: 'pin', text: '老人喜欢听老歌。' })] }))).toMatchObject({ key: 'pin:f1' });
    // sensitive / health / blocked / category not allowed
    expect(pickMemoryMaterial(input({ facts: [fact({ sensitive: true })] }))).toBeNull();
    expect(pickMemoryMaterial(input({ facts: [fact({ text: '老人喜欢去医院。' })] }))).toBeNull();
    expect(pickMemoryMaterial(input({ facts: [fact({ text: '老人喜欢聊年龄。' })] }))).toBeNull();
    expect(pickMemoryMaterial(input({ facts: [fact({ category: 'health' })] }))).toBeNull();
    expect(pickMemoryMaterial(input({ facts: [fact({ category: 'safety' })] }))).toBeNull();
  });

  it('falls back to recent statements and filters length, questions and avoidance', () => {
    expect(pickMemoryMaterial(input({ statements: [{ text: '我今天去了公园。', saidAt: NOW - 3 * DAY }] })))
      .toMatchObject({ key: statementKey('我今天去了公园。'), form: 'quote', said: '三天前' });
    expect(pickMemoryMaterial(input({ statements: [{ text: '好', saidAt: NOW }] }))).toBeNull();
    expect(pickMemoryMaterial(input({ statements: [{ text: '我今天去了公园吗？', saidAt: NOW }] }))).toBeNull();
    expect(pickMemoryMaterial(input({ statements: [{ text: '我今天去了公园。', saidAt: NOW }], avoided: new Set([statementKey('我今天去了公园。')]) }))).toBeNull();
  });

  it('returns null when nothing usable exists', () => {
    expect(pickMemoryMaterial(input())).toBeNull();
  });
});

describe('pickTopicMaterial', () => {
  const topics = [
    { id: 'a', prompt: '甲', fallbackText: '甲' },
    { id: 'b', prompt: '乙', fallbackText: '乙' },
    { id: 'c', prompt: '丙', fallbackText: '丙' },
  ];

  it('skips avoided cards and uses the longest-unused card', () => {
    const got = pickTopicMaterial(topics, new Set(['card:a']), [1]);
    expect(got?.exhausted).toBe(false);
    expect(got?.material.cardIndex).not.toBe(0);
    expect(got?.material.key).toMatch(/^card:/);
  });

  it('reuses a card and flags exhaustion when every card is avoided', () => {
    const got = pickTopicMaterial(topics, new Set(['card:a', 'card:b', 'card:c']), []);
    expect(got?.exhausted).toBe(true);
    expect(got?.material.key).toMatch(/^card:/);
  });

  it('returns null for an empty pool', () => {
    expect(pickTopicMaterial([], new Set(), [])).toBeNull();
  });
});

describe('pickQuestionMaterial', () => {
  const memory = { source: 'memory', form: 'topic', text: '记得', said: null, key: 'fact:f1', cardIndex: null } as const;
  const topic = {
    material: { source: 'card', form: 'topic', text: '话题', said: null, key: 'card:a', cardIndex: 0 } as const,
    exhausted: false,
  };

  it('uses memory when there is no topic card', () => {
    let calls = 0;
    const got = pickQuestionMaterial({ random: () => { calls++; return 0.9; }, memoryRatio: 70, memory, topic: null });
    expect(got?.material.key).toBe('fact:f1');
    expect(calls).toBe(0);
  });

  it('uses the topic card when there is no memory', () => {
    let calls = 0;
    const got = pickQuestionMaterial({ random: () => { calls++; return 0; }, memoryRatio: 70, memory: null, topic });
    expect(got?.material.key).toBe('card:a');
    expect(calls).toBe(0);
  });

  it('rolls exactly once when both exist', () => {
    let calls = 0;
    const fixed = (value: number) => () => { calls++; return value; };
    expect(pickQuestionMaterial({ random: fixed(0.0), memoryRatio: 70, memory, topic })?.material.key).toBe('fact:f1');
    expect(calls).toBe(1);
    calls = 0;
    expect(pickQuestionMaterial({ random: fixed(0.99), memoryRatio: 70, memory, topic })?.material.key).toBe('card:a');
    expect(calls).toBe(1);
    expect(pickQuestionMaterial({ random: fixed(0.0), memoryRatio: 0, memory, topic })?.material.key).toBe('card:a');
    expect(pickQuestionMaterial({ random: fixed(0.99), memoryRatio: 100, memory, topic })?.material.key).toBe('fact:f1');
  });
});
