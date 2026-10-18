import { fileURLToPath } from 'node:url';
import { loadSafetyConfig } from '../config.ts';

const safety = loadSafetyConfig(fileURLToPath(new URL('../../config/safety.json', import.meta.url)));

/** Map configured Chinese numerals to ASCII digits. */
export function normalizeChineseDigits(text: string): string {
  let out = '';
  for (const ch of text) out += safety.chineseDigits[ch] ?? ch;
  return out;
}

/** Normalize numerals, then mask each run of at least minMaskedDigits. */
export function redact(text: string): string {
  const normalized = normalizeChineseDigits(text);
  const pattern = new RegExp(`\\d{${safety.minMaskedDigits},}`, 'g');
  return normalized.replace(pattern, (run) => '*'.repeat(run.length));
}
