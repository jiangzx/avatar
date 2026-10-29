export const FACE_SIZE = 96;

/** Builds Wav2Lip's 6-channel 96x96 BGR input from an RGBA face crop. */
export function packFace(rgba: Uint8ClampedArray, size = FACE_SIZE): Float32Array {
  const plane = size * size;
  if (rgba.length !== plane * 4) throw new Error('packFace: rgba length');
  const out = new Float32Array(6 * plane);
  for (let y = 0; y < size; y++) {
    const maskedRow = y >= size / 2;
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const p = y * size + x;
      const b = rgba[src + 2] / 255;
      const g = rgba[src + 1] / 255;
      const r = rgba[src] / 255;
      // Wav2Lip was trained on OpenCV BGR crops; the browser decodes RGB.
      out[p] = maskedRow ? 0 : b;
      out[plane + p] = maskedRow ? 0 : g;
      out[2 * plane + p] = maskedRow ? 0 : r;
      out[3 * plane + p] = b;
      out[4 * plane + p] = g;
      out[5 * plane + p] = r;
    }
  }
  return out;
}

/** Converts one 3x96x96 BGR model output to RGBA for ImageData. */
export function patchToRgba(patch: Float32Array, offset: number, size = FACE_SIZE): Uint8ClampedArray {
  const plane = size * size;
  if (patch.length < offset + 3 * plane) throw new Error('patchToRgba: length');
  const out = new Uint8ClampedArray(plane * 4);
  for (let p = 0; p < plane; p++) {
    const b = patch[offset + p];
    const g = patch[offset + plane + p];
    const r = patch[offset + 2 * plane + p];
    out[p * 4] = Math.round(r * 255);
    out[p * 4 + 1] = Math.round(g * 255);
    out[p * 4 + 2] = Math.round(b * 255);
    out[p * 4 + 3] = 255;
  }
  return out;
}
