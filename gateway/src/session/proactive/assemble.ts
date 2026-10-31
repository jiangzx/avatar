// Builds a ProactiveIntent from an engine decision (spec 意图契约). Pure: inputs in, intent out.
import type { Language } from '@anyidea/protocol';
import type { ThreadRecord } from '../../memory/store.ts';
import type { FallbackKey, IntentCopy, IntentPurpose } from '../../roles/types.ts';
import type { AffectCard } from '../affect.ts';
import type { IntentKind, ProactivityConfig } from './config.ts';
import { beijingHour, type CareStage, type Decision, type Familiarity, type Moment } from './engine.ts';
import type { ProactiveIntent, QuestionMode } from './intent.ts';
import type { QuestionMaterial } from './questionMaterial.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Material the session found for this moment; buildIntent uses only what the decision needs. */
export interface IntentMaterial {
  thread?: ThreadRecord;
  /** The user's own unfinished line in this session (already evidence-checked). */
  openLoop?: string;
  /** The open loop has a health word: lock the quote and append withCare (same as health threads). */
  openLoopSensitive?: boolean;
  /** Topic card prompt; not the user's words. */
  topic?: string;
  /** A remembered user line that names family. */
  family?: string;
  /** Memory or topic-card material for the one question this line must ask. */
  question?: QuestionMaterial;
}

export interface PlannedIntent {
  intent: ProactiveIntent;
  purpose: IntentPurpose;
  /** Health quote: append IntentCopy.withCare. */
  allowCare: boolean;
  /** Same-episode second question: append withFollowUp. */
  followUp: boolean;
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
  /** A question was already asked in this silence episode. */
  followUp?: boolean;
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

/** Question contract per kind and moment (2026-10-31 spec §3.1). */
export function questionMode(kind: IntentKind, moment: Moment, enabled = true): QuestionMode {
  if (kind === 'restQuiet') return 'forbidden';
  if (!enabled) return 'allowed';
  const questionMoment = moment === 'silenceContext' || moment === 'silenceCheck';
  if ((kind === 'interestTopic' || kind === 'selfShare') && questionMoment) return 'required';
  if ((kind === 'interestTopic' || kind === 'selfShare') && moment === 'silenceLeave') return 'forbidden';
  return 'allowed';
}

function fallbackKeyFor(kind: IntentKind, moment: Moment, enabled: boolean): FallbackKey | 'greetingPlain' {
  if (kind === 'interestTopic') return questionMode(kind, moment, enabled) === 'required' ? 'interestTopic' : 'interestTopicStatement';
  if (kind === 'selfShare') return questionMode(kind, moment, enabled) === 'required' ? 'selfShareQuestion' : 'selfShare';
  return kind as FallbackKey | 'greetingPlain';
}

type Shape = {
  purpose: IntentPurpose;
  fallbackKey: FallbackKey | 'greetingPlain';
  quotes: Array<{ text: string; said: string | null }>;
  facts: string[];
  allowCare?: boolean;
  question?: QuestionMaterial;
};

function shapeFor(decision: Decision, input: BuildInput): Shape | null {
  const m = input.material;
  const words = input.saidWords;
  switch (decision.kind) {
    case 'threadFollowup': {
      const t = m.thread;
      if (!t || t.id !== decision.threadId) return null;
      const purpose = threadPurpose(t, input.now);
      if (t.sensitive) {
        return {
          purpose, fallbackKey: 'threadSensitive',
          quotes: [{ text: t.quote, said: saidWhen(t.createdAt, input.now, words) }],
          facts: [], allowCare: true,
        };
      }
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
      if (m.openLoopSensitive) {
        return {
          purpose: 'continueThread', fallbackKey: 'continueThread',
          quotes: [{ text: m.openLoop, said: words.justNow }],
          facts: [], allowCare: true,
        };
      }
      return { purpose: 'continueThread', fallbackKey: 'continueThread', quotes: [{ text: m.openLoop, said: words.justNow }], facts: [] };
    case 'interestTopic': {
      // T3 fallback: the runtime still supplies `topic` until T4 wires the memory/card material.
      const q = m.question ?? (m.topic
        ? { source: 'card' as const, form: 'topic' as const, text: m.topic, said: null, key: 'card:', cardIndex: null }
        : undefined);
      if (!q) return null;
      const required = questionMode('interestTopic', input.moment, input.cfg.topicQuestion.enabled) === 'required';
      return {
        purpose: 'interestTopic',
        fallbackKey: fallbackKeyFor('interestTopic', input.moment, input.cfg.topicQuestion.enabled),
        quotes: q.form === 'quote' ? [{ text: q.text, said: q.said }] : [],
        facts: q.form === 'topic' ? [q.text] : [],
        question: q,
      };
    }
    case 'humanConnection':
      return m.family ? { purpose: 'humanConnection', fallbackKey: 'humanConnection', quotes: [{ text: m.family, said: words.earlier }], facts: [] } : null;
    case 'selfShare': {
      const required = questionMode('selfShare', input.moment, input.cfg.topicQuestion.enabled) === 'required';
      if (required && !m.question) return null;
      return {
        purpose: 'selfShare',
        fallbackKey: fallbackKeyFor('selfShare', input.moment, input.cfg.topicQuestion.enabled),
        quotes: [],
        facts: [],
        ...(m.question ? { question: m.question } : {}),
      };
    }
    case 'presenceCheck':
      return { purpose: 'presenceCheck', fallbackKey: 'presenceCheck', quotes: [], facts: [] };
    case 'restQuiet':
      return { purpose: 'restQuiet', fallbackKey: 'restQuiet', quotes: [], facts: [] };
    case 'greetingPlain':
      // The opening's fallback is composed from greetingNameTexts by the runtime.
      return { purpose: 'greetingPlain', fallbackKey: 'greetingPlain', quotes: [], facts: [] };
    case 'quiet':
      return null;
  }
}

/** Null = do not speak (quiet, or the material the decision needs is missing). */
export function buildIntent(decision: Decision, input: BuildInput): PlannedIntent | null {
  const shape = shapeFor(decision, input);
  if (!shape) return null;
  const question = questionMode(decision.kind, input.moment, input.cfg.topicQuestion.enabled);
  const intent: ProactiveIntent = {
    moment: input.moment,
    kind: decision.kind,
    material: {
      quotes: shape.quotes,
      facts: shape.facts,
      ...(shape.question
        ? { question: { text: shape.question.text, said: shape.question.said, topic: shape.question.form === 'topic' } }
        : {}),
    },
    tone: {
      familiarity: input.familiarity,
      stage: input.affect.low ? input.affect.stage : null,
      allowJoke: input.familiarity === 'oldFriend' && !input.affect.low,
    },
    constraints: {
      maxChars: input.cfg.maxChars,
      question,
      mustExpress: decision.kind === 'presenceCheck' ? 'presence' : null,
    },
    language: input.language,
    fallbackKey: shape.fallbackKey,
    ...(shape.question ? { questionKey: shape.question.key } : {}),
  };
  return { intent, purpose: shape.purpose, allowCare: shape.allowCare ?? false, followUp: input.followUp ?? false };
}
