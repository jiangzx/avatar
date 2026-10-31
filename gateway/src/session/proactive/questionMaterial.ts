// Memory-vs-topic-card material selection for proactive topic questions (2026-10-31 spec).
// Pure: no I/O. The runtime loads the rows and passes them in.
import type { TopicQuestionRules } from '../../i18n/types.ts';
import { containsPhrase } from '../../i18n/text.ts';
import type { EvidenceRules } from '../../memory/evidence.ts';
import { isMemoryEvidence, statementKey } from '../../memory/evidence.ts';
import type { AgentFactRow, PinnedRow, ProfileFactRow, ThreadRecord } from '../../memory/store.ts';
import type { IntentCopy, TopicCard } from '../../roles/types.ts';
import { saidWhen } from './assemble.ts';
import { pickFallback } from './fallback.ts';

export { statementKey };

export type TopicFactCategory = 'preference' | 'person' | 'other' | 'profile';

export interface QuestionMaterial {
  source: 'memory' | 'card';
  form: 'quote' | 'topic';
  text: string;
  said: string | null;
  /** card:<id> | fact:<id> | pin:<id> | thread:<id> | stmt:<hash> */
  key: string;
  cardIndex: number | null;
}

export interface FactChoice {
  id: string;
  text: string;
  category: string;
  source: 'fact' | 'pin';
  sensitive: boolean;
}

export interface RecentStatement {
  text: string;
  /** Session start, used only for the "said when" hint. */
  saidAt: number;
}

export interface MemoryMaterialInput {
  now: number;
  threads: readonly ThreadRecord[];
  facts: readonly FactChoice[];
  statements: readonly RecentStatement[];
  avoided: ReadonlySet<string>;
  healthWords: readonly string[];
  evidence: EvidenceRules;
  rules: TopicQuestionRules;
  factCategories: readonly TopicFactCategory[];
  saidWords: IntentCopy['saidWhen'];
  minStatementChars: number;
  mentioned: ReadonlySet<string>;
}

const hasAny = (text: string, words: readonly string[]) => words.some((word) => containsPhrase(text, word));

/** Stable key for a user statement; never stores the text itself. */
// re-exported from memory/evidence.ts to keep the memory layer import direction legal.

/** Flatten store rows into one list; profile facts first, then pins, then this agent's facts. */
export function factChoices(
  profile: readonly ProfileFactRow[],
  facts: readonly AgentFactRow[],
  pins: readonly PinnedRow[],
): FactChoice[] {
  const out: FactChoice[] = [];
  for (const row of profile) {
    if (row.category !== 'profile') continue;
    out.push({ id: row.id, text: row.text, category: row.category, source: 'fact', sensitive: false });
  }
  for (const row of pins) {
    out.push({ id: row.id, text: row.text, category: 'pin', source: 'pin', sensitive: row.sensitive });
  }
  for (const row of facts) {
    out.push({ id: row.id, text: row.text, category: row.category, source: 'fact', sensitive: row.sensitive });
  }
  return out;
}

function factAllowed(fact: FactChoice, input: MemoryMaterialInput): boolean {
  if (fact.sensitive) return false;
  const keyword = hasAny(fact.text, input.rules.factKeywords);
  // Pins have no category; they only need a topic keyword.
  if (fact.source === 'pin') return keyword;
  if (!input.factCategories.includes(fact.category as TopicFactCategory)) return false;
  // profile / other facts need a topic keyword; preference / person are topic-like by category.
  if (fact.category === 'profile' || fact.category === 'other') return keyword;
  return fact.category === 'preference' || fact.category === 'person';
}

/** Threads -> topic-like facts -> recent ended-session statements. Null = no usable memory. */
export function pickMemoryMaterial(input: MemoryMaterialInput): QuestionMaterial | null {
  const blocked = (text: string) =>
    hasAny(text, input.healthWords) || hasAny(text, input.rules.factBlockKeywords);

  for (const thread of input.threads) {
    if (!thread.quote || thread.sensitive) continue;
    if (input.mentioned.has(thread.id) || input.avoided.has(`thread:${thread.id}`)) continue;
    if (blocked(thread.quote) || !isMemoryEvidence(thread.quote, input.evidence)) continue;
    return {
      source: 'memory',
      form: 'quote',
      text: thread.quote,
      said: saidWhen(thread.createdAt, input.now, input.saidWords),
      key: `thread:${thread.id}`,
      cardIndex: null,
    };
  }

  for (const fact of input.facts) {
    if (!fact.text.trim() || blocked(fact.text)) continue;
    if (input.avoided.has(`${fact.source}:${fact.id}`)) continue;
    if (!factAllowed(fact, input)) continue;
    return {
      source: 'memory',
      form: 'topic',
      text: fact.text,
      said: null,
      key: `${fact.source}:${fact.id}`,
      cardIndex: null,
    };
  }

  for (const line of input.statements) {
    if (line.text.trim().length < input.minStatementChars) continue;
    if (blocked(line.text) || !isMemoryEvidence(line.text, input.evidence)) continue;
    const key = statementKey(line.text);
    if (input.avoided.has(key)) continue;
    return {
      source: 'memory',
      form: 'quote',
      text: line.text,
      said: saidWhen(line.saidAt, input.now, input.saidWords),
      key,
      cardIndex: null,
    };
  }
  return null;
}

/** Pick a topic card, skipping avoided cards; if all are avoided, reuse the oldest one and flag it. */
export function pickTopicMaterial(
  topics: readonly TopicCard[],
  avoided: ReadonlySet<string>,
  recent: readonly number[],
): { material: QuestionMaterial; exhausted: boolean } | null {
  if (topics.length === 0) return null;
  const allowed = topics.map((_, index) => index).filter((index) => !avoided.has(`card:${topics[index]!.id}`));
  const pool = allowed.length > 0 ? allowed : topics.map((_, index) => index);
  const recentInPool = recent.map((index) => pool.indexOf(index)).filter((index) => index >= 0);
  const index = pool[pickFallback(pool.length, recentInPool)]!;
  const card = topics[index]!;
  return {
    material: { source: 'card', form: 'topic', text: card.prompt, said: null, key: `card:${card.id}`, cardIndex: index },
    exhausted: allowed.length === 0,
  };
}

/** One roll per silence episode. `random` is called only when both sources exist. */
export function pickQuestionMaterial(input: {
  random: () => number;
  memoryRatio: number;
  memory: QuestionMaterial | null;
  topic: { material: QuestionMaterial; exhausted: boolean } | null;
}): { material: QuestionMaterial; exhausted: boolean } | null {
  const { memory, topic } = input;
  if (memory && topic) {
    return input.random() * 100 < input.memoryRatio
      ? { material: memory, exhausted: false }
      : { material: topic.material, exhausted: topic.exhausted };
  }
  if (memory) return { material: memory, exhausted: false };
  return topic;
}
