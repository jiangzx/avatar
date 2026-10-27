import { describe, expect, it } from 'vitest';
import { DEFAULT_I18N } from '../src/i18n/load.ts';
import { createToolRegistry } from '../src/session/tools/registry.ts';
import {
  conditionKey,
  loadWeatherConfig,
  lookupWeather,
  readLocation,
  weatherLine,
  type WeatherCopy,
  type WeatherFetch,
} from '../src/session/tools/weather.ts';
import type { ToolContext } from '../src/session/tools/registry.ts';
import { ActionRouter } from '../src/session/actions.ts';
import { ConversationLedger } from '../src/session/ledger.ts';
import { NO_TURN } from '../src/session/turnAccess.ts';

const copy: WeatherCopy = DEFAULT_I18N.memory.zh.weather;
const config = loadWeatherConfig();

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<WeatherFetch>> {
  return { ok: status >= 200 && status < 300, json: async () => body };
}

function fetchOf(bodies: unknown[]): WeatherFetch {
  const pending = [...bodies];
  return async () => jsonResponse(200, pending.shift());
}

const geo = { results: [{ name: '北京', latitude: 39.9, longitude: 116.4 }] };
const forecast = {
  current: { temperature_2m: 18.4, weather_code: 61 },
  daily: { temperature_2m_max: [22.2], temperature_2m_min: [11.6] },
};

describe('weather lookup', () => {
  it('maps a forecast into the configured sentence', () => {
    expect(conditionKey(0)).toBe('clear');
    expect(conditionKey(61)).toBe('rain');
    expect(conditionKey(95)).toBe('thunder');
    expect(conditionKey(123)).toBe('unknown');
    expect(weatherLine(copy, { place: '北京', code: 61, temp: 18.4, max: 22.2, min: 11.6 }))
      .toBe('北京今天下雨，现在大约18度，最高22度，最低12度。');
  });

  it('asks when the model did not name a place', () => {
    expect(readLocation({})).toBeNull();
    expect(readLocation({ location: '  北京  ' })).toBe('北京');
    expect(readLocation({ location: 'x'.repeat(33) })).toBeNull();
  });

  it('returns the spoken line for a known place and a miss for an unknown one', async () => {
    const hit = await lookupWeather('北京', copy, config, fetchOf([geo, forecast]), 'zh');
    expect(hit).toEqual({ ok: true, text: '北京今天下雨，现在大约18度，最高22度，最低12度。' });
    const miss = await lookupWeather('不存在', copy, config, fetchOf([{ results: [] }]), 'zh');
    expect(miss).toEqual({ ok: false, error: 'not_found', text: copy.notFoundText });
  });

  it('does not throw when the weather service fails', async () => {
    const down: WeatherFetch = async () => jsonResponse(503, {});
    const failed = await lookupWeather('北京', copy, config, down, 'zh');
    expect(failed).toEqual({ ok: false, error: 'weather_unavailable', text: copy.unavailableText });
  });

  it('is offered to the model and speaks only the lookup result', async () => {
    const registry = createToolRegistry({
      language: 'zh',
      memory: DEFAULT_I18N.memory.zh,
      evidence: DEFAULT_I18N.evidence,
      recentQueries: DEFAULT_I18N.recentQueries,
      recallPrompt: 'fixture',
      safety: DEFAULT_I18N.safety,
      clipChars: 80,
      phraseTimeoutMs: 1_500,
      weatherFetch: fetchOf([geo, forecast]),
    });
    expect(registry.specs().some((spec) => spec.name === 'get_weather')).toBe(true);
    const ctx = {
      sessionId: 's1',
      ledger: new ConversationLedger(),
      actions: new ActionRouter(),
      now: 1,
      characterId: 'xiaonuan',
      turn: NO_TURN,
      memoryGate: () => 'ok' as const,
    } satisfies ToolContext;
    await expect(registry.handle('get_weather', {}, ctx)).resolves.toEqual({
      ok: false,
      error: 'location_required',
      text: copy.missingLocationText,
    });
    await expect(registry.handle('get_weather', { location: '北京' }, ctx)).resolves.toEqual({
      ok: true,
      text: '北京今天下雨，现在大约18度，最高22度，最低12度。',
      spokenText: '北京今天下雨，现在大约18度，最高22度，最低12度。',
    });
  });
});
