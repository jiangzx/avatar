#!/usr/bin/env python3
"""Generate the mel filterbank and a fixture from Wav2Lip's own audio.py."""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav2lip", required=True)
    ap.add_argument("--pcm", required=True)
    ap.add_argument("--filterbank", required=True)
    ap.add_argument("--fixture", required=True)
    args = ap.parse_args()

    sys.path.insert(0, args.wav2lip)
    # Wav2Lip pinned librosa 0.7.0, whose stft default is pad_mode='reflect'.
    # Modern librosa defaults to 'constant'; force the training-time behaviour.
    import librosa
    _orig_stft = librosa.stft
    def _stft_reflect(*call_args, **kwargs):
        kwargs.setdefault("pad_mode", "reflect")
        return _orig_stft(*call_args, **kwargs)
    librosa.stft = _stft_reflect

    import audio as wav2lip_audio

    raw = np.fromfile(args.pcm, dtype="<i2").astype(np.float32) / 32768.0
    pcm16 = resample_poly(raw, 2, 3).astype(np.float32)[:16000]
    # Quantize first: the browser will feed int16 / 32768 to the mel front-end.
    pcm16_q = np.round(pcm16 * 32767).astype(np.int16)
    mel = wav2lip_audio.melspectrogram(pcm16_q.astype(np.float32) / 32768.0)
    filterbank = wav2lip_audio._build_mel_basis()

    Path(args.filterbank).parent.mkdir(parents=True, exist_ok=True)
    Path(args.filterbank).write_text(json.dumps({
        "bins": int(filterbank.shape[0]),
        "fftBins": int(filterbank.shape[1]),
        "data": filterbank.tolist(),
    }))

    Path(args.fixture).parent.mkdir(parents=True, exist_ok=True)
    Path(args.fixture).write_text(json.dumps({
        "sampleRate": 16000,
        "pcm16": [int(x) for x in pcm16_q],
        "bins": int(mel.shape[0]),
        "frames": int(mel.shape[1]),
        "mel": mel.reshape(-1).tolist(),
    }))
    print(f"mel={mel.shape} filterbank={filterbank.shape}")


if __name__ == "__main__":
    main()
