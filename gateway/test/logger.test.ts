import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, defaultLogger, type LogLine } from '../src/log/logger.ts';
import { createLogLevelControl } from '../src/log/levels.ts';
import { ownerShortId } from '../src/log/ownerId.ts';
import { stdoutSink } from '../src/log/stdoutSink.ts';
import { captureLogger } from './helpers/logCapture.ts';

afterEach(() => { vi.restoreAllMocks(); });

describe('createLogger', () => {
  it('writes level, event, binding and fields to every sink', () => {
    const { logger, lines } = captureLogger();
    logger.child({ sid: 's1', oid: 'o1', char: 'xiaonuan' }).child({ seq: 3 }).warn('response_end', { ms: 5 });
    expect(lines).toEqual([{ t: expect.any(Number), level: 'warn', event: 'response_end', binding: { sid: 's1', oid: 'o1', char: 'xiaonuan', seq: 3 }, fields: { ms: 5 } }]);
  });

  it('lets later bindings win and ignores undefined binding values', () => {
    const { logger, lines } = captureLogger();
    logger.child({ sid: 'a', char: 'xiaokai' }).child({ sid: 'b', oid: undefined }).info('x');
    expect(lines[0]!.binding).toEqual({ sid: 'b', char: 'xiaokai' });
  });

  it('drops reserved keys passed as fields', () => {
    const { logger, lines } = captureLogger();
    logger.child({ seq: 1 }).info('reply_metrics', { seq: 9, level: 'x', event: 'y', t: 1, sid: 's', reply_chars: 4 });
    expect(lines[0]!.fields).toEqual({ reply_chars: 4 });
    expect(lines[0]!.binding).toEqual({ seq: 1 });
  });

  it('filters by the level control, per owner', () => {
    const lines: LogLine[] = [];
    const levels = createLogLevelControl('info', () => 0);
    const logger = createLogger({ sinks: [{ write: (l) => { lines.push(l); } }], levels, strict: true });
    logger.debug('quiet');
    levels.setOverride({ scope: 'owner', oid: 'o1', level: 'debug', until: 10, actor: 'admin' });
    logger.child({ oid: 'o1' }).debug('loud');
    logger.child({ oid: 'o2' }).debug('still_quiet');
    expect(lines.map((l) => l.event)).toEqual(['loud']);
  });

  it('throws on banned fields and bad event names in strict mode', () => {
    const { logger } = captureLogger();
    expect(() => logger.info('affect', { text: '腰疼' })).toThrow('log_field_rejected:affect:text');
    expect(() => logger.info('Bad Event')).toThrow('log_event_invalid');
  });

  it('drops banned fields and reports them in lenient mode', () => {
    const { logger, lines } = captureLogger({ strict: false });
    logger.child({ sid: 's1' }).info('affect', { text: '腰疼', ms: 2 });
    expect(lines.map((l) => [l.level, l.event, l.fields])).toEqual([
      ['info', 'affect', { ms: 2 }],
      ['warn', 'log_field_rejected', { rejected_event: 'affect', field: 'text' }],
    ]);
    expect(JSON.stringify(lines)).not.toContain('腰疼');
  });

  it('keeps log_field_rejected as the top-level event on stdout', () => {
    const out: string[] = [];
    const logger = createLogger({
      sinks: [stdoutSink((s) => { out.push(s); })],
      levels: createLogLevelControl('info'),
      strict: false,
    });
    logger.info('affect', { text: '腰疼' });
    expect(out).toHaveLength(2);
    const rejected = JSON.parse(out[1]!) as Record<string, unknown>;
    expect(rejected).toMatchObject({ level: 'warn', event: 'log_field_rejected', rejected_event: 'affect', field: 'text' });
    expect(JSON.stringify(out)).not.toContain('腰疼');
  });

  it('keeps going when a sink throws', () => {
    const lines: LogLine[] = [];
    const logger = createLogger({
      sinks: [{ write: () => { throw new Error('disk full'); } }, { write: (l) => { lines.push(l); } }],
      levels: createLogLevelControl('info'),
      strict: true,
    });
    expect(() => logger.info('x')).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe('stdoutSink', () => {
  it('prints one ISO-timed JSON line with oid wrapped in {E}', () => {
    const out: string[] = [];
    stdoutSink((s) => { out.push(s); }).write({ t: Date.UTC(2026, 9, 27), level: 'info', event: 'session_created', binding: { sid: 's1', oid: 'abc123def456', char: 'xiaonuan' }, fields: { sessions: 1 } });
    expect(out).toEqual(['{"t":"2026-10-27T00:00:00.000Z","level":"info","event":"session_created","sid":"s1","oid":"{E}abc123def456","char":"xiaonuan","sessions":1}\n']);
  });

  it('defaults to process.stdout looked up at write time', () => {
    const writes: string[] = [];
    const logger = defaultLogger();
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write);
    logger.info('gateway_listening', { port: 1 });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toMatchObject({ level: 'info', event: 'gateway_listening', port: 1 });
  });

  it('hides debug lines by default', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    defaultLogger().debug('session_push', { instructions: true });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('ownerShortId', () => {
  it('is a stable 12-char sha256 prefix', () => {
    expect(ownerShortId('owner-1')).toMatch(/^[0-9a-f]{12}$/);
    expect(ownerShortId('owner-1')).toBe(ownerShortId('owner-1'));
    expect(ownerShortId('owner-1')).not.toBe(ownerShortId('owner-2'));
  });
});
