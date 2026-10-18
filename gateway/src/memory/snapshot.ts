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
  const kept: string[] = [];
  for (const line of [...addressing, ...other, ...notes]) {
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

function joinedLength(lines: readonly string[]): number {
  let used = 0;
  for (const line of lines) used = used === 0 ? line.length : used + 1 + line.length;
  return used;
}
