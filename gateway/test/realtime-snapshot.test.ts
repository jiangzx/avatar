import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { ConfigInvalidError } from '../src/config-store/errors.ts';
import { parseOverlayKey, readTargetValue, type ModelDefaults, type Overlay } from '../src/config-store/keys.ts';
import { buildConfigSnapshot } from '../src/session/configSnapshot.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = loadConfig({ APP_SECRET: 'test-secret-0123456789' });
const models: ModelDefaults = {
  realtimeEndpoint: 'wss://example.invalid/realtime',
  realtimeModel: 'qwen3.8-omni-flash-realtime',
  textEndpoint: 'https://example.invalid/chat',
  summarizerModel: 'qwen-flash',
};
const voiceDefaults = { zh: 'env-zh', ja: 'env-ja', en: 'env-en' };
const tmpRoot = mkdtempSync(join(tmpdir(), 'realtime-snapshot-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function build(overlay: Overlay) {
  return buildConfigSnapshot({
    gatewayRoot: root, overlay, version: 1, ledger: env.ledger,
    sessionStartTimeoutMs: env.sessionStartTimeoutMs, models, voiceDefaults, tmpRoot,
  });
}

describe('realtime snapshot', () => {
  it('defaults to 3.8 with its turn detection, live voice updates and baseline voices', () => {
    const snap = build({});
    expect(snap.realtime.model).toBe('qwen3.8-omni-flash-realtime');
    expect(snap.realtime.turnDetection).toEqual({ type: 'semantic_vad', silenceDurationMs: 800 });
    expect(snap.realtime.speechRate).toBeNull();
    expect(snap.realtime.voiceUpdate).toBe('live');
    expect(snap.realtime.voices.xiaonuan.zh).toBe('longanlingxin');
    expect(snap.realtime.voices.xiaokai.zh).toBe('Evan');
  });

  it('switches model in the snapshot and uses that model capability and voices', () => {
    const snap = build({ 'model:qwen.realtimeModel': 'qwen-audio-3.1-realtime-flash' });
    expect(snap.realtime.model).toBe('qwen-audio-3.1-realtime-flash');
    expect(snap.realtime.turnDetection).toEqual({ type: 'server_vad', silenceDurationMs: 800 });
    expect(snap.realtime.speechRate).toMatchObject({ low: 0.8, default: 1 });
    expect(snap.realtime.voiceUpdate).toBe('connect_only');
    expect(snap.realtime.voices.xiaonuan.zh).toBe('longanlingxin_v3.1');
  });

  it('applies a per-model voice overlay', () => {
    const snap = build({
      'model:qwen.realtimeModel': 'qwen-audio-3.1-realtime-flash',
      'voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh': 'longanqian_v3.1',
    });
    expect(snap.realtime.voices.xiaonuan.zh).toBe('longanqian_v3.1');
  });

  it('keeps an old character voice overlay on the env default model, but the new overlay wins', () => {
    const old = build({ 'character:xiaonuan.voices.qwen.zh': 'Ryan' });
    expect(old.realtime.voices.xiaonuan.zh).toBe('Ryan');
    const both = build({
      'character:xiaonuan.voices.qwen.zh': 'Ryan',
      'voice:qwen3.8-omni-flash-realtime/xiaonuan.zh': 'Evan',
    });
    expect(both.realtime.voices.xiaonuan.zh).toBe('Evan');
  });

  it('ignores the old character voice overlay on a non-default model', () => {
    const snap = build({
      'model:qwen.realtimeModel': 'qwen-audio-3.1-realtime-flash',
      'character:xiaonuan.voices.qwen.zh': 'Ryan',
    });
    expect(snap.realtime.voices.xiaonuan.zh).toBe('longanlingxin_v3.1');
  });

  it('rejects an unknown model with a Chinese startup message', () => {
    expect(() => build({ 'model:qwen.realtimeModel': 'nope' })).toThrow(ConfigInvalidError);
    try {
      build({ 'model:qwen.realtimeModel': 'nope' });
    } catch (error) {
      expect((error as ConfigInvalidError).issues[0]?.message).toContain('通话模型不存在');
    }
  });

  it('parses and reads the per-model voice target', () => {
    const target = parseOverlayKey('voice:qwen-audio-3.1-realtime-flash/xiaonuan.zh');
    expect(target).toEqual({
      kind: 'voice', model: 'qwen-audio-3.1-realtime-flash', character: 'xiaonuan', language: 'zh',
    });
    expect(readTargetValue(root, target, models)).toBe('longanlingxin_v3.1');
  });

  it('rejects a bad character or language in the voice key', () => {
    expect(() => parseOverlayKey('voice:qwen-audio-3.1-realtime-flash/nope.zh')).toThrow('overlay_key_invalid');
    expect(() => parseOverlayKey('voice:qwen-audio-3.1-realtime-flash/xiaonuan.fr')).toThrow('overlay_key_invalid');
  });
});
