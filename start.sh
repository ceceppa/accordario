#!/usr/bin/env bash
# Accordario: set up the Python environment (first run only) and start the server.
set -euo pipefail
cd "$(dirname "$0")/server"

PORT="${PORT:-8765}"
VENV=".venv"

find_python() {
  for candidate in python3.11 python3.10 python3.12 "$HOME/.pyenv/versions/3.10.14/bin/python"; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "import hashlib, ssl" 2>/dev/null; then
      echo "$candidate"; return
    fi
  done
  echo "Serve Python 3.10, 3.11 o 3.12 (madmom non supporta ancora le versioni successive)." >&2
  exit 1
}

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Manca ffmpeg: installalo con  brew install ffmpeg" >&2
  exit 1
fi

if [ ! -x "$VENV/bin/python" ]; then
  PY="$(find_python)"
  echo "Creo l'ambiente Python con $PY…"
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip setuptools wheel
  "$VENV/bin/pip" install "numpy<2" "cython<3.1" "scipy<1.14" mido
  "$VENV/bin/pip" install --no-build-isolation "git+https://github.com/CPJKU/madmom.git"
  "$VENV/bin/pip" install -r requirements.txt
fi

# yt-dlp must stay current: YouTube changes often.
"$VENV/bin/pip" install -q --upgrade "yt-dlp[default]" >/dev/null 2>&1 || true

echo "Accordario su http://127.0.0.1:$PORT"
exec "$VENV/bin/python" -m uvicorn app:app --host 127.0.0.1 --port "$PORT"
