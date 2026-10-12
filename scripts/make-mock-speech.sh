#!/usr/bin/env bash
# Generates a Mandarin speech sample (24 kHz, PCM16 LE, mono, raw) with macOS `say`.
# Used by the gateway MockAdapter as reply audio and by the AEC spike as playback signal.
set -euo pipefail
cd "$(dirname "$0")/.."
TEXT="你好呀，我是小暖，很高兴见到你。今天天气不错，我们可以随便聊聊，比如你早饭吃了什么，有没有出去走一走，最近有没有什么开心的事情，想跟我分享一下吗？我会一直在这里听你说。"
VOICE="${VOICE:-$(say -v '?' | awk '/zh_CN/ {sub(/[[:space:]]+zh_CN.*/, ""); print; exit}')}"
[ -n "$VOICE" ] || { echo "No zh_CN voice installed for 'say'" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
say -v "$VOICE" -o "$tmp/speech.aiff" "$TEXT"
afconvert -f WAVE -d LEI16@24000 -c 1 "$tmp/speech.aiff" "$tmp/speech.wav"
mkdir -p gateway/mock avatar-core/public/spike
python3 -I - "$tmp/speech.wav" gateway/mock/speech-24k.pcm <<'PY'
import sys, wave
with wave.open(sys.argv[1], "rb") as w:
    assert w.getframerate() == 24000 and w.getsampwidth() == 2 and w.getnchannels() == 1
    data = w.readframes(w.getnframes())
with open(sys.argv[2], "wb") as f:
    f.write(data)
PY
cp gateway/mock/speech-24k.pcm avatar-core/public/spike/speech-24k.pcm
echo "voice=$VOICE bytes=$(wc -c < gateway/mock/speech-24k.pcm)"
