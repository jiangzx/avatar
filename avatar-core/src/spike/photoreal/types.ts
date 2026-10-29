export interface FaceBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface FrameMeta {
  index: number;
  frameUrl: string; // full frame, "/spike/photoreal/frames/frame-000.webp"
  faceUrl: string;  // 96x96 face crop, "/spike/photoreal/faces/face-000.webp"
  box: FaceBox;
}

export interface SampleManifest {
  name: string;
  fps: number;               // 25
  width: number;
  height: number;
  pcmUrl: string;            // "/spike/photoreal/speech-24k.pcm"
  pcmSampleRate: number;     // 24000
  frames: FrameMeta[];
}

export interface PhotorealConfig {
  fps: number;               // 25
  melSampleRate: number;     // 16000
  melBins: number;           // 80
  melWindow: number;         // 16
  faceSize: number;          // 96
  batchFrames: number;       // 8
  prebufferFrames: number;   // 6
  firstLipTimeoutMs: number; // 300
  maxAheadFrames: number;    // 25
}
