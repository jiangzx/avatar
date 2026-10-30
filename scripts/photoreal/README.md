# Photoreal spike assets

Research-only demo. Wav2Lip is not licensed for commercial use.

Wav2Lip is used at commit `bac9a81e63ecc153202353372e5724b83d9e6322`.
`github.com` cloning is blocked on some networks, so the script downloads the
official codeload archive
`https://codeload.github.com/Rudrabha/Wav2Lip/tar.gz/bac9a81e63ecc153202353372e5724b83d9e6322`
(455087 bytes), verifies its SHA-256
(`3666768f1fafe854048f17f63a6d193c9c2a93f3f3214fab00e6155ef721f83a`), and
extracts it to `build/photoreal/wav2lip/`.

## Requirements

Python 3.11 (`python3.11`, or set `PYTHON=/path/to/python3.11`): Wav2Lip's
`audio.py` passes `sr`/`n_fft` to `librosa.filters.mel` positionally, which
librosa 0.10+ no longer accepts. The script creates its virtualenv with Python
3.11 and pins librosa 0.9.2. Also requires `ffmpeg` and macOS `say`/`afconvert`.

## Mel reference only (no checkpoint)

```bash
./scripts/photoreal/build-assets.sh --mel-only
```

Regenerates `avatar-core/src/spike/photoreal/mel-filterbank.json` and
`avatar-core/test/fixtures/photoreal/mel-fixture.json` from the mock speech
sample. It needs no checkpoint and does not create `wav2lip.onnx`, frames,
faces, `manifest.json`, or the lock file.

## Full assets

1. Download `wav2lip_gan.pth` from the official checkpoint folder:
   https://drive.google.com/drive/folders/153HLrqlBNxzZcHi17PEvP09kkAfzRshM
   The Wav2Lip + GAN file is:
   https://drive.google.com/file/d/15G3U08c8xsCkOqQxE38Z2XXDnPcOptNk/view
   Put it at `build/photoreal/wav2lip_gan.pth`.
2. Run `./scripts/photoreal/build-assets.sh`.
3. Assets land in `avatar-core/photoreal/public/spike/photoreal/` and are gitignored.
4. `scripts/photoreal-assets.lock.json` records the SHA-256 of the checkpoint,
   sample video, ONNX, and PCM. Commit the lock file; never commit the assets.

The exported frames are scaled to 960 px wide (`--max-width`) because S3FD
activations grow with input resolution and the page loads every frame as an
`ImageBitmap`; face crops are still cut from the original frames.

Sample video: https://assets.sync.so/docs/example-video.mp4 (10 s trim).
S3FD weights: https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth
