import { guardFields } from './fieldGuard.ts';
import { createLogLevelControl, type LogLevelControl } from './levels.ts';
import { stdoutSink } from './stdoutSink.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogField = string | number | boolean | null;
export type LogFields = Record<string, LogField>;
export interface LogBinding { sid?: string; oid?: string; char?: string; seq?: number; job?: string }
export interface LogLine { t: number; level: LogLevel; event: string; binding: LogBinding; fields: LogFields }
export interface LogSink { write(line: LogLine): void }
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(binding: LogBinding): Logger; // merges; later keys win
}
export interface LoggerOptions { sinks: readonly LogSink[]; levels: LogLevelControl; strict: boolean; now?: () => number }

export const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED = new Set(['t', 'level', 'event', 'sid', 'oid', 'char', 'seq', 'job']);
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Content-free structured logger. Shared resources are injected; the logger itself holds no global state. */
export function createLogger(options: LoggerOptions): Logger {
  return bind(options, {});
}

/** Immutable default for tests and scripts: stdout sink, fixed info level, strict guard. */
export function defaultLogger(): Logger {
  return createLogger({ sinks: [stdoutSink()], levels: createLogLevelControl('info'), strict: true });
}

function bind(options: LoggerOptions, binding: LogBinding): Logger {
  const now = options.now ?? Date.now;
  const write = (line: LogLine) => {
    for (const sink of options.sinks) {
      try { sink.write(line); } catch { /* a sink reports its own failures; logging never breaks the caller */ }
    }
  };
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[options.levels.levelFor(binding.oid)]) return;
    let name = event;
    if (!EVENT_NAME.test(name)) {
      if (options.strict) throw new Error('log_event_invalid');
      name = 'log_event_invalid';
    }
    const open: LogFields = {};
    for (const [key, value] of Object.entries(fields)) if (!RESERVED.has(key)) open[key] = value;
    const guarded = guardFields(name, open, options.strict);
    const t = now();
    write({ t, level, event: name, binding, fields: guarded.fields });
    if (guarded.rejected.length > 0) {
      write({ t, level: 'warn', event: 'log_field_rejected', binding, fields: { rejected_event: name, field: guarded.rejected.join(',') } });
    }
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (next) => bind(options, merge(binding, next)),
  };
}

function merge(base: LogBinding, next: LogBinding): LogBinding {
  const out: LogBinding = { ...base };
  for (const [key, value] of Object.entries(next) as Array<[keyof LogBinding, string | number | undefined]>) {
    if (value !== undefined) (out as Record<string, string | number>)[key] = value;
  }
  return out;
}
