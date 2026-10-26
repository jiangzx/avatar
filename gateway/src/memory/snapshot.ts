// High-risk memory-view contract: read docs/project/roadmap.md "记忆与回忆：已踩过的坑" before changing.
import { DEFAULT_I18N } from '../i18n/load.ts';
import { PROMPT_LABELS, type PromptLabels } from '../roles/labels.ts';
import { EMPTY_EVIDENCE_RULES, isMemoryEvidence, type EvidenceRules } from './evidence.ts';
import type { MemoryStore } from './store.ts';

/** Language-specific inputs: labels come from PROMPT_LABELS, rules from the i18n bundle. */
export interface SnapshotRules {
  addressingPatterns?: readonly RegExp[];
  evidence?: EvidenceRules;
}

export function renderSnapshot(input: {
  facts: readonly { category: string; text: string }[];
  notes: readonly { text: string }[];
  episode?: { summary: string };
  tail: readonly { role: 'user' | 'assistant'; text: string }[];
  maxChars: number;
  labels?: PromptLabels;
  rules?: SnapshotRules;
}): string {
  const labels = input.labels ?? PROMPT_LABELS.zh;
  const addressingPatterns = input.rules?.addressingPatterns ?? [];
  const addressing = input.facts
    .filter((f) => f.category === 'addressing' && f.text)
    .map((f) => addressingText(oneLine(f.text), labels, addressingPatterns));
  const other = input.facts
    .filter((f) => f.category !== 'addressing' && f.text)
    .map((f) => `${factLabel(f.category, labels)}${labels.separator}${oneLine(f.text)}`);
  const notes = input.notes
    .filter((n) => n.text)
    .map((n) => `${labels.relationship}${labels.separator}${oneLine(n.text)}`);
  const tail = input.tail
    .filter((t) => t.text)
    .map((t) => `${t.role === 'user' ? labels.user : labels.assistant}${labels.separator}${oneLine(t.text)}`);
  const head = addressing.join('\n');
  // Names stay whole even when the addressing block itself exceeds the budget.
  if (head.length > input.maxChars) return head;
  const kept = [...addressing];
  const episode = input.episode?.summary
    ? `${labels.episode}${labels.separator}${input.episode.summary}`
    : '';
  if (episode && joinedLength([...kept, episode]) <= input.maxChars) kept.push(episode);
  for (const line of [...other, ...notes]) {
    if (joinedLength([...kept, line]) > input.maxChars) break;
    kept.push(line);
  }
  // Older tail lines drop first. A line that does not fit ends the suffix.
  let start = tail.length;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (joinedLength([...kept, ...tail.slice(i)]) > input.maxChars) break;
    start = i;
  }
  return [...kept, ...tail.slice(start)].join('\n');
}

/** Store rows one view render needs. Scope keys come from the server-side SessionContext. */
export interface MemoryViewSource {
  /** Plain stored name (profile_facts addressing row), or null. */
  addressing: string | null;
  /** Shared basics (profile_facts profile rows). */
  profile: readonly string[];
  /** This character's facts. Sensitive ones never enter a view. */
  facts: readonly { text: string; sensitive: boolean }[];
  /** This character's pins, newest first. Sensitive ones only enter pinnedBlock. */
  pinned: readonly { text: string; sensitive: boolean }[];
  /** Chronological (oldest first). Rows without a role are recent-session user rows. */
  tail: readonly { role?: 'user' | 'assistant'; text: string }[];
}

export interface MemoryViewInput extends MemoryViewSource {
  maxChars: number;
  labels?: PromptLabels;
  rules?: SnapshotRules;
}

export interface MemoryViews {
  /** Normal replies: name, basics, open facts, verbatim user statements. Pins travel in pinnedBlock. */
  full: string;
  /** Greeting planner: name, basics, open pins, open facts. No tail. */
  greeting: string;
  /** Silence planner: basics, open pins, open facts. Never the name. */
  proactive: string;
  /** True when the greeting view carries a topic, not just the name. */
  hasTopic: boolean;
  /** Every pin of this character, sensitive ones included (Q33). Rendered beside the snapshot, never clipped. */
  pinnedBlock: string;
}

/**
 * Builds the prompt views from user-grounded memory only (roadmap memory pit 4, revised by Q33).
 * Episodes, relationship notes, extracted sensitive facts, and assistant lines never enter any view.
 * The only sensitive text that reaches a prompt is a pin the user asked for, and only through pinnedBlock.
 */
export function renderMemoryViews(input: MemoryViewInput): MemoryViews {
  const labels = input.labels ?? PROMPT_LABELS.zh;
  const patterns = input.rules?.addressingPatterns ?? [];
  const nameFacts = input.addressing ? [{ category: 'addressing', text: labelledName(input.addressing, labels, patterns) }] : [];
  const profile = input.profile.filter(Boolean).map((text) => ({ category: 'profile', text }));
  const openPins = input.pinned.filter((pin) => pin.text && !pin.sensitive).map((pin) => ({ category: 'pinned', text: pin.text }));
  const facts = input.facts.filter((fact) => fact.text && !fact.sensitive).map((fact) => ({ category: 'other', text: fact.text }));
  const evidence = input.rules?.evidence ?? EMPTY_EVIDENCE_RULES;
  // Recent-session rows have no role; assistant rows are never evidence.
  const userTail = input.tail
    .filter((entry) => entry.role !== 'assistant' && isMemoryEvidence(entry.text, evidence))
    .map((entry) => ({ role: 'user' as const, text: entry.text }));
  const render = (rows: readonly { category: string; text: string }[], tail: readonly { role: 'user'; text: string }[]) =>
    renderSnapshot({ facts: rows, notes: [], tail, maxChars: input.maxChars, labels, rules: input.rules });
  return {
    full: render([...nameFacts, ...profile, ...facts], userTail),
    greeting: render([...nameFacts, ...profile, ...openPins, ...facts], []),
    proactive: render([...profile, ...openPins, ...facts], []),
    hasTopic: profile.length + openPins.length + facts.length > 0,
    pinnedBlock: input.pinned
      .filter((pin) => pin.text)
      .map((pin) => `${labels.pinned}${labels.separator}${oneLine(pin.text)}`)
      .join('\n'),
  };
}

/** One read of everything the views need, shared by DeviceRegistry.resolve and Session.refreshMemorySnapshot. */
export function memoryViewSource(store: MemoryStore, ownerId: string, agentId: string, tailLimit = 12): MemoryViewSource {
  const shared = store.listProfileFacts(ownerId);
  return {
    addressing: shared.find((row) => row.category === 'addressing')?.text ?? null,
    profile: shared.filter((row) => row.category === 'profile').map((row) => row.text),
    facts: store.listAgentFacts(ownerId, agentId).map(({ text, sensitive }) => ({ text, sensitive })),
    pinned: store.listPinned(ownerId, agentId).map(({ text, sensitive }) => ({ text, sensitive })),
    tail: store.recentUserMessages(ownerId, agentId, tailLimit).slice().reverse(),
  };
}

/** Shared basics and pins keep their own labels; every other category is a plain fact. */
function factLabel(category: string, labels: PromptLabels): string {
  if (category === 'profile') return labels.profile;
  if (category === 'pinned') return labels.pinned;
  return labels.fact;
}

/** A stored line must not be able to forge a second labelled snapshot line. */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

// Extraction may store an already-labelled name from any language; re-render it in the session language.
const STORED_ADDRESSING = /^(?:称呼|呼び方|Address as)[：:]\s*(.+)$/iu;

/** Longest stored name; matches PUT /memory/addressing text(1..20) in spec §7. */
export const ADDRESSING_MAX_CHARS = 20;

/**
 * Plain name from a stored or extracted addressing line: drops a "称呼：/呼び方：/Address as:" label and folds
 * it to one trimmed line. A bare label with no name stays as it is; callers treat that as not a name.
 */
export function plainAddressing(text: string): string {
  const line = oneLine(text);
  return STORED_ADDRESSING.exec(line)?.[1]?.trim() ?? line;
}

/** Stored names are plain since Task 3: label them, but keep legacy labelled or self-introduction text as before. */
function labelledName(text: string, labels: PromptLabels, patterns: readonly RegExp[]): string {
  const line = oneLine(text);
  // A self-introduction may be in another language than this session; addressingText rewrites it after a switch.
  if (STORED_ADDRESSING.test(line) || isAddressingSentence(line, patterns)) return line;
  return `${labels.addressing}${labels.separator}${line}`;
}

function isAddressingSentence(line: string, patterns: readonly RegExp[]): boolean {
  if (patterns.some((pattern) => pattern.test(line))) return true;
  return Object.values(DEFAULT_I18N.memory).some((copy) => copy.addressingPatterns.some((pattern) => pattern.test(line)));
}

/** Renders a stored self-introduction as a short label so the model does not mirror the whole sentence. */
function addressingText(text: string, labels: PromptLabels, patterns: readonly RegExp[]): string {
  const trimmed = text.trim();
  const stored = STORED_ADDRESSING.exec(trimmed);
  if (stored?.[1]) return `${labels.addressing}${labels.separator}${stored[1]}`;
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match?.[1]) return `${labels.addressing}${labels.separator}${match[1]}`;
  }
  return text;
}

function joinedLength(lines: readonly string[]): number {
  let used = 0;
  for (const line of lines) used = used === 0 ? line.length : used + 1 + line.length;
  return used;
}
