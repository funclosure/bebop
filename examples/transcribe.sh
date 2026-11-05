#!/usr/bin/env bash
# Voice notes → text, offline, with whisper.cpp. For HUB_TRANSCRIBE_CMD:
#
#   HUB_TRANSCRIBE_CMD="/path/to/bebop/examples/transcribe.sh {in} {out}"
#
#   transcribe.sh IN OUT     any audio ffmpeg reads → OUT, one "[m:ss] text" line per segment
#   transcribe.sh --fetch    download the model now (setup does this), then exit
#   transcribe.sh --check    say whether the tools and the model are there
#
# Needs whisper-cli and ffmpeg (macOS: brew install whisper-cpp ffmpeg). The model is
# $BEBOP_WHISPER_MODEL, default ~/.cache/bebop/ggml-large-v3-turbo-q5_0.bin (about 550 MB,
# multilingual). If it's missing, a voice note starts the download in the background and fails
# with a note saying so; the notes after it are transcribed once it's done.
# Optional: BEBOP_WHISPER_LANG (default auto), BEBOP_WHISPER_PROMPT (a line in the style you want,
# e.g. 以下是繁體中文的句子。 for Traditional Chinese), WHISPER_CLI (default whisper-cli).
set -euo pipefail

MODEL="${BEBOP_WHISPER_MODEL:-$HOME/.cache/bebop/ggml-large-v3-turbo-q5_0.bin}"
MODEL_URL="${BEBOP_WHISPER_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$(basename "$MODEL")}"
CLI="${WHISPER_CLI:-whisper-cli}"
LANG_OPT="${BEBOP_WHISPER_LANG:-auto}"
PROMPT=()
[ -n "${BEBOP_WHISPER_PROMPT:-}" ] && PROMPT=(--prompt "$BEBOP_WHISPER_PROMPT")

die() { echo "transcribe: $*" >&2; exit 2; }
need() {
  command -v "$CLI" >/dev/null 2>&1 || die "whisper-cli not found (macOS: brew install whisper-cpp; Linux: build whisper.cpp and set WHISPER_CLI)"
  command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg not found (macOS: brew install ffmpeg; Linux: your package manager's ffmpeg)"
}

# Download to a temporary name, then move it into place, so a half-done file is never used.
# A lock folder keeps two notes from downloading at once.
fetch() {
  mkdir -p "$(dirname "$MODEL")"
  local lock="$MODEL.lock"
  if ! mkdir "$lock" 2>/dev/null; then echo "transcribe: the model is already downloading" >&2; return 1; fi
  trap 'rmdir "$lock" 2>/dev/null || true' RETURN
  curl -fL --retry 3 --silent --show-error -o "$MODEL.part" "$MODEL_URL" || { rm -f "$MODEL.part"; echo "transcribe: couldn't download $MODEL_URL" >&2; return 1; }
  mv "$MODEL.part" "$MODEL"
}

case "${1:-}" in
  --fetch) [ -s "$MODEL" ] && { echo "model: $MODEL"; exit 0; }; fetch && echo "model: $MODEL"; exit $? ;;
  --check)
    need
    [ -s "$MODEL" ] || die "no model at $MODEL (run: $0 --fetch)"
    echo "ok: $(command -v "$CLI"), $(command -v ffmpeg), $MODEL"; exit 0 ;;
  -h|--help|"") sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

IN="$1"; OUT="${2:?usage: transcribe.sh IN OUT}"
[ -f "$IN" ] || die "no such audio file: $IN"
need
if [ ! -s "$MODEL" ]; then
  if [ -d "$MODEL.lock" ]; then die "the speech model is still downloading (about 550 MB); later notes will be transcribed"; fi
  ( fetch >/dev/null 2>&1 & ) # detached, so the hub's timeout doesn't cut it short
  die "downloading the speech model (about 550 MB) to $MODEL; later notes will be transcribed"
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/bebop-transcribe.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
ffmpeg -nostdin -loglevel error -y -i "$IN" -ar 16000 -ac 1 -c:a pcm_s16le "$TMP/audio.wav" || die "ffmpeg couldn't read $IN"
"$CLI" -m "$MODEL" -f "$TMP/audio.wav" -l "$LANG_OPT" ${PROMPT[@]+"${PROMPT[@]}"} -osrt -of "$TMP/t" -np >/dev/null 2>"$TMP/err" || die "whisper-cli failed: $(tail -n 3 "$TMP/err" | tr '\n' ' ')"
[ -s "$TMP/t.srt" ] || die "whisper-cli wrote no transcript"

# SRT blocks (number, "HH:MM:SS,mmm --> …", text lines) → "[m:ss] text", or [h:mm:ss] past an hour.
awk '
  function flush() { if (stamp != "" && text != "") print stamp " " text; stamp = ""; text = "" }
  /-->/ { flush(); split($1, t, /[:,]/); h = t[1] + 0; m = t[2] + 0; s = t[3] + 0
          stamp = h ? sprintf("[%d:%02d:%02d]", h, m, s) : sprintf("[%d:%02d]", m, s); next }
  /^[0-9]+\r?$/ && stamp == "" { next }
  /^\r?$/ { flush(); next }
  { sub(/\r$/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); if ($0 != "") text = text == "" ? $0 : text " " $0 }
  END { flush() }
' "$TMP/t.srt" > "$OUT"
[ -s "$OUT" ] || die "the note has no speech in it"
