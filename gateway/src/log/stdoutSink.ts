import type { LogSink } from './logger.ts';

/** One JSON line per entry. `oid` is L3 user data, so stdout wraps it in {E}. */
export function stdoutSink(write: (s: string) => void = (s) => { process.stdout.write(s); }): LogSink {
  return {
    write(line) {
      const { sid, oid, char, seq, job } = line.binding;
      const record: Record<string, unknown> = { t: new Date(line.t).toISOString(), level: line.level, event: line.event };
      if (sid !== undefined) record.sid = sid;
      if (oid !== undefined) record.oid = `{E}${oid}`;
      if (char !== undefined) record.char = char;
      if (seq !== undefined) record.seq = seq;
      if (job !== undefined) record.job = job;
      try { write(`${JSON.stringify({ ...record, ...line.fields })}\n`); } catch { /* stdout closed: nothing else to report to */ }
    },
  };
}
