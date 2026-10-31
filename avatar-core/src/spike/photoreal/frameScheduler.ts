export interface FrameChoice {
  frame: number;
  repeated: boolean;
  behind: number;
}

/** Picks the frame for the current audio time without ever showing an unready frame. */
export function chooseFrame(audioMs: number, readyThrough: number, fps: number, totalFrames: number): FrameChoice {
  if (!Number.isFinite(audioMs) || audioMs < 0) throw new Error('audioMs');
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('fps');
  if (!Number.isInteger(totalFrames) || totalFrames <= 0) throw new Error('totalFrames');

  const desired = Math.min(totalFrames - 1, Math.floor((audioMs * fps) / 1000));
  const ready = Math.min(readyThrough, totalFrames - 1);
  const frame = Math.min(desired, ready);
  return {
    frame,
    repeated: frame < desired,
    behind: Math.max(0, desired - ready),
  };
}
