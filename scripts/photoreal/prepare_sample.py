#!/usr/bin/env python3
"""Prepare a 25 fps talking-face sample for the browser spike."""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

DETECT_BATCH = 4
OUT_MAX_WIDTH = 960


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav2lip", required=True)
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=int, default=25)
    ap.add_argument("--pads", type=int, nargs=4, default=[0, 10, 0, 0])
    ap.add_argument("--max-width", type=int, default=OUT_MAX_WIDTH)
    args = ap.parse_args()

    sys.path.insert(0, args.wav2lip)
    from face_detection import FaceAlignment, LandmarksType

    out = Path(args.out)
    (out / "frames").mkdir(parents=True, exist_ok=True)
    (out / "faces").mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(args.video)
    frames = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
    cap.release()
    if not frames:
        raise SystemExit("no frames decoded")
    height, width = frames[0].shape[:2]

    scale = min(1.0, args.max_width / width)
    out_width = max(16, int(round(width * scale)))
    out_height = max(16, int(round(height * scale)))
    sx = out_width / width
    sy = out_height / height

    def scaled(frame: np.ndarray) -> np.ndarray:
        if out_width == width and out_height == height:
            return frame
        return cv2.resize(frame, (out_width, out_height), interpolation=cv2.INTER_AREA)

    detector = FaceAlignment(LandmarksType._2D, flip_input=False, device="cpu")
    # S3FD activations blow up at 1080p; detect on the output-size frames in small batches.
    rects = []
    for start in range(0, len(frames), DETECT_BATCH):
        chunk = np.array([scaled(f) for f in frames[start:start + DETECT_BATCH]])
        rects.extend(detector.get_detections_for_batch(chunk))
    if any(r is None for r in rects):
        raise SystemExit("face not detected in every frame")

    # Pads are in full-resolution pixels; crops come from the original frames.
    pady1, pady2, padx1, padx2 = args.pads
    boxes = []
    for rect in rects:
        x1 = max(0, int(round(rect[0] / sx)) - padx1)
        y1 = max(0, int(round(rect[1] / sy)) - pady1)
        x2 = min(width, int(round(rect[2] / sx)) + padx2)
        y2 = min(height, int(round(rect[3] / sy)) + pady2)
        boxes.append([x1, y1, x2, y2])
    boxes = np.array(boxes, dtype=np.float64)

    # Smooth boxes over five frames, matching inference.py.
    smooth = []
    for i in range(len(boxes)):
        window = boxes[i:i + 5] if i + 5 <= len(boxes) else boxes[len(boxes) - 5:]
        smooth.append(np.mean(window, axis=0))
    boxes = np.array(smooth)

    metas = []
    for i, (frame, box) in enumerate(zip(frames, boxes)):
        x1, y1, x2, y2 = [int(round(v)) for v in box]
        x1 = max(0, min(width - 1, x1))
        x2 = max(x1 + 1, min(width, x2))
        y1 = max(0, min(height - 1, y1))
        y2 = max(y1 + 1, min(height, y2))
        ox1 = max(0, min(out_width - 1, int(round(x1 * sx))))
        ox2 = max(ox1 + 1, min(out_width, int(round(x2 * sx))))
        oy1 = max(0, min(out_height - 1, int(round(y1 * sy))))
        oy2 = max(oy1 + 1, min(out_height, int(round(y2 * sy))))
        face = cv2.resize(frame[y1:y2, x1:x2], (96, 96), interpolation=cv2.INTER_AREA)
        frame_path = f"frames/frame-{i:03d}.webp"
        face_path = f"faces/face-{i:03d}.webp"
        cv2.imwrite(str(out / frame_path), scaled(frame), [cv2.IMWRITE_WEBP_QUALITY, 90])
        cv2.imwrite(str(out / face_path), face, [cv2.IMWRITE_WEBP_QUALITY, 95])
        metas.append({
            "index": i,
            "frameUrl": f"/spike/photoreal/{frame_path}",
            "faceUrl": f"/spike/photoreal/{face_path}",
            "box": {"x1": ox1, "y1": oy1, "x2": ox2, "y2": oy2},
        })

    manifest = {
        "name": "sync-example",
        "fps": args.fps,
        "width": out_width,
        "height": out_height,
        "pcmUrl": "/spike/photoreal/speech-24k.pcm",
        "pcmSampleRate": 24000,
        "frames": metas,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"frames={len(metas)} size={out_width}x{out_height} source={width}x{height}")


if __name__ == "__main__":
    main()
