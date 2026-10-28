export interface DiffOp { type: 'same' | 'del' | 'ins'; text: string }

function push(ops: DiffOp[], type: DiffOp['type'], text: string): void {
  if (!text) return;
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.text += text;
  else ops.push({ type, text });
}

/** Character diff (LCS) after trimming the shared prefix and suffix; too large -> one delete plus one insert. */
export function diffText(before: string, after: string, maxCells = 4_000_000): DiffOp[] {
  const a = Array.from(before);
  const b = Array.from(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops: DiffOp[] = [];
  push(ops, 'same', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > maxCells) {
    push(ops, 'del', midA.join(''));
    push(ops, 'ins', midB.join(''));
  } else {
    lcs(midA, midB, ops);
  }
  push(ops, 'same', a.slice(endA).join(''));
  return ops;
}

function lcs(a: string[], b: string[], ops: DiffOp[]): void {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(ops, 'same', a[i]!); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { push(ops, 'del', a[i]!); i++; }
    else { push(ops, 'ins', b[j]!); j++; }
  }
  while (i < n) push(ops, 'del', a[i++]!);
  while (j < m) push(ops, 'ins', b[j++]!);
}
