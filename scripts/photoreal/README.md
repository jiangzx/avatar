# Photoreal spike assets

Research-only demo. Wav2Lip is not licensed for commercial use.

1. Download `wav2lip_gan.pth` from the official checkpoint folder:
   https://drive.google.com/drive/folders/153HLrqlBNxzZcHi17PEvP09kkAfzRshM
   The Wav2Lip + GAN file is:
   https://drive.google.com/file/d/15G3U08c8xsCkOqQxE38Z2XXDnPcOptNk/view
   Put it at `build/photoreal/wav2lip_gan.pth`.
2. Run `./scripts/photoreal/build-assets.sh`.
3. Assets land in `avatar-core/photoreal/public/spike/photoreal/` and are gitignored.
4. `scripts/photoreal-assets.lock.json` records the SHA-256 of the checkpoint,
   sample video, ONNX, and PCM. Commit the lock file; never commit the assets.

Wav2Lip commit: `bac9a81e63ecc153202353372e5724b83d9e6322`.
Sample video: https://assets.sync.so/docs/example-video.mp4 (10 s trim).
S3FD weights: https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth

Requires: `git`, `ffmpeg`, `python3` (with venv), and macOS `say`/`afconvert`.
