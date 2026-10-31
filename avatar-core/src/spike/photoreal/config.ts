import type { PhotorealConfig } from './types.ts';

export const DEFAULT_PHOTOREAL_CONFIG: PhotorealConfig = {
  fps: 25,
  melSampleRate: 16000,
  melBins: 80,
  melWindow: 16,
  faceSize: 96,
  batchFrames: 8,
  prebufferFrames: 6,
  firstLipTimeoutMs: 300,
  maxAheadFrames: 25,
};

function intIn(raw: Record<string, unknown>, key: keyof PhotorealConfig, min: number, max: number): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`config.${key}`);
  }
  return value;
}

export function parsePhotorealConfig(raw: unknown): PhotorealConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('config');
  const r = raw as Record<string, unknown>;
  return {
    fps: intIn(r, 'fps', 1, 60),
    melSampleRate: intIn(r, 'melSampleRate', 8000, 48000),
    melBins: intIn(r, 'melBins', 1, 256),
    melWindow: intIn(r, 'melWindow', 1, 64),
    faceSize: intIn(r, 'faceSize', 16, 512),
    batchFrames: intIn(r, 'batchFrames', 1, 32),
    prebufferFrames: intIn(r, 'prebufferFrames', 0, 64),
    firstLipTimeoutMs: intIn(r, 'firstLipTimeoutMs', 0, 5000),
    maxAheadFrames: intIn(r, 'maxAheadFrames', 1, 256),
  };
}
