#!/usr/bin/env python3
"""Prepare a 25 fps talking-face sample for the browser spike."""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav2lip", required=True)
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=int, default=25)
    ap.add_argument("--pads", type=int, nargs=4, default=[0, 10, 0, 0])
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

    detector = FaceAlignment(LandmarksType._2D, flip_input=False, device="cpu")
    rects = detector.get_detections_for_batch(np.array(frames))
    if any(r is None for r in rects):
        raise SystemExit("face not detected in every frame")

    pady1, pady2, padx1, padx2 = args.pads
    boxes = []
    for rect in rects:
        x1 = max(0, int(rect[0]) - padx1)
        y1 = max(0, int(rect[1]) - pady1)
        x2 = min(width, int(rect[2]) + padx2)
        y2 = min(height, int(rect[3]) + pady2)
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
        face = cv2.resize(frame[y1:y2, x1:x2], (96, 96), interpolation=cv2.INTER_AREA)
        frame_path = f"frames/frame-{i:03d}.webp"
        face_path = f"faces/face-{i:03d}.webp"
        cv2.imwrite(str(out / frame_path), frame, [cv2.IMWRITE_WEBP_QUALITY, 90])
        cv2.imwrite(str(out / face_path), face, [cv2.IMWRITE_WEBP_QUALITY, 95])
        metas.append({
            "index": i,
            "frameUrl": f"/spike/photoreal/{frame_path}",
            "faceUrl": f"/spike/photoreal/{face_path}",
            "box": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
        })

    manifest = {
        "name": "sync-example",
        "fps": args.fps,
        "width": width,
        "height": height,
        "pcmUrl": "/spike/photoreal/speech-24k.pcm",
        "pcmSampleRate": 24000,
        "frames": metas,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"frames={len(metas)} size={width}x{height}")


if __name__ == "__main__":
    main()
