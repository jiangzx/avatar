#!/usr/bin/env bash
# Builds the photoreal spike assets. The checkpoint is a manual download.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
BUILD="$ROOT/build/photoreal"
OUT="$ROOT/avatar-core/photoreal/public/spike/photoreal"
COMMIT="bac9a81e63ecc153202353372e5724b83d9e6322"
SRC_URL="https://codeload.github.com/Rudrabha/Wav2Lip/tar.gz/$COMMIT"
SRC_SHA256="3666768f1fafe854048f17f63a6d193c9c2a93f3f3214fab00e6155ef721f83a"
PYTHON="${PYTHON:-$(command -v python3.11 || true)}"
MODE="${1:-full}"

if [[ "$MODE" != "full" && "$MODE" != "--mel-only" ]]; then
  echo "usage: $0 [--mel-only]" >&2
  exit 2
fi

if [[ -z "$PYTHON" ]]; then
  echo "python3.11 not found; install Python 3.11 or set PYTHON=/path/to/python3.11" >&2
  exit 1
fi
mkdir -p "$BUILD"

# GitHub cloning is blocked on some networks; use the official archive at the pinned commit.
if [[ ! -f "$BUILD/wav2lip/models/wav2lip.py" ]]; then
  archive="$BUILD/wav2lip-src.tar.gz"
  if [[ ! -f "$archive" ]]; then
    curl -L --fail -o "$archive" "$SRC_URL"
  fi
  actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
  if [[ "$actual" != "$SRC_SHA256" ]]; then
    echo "checksum mismatch for $archive: got $actual, want $SRC_SHA256" >&2
    exit 1
  fi
  tmp="$BUILD/wav2lip-extract"
  rm -rf "$tmp" "$BUILD/wav2lip"
  mkdir -p "$tmp"
  tar -xzf "$archive" -C "$tmp"
  mv "$tmp/Wav2Lip-$COMMIT" "$BUILD/wav2lip"
  rmdir "$tmp"
fi

# Wav2Lip is from 2020; modern numpy removed the np.float/np.int aliases.
"$PYTHON" -I - "$BUILD/wav2lip" <<'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
for path in root.rglob("*.py"):
    text = path.read_text()
    fixed = re.sub(r"\bnp\.(float|int|bool|object)\b", r"\1", text)
    if fixed != text:
        path.write_text(fixed)
PY

if [[ "$MODE" == "--mel-only" ]]; then
  VENV="$BUILD/venv-mel"
  if [[ ! -x "$VENV/bin/python" ]]; then
    "$PYTHON" -m venv "$VENV"
    "$VENV/bin/pip" install --upgrade pip
    "$VENV/bin/pip" install numpy==1.26.4 scipy==1.13.1 librosa==0.9.2
  fi
  mkdir -p "$OUT"
  ./scripts/make-mock-speech.sh
  head -c $((24000 * 2 * 10)) gateway/mock/speech-24k.pcm > "$OUT/speech-24k.pcm"
  "$VENV/bin/python" scripts/photoreal/make_mel_fixture.py \
    --wav2lip "$BUILD/wav2lip" \
    --pcm "$OUT/speech-24k.pcm" \
    --filterbank avatar-core/src/spike/photoreal/mel-filterbank.json \
    --fixture avatar-core/test/fixtures/photoreal/mel-fixture.json
  exit 0
fi

if [[ ! -f "$BUILD/wav2lip_gan.pth" ]]; then
  echo "missing $BUILD/wav2lip_gan.pth" >&2
  echo "download it from https://drive.google.com/drive/folders/153HLrqlBNxzZcHi17PEvP09kkAfzRshM" >&2
  exit 1
fi
mkdir -p "$OUT/frames" "$OUT/faces"

S3FD="$BUILD/wav2lip/face_detection/detection/sfd/s3fd.pth"
mkdir -p "$(dirname "$S3FD")"
if [[ ! -f "$S3FD" ]]; then
  curl -L --fail -o "$S3FD" https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth
fi

if [[ ! -f "$BUILD/sample.mp4" ]]; then
  curl -L --fail -o "$BUILD/sample.mp4" https://assets.sync.so/docs/example-video.mp4
fi
ffmpeg -y -i "$BUILD/sample.mp4" -t 10 -r 25 -an -c:v libx264 -pix_fmt yuv420p "$BUILD/sample-10s.mp4"

./scripts/make-mock-speech.sh
head -c $((24000 * 2 * 10)) gateway/mock/speech-24k.pcm > "$OUT/speech-24k.pcm"

if [[ ! -x "$BUILD/venv/bin/python" ]]; then
  "$PYTHON" -m venv "$BUILD/venv"
  "$BUILD/venv/bin/pip" install --upgrade pip
  "$BUILD/venv/bin/pip" install -r scripts/photoreal/requirements.txt
fi

rm -f "$OUT/wav2lip.onnx.data"
"$BUILD/venv/bin/python" scripts/photoreal/export_wav2lip.py \
  --wav2lip "$BUILD/wav2lip" \
  --checkpoint "$BUILD/wav2lip_gan.pth" \
  --out "$OUT/wav2lip.onnx"

"$BUILD/venv/bin/python" scripts/photoreal/prepare_sample.py \
  --wav2lip "$BUILD/wav2lip" \
  --video "$BUILD/sample-10s.mp4" \
  --out "$OUT" \
  --fps 25

"$BUILD/venv/bin/python" scripts/photoreal/make_mel_fixture.py \
  --wav2lip "$BUILD/wav2lip" \
  --pcm "$OUT/speech-24k.pcm" \
  --filterbank avatar-core/src/spike/photoreal/mel-filterbank.json \
  --fixture avatar-core/test/fixtures/photoreal/mel-fixture.json

"$PYTHON" - "$BUILD" "$OUT" "$ROOT/scripts/photoreal-assets.lock.json" <<'PY'
import hashlib, json, pathlib, sys
build = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
lock_path = pathlib.Path(sys.argv[3])

def entry(path: pathlib.Path) -> dict:
    data = path.read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

lock = {
    "wav2lip_checkpoint": entry(build / "wav2lip_gan.pth"),
    "sample_video": entry(build / "sample.mp4"),
    "wav2lip_onnx": entry(out / "wav2lip.onnx"),
    "speech_pcm": entry(out / "speech-24k.pcm"),
    "manifest": entry(out / "manifest.json"),
}
lock_path.write_text(json.dumps(lock, indent=2) + "\n")
print(json.dumps(lock, indent=2))
PY
