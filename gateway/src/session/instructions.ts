import type { LedgerEntry } from './ledger.ts';
import { PROMPT_LABELS, type PromptLabels } from '../roles/labels.ts';

export interface InstructionBudget {
  totalChars: number;
  snapshotMaxChars: number;
  summaryMaxChars: number;
}

export interface InstructionParts {
  persona: string;
  memorySnapshot?: string;
  summary: string;
  recent: readonly LedgerEntry[];
}

const line = (e: LedgerEntry, labels: PromptLabels) =>
  `${e.role === 'user' ? labels.user : labels.assistant}${labels.separator}${e.text}`;

function render(
  persona: string,
  snapshot: string,
  summary: string,
  lines: readonly string[],
  labels: PromptLabels,
): string {
  const parts = [persona.trim()];
  if (snapshot) parts.push(labels.memoryHeader, snapshot);
  parts.push(
    labels.summaryHeader,
    summary || labels.empty,
    labels.recentHeader,
    lines.length > 0 ? lines.join('\n') : labels.empty,
  );
  return parts.join('\n\n');
}

function clipHead(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 1 ? '' : `${s.slice(0, max - 1)}…`;
}

function clipTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 1 ? '' : `…${s.slice(s.length - max + 1)}`;
}

export function buildInstructions(
  parts: InstructionParts,
  budget?: InstructionBudget,
  labels: PromptLabels = PROMPT_LABELS.zh,
): string {
  const lines = parts.recent.map((entry) => line(entry, labels));
  if (!budget) return render(parts.persona, parts.memorySnapshot ?? '', parts.summary, lines, labels);
  let snapshot = clipHead(parts.memorySnapshot ?? '', budget.snapshotMaxChars);
  let summary = clipTail(parts.summary, budget.summaryMaxChars);
  const kept = [...lines];
  const over = () => render(parts.persona, snapshot, summary, kept, labels).length - budget.totalChars;
  while (over() > 0 && kept.length > 0) kept.shift();
  if (over() > 0) summary = clipTail(summary, Math.max(0, summary.length - over()));
  if (over() > 0) snapshot = clipHead(snapshot, Math.max(0, snapshot.length - over()));
  return render(parts.persona, snapshot, summary, kept, labels);
}

export function historyBudget(
  persona: string,
  budget: InstructionBudget,
  labels: PromptLabels = PROMPT_LABELS.zh,
): number {
  return budget.totalChars - render(persona, 'x'.repeat(budget.snapshotMaxChars), '', [], labels).length;
}
