#!/usr/bin/env python3
"""Export Wav2Lip (GAN) to a fixed-shape ONNX for ONNX Runtime Web."""
import argparse
import hashlib
import sys
from pathlib import Path

import numpy as np
import torch

# wav2lip_gan.pth from the official release, hash-verified against multiple mirrors.
EXPECTED_CHECKPOINT_SHA256 = "ca9ab7b7b812c0e80a6e70a5977c545a1e8a365a6c49d5e533023c034d7ac3d8"


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_checkpoint(path: str) -> dict:
    digest = sha256_file(path)
    if digest != EXPECTED_CHECKPOINT_SHA256:
        raise SystemExit(f"checkpoint sha256 mismatch: got {digest}, want {EXPECTED_CHECKPOINT_SHA256}")
    try:
        return torch.load(path, map_location="cpu", weights_only=True)
    except Exception as exc:  # legacy pickle; the hash was verified above
        print(f"weights_only=True failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        print(f"checkpoint sha256={digest} matches the verified mirror; retrying with weights_only=False", file=sys.stderr)
        return torch.load(path, map_location="cpu", weights_only=False)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav2lip", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    sys.path.insert(0, args.wav2lip)
    from models import Wav2Lip

    model = Wav2Lip()
    checkpoint = load_checkpoint(args.checkpoint)
    state = {k.replace("module.", ""): v for k, v in checkpoint["state_dict"].items()}
    model.load_state_dict(state)
    model.eval()

    mel = torch.zeros(args.batch, 1, 80, 16, dtype=torch.float32)
    img = torch.zeros(args.batch, 6, 96, 96, dtype=torch.float32)
    with torch.no_grad():
        ref = model(mel, img).numpy()

    torch.onnx.export(
        model,
        (mel, img),
        args.out,
        input_names=["mel", "img"],
        output_names=["out"],
        opset_version=args.opset,
        do_constant_folding=True,
    )

    import onnx
    onnx.checker.check_model(args.out)
    import onnxruntime as ort
    session = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    got = session.run(None, {"mel": mel.numpy(), "img": img.numpy()})[0]
    np.testing.assert_allclose(got, ref, rtol=1e-4, atol=1e-4)
    size = Path(args.out).stat().st_size
    print(f"ok onnx={args.out} bytes={size} max_abs_diff={np.max(np.abs(got - ref)):.6f}")


if __name__ == "__main__":
    main()
