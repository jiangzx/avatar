import type { FaceBox } from './types.ts';

export function clampBox(box: FaceBox, width: number, height: number): FaceBox {
  const x1 = Math.max(0, Math.min(width - 1, Math.round(box.x1)));
  const y1 = Math.max(0, Math.min(height - 1, Math.round(box.y1)));
  const x2 = Math.max(x1 + 1, Math.min(width, Math.round(box.x2)));
  const y2 = Math.max(y1 + 1, Math.min(height, Math.round(box.y2)));
  return { x1, y1, x2, y2 };
}

export function drawComposite(
  ctx: CanvasRenderingContext2D,
  frame: CanvasImageSource,
  face: CanvasImageSource,
  patch: ImageData | null,
  box: FaceBox,
  patchCanvas: HTMLCanvasElement,
): void {
  const b = clampBox(box, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(frame, 0, 0);
  const w = b.x2 - b.x1;
  const h = b.y2 - b.y1;
  if (patch) {
    const patchCtx = patchCanvas.getContext('2d');
    if (!patchCtx) throw new Error('patch canvas 2d');
    patchCtx.putImageData(patch, 0, 0);
    ctx.drawImage(patchCanvas, b.x1, b.y1, w, h);
  } else {
    ctx.drawImage(face, b.x1, b.y1, w, h);
  }
}
