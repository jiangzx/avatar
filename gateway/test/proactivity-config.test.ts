import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseOverlayKey } from '../src/config-store/keys.ts';
import { buildConfigSnapshot } from '../src/session/configSnapshot.ts';
import { SCORED_KINDS, loadProactivity, ProactivitySchema } from '../src/session/proactive/config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const path = `${root}config/proactivity.json`;
const raw = () => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const models = { realtimeEndpoint: '', realtimeModel: 'qwen3.8-omni-flash-realtime', textEndpoint: '', summarizerModel: 'm' };
const voiceDefaults = { zh: 'longanlingxin', ja: 'Tina', en: 'Tina' };
const ledger = { keepRecentTurns: 8, summarizeAfterTurns: 16, summarizeAfterTokens: 6_000 };

describe('proactivity.json', () => {
  it('loads the baseline with every scored kind and weights that sum to 100', () => {
    const cfg = loadProactivity(path);
    expect(cfg.defaultTier).toBe('moderate');
    expect(Object.keys(cfg.kinds).sort()).toEqual([...SCORED_KINDS].sort());
    for (const kind of SCORED_KINDS) {
      const w = cfg.kinds[kind].weights;
      expect(w.relevance + w.urgency + w.importance + w.novelty, kind).toBe(100);
    }
    expect(cfg.material.familyLookback).toBe(30);
    expect(cfg.threads.quoteMaxChars).toBe(80);
    expect(cfg.topicQuestion).toEqual({
      enabled: true,
      memoryRatio: 70,
      recentSessions: 3,
      recentDays: 7,
      declineCooldownDays: 90,
      minStatementChars: 5,
      factCategories: ['preference', 'person', 'other', 'profile'],
    });
  });

  it('sizes the three tiers for a heavy call day', () => {
    const cfg = loadProactivity(path);
    expect(cfg.tiers).toEqual({
      quiet: { threshold: 65, maxPerSession: 4, maxPerDay: 12 },
      moderate: { threshold: 40, maxPerSession: 12, maxPerDay: 60 },
      active: { threshold: 30, maxPerSession: 16, maxPerDay: 100 },
    });
  });

  it('rejects weights that do not sum to 100, unknown keys and out-of-range values', () => {
    const bad = raw();
    bad.kinds.routine.weights.novelty += 1;
    expect(ProactivitySchema.safeParse(bad).success).toBe(false);
    expect(ProactivitySchema.safeParse({ ...raw(), extra: 1 }).success).toBe(false);
    const high = raw();
    high.tiers.quiet.threshold = 101;
    expect(ProactivitySchema.safeParse(high).success).toBe(false);
    const window = raw();
    window.routine.morning = { start: 10, end: 6 };
    expect(ProactivitySchema.safeParse(window).success).toBe(false);
    const lookback = raw();
    lookback.material.familyLookback = 0;
    expect(ProactivitySchema.safeParse(lookback).success).toBe(false);
    const day = raw();
    day.tiers.active.maxPerDay = 121;
    expect(ProactivitySchema.safeParse(day).success).toBe(false);
    const maxDay = raw();
    maxDay.tiers.active.maxPerDay = 120;
    expect(ProactivitySchema.safeParse(maxDay).success).toBe(true);
    const ratio = raw();
    ratio.topicQuestion.memoryRatio = 101;
    expect(ProactivitySchema.safeParse(ratio).success).toBe(false);
    const categories = raw();
    categories.topicQuestion.factCategories = ['preference', 'preference'];
    expect(ProactivitySchema.safeParse(categories).success).toBe(false);
    const cooldown = raw();
    cooldown.topicQuestion.declineCooldownDays = -1;
    expect(ProactivitySchema.safeParse(cooldown).success).toBe(false);
  });

  it('is part of the config snapshot and can be overlaid', () => {
    expect(parseOverlayKey('proactivity:tiers.quiet.threshold')).toEqual({ kind: 'json', file: 'config/proactivity.json', path: ['tiers', 'quiet', 'threshold'] });
    const snap = buildConfigSnapshot({ gatewayRoot: root, overlay: { 'proactivity:tiers.quiet.threshold': 80 }, version: 3, ledger, sessionStartTimeoutMs: 10_000, models, voiceDefaults });
    expect(snap.proactivity.tiers.quiet.threshold).toBe(80);
    expect(() => buildConfigSnapshot({ gatewayRoot: root, overlay: { 'proactivity:tiers.quiet.missing': 1 }, version: 4, ledger, sessionStartTimeoutMs: 10_000, models, voiceDefaults })).toThrow();
    // affect.care is retired but kept: a stored overlay that still sets it must keep building.
    expect(() => buildConfigSnapshot({ gatewayRoot: root, overlay: { 'affect:care.maxAgeDays': 5 }, version: 5, ledger, sessionStartTimeoutMs: 10_000, models, voiceDefaults })).not.toThrow();
  });
});
