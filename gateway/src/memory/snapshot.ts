// High-risk memory-view contract: read docs/project/roadmap.md "记忆与回忆：已踩过的坑" before changing.
import { isMemoryEvidence } from './evidence.ts';

export function renderSnapshot(input: {
  facts: readonly { category: string; text: string }[]
  notes: readonly { text: string }[]
  episode?: { summary: string }
  tail: readonly { role: 'user' | 'assistant'; text: string }[]
  maxChars: number
}): string {
  const addressing = input.facts.filter((f) => f.category === 'addressing' && f.text).map((f) => addressingText(f.text));
  const other = input.facts.filter((f) => f.category !== 'addressing' && f.text).map((f) => `事实：${f.text}`);
  const notes = input.notes.filter((n) => n.text).map((n) => `关系：${n.text}`);
  const tail = input.tail.filter((t) => t.text).map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text}`);
  const head = addressing.join('\n');
  // Names stay whole even when the addressing block itself exceeds the budget.
  if (head.length > input.maxChars) return head;
  const kept = [...addressing];
  const episode = input.episode?.summary ? `上次话题（概括，非原话）：${input.episode.summary}` : '';
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
  skipPatterns?: readonly string[];
  maxChars: number;
}): MemoryViews {
  const nameFacts = input.addressing.filter(Boolean).map((text) => ({ category: 'addressing', text }));
  const factLines = input.facts.filter(Boolean).map((text) => ({ category: 'other', text }));
  const skipPatterns = input.skipPatterns ?? [];
  // Recent-session rows have no role; assistant rows are never evidence.
  const userTail = input.tail
    .filter((entry) => entry.role !== 'assistant' && isMemoryEvidence(entry.text, skipPatterns))
    .map((entry) => ({ role: 'user' as const, text: entry.text }));
  return {
    full: renderSnapshot({ facts: [...nameFacts, ...factLines], notes: [], tail: userTail, maxChars: input.maxChars }),
    greeting: renderSnapshot({ facts: [...nameFacts, ...factLines], notes: [], tail: [], maxChars: input.maxChars }),
    proactive: renderSnapshot({ facts: factLines, notes: [], tail: [], maxChars: input.maxChars }),
    hasTopic: factLines.length > 0,
  };
}

/** Renders a stored self-introduction as a short label so the model does not mirror the whole sentence. */
function addressingText(text: string): string {
  const match = /^(?:用户名叫|用户叫|我叫)(.+)$/.exec(text.trim());
  return match ? `称呼：${match[1]}` : text;
}

function joinedLength(lines: readonly string[]): number {
  let used = 0;
  for (const line of lines) used = used === 0 ? line.length : used + 1 + line.length;
  return used;
}
