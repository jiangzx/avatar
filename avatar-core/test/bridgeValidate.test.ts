import { describe, expect, it } from 'vitest';
import { MAX_APP_SECRET_LEN, MAX_DEBUG_TEXT_LEN, parseFromFlutter } from '../src/bridgeValidate.ts';

const cfg = (over: Record<string, unknown> = {}) => ({
  type: 'config',
  gatewayUrl: 'http://10.0.2.2:8787',
  appSecret: 's3cret',
  audioPath: 'A',
  echo: 'true',
  ...over,
});

describe('parseFromFlutter', () => {
  it('accepts a valid config and keeps only contract fields', () => {
    expect(parseFromFlutter({ ...cfg(), extra: 1 })).toEqual(cfg());
    expect(parseFromFlutter(cfg({ echo: undefined }))).toEqual({ ...cfg(), echo: undefined });
    expect(parseFromFlutter(cfg({ audioPath: 'B', echo: 'all' }))).toEqual(cfg({ audioPath: 'B', echo: 'all' }));
  });

  it('accepts loopback, emulator and RFC1918 gateway hosts', () => {
    for (const url of [
      'http://127.0.0.1:8787',
      'http://localhost:8787',
      'http://10.0.2.2:8787',
      'https://192.168.1.20:8787',
      'http://10.1.2.3',
      'http://172.16.0.1',
      'http://172.31.255.254',
    ]) {
      expect(parseFromFlutter(cfg({ gatewayUrl: url })), url).not.toBeNull();
    }
  });

  it('rejects public hosts, userinfo and non-http schemes', () => {
    for (const url of [
      'https://evil.example',
      'http://user@127.0.0.1',
      'http://user:pw@127.0.0.1',
      'ws://127.0.0.1:8787',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http://172.32.0.1',
      'http://172.15.255.255',
      'http://192.168.1.1.evil.example',
      'http://8.8.8.8',
      'not a url',
      42,
    ]) {
      expect(parseFromFlutter(cfg({ gatewayUrl: url })), String(url)).toBeNull();
    }
  });

  it('rejects bad config enums and secrets', () => {
    expect(parseFromFlutter(cfg({ audioPath: 'C' }))).toBeNull();
    expect(parseFromFlutter(cfg({ audioPath: undefined }))).toBeNull();
    expect(parseFromFlutter(cfg({ echo: 'none' }))).toBeNull();
    expect(parseFromFlutter(cfg({ echo: true }))).toBeNull();
    expect(parseFromFlutter(cfg({ appSecret: '' }))).toBeNull();
    expect(parseFromFlutter(cfg({ appSecret: 7 }))).toBeNull();
    expect(parseFromFlutter(cfg({ appSecret: 'x'.repeat(MAX_APP_SECRET_LEN + 1) }))).toBeNull();
  });

  it('validates mute, end and debugText', () => {
    expect(parseFromFlutter({ type: 'mute', muted: true })).toEqual({ type: 'mute', muted: true });
    expect(parseFromFlutter({ type: 'mute', muted: 'false' })).toBeNull();
    expect(parseFromFlutter({ type: 'mute' })).toBeNull();
    expect(parseFromFlutter({ type: 'end' })).toEqual({ type: 'end' });
    expect(parseFromFlutter({ type: 'debugText', text: '给我比心' })).toEqual({ type: 'debugText', text: '给我比心' });
    expect(parseFromFlutter({ type: 'debugText', text: 'x'.repeat(MAX_DEBUG_TEXT_LEN) })).not.toBeNull();
    expect(parseFromFlutter({ type: 'debugText', text: 'x'.repeat(MAX_DEBUG_TEXT_LEN + 1) })).toBeNull();
    expect(parseFromFlutter({ type: 'debugText', text: 5 })).toBeNull();
  });

  it('rejects unknown types and garbage', () => {
    for (const raw of [null, undefined, [], ['config'], 'config', 1, {}, { type: 'reboot' }, { type: 7 }]) {
      expect(parseFromFlutter(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});
