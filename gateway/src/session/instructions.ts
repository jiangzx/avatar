import type { LedgerEntry } from './ledger.ts';

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

const line = (e: LedgerEntry) => `${e.role === 'user' ? '用户' : '助手'}：${e.text}`;

function render(persona: string, snapshot: string, summary: string, lines: readonly string[]): string {
  const parts = [persona.trim()];
  if (snapshot) parts.push('## 记忆参考（可能不准确，注意「用户」与「助手」的区别）', snapshot);
  parts.push('## 对话摘要', summary || '（暂无）', '## 最近对话', lines.length > 0 ? lines.join('\n') : '（暂无）');
  return parts.join('\n\n');
}

/** Keeps the start (the snapshot puts the user's name first). */
function clipHead(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 1 ? '' : `${s.slice(0, max - 1)}…`;
}

/** Keeps the end (the newest part of a summary). */
function clipTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 1 ? '' : `…${s.slice(s.length - max + 1)}`;
}

/**
 * Persona → memory snapshot → summary → recent turns, within `budget.totalChars`.
 * Truncates from the back: oldest recent lines, then the summary's head, then the snapshot's tail.
 * The persona (safety + style + actions + activity directory) is never truncated.
 */
export function buildInstructions(parts: InstructionParts, budget?: InstructionBudget): string {
  const lines = parts.recent.map(line);
  if (!budget) return render(parts.persona, parts.memorySnapshot ?? '', parts.summary, lines);
  let snapshot = clipHead(parts.memorySnapshot ?? '', budget.snapshotMaxChars);
  let summary = clipTail(parts.summary, budget.summaryMaxChars);
  const kept = [...lines];
  const over = () => render(parts.persona, snapshot, summary, kept).length - budget.totalChars;
  while (over() > 0 && kept.length > 0) kept.shift();
  if (over() > 0) summary = clipTail(summary, Math.max(0, summary.length - over()));
  if (over() > 0) snapshot = clipHead(snapshot, Math.max(0, snapshot.length - over()));
  return render(parts.persona, snapshot, summary, kept);
}

/** Characters left for summary + recent turns once persona and a full snapshot are in place. */
export function historyBudget(persona: string, budget: InstructionBudget): number {
  return budget.totalChars - render(persona, 'x'.repeat(budget.snapshotMaxChars), '', []).length;
}
