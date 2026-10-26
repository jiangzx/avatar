// High-risk memory-view contract: read docs/project/roadmap.md "记忆与回忆：已踩过的坑" before changing.
import { DEFAULT_I18N } from '../i18n/load.ts';
import { PROMPT_LABELS, type PromptLabels } from '../roles/labels.ts';
import { EMPTY_EVIDENCE_RULES, isMemoryEvidence, type EvidenceRules } from './evidence.ts';

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
    .map((f) => `${labels.fact}${labels.separator}${oneLine(f.text)}`);
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

export interface MemoryViews {
  /** Normal replies: addressing, non-sensitive facts, and verbatim user statements. */
  full: string;
  /** Greeting planner: addressing and non-sensitive facts only, no tail. */
  greeting: string;
  /** Silence planner: non-sensitive facts only, never the name. */
  proactive: string;
  /** True when the greeting view carries a real topic fact, not just the name. */
  hasTopic: boolean;
}

/**
 * Builds the three prompt views from user-grounded memory only.
 * Episodes, relationship notes, sensitive facts, and assistant lines never enter any view.
 * `tail` is chronological (oldest first), so the budget drops the oldest statements first.
 */
export function renderMemoryViews(input: {
  addressing: readonly string[];
  facts: readonly string[];
  tail: readonly { role?: 'user' | 'assistant'; text: string }[];
  maxChars: number;
  labels?: PromptLabels;
  rules?: SnapshotRules;
}): MemoryViews {
  const labels = input.labels ?? PROMPT_LABELS.zh;
  const patterns = input.rules?.addressingPatterns ?? [];
  const nameFacts = input.addressing.filter(Boolean).map((text) => ({ category: 'addressing', text: labelledName(text, labels, patterns) }));
  const factLines = input.facts.filter(Boolean).map((text) => ({ category: 'other', text }));
  const evidence = input.rules?.evidence ?? EMPTY_EVIDENCE_RULES;
  // Recent-session rows have no role; assistant rows are never evidence.
  const userTail = input.tail
    .filter((entry) => entry.role !== 'assistant' && isMemoryEvidence(entry.text, evidence))
    .map((entry) => ({ role: 'user' as const, text: entry.text }));
  return {
    full: renderSnapshot({ facts: [...nameFacts, ...factLines], notes: [], tail: userTail, maxChars: input.maxChars, labels: input.labels, rules: input.rules }),
    greeting: renderSnapshot({ facts: [...nameFacts, ...factLines], notes: [], tail: [], maxChars: input.maxChars, labels: input.labels, rules: input.rules }),
    proactive: renderSnapshot({ facts: factLines, notes: [], tail: [], maxChars: input.maxChars, labels: input.labels, rules: input.rules }),
    hasTopic: factLines.length > 0,
  };
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
