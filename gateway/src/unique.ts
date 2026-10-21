/** Order-preserving deduplication shared by config and i18n loaders. */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
