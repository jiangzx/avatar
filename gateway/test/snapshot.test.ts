import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../src/session/instructions.ts';
import { renderMemoryViews, renderSnapshot } from '../src/memory/snapshot.ts';

describe('renderSnapshot', () => {
  it('puts the addressing name ahead of a preference, a note, and the tail', () => {
    const text = renderSnapshot({
      facts: [
        { category: 'preference', text: '喜欢喝茶' },
        { category: 'addressing', text: '称呼：王叔' },
      ],
      notes: [{ text: '说话慢一点' }],
      tail: [{ role: 'user', text: '昨天去了公园' }, { role: 'assistant', text: '公园空气好' }],
      maxChars: 200,
    });
    expect(text).toBe('称呼：王叔\n事实：喜欢喝茶\n关系：说话慢一点\n用户：昨天去了公园\n助手：公园空气好');
  });

  it('clips at line boundaries and keeps the name whole when the budget fits the name', () => {
    const name = '称呼：王叔';
    const text = renderSnapshot({
      facts: [
        { category: 'preference', text: '喜欢喝茶' },
        { category: 'addressing', text: name },
      ],
      notes: [],
      tail: [{ role: 'user', text: '昨天去了公园' }],
      maxChars: name.length + 2,
    });
    expect(text).toBe(name);
    expect(text.length).toBeLessThanOrEqual(name.length + 2);
  });

  it('keeps every addressing fact when they exceed the budget', () => {
    const text = renderSnapshot({
      facts: [
        { category: 'preference', text: '喜欢喝茶' },
        { category: 'addressing', text: '称呼：王叔' },
        { category: 'addressing', text: '也叫王先生' },
      ],
      notes: [],
      tail: [{ role: 'user', text: '昨天去了公园' }],
      maxChars: 2,
    });
    expect(text).toBe('称呼：王叔\n也叫王先生');
  });

  it('keeps the previous discussion ahead of other facts within the budget', () => {
    const name = '称呼：王叔';
    const summary = '聊过公园散步和出门添衣';
    const text = renderSnapshot({
      facts: [{ category: 'addressing', text: name }, { category: 'preference', text: 'x'.repeat(100) }],
      episode: { summary }, notes: [], tail: [], maxChars: 60,
    });
    expect(text.startsWith(name)).toBe(true);
    expect(text).toContain(summary);
    expect(text).not.toContain('x');
    expect(text.length).toBeLessThanOrEqual(60);
  });

  it('omits an episode that cannot fit without cutting the name', () => {
    const text = renderSnapshot({
      facts: [{ category: 'addressing', text: '称呼：王叔' }],
      episode: { summary: 'x'.repeat(100) }, notes: [], tail: [], maxChars: 10,
    });
    expect(text).toBe('称呼：王叔');
  });

  it('returns an empty string when there is nothing to remember', () => {
    expect(renderSnapshot({ facts: [], notes: [], tail: [], maxChars: 600 })).toBe('');
  });

  it('keeps the newest tail line and drops the oldest when the tail exceeds the budget', () => {
    const addressing = '称呼：王叔';
    const newest = '用户：刚刚说的';
    const text = renderSnapshot({
      facts: [{ category: 'addressing', text: addressing }],
      notes: [],
      tail: [
        { role: 'user', text: '很久以前的那句话呀' },
        { role: 'user', text: '刚刚说的' },
      ],
      maxChars: addressing.length + 1 + newest.length,
    });
    expect(text).toBe(`${addressing}\n${newest}`);
  });

  it('keeps facts and notes ahead of the newest tail that still fits', () => {
    const text = renderSnapshot({
      facts: [
        { category: 'addressing', text: '称呼：王叔' },
        { category: 'preference', text: '喜欢喝茶' },
      ],
      notes: [{ text: '说话慢一点' }],
      tail: [
        { role: 'user', text: '很久以前的那句话呀' },
        { role: 'assistant', text: '刚刚这句' },
      ],
      maxChars: '称呼：王叔\n事实：喜欢喝茶\n关系：说话慢一点\n助手：刚刚这句'.length,
    });
    expect(text).toBe('称呼：王叔\n事实：喜欢喝茶\n关系：说话慢一点\n助手：刚刚这句');
  });

  it('starts the instructions memory section with the name', () => {
    const snapshot = renderSnapshot({
      facts: [
        { category: 'preference', text: '喜欢喝茶' },
        { category: 'addressing', text: '称呼：王叔' },
      ],
      notes: [],
      tail: [{ role: 'user', text: '昨天去了公园' }],
      maxChars: 600,
    });
    const text = buildInstructions(
      { persona: 'P', memorySnapshot: snapshot, summary: 'S', recent: [] },
      { totalChars: 1000, snapshotMaxChars: 600, summaryMaxChars: 100 },
    );
    expect(text.split('## 记忆参考（可能不准确，注意「用户」与「助手」的区别）\n\n')[1]?.startsWith('称呼：王叔')).toBe(true);
  });

  it('renders a legacy self-introduction as a short addressing label', () => {
    const text = renderSnapshot({
      facts: [{ category: 'addressing', text: '用户名叫王叔' }],
      notes: [],
      tail: [],
      maxChars: 200,
    });
    expect(text).toBe('称呼：王叔');
  });
});

describe('renderMemoryViews', () => {
  const views = renderMemoryViews({
    addressing: ['称呼：王叔'],
    facts: ['喜欢喝茶'],
    tail: [
      { role: 'user', text: '上次聊过电影吗？' },
      { role: 'user', text: '我什么时候说喜欢喝茶？' },
      { role: 'user', text: '昨天去了公园' },
      { role: 'assistant', text: '公园空气好' },
    ],
    maxChars: 600,
  });

  it('keeps the full view to user statements only', () => {
    expect(views.full).toBe('称呼：王叔\n事实：喜欢喝茶\n用户：昨天去了公园');
    expect(views.full).not.toContain('公园空气好');
    expect(views.full).not.toContain('上次聊过电影吗');
    expect(views.full).not.toContain('我什么时候说喜欢喝茶');
  });

  it('removes the tail for greetings and the name for proactive lines', () => {
    expect(views.greeting).toBe('称呼：王叔\n事实：喜欢喝茶');
    expect(views.proactive).toBe('事实：喜欢喝茶');
    expect(views.hasTopic).toBe(true);
  });

  it('marks a name-only greeting as having no topic', () => {
    const nameOnly = renderMemoryViews({
      addressing: ['称呼：王叔'],
      facts: [],
      tail: [{ role: 'user', text: '昨天去了公园' }],
      maxChars: 600,
    });
    expect(nameOnly.greeting).toBe('称呼：王叔');
    expect(nameOnly.hasTopic).toBe(false);
  });
});
