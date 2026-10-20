/**
 * A user line is memory evidence only when it is a statement.
 * Questions, challenges, denials, and configured skip phrases never become recalled facts.
 */
export function isMemoryEvidence(text: string, skipPatterns: readonly string[]): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (/[？?]\s*$/.test(cleaned)) return false;
  return !skipPatterns.some((pattern) => pattern.length > 0 && cleaned.includes(pattern));
}
