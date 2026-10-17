/** Parses the gateway's JSON log lines (content-free) for acceptance reports. */
export interface LogLine {
  t: string;
  event: string;
  [k: string]: unknown;
}

export function parseLogLines(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const v = JSON.parse(line) as Partial<LogLine>;
      if (typeof v.t === 'string' && typeof v.event === 'string') out.push(v as LogLine);
    } catch {
      // not a gateway log line
    }
  }
  return out;
}

/** Nearest-rank percentile of an ascending list (same rule as app/lib/metrics.dart). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

const METRIC_FIELDS = ['speech_to_first_audio_ms', 'vad_to_first_audio_ms', 'gen_ms', 'input_tokens', 'output_tokens', 'reply_chars'] as const;

export function summarizeReplyMetrics(lines: LogLine[]): Record<string, { n: number; p50: number; p90: number }> {
  const out: Record<string, { n: number; p50: number; p90: number }> = {};
  const rows = lines.filter((l) => l.event === 'reply_metrics');
  for (const field of METRIC_FIELDS) {
    const values = rows.map((r) => r[field]).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    out[field] = { n: values.length, p50: percentile(values, 50), p90: percentile(values, 90) };
  }
  return out;
}

/**
 * Silence gate: a 'reply' without a local `vad_edge speaking` since the previous response is unprompted
 * (speaker echo or noise). 'followup' responses are proactive; greeting is excluded.
 */
export function analyzeSilence(lines: LogLine[], windowMs = 300_000): { replies: number; unprompted: number; proactive: number; maxProactivePerWindow: number } {
  let sawSpeech = false;
  let replies = 0;
  let unprompted = 0;
  const proactiveAt: number[] = [];
  for (const l of lines) {
    if (l.event === 'vad_edge' && l.state === 'speaking') sawSpeech = true;
    if (l.event !== 'response_start') continue;
    if (l.kind === 'reply') {
      replies++;
      if (!sawSpeech) unprompted++;
    } else if (l.kind === 'followup') proactiveAt.push(Date.parse(l.t));
    sawSpeech = false;
  }
  let maxProactivePerWindow = 0;
  for (let i = 0; i < proactiveAt.length; i++) {
    const inWindow = proactiveAt.filter((t) => t >= proactiveAt[i]! && t < proactiveAt[i]! + windowMs).length;
    maxProactivePerWindow = Math.max(maxProactivePerWindow, inWindow);
  }
  return { replies, unprompted, proactive: proactiveAt.length, maxProactivePerWindow };
}
