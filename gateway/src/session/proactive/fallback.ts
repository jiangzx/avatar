/** First line not used recently; if all were, the oldest recent one. `recent` is newest first. */
export function pickFallback(count: number, recent: readonly number[]): number {
  const valid = recent.filter((i) => Number.isInteger(i) && i >= 0 && i < count);
  for (let i = 0; i < count; i++) if (!valid.includes(i)) return i;
  return valid[valid.length - 1] ?? 0;
}
