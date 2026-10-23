import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import { AffectTracker, loadAffectConfig, type AffectCard } from '../src/session/affect.ts';
import { TopicExhaustion } from '../src/session/topicExhaustion.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const exhausted = { shortMaxChars: 4, shortStreakTrigger: 2, cooldownTurns: 4, declineCooldownTurns: 10 };
const decline = ['算了', '不想聊这个'];
const card = (over: Partial<AffectCard> = {}): AffectCard => ({
  emotion: 'neutral', intensity: 1, trend: 'flat', need: 'chat', strategy: 'ask', mismatch: false, crisis: false, ...over,
});

describe('TopicExhaustion', () => {
  it('arms after the first short answer and cools down once the second one used it', () => {
    const t = new TopicExhaustion(exhausted);
    t.onFinal('嗯', true, decline);
    expect(t.armed).toBe(true);
    t.onFinal('还行', false, decline);
    expect(t.armed).toBe(false);
    // cooldownTurns = 4 blocks exactly the next four finals.
    for (let i = 0; i < 4; i++) {
      t.onFinal('还行', false, decline);
      expect(t.armed).toBe(false);
    }
    t.onFinal('还行', false, decline);
    expect(t.armed).toBe(true);
    expect(t.armedCount).toBe(2);
    expect(t.revokedCount).toBe(0);
  });

  it('revokes on real content, counts it, and can arm again', () => {
    const t = new TopicExhaustion(exhausted);
    t.onFinal('嗯', true, decline);
    t.onFinal('我下午去公园看人下棋了', false, decline);
    expect(t.armed).toBe(false);
    expect(t.revokedCount).toBe(1);
    t.onFinal('好吧', false, decline);
    expect(t.armed).toBe(true);
    expect(t.armedCount).toBe(2);
  });

  it('ignores spaces and punctuation when it measures a short answer', () => {
    const a = new TopicExhaustion(exhausted);
    a.onFinal('嗯……。', false, decline);
    expect(a.armed).toBe(true);
    const b = new TopicExhaustion(exhausted);
    b.onFinal('Yes.', false, decline);
    expect(b.armed).toBe(true);
    const c = new TopicExhaustion(exhausted);
    c.onFinal('Not really sure.', false, decline);
    expect(c.armed).toBe(false);
  });

  it('cools down for ten finals after a decline and does not count it as revoked', () => {
    const t = new TopicExhaustion(exhausted);
    t.onFinal('嗯', true, decline);
    t.onFinal('算了吧', false, decline);
    expect(t.armed).toBe(false);
    // declineCooldownTurns = 10 blocks exactly the next ten finals.
    for (let i = 0; i < 10; i++) {
      t.onFinal('嗯', true, decline);
      expect(t.armed).toBe(false);
    }
    t.onFinal('嗯', true, decline);
    expect(t.armed).toBe(true);
    expect(t.revokedCount).toBe(0);
  });

  it('never arms while the latest card is low, and a low or crisis card disarms', () => {
    const t = new TopicExhaustion(exhausted);
    t.onCard(card({ emotion: 'sad', intensity: 3 }), true);
    t.onFinal('嗯', true, decline);
    expect(t.armed).toBe(false);
    t.onCard(card(), false);
    expect(t.armed).toBe(false);
    t.onFinal('嗯', true, decline);
    expect(t.armed).toBe(true);
    t.onCard(card({ emotion: 'sad', intensity: 3, crisis: true }), true);
    expect(t.armed).toBe(false);
  });

  it('arms on a topic_exhausted card unless it is cooling down', () => {
    const t = new TopicExhaustion(exhausted);
    t.onCard(card({ need: 'topic_exhausted' }), false);
    expect(t.armed).toBe(true);
    t.onFinal('还行', false, decline);
    expect(t.armed).toBe(false);
    t.onCard(card({ need: 'topic_exhausted' }), false);
    expect(t.armed).toBe(false);
    expect(t.armedCount).toBe(1);
  });
});

describe('AffectTracker topic exhaustion', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const config = loadAffectConfig(`${root}config/affect.json`);
  const json = (over: Record<string, unknown> = {}) => JSON.stringify({
    emotion: 'neutral', intensity: 1, trend: 'flat', need: 'topic_exhausted', strategy: 'disclose', mismatch: false, crisis: false, ...over,
  });
  function make(reply: () => string) {
    const cards: AffectCard[] = [];
    const tracker = new AffectTracker({
      client: { complete: async () => reply() },
      config,
      prompt: () => 'AFFECT',
      history: () => [],
      evidence: DEFAULT_I18N.evidence,
      safety: DEFAULT_I18N.safety,
      onCard: (accepted) => cards.push(accepted),
      declinePhrases: (language) => DEFAULT_I18N.affect[language].declinePhrases,
    });
    return { tracker, cards };
  }

  it('arms on a short answer, revokes on content, re-arms on a topic_exhausted card, and counts both', async () => {
    const { tracker, cards } = make(() => json());
    expect(tracker.exhaustedArmed).toBe(false);
    tracker.onLightFinal('嗯', 'zh');
    expect(tracker.exhaustedArmed).toBe(true);
    tracker.onUserFinal('我下午去公园看人下棋了', 'zh');
    expect(tracker.exhaustedArmed).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(cards).toHaveLength(1);
    expect(tracker.exhaustedArmed).toBe(true);
    expect(tracker.summary()).toMatchObject({ exhaustedArmed: 2, exhaustedRevoked: 1 });
    tracker.dispose();
  });

  it('cools down after a decline phrase and never arms on a low card', async () => {
    const declined = make(() => json());
    declined.tracker.onUserFinal(DEFAULT_I18N.affect.zh.declinePhrases[0]!, 'zh');
    await vi.advanceTimersByTimeAsync(10);
    expect(declined.tracker.exhaustedArmed).toBe(false);
    declined.tracker.dispose();

    const low = make(() => json({ emotion: 'sad', intensity: 3, need: 'vent', strategy: 'comfort' }));
    low.tracker.onUserFinal('老伴走了以后家里空落落的', 'zh');
    await vi.advanceTimersByTimeAsync(10);
    low.tracker.onLightFinal('嗯', 'zh');
    expect(low.tracker.exhaustedArmed).toBe(false);
    low.tracker.dispose();
  });
});

describe('TopicExhaustion.reset', () => {
  it('drops the streak and the armed hint but keeps the cooldown', () => {
    const t = new TopicExhaustion({ shortMaxChars: 4, shortStreakTrigger: 2, cooldownTurns: 4, declineCooldownTurns: 10 });
    t.onFinal('嗯', true, []);
    expect(t.armed).toBe(true);
    t.reset();
    expect(t.armed).toBe(false);
    expect(t.armedCount).toBe(1);
    t.onFinal('算了', false, ['算了']);
    t.reset();
    t.onFinal('嗯', true, []);
    expect(t.armed).toBe(false); // the decline cooldown survives a reset
  });
});
