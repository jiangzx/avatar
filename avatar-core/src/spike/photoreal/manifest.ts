import type { FaceBox, FrameMeta, SampleManifest } from './types.ts';

const LOCAL_URL = /^\/spike\/photoreal\/[A-Za-z0-9._/-]+$/;

function str(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(key);
  return value;
}

function num(raw: Record<string, unknown>, key: string, min: number, max: number, where = key): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(where);
  return value;
}

function box(raw: unknown, width: number, height: number, where: string): FaceBox {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where}.box`);
  const b = raw as Record<string, unknown>;
  const at = `${where}.box`;
  const out = {
    x1: num(b, 'x1', 0, width, at),
    y1: num(b, 'y1', 0, height, at),
    x2: num(b, 'x2', 0, width, at),
    y2: num(b, 'y2', 0, height, at),
  };
  if (out.x2 <= out.x1 || out.y2 <= out.y1) throw new Error(at);
  return out;
}

export function parseSampleManifest(raw: unknown): SampleManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest');
  const r = raw as Record<string, unknown>;
  const fps = num(r, 'fps', 1, 60);
  const width = num(r, 'width', 16, 8192);
  const height = num(r, 'height', 16, 8192);
  const pcmSampleRate = num(r, 'pcmSampleRate', 8000, 48000);
  const pcmUrl = str(r, 'pcmUrl');
  if (!LOCAL_URL.test(pcmUrl)) throw new Error('pcmUrl');
  if (!Array.isArray(r.frames) || r.frames.length === 0) throw new Error('frames');
  const frames: FrameMeta[] = r.frames.map((value, i) => {
    if (typeof value !== 'object' || value === null) throw new Error(`frames[${i}]`);
    const f = value as Record<string, unknown>;
    if (f.index !== i) throw new Error(`frames[${i}].index`);
    const frameUrl = str(f, 'frameUrl');
    const faceUrl = str(f, 'faceUrl');
    if (!LOCAL_URL.test(frameUrl)) throw new Error(`frames[${i}].frameUrl`);
    if (!LOCAL_URL.test(faceUrl)) throw new Error(`frames[${i}].faceUrl`);
    return { index: i, frameUrl, faceUrl, box: box(f.box, width, height, `frames[${i}]`) };
  });
  return { name: str(r, 'name'), fps, width, height, pcmUrl, pcmSampleRate, frames };
}
