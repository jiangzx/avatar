/**
 * A user line is memory evidence only when it is a statement.
 * Questions, challenges, denials, and configured skip phrases never become recalled facts.
 */
export function isMemoryEvidence(
  text: string,
  skipPatterns: readonly string[],
  lightAcks: readonly string[] = [],
): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  // Light acknowledgements only count when they are the whole utterance; "好的，我喜欢听京剧" is a statement.
  const normalized = normalizeUtterance(cleaned);
  if (lightAcks.some((ack) => normalizeUtterance(ack) === normalized)) return false;
  if (/[？?]\s*$/.test(cleaned)) return false;
  // ASR often drops the question mark: "你吃饭了吗。"
  if (/(?:吗|呢|么|嘛|来着)\s*[。.!！…~～]*$/.test(cleaned)) return false;
  return !skipPatterns.some((pattern) => pattern.length > 0 && cleaned.includes(pattern));
}

/** Whitespace and sentence punctuation are not evidence-bearing. */
function normalizeUtterance(text: string): string {
  return text.replace(/[\s。！？!?，,、.~～…]+/gu, '');
}
