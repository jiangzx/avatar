import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CHARACTER_IDS, LANGUAGES } from '@anyidea/protocol';
import { loadRealtimeRegistry, missingRealtimePrices, voiceFor } from '../src/realtime/models.ts';
import { loadPricingBaseline } from '../src/usage/pricing.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const path = `${root}config/realtime.json`;
const tmp = mkdtempSync(join(tmpdir(), 'realtime-models-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function broken(mutate: (doc: Record<string, any>) => void): string {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  mutate(doc);
  const file = join(tmp, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

describe('realtime registry', () => {
  it('loads both shipped models and covers every character and language', () => {
    const registry = loadRealtimeRegistry(path, { defaultModel: 'qwen3.8-omni-flash-realtime' });
    expect(registry.ids).toEqual(['qwen3.8-omni-flash-realtime', 'qwen-audio-3.1-realtime-flash']);
    for (const id of registry.ids) {
      const model = registry.get(id);
      for (const language of LANGUAGES) {
        expect(model.voices.catalog[language].length).toBeGreaterThan(0);
        for (const characterId of CHARACTER_IDS) {
          const voice = model.voices.byCharacter[characterId]![language];
          expect(voice).toBeTruthy();
          expect(model.voices.catalog[language].some((option) => option.value === voice)).toBe(true);
        }
      }
    }
    expect(registry.get('qwen3.8-omni-flash-realtime').speechRate).toBeNull();
    expect(registry.get('qwen-audio-3.1-realtime-flash').speechRate).toMatchObject({ min: 0.5, max: 2, default: 1, low: 0.8 });
    expect(voiceFor(registry.get('qwen3.8-omni-flash-realtime'), 'xiaonuan', 'zh')).toBe('longanlingxin');
  });

  it('rejects an unknown default model', () => {
    expect(() => loadRealtimeRegistry(path, { defaultModel: 'nope' })).toThrow('realtime_model_unknown:nope');
  });

  it('rejects a character voice that is not in that model language catalog', () => {
    const file = broken((doc) => { doc.models['qwen-audio-3.1-realtime-flash'].voices.byCharacter.xiaonuan.zh = 'nope'; });
    expect(() => loadRealtimeRegistry(file, { defaultModel: 'qwen-audio-3.1-realtime-flash' })).toThrow(
      'realtime_voice_invalid:qwen-audio-3.1-realtime-flash:xiaonuan:zh',
    );
  });

  it('rejects speech rate bounds that ignore the model range', () => {
    // Keep the value inside the zod range but above default, so the cross-field check is what rejects it.
    const file = broken((doc) => { doc.models['qwen-audio-3.1-realtime-flash'].speechRate.low = 1.5; });
    expect(() => loadRealtimeRegistry(file)).toThrow('realtime_speech_rate_invalid:qwen-audio-3.1-realtime-flash');
  });

  it('reports models without a realtime audio price', () => {
    const registry = loadRealtimeRegistry(path);
    expect(missingRealtimePrices(registry, new Set(['qwen3.8-omni-flash-realtime']))).toEqual([
      'qwen-audio-3.1-realtime-flash',
    ]);
  });

  it('prices every shipped model', () => {
    const priced = new Set(loadPricingBaseline(`${root}config/pricing.json`).map((entry) => entry.model));
    expect(missingRealtimePrices(loadRealtimeRegistry(path), priced)).toEqual([]);
  });
});
