import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { WeatherCopy } from '../../i18n/types.ts';
import type { ToolHandler } from './registry.ts';

export type { WeatherCopy };

export const WEATHER_CONDITIONS = [
  'clear',
  'mainlyClear',
  'partlyCloudy',
  'overcast',
  'fog',
  'drizzle',
  'rain',
  'freezingRain',
  'snow',
  'showers',
  'snowShowers',
  'thunder',
  'unknown',
] as const;

export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];

export interface WeatherConfig {
  timeoutMs: number;
  geocodeUrl: string;
  forecastUrl: string;
}

const WeatherConfigSchema = z.object({
  timeoutMs: z.number().int().min(500).max(15_000),
  geocodeUrl: z.string().url(),
  forecastUrl: z.string().url(),
}).strict();

const GeoSchema = z.object({
  results: z.array(z.object({
    name: z.string().min(1),
    latitude: z.number(),
    longitude: z.number(),
  })).optional(),
});

const ForecastSchema = z.object({
  current: z.object({
    temperature_2m: z.number(),
    weather_code: z.number().int(),
  }),
  daily: z.object({
    temperature_2m_max: z.array(z.number()).min(1),
    temperature_2m_min: z.array(z.number()).min(1),
  }),
});

export type WeatherResult =
  | { ok: true; text: string }
  | { ok: false; error: 'not_found' | 'weather_unavailable'; text: string };

export interface WeatherFetch {
  (url: string, signal: AbortSignal): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

/** WMO code used by Open-Meteo, grouped into the phrases in config. */
export function conditionKey(code: number): WeatherCondition {
  if (code === 0) return 'clear';
  if (code === 1) return 'mainlyClear';
  if (code === 2) return 'partlyCloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code === 51 || code === 53 || code === 55) return 'drizzle';
  if (code === 56 || code === 57 || code === 66 || code === 67) return 'freezingRain';
  if (code === 61 || code === 63 || code === 65) return 'rain';
  if (code === 71 || code === 73 || code === 75 || code === 77) return 'snow';
  if (code === 80 || code === 81 || code === 82) return 'showers';
  if (code === 85 || code === 86) return 'snowShowers';
  if (code === 95 || code === 96 || code === 99) return 'thunder';
  return 'unknown';
}

export function weatherLine(
  copy: WeatherCopy,
  facts: { place: string; code: number; temp: number; max: number; min: number },
): string {
  return copy.line
    .replaceAll('{place}', facts.place)
    .replaceAll('{condition}', copy.conditions[conditionKey(facts.code)])
    .replaceAll('{temp}', String(Math.round(facts.temp)))
    .replaceAll('{max}', String(Math.round(facts.max)))
    .replaceAll('{min}', String(Math.round(facts.min)));
}

/** City the model named. Empty, too long, or non-text means the caller should ask. */
export function readLocation(args: unknown): string | null {
  let value = args;
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const raw = (value as { location?: unknown }).location;
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\u0000-\u001f]/g, '').trim();
  if (!text || [...text].length > 32) return null;
  return text;
}

export function loadWeatherConfig(path = fileURLToPath(new URL('../../../config/weather.json', import.meta.url))): WeatherConfig {
  const parsed = WeatherConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error('weather_config_invalid');
  for (const url of [parsed.data.geocodeUrl, parsed.data.forecastUrl]) {
    if (new URL(url).protocol !== 'https:') throw new Error('weather_config_invalid');
  }
  return parsed.data;
}

export async function lookupWeather(
  location: string,
  copy: WeatherCopy,
  config: WeatherConfig,
  fetchImpl: WeatherFetch,
  language: string,
): Promise<WeatherResult> {
  const signal = AbortSignal.timeout(config.timeoutMs);
  try {
    const geoUrl = new URL(config.geocodeUrl);
    geoUrl.searchParams.set('name', location);
    geoUrl.searchParams.set('count', '1');
    geoUrl.searchParams.set('language', language);
    geoUrl.searchParams.set('format', 'json');
    const geoResponse = await fetchImpl(geoUrl.toString(), signal);
    if (!geoResponse.ok) return unavailable(copy);
    const geo = GeoSchema.safeParse(await geoResponse.json());
    const place = geo.success ? geo.data.results?.[0] : undefined;
    if (!place) return { ok: false, error: 'not_found', text: copy.notFoundText };
    const forecastUrl = new URL(config.forecastUrl);
    forecastUrl.searchParams.set('latitude', String(place.latitude));
    forecastUrl.searchParams.set('longitude', String(place.longitude));
    forecastUrl.searchParams.set('current', 'temperature_2m,weather_code');
    forecastUrl.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min');
    forecastUrl.searchParams.set('timezone', 'auto');
    forecastUrl.searchParams.set('forecast_days', '1');
    const forecastResponse = await fetchImpl(forecastUrl.toString(), signal);
    if (!forecastResponse.ok) return unavailable(copy);
    const forecast = ForecastSchema.safeParse(await forecastResponse.json());
    if (!forecast.success) return unavailable(copy);
    const max = forecast.data.daily.temperature_2m_max[0];
    const min = forecast.data.daily.temperature_2m_min[0];
    if (max === undefined || min === undefined) return unavailable(copy);
    return {
      ok: true,
      text: weatherLine(copy, {
        place: place.name,
        code: forecast.data.current.weather_code,
        temp: forecast.data.current.temperature_2m,
        max,
        min,
      }),
    };
  } catch {
    return unavailable(copy);
  }
}

function unavailable(copy: WeatherCopy): WeatherResult {
  return { ok: false, error: 'weather_unavailable', text: copy.unavailableText };
}

export function weatherTool(
  copy: WeatherCopy,
  config: WeatherConfig,
  language: string,
  fetchImpl: WeatherFetch,
): ToolHandler {
  return {
    spec: {
      name: 'get_weather',
      description: copy.toolDescription,
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: copy.locationDescription },
        },
      },
    },
    async handle(args: unknown) {
      const location = readLocation(args);
      if (!location) return { ok: false, error: 'location_required', text: copy.missingLocationText };
      const result = await lookupWeather(location, copy, config, fetchImpl, language);
      // Speak the forecast itself. A free continuation turns it into small talk.
      return result.ok ? { ...result, spokenText: result.text } : result;
    },
  };
}
