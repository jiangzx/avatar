#!/usr/bin/env python3
"""Repack Lily.zip with the backdrop text painted out of every frame.

The public frames are JPEG files named *.sij. On the 540x960 frames the white
"duix.com" text sits at x 82-181, y 91-108. This copies the backdrop row just
above that box over the text. Other zip entries are copied unchanged.
"""

import os
import subprocess
import sys
import tempfile
import zipfile

SRC_W = 540
X0, Y0, X1, Y1 = 70, 82, 195, 118
SAMPLE_Y = 76


def paint(rgb: bytearray) -> None:
    width = SRC_W
    for y in range(Y0, Y1):
        for x in range(X0, X1):
            src = (SAMPLE_Y * width + x) * 3
            dst = (y * width + x) * 3
            rgb[dst : dst + 3] = rgb[src : src + 3]


def recode(jpeg: bytes, work: str) -> bytes:
    src = os.path.join(work, "in.jpg")
    rgb_path = os.path.join(work, "frame.rgb")
    out = os.path.join(work, "out.jpg")
    with open(src, "wb") as f:
        f.write(jpeg)
    subprocess.check_call(
        ["ffmpeg", "-y", "-i", src, "-f", "rawvideo", "-pix_fmt", "rgb24", rgb_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    rgb = bytearray(open(rgb_path, "rb").read())
    if len(rgb) != SRC_W * 960 * 3:
        raise SystemExit(f"unexpected frame size {len(rgb)}")
    paint(rgb)
    with open(rgb_path, "wb") as f:
        f.write(rgb)
    subprocess.check_call(
        [
            "ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "540x960",
            "-i", rgb_path, "-q:v", "3", out,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return open(out, "rb").read()


def main() -> None:
    src, dest = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w") as zout, tempfile.TemporaryDirectory() as work:
        frames = 0
        for info in zin.infolist():
            data = zin.read(info)
            if info.filename.endswith(".sij"):
                data = recode(data, work)
                frames += 1
            zout.writestr(info, data)
    print(f"rewrote {frames} frames -> {dest}")


if __name__ == "__main__":
    main()
