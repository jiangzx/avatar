import type * as Ort from 'onnxruntime-web/webgpu';

export interface PackedBatch {
  mel: Float32Array;
  img: Float32Array;
}

// Wav2Lip takes 6 face channels. ORT WebGPU 1.30 miscomputes a Conv with 6
// input channels, so the exported model pads the face input to 8 with zeros.
const FACE_CHANNELS = 6;
const MODEL_FACE_CHANNELS = 8;

interface OrtTensor {
  data: Float32Array | Int32Array | Uint8Array | string[];
  dims: readonly number[];
}

interface OrtModule {
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor;
  InferenceSession: {
    create(modelUrl: string, options: Record<string, unknown>): Promise<OrtSession>;
  };
}

interface OrtSession {
  run(inputs: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

/** Packs up to batchFrames windows into the fixed B=8 ONNX input tensors. */
export function packBatch(
  melWindows: Float32Array[],
  faces: Float32Array[],
  count: number,
  batchFrames: number,
  melWindow: number,
  faceSize: number,
  melBins = 80,
): PackedBatch {
  if (!Number.isInteger(count) || count < 0 || count > batchFrames) throw new Error('packBatch: count');
  if (melWindows.length < count || faces.length < count) throw new Error('packBatch: inputs');
  const melStride = melBins * melWindow;
  const faceStride = FACE_CHANNELS * faceSize * faceSize;
  const modelFaceStride = MODEL_FACE_CHANNELS * faceSize * faceSize;
  const mel = new Float32Array(batchFrames * melStride);
  const img = new Float32Array(batchFrames * modelFaceStride);
  for (let i = 0; i < count; i++) {
    if (melWindows[i].length !== melStride) throw new Error('packBatch: mel');
    if (faces[i].length !== faceStride) throw new Error('packBatch: face');
    mel.set(melWindows[i], i * melStride);
    // The last two planes stay zero: the widened model ignores them.
    img.set(faces[i], i * modelFaceStride);
  }
  return { mel, img };
}

/** Small wrapper around ONNX Runtime Web with a fixed Wav2Lip batch. */
export class Wav2LipRunner {
  private constructor(
    private readonly session: OrtSession,
    private readonly ort: OrtModule,
    readonly provider: string,
  ) {}

  static async create(modelUrl: string, opts: { webgpu: boolean }): Promise<Wav2LipRunner> {
    const ort = (await import('onnxruntime-web/webgpu')) as unknown as OrtModule;
    const executionProviders = opts.webgpu ? ['webgpu', 'wasm'] : ['wasm'];
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders,
      graphOptimizationLevel: 'all',
    });
    // ORT does not reliably expose the selected EP; this is the requested one.
    return new Wav2LipRunner(session, ort, opts.webgpu ? 'webgpu' : 'wasm');
  }

  async infer(packed: PackedBatch, batchFrames: number): Promise<Float32Array> {
    const mel = new this.ort.Tensor('float32', packed.mel, [batchFrames, 1, 80, 16]);
    const img = new this.ort.Tensor('float32', packed.img, [batchFrames, MODEL_FACE_CHANNELS, 96, 96]);
    const out = await this.session.run({ mel, img });
    const tensor = out.out;
    if (!tensor || !(tensor.data instanceof Float32Array)) throw new Error('infer: bad output');
    return tensor.data;
  }
}
