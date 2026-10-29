import { describe, expect, it } from 'vitest';
import { parseSampleManifest } from '../../src/spike/photoreal/manifest.ts';

const valid = {
  name: 'sample',
  fps: 25,
  width: 640,
  height: 480,
  pcmUrl: '/spike/photoreal/speech-24k.pcm',
  pcmSampleRate: 24000,
  frames: [
    {
      index: 0,
      frameUrl: '/spike/photoreal/frames/frame-000.webp',
      faceUrl: '/spike/photoreal/faces/face-000.webp',
      box: { x1: 100, y1: 50, x2: 300, y2: 400 },
    },
  ],
};

describe('parseSampleManifest', () => {
  it('accepts a valid manifest', () => {
    expect(parseSampleManifest(valid).frames).toHaveLength(1);
  });

  it('rejects out-of-order indices', () => {
    const bad = structuredClone(valid);
    bad.frames[0].index = 3;
    expect(() => parseSampleManifest(bad)).toThrow('frames[0].index');
  });

  it('rejects a box outside the frame', () => {
    const bad = structuredClone(valid);
    bad.frames[0].box.x2 = 641;
    expect(() => parseSampleManifest(bad)).toThrow('frames[0].box');
  });

  it('rejects a non-local URL', () => {
    const bad = structuredClone(valid);
    bad.frames[0].faceUrl = 'https://example.com/face.webp';
    expect(() => parseSampleManifest(bad)).toThrow('frames[0].faceUrl');
  });

  it('rejects an empty frame list', () => {
    expect(() => parseSampleManifest({ ...valid, frames: [] })).toThrow('frames');
  });
});
