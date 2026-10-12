type Field = string | number | boolean | null;

/**
 * Structured log line. NEVER pass conversation content (audio, ASR text, replies):
 * only event names, ids, counts, durations and error codes.
 */
export function log(event: string, fields: Record<string, Field> = {}): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}
