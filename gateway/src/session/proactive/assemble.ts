// Builds a ProactiveIntent from an engine decision (spec 意图契约). Pure: inputs in, intent out.
import type { Language } from '@anyidea/protocol';
import type { ThreadRecord } from '../../memory/store.ts';
import type { FallbackKey, IntentCopy, IntentPurpose } from '../../roles/types.ts';
import type { AffectCard } from '../affect.ts';
import type { ProactivityConfig } from './config.ts';
import { beijingHour, type CareStage, type Decision, type Familiarity, type Moment } from './engine.ts';
import type { ProactiveIntent } from './intent.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Material the session found for this moment; buildIntent uses only what the decision needs. */
export interface IntentMaterial {
  thread?: ThreadRecord;
  /** The user's own unfinished line in this session (already evidence-checked). */
  openLoop?: string;
  /** The open loop has a health word: read the fallback line instead (same rule as health threads). */
  openLoopSensitive?: boolean;
  /** Topic card prompt; not the user's words. */
  topic?: string;
  /** A remembered user line that names family. */
  family?: string;
}

export interface PlannedIntent {
  intent: ProactiveIntent;
  purpose: IntentPurpose;
  /** Health thread (2026-10-29): speak the fallback line, never render the quote. */
  fallbackOnly: boolean;
}

export interface BuildInput {
  moment: Moment;
  now: number;
  language: Language;
  familiarity: Familiarity;
  affect: { low: boolean; stage: CareStage };
  material: IntentMaterial;
  cfg: ProactivityConfig;
  saidWords: IntentCopy['saidWhen'];
}

export function beijingDay(at: number): string {
  return new Date(at + 8 * HOUR).toISOString().slice(0, 10);
}

/** ESConv stage from the latest card only (spec 情绪轨迹 › 应对阶段). */
export function careStage(card: AffectCard | null): CareStage {
  if (!card) return 'explore';
  if (card.need === 'help' || card.strategy === 'suggest') return 'suggest';
  if (card.strategy === 'comfort' || card.strategy === 'affirm' || card.strategy === 'reflect') return 'comfort';
  return 'explore';
}

/** How long ago, in Beijing calendar days, in the role's words. */
export function saidWhen(at: number, now: number, words: IntentCopy['saidWhen']): string {
  const days = Math.round((Date.parse(beijingDay(now)) - Date.parse(beijingDay(at))) / DAY);
  if (days <= 0) return words.today;
  if (days === 1) return words.yesterday;
  if (days <= 6) return words.days[days - 2] ?? words.earlier;
  if (days <= 13) return words.lastWeek;
  return words.earlier;
}

const ROUTINE_PURPOSE = { morning: 'routineMorning', noon: 'routineNoon', evening: 'routineEvening', night: 'routineNight' } as const;

function routinePurpose(now: number, cfg: ProactivityConfig): IntentPurpose | null {
  const hour = beijingHour(now);
  for (const slot of ['morning', 'noon', 'evening', 'night'] as const) {
    const w = cfg.routine[slot];
    if (hour >= w.start && hour < w.end) return ROUTINE_PURPOSE[slot];
  }
  return null;
}

function threadPurpose(thread: ThreadRecord, now: number): IntentPurpose {
  if (thread.kind === 'event') return now < thread.dueAt ? 'threadEventBefore' : 'threadEventAfter';
  return thread.kind === 'concern' ? 'threadConcern' : 'threadPlan';
}

type Shape = { purpose: IntentPurpose; fallbackKey: FallbackKey; quotes: Array<{ text: string; said: string | null }>; facts: string[]; fallbackOnly?: boolean };

function shapeFor(decision: Decision, input: BuildInput): Shape | null {
  const m = input.material;
  const words = input.saidWords;
  switch (decision.kind) {
    case 'threadFollowup': {
      const t = m.thread;
      if (!t || t.id !== decision.threadId) return null;
      const purpose = threadPurpose(t, input.now);
      // Health quotes stay out of every instruction; the sensitive group is read instead.
      if (t.sensitive) return { purpose, fallbackKey: 'threadSensitive', quotes: [], facts: [], fallbackOnly: true };
      return { purpose, fallbackKey: 'threadFollowup', quotes: [{ text: t.quote, said: saidWhen(t.createdAt, input.now, words) }], facts: [] };
    }
    case 'moodCheck':
      return { purpose: input.affect.low ? 'moodCheckNow' : 'moodCheckEarlier', fallbackKey: 'moodCheck', quotes: [], facts: [] };
    case 'routine': {
      const purpose = routinePurpose(input.now, input.cfg);
      return purpose ? { purpose, fallbackKey: 'routine', quotes: [], facts: [] } : null;
    }
    case 'continueThread':
      if (!m.openLoop) return null;
      if (m.openLoopSensitive) return { purpose: 'continueThread', fallbackKey: 'continueThread', quotes: [], facts: [], fallbackOnly: true };
      return { purpose: 'continueThread', fallbackKey: 'continueThread', quotes: [{ text: m.openLoop, said: words.justNow }], facts: [] };
    case 'interestTopic':
      return m.topic ? { purpose: 'interestTopic', fallbackKey: 'interestTopic', quotes: [], facts: [m.topic] } : null;
    case 'humanConnection':
      return m.family ? { purpose: 'humanConnection', fallbackKey: 'humanConnection', quotes: [{ text: m.family, said: words.earlier }], facts: [] } : null;
    case 'selfShare':
      return { purpose: 'selfShare', fallbackKey: 'selfShare', quotes: [], facts: [] };
    case 'presenceCheck':
      return { purpose: 'presenceCheck', fallbackKey: 'presenceCheck', quotes: [], facts: [] };
    case 'restQuiet':
      return { purpose: 'restQuiet', fallbackKey: 'restQuiet', quotes: [], facts: [] };
    case 'quiet':
    case 'greetingPlain':
      return null;
  }
}

/** Null = do not speak (quiet, the opening, or the material the decision needs is missing). */
export function buildIntent(decision: Decision, input: BuildInput): PlannedIntent | null {
  const shape = shapeFor(decision, input);
  if (!shape) return null;
  const structural = decision.kind === 'presenceCheck' || decision.kind === 'restQuiet';
  const intent: ProactiveIntent = {
    moment: input.moment,
    kind: decision.kind,
    material: { quotes: shape.quotes, facts: shape.facts },
    tone: {
      familiarity: input.familiarity,
      stage: input.affect.low ? input.affect.stage : null,
      allowJoke: input.familiarity === 'oldFriend' && !input.affect.low,
    },
    constraints: { maxChars: input.cfg.maxChars, allowQuestion: !structural, mustExpress: decision.kind === 'presenceCheck' ? 'presence' : null },
    language: input.language,
    fallbackKey: shape.fallbackKey,
  };
  return { intent, purpose: shape.purpose, fallbackOnly: shape.fallbackOnly ?? false };
}
