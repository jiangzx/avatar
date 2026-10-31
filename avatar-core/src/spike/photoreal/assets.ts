import { parseSampleManifest } from './manifest.ts';
import type { SampleManifest } from './types.ts';

export function pcmBytesToInt16(buffer: ArrayBuffer): Int16Array {
  if (buffer.byteLength % 2 !== 0) throw new Error('pcm: odd bytes');
  return new Int16Array(buffer);
}

export async function fetchManifest(url: string): Promise<SampleManifest> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`manifest ${response.status}`);
  return parseSampleManifest(await response.json());
}

export async function fetchImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image ${response.status}`);
  return createImageBitmap(await response.blob());
}

export async function fetchPcm(url: string): Promise<Int16Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`pcm ${response.status}`);
  return pcmBytesToInt16(await response.arrayBuffer());
}
