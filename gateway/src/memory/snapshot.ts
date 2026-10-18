export function renderSnapshot(input: {
  facts: readonly { category: string; text: string }[]
  notes: readonly { text: string }[]
  tail: readonly { role: 'user' | 'assistant'; text: string }[]
  maxChars: number
}): string {
  const addressing = input.facts.filter((f) => f.category === 'addressing' && f.text).map((f) => f.text);
  const other = input.facts.filter((f) => f.category !== 'addressing' && f.text).map((f) => f.text);
  const notes = input.notes.filter((n) => n.text).map((n) => n.text);
  const tail = input.tail.filter((t) => t.text).map((t) => `${t.role === 'user' ? '用户' : '助手'}：${t.text}`);
  const head = addressing.join('\n');
  // Names stay whole even when the addressing block itself exceeds the budget.
  if (head.length > input.maxChars) return head;
  const body = [...(head ? [head] : []), ...other, ...notes, ...tail].join('\n');
  return clipToFit(body, input.maxChars);
}

/** Keeps a prefix of whole lines. Never splits a fact. */
export function clipToFit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const kept: string[] = [];
  let used = 0;
  for (const line of text.split('\n')) {
    const next = kept.length === 0 ? line.length : used + 1 + line.length;
    if (next > maxChars) break;
    kept.push(line);
    used = next;
  }
  return kept.join('\n');
}
