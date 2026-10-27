import { createLogger, type LogLevel, type LogLine, type Logger } from '../../src/log/logger.ts';
import { createLogLevelControl } from '../../src/log/levels.ts';

/** In-memory logger for tests: every line at or above `level` (default debug), strict by default. */
export function captureLogger(opts: { level?: LogLevel; strict?: boolean } = {}): { logger: Logger; lines: LogLine[]; events(name?: string): LogLine[] } {
  const lines: LogLine[] = [];
  const logger = createLogger({
    sinks: [{ write: (line) => { lines.push(line); } }],
    levels: createLogLevelControl(opts.level ?? 'debug'),
    strict: opts.strict ?? true,
  });
  return { logger, lines, events: (name) => (name === undefined ? lines : lines.filter((line) => line.event === name)) };
}
