import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDirectorConfig } from '../src/config.ts';
import { loadI18n } from '../src/i18n/load.ts';
import type { ThreadRecord } from '../src/memory/store.ts';
import type { AffectCard } from '../src/session/affect.ts';
import { beijingDay, buildIntent, careStage, saidWhen, type BuildInput } from '../src/session/proactive/assemble.ts';
import { checkSpoken, violationsOf } from '../src/session/proactive/check.ts';
import { loadProactivity } from '../src/session/proactive/config.ts';
import type { Decision } from '../src/session/proactive/engine.ts';
import { pickFallback } from '../src/session/proactive/fallback.ts';
import { renderIntent } from '../src/session/proactive/render.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cfg = loadProactivity(`${root}config/proactivity.json`);
const zh = loadDirectorConfig(`${root}roles/elder-companion/zh/director.json`);
const copy = zh.intents!;
const i18n = loadI18n(`${root}config`);
const DAY = 86_400_000;
const HOUR = 3_600_000;
// 08:30 Beijing (morning routine window).
const NOW = Date.parse('2026-11-03T08:30:00+08:00');

const thread = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  id: 't1', kind: 'concern', quote: '最近膝盖一到晚上就疼，睡不踏实。', dueAt: NOW, sensitive: false, mentionCount: 0,
  lastMentionedAt: null, createdAt: NOW - 3 * DAY, sourceSessionId: 's-old', ...over,
});
const input = (over: Partial<BuildInput> = {}): BuildInput => ({
  moment: 'silenceContext', now: NOW, language: 'zh', familiarity: 'familiar',
  affect: { low: false, stage: 'explore' }, material: {}, cfg, saidWords: copy.saidWhen, ...over,
});
const decision = (kind: Decision['kind'], threadId?: string): Decision => ({ kind, score: 0.6, candidates: 1, ...(threadId ? { threadId } : {}) });
const card = (over: Partial<AffectCard> = {}): AffectCard => ({ emotion: 'sad', intensity: 2, trend: 'flat', need: 'vent', strategy: 'ask', mismatch: false, crisis: false, ...over });

describe('assemble helpers', () => {
  it('reads the Beijing date and how long ago something was said', () => {
    expect(beijingDay(Date.parse('2026-11-03T00:10:00+08:00'))).toBe('2026-11-03');
    expect(beijingDay(Date.parse('2026-11-02T23:50:00+08:00'))).toBe('2026-11-02');
    expect(saidWhen(NOW - HOUR, NOW, copy.saidWhen)).toBe('今天');
    expect(saidWhen(Date.parse('2026-11-02T23:50:00+08:00'), NOW, copy.saidWhen)).toBe('昨天');
    expect(saidWhen(NOW - 2 * DAY, NOW, copy.saidWhen)).toBe('前天');
    expect(saidWhen(NOW - 3 * DAY, NOW, copy.saidWhen)).toBe('三天前');
    expect(saidWhen(NOW - 9 * DAY, NOW, copy.saidWhen)).toBe('上周');
    expect(saidWhen(NOW - 20 * DAY, NOW, copy.saidWhen)).toBe('之前');
  });

  it('derives the care stage from the latest card', () => {
    expect(careStage(null)).toBe('explore');
    expect(careStage(card({ need: 'help' }))).toBe('suggest');
    expect(careStage(card({ strategy: 'suggest' }))).toBe('suggest');
    expect(careStage(card({ strategy: 'comfort' }))).toBe('comfort');
    expect(careStage(card({ strategy: 'ask' }))).toBe('explore');
  });
});

describe('buildIntent', () => {
  it('locks a plain thread to its own quote and when it was said', () => {
    const t = thread();
    const planned = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: t } }))!;
    expect(planned.purpose).toBe('threadConcern');
    expect(planned.allowCare).toBe(false);
    expect(planned.intent.material.quotes).toEqual([{ text: t.quote, said: '三天前' }]);
    expect(planned.intent.fallbackKey).toBe('threadFollowup');
  });

  it('locks a sensitive quote and marks it for one care line', () => {
    const t = thread({ sensitive: true, quote: '我有高血压，这几天量着有点高。' });
    const planned = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: t } }))!;
    expect(planned.allowCare).toBe(true);
    expect(planned.intent.material.quotes).toEqual([{ text: t.quote, said: '三天前' }]);
    expect(planned.intent.fallbackKey).toBe('threadSensitive');
  });

  it('splits events into before and after', () => {
    const before = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: thread({ kind: 'event', dueAt: NOW + 20 * HOUR }) } }))!;
    const after = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: thread({ kind: 'event', dueAt: NOW - 5 * HOUR }) } }))!;
    expect(before.purpose).toBe('threadEventBefore');
    expect(after.purpose).toBe('threadEventAfter');
  });

  it('picks purposes for mood, routine and the structural steps', () => {
    expect(buildIntent(decision('moodCheck'), input({ affect: { low: true, stage: 'comfort' } }))!.purpose).toBe('moodCheckNow');
    expect(buildIntent(decision('moodCheck'), input())!.purpose).toBe('moodCheckEarlier');
    expect(buildIntent(decision('routine'), input())!.purpose).toBe('routineMorning');
    expect(buildIntent(decision('routine'), input({ now: Date.parse('2026-11-03T15:00:00+08:00') }))).toBeNull();
    const checkin = buildIntent(decision('presenceCheck'), input({ moment: 'silenceCheckin' }))!;
    // checkin asks whether the user is still there; only rest bans questions.
    expect(checkin.intent.constraints).toEqual({ maxChars: cfg.maxChars, allowQuestion: true, mustExpress: 'presence' });
    expect(buildIntent(decision('restQuiet'), input({ moment: 'silenceRest' }))!.intent.constraints.allowQuestion).toBe(false);
  });

  it('uses the open loop, topic and family line as locked material, and needs them', () => {
    expect(buildIntent(decision('continueThread'), input({ material: { openLoop: '我那盆君子兰今年还没开花' } }))!.intent.material.quotes)
      .toEqual([{ text: '我那盆君子兰今年还没开花', said: '刚才' }]);
    expect(buildIntent(decision('continueThread'), input())).toBeNull();
    const health = buildIntent(decision('continueThread'), input({ material: { openLoop: '最近膝盖疼得睡不着', openLoopSensitive: true } }))!;
    expect(health.allowCare).toBe(true);
    expect(health.intent.material.quotes).toEqual([{ text: '最近膝盖疼得睡不着', said: '刚才' }]);
    expect(health.intent.fallbackKey).toBe('continueThread');
    expect(buildIntent(decision('interestTopic'), input({ material: { topic: '年轻时爱听的一首老歌' } }))!.intent.material.facts).toEqual(['年轻时爱听的一首老歌']);
    expect(buildIntent(decision('humanConnection'), input({ material: { family: '闺女在深圳工作，一年也就回来一两趟。' } }))!.intent.material.quotes)
      .toEqual([{ text: '闺女在深圳工作，一年也就回来一两趟。', said: '之前' }]);
    expect(buildIntent(decision('humanConnection'), input())).toBeNull();
  });

  it('returns null for quiet and when the thread does not match the decision', () => {
    expect(buildIntent(decision('quiet'), input())).toBeNull();
    expect(buildIntent(decision('greetingPlain'), input({ moment: 'sessionStart' }))!.purpose).toBe('greetingPlain');
    expect(buildIntent(decision('threadFollowup', 'other'), input({ material: { thread: thread() } }))).toBeNull();
  });

  it('sets tone from familiarity and the care stage', () => {
    const low = buildIntent(decision('moodCheck'), input({ familiarity: 'oldFriend', affect: { low: true, stage: 'comfort' } }))!;
    expect(low.intent.tone).toEqual({ familiarity: 'oldFriend', stage: 'comfort', allowJoke: false });
    const fine = buildIntent(decision('selfShare'), input({ familiarity: 'oldFriend' }))!;
    expect(fine.intent.tone).toEqual({ familiarity: 'oldFriend', stage: null, allowJoke: true });
  });
});

describe('renderIntent', () => {
  it('renders plan A: frame, locked quote, tone', () => {
    const t = thread();
    const planned = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: t } }))!;
    const request = renderIntent(planned, copy, zh.fallbacks!.threadFollowup[0]!);
    expect(request.cue).toBe('followup');
    expect(request.fallbackText).toBe(zh.fallbacks!.threadFollowup[0]);
    expect(request.instruction.split('\n')).toEqual([
      `现在由你主动开口，说一两句口语，不超过${cfg.maxChars}个字。目的：${copy.purposes.threadConcern}。`,
      `能用的事实只有下面【】里老人三天前说过的话；不要补充人名、地名、作品名、日期、数字或其他细节。`,
      `【${t.quote}】`,
      copy.tones.familiar,
    ]);
    expect(request.instruction).not.toContain(copy.withCare);
  });

  it('renders a sensitive thread with the quote and the care line; fallback text stays in the sensitive group', () => {
    const t = thread({ sensitive: true, quote: '我有高血压，这几天量着有点高。' });
    const planned = buildIntent(decision('threadFollowup', 't1'), input({ material: { thread: t } }))!;
    const line = zh.fallbacks!.threadSensitive[2]!;
    const request = renderIntent(planned, copy, line);
    expect(request.fallbackText).toBe(line);
    expect(request.instruction.split('\n')).toEqual([
      `现在由你主动开口，说一两句口语，不超过${cfg.maxChars}个字。目的：${copy.purposes.threadConcern}。`,
      '能用的事实只有下面【】里老人三天前说过的话；不要补充人名、地名、作品名、日期、数字或其他细节。',
      `【${t.quote}】`,
      copy.withCare,
      copy.tones.familiar,
    ]);
  });

  it('renders topics with withTopic, no material with withoutMaterial, and bans questions where needed', () => {
    const topic = renderIntent(buildIntent(decision('interestTopic'), input({ material: { topic: '今天吃了什么好吃的' } }))!, copy, 'x');
    expect(topic.instruction).toContain('能用的话题只有下面【】里的内容');
    expect(topic.instruction).toContain('【今天吃了什么好吃的】');
    const checkin = renderIntent(buildIntent(decision('presenceCheck'), input({ moment: 'silenceCheckin' }))!, copy, 'x');
    expect(checkin.instruction).toContain(copy.withoutMaterial);
    expect(checkin.instruction).not.toContain(copy.noQuestion);
    const rest = renderIntent(buildIntent(decision('restQuiet'), input({ moment: 'silenceRest' }))!, copy, 'x');
    expect(rest.instruction.endsWith(copy.noQuestion)).toBe(true);
    const low = renderIntent(buildIntent(decision('moodCheck'), input({ familiarity: 'oldFriend', affect: { low: true, stage: 'explore' } }))!, copy, 'x');
    expect(low.instruction).toContain(copy.tones.familiar);
    expect(low.instruction).not.toContain(copy.tones.oldFriend);
    expect(low.instruction).toContain(copy.tones.explore);
  });

  it('does not expand $ patterns from user words', () => {
    const planned = buildIntent(decision('continueThread'), input({ material: { openLoop: '花了 $& 块钱' } }))!;
    expect(renderIntent(planned, copy, 'x').instruction).toContain('【花了 $& 块钱】');
  });
});

describe('pickFallback', () => {
  it('rotates through unused lines and never repeats a recent one', () => {
    expect(pickFallback(5, [])).toBe(0);
    expect(pickFallback(5, [0])).toBe(1);
    expect(pickFallback(5, [2, 1, 0])).toBe(3);
    expect(pickFallback(5, [3, 2, 1])).toBe(0);
    // An admin shortened the group: stale indexes are ignored.
    expect(pickFallback(5, [7, 6])).toBe(0);
    // Every line recent: the oldest recent one.
    expect(pickFallback(3, [1, 2, 0])).toBe(0);
  });
});

describe('checkSpoken', () => {
  const rules = { healthWords: i18n.memory.zh.healthWords, silence: i18n.silence.zh };

  it('counts health words that are not in the material (probe: 按时吃药)', () => {
    const c = checkSpoken('陈叔，血压高了别着急，记得按时吃药。', { material: ['我有高血压，这几天量着有点高。', '昨天'], allowQuestion: true, mustExpress: null }, rules);
    expect(c.health).toBeGreaterThanOrEqual(1);
    expect(violationsOf(c)).toContainEqual({ kind: 'health', count: c.health });
    const clean = checkSpoken('陈叔，这几天血压还高吗？', { material: ['我有高血压，这几天量着有点高。'], allowQuestion: true, mustExpress: null }, rules);
    expect(clean.health).toBe(0);
  });

  it('counts titles and numbers outside the material, questions and missing presence', () => {
    const c = checkSpoken('要不听听《茉莉花》？三点钟我再来。', { material: [], allowQuestion: false, mustExpress: 'presence' }, rules);
    expect(c.titles).toBe(1);
    expect(c.numbers).toBe(1);
    expect(c.question).toBe(true);
    expect(c.presenceMissing).toBe(true);
    expect(violationsOf(c).map((v) => v.kind).sort()).toEqual(['number', 'presence', 'question', 'title']);
    const ok = checkSpoken('我一直都在，您还在听吗？想聊随时说。', { material: ['我一直都在，您还在听吗？想聊随时说。'], allowQuestion: true, mustExpress: 'presence' }, rules);
    expect(violationsOf(ok)).toEqual([]);
  });
});
