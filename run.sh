#!/usr/bin/env bash
set -euo pipefail

# Change working dir to script location (project root)
cd "$(dirname "$0")"

PY=python3

if ! command -v "$PY" >/dev/null 2>&1; then
  cat >&2 <<'MSG'
python3 not found. Install Python 3.10+ (e.g. `brew install python@3.11` or use pyenv).
MSG
  exit 2
fi

ver=$("$PY" -c 'import sys; v=sys.version_info; print(f"{v.major}.{v.minor}")')
maj=$(printf '%s' "$ver" | cut -d. -f1)
min=$(printf '%s' "$ver" | cut -d. -f2)
if [ "$maj" -lt 3 ] || { [ "$maj" -eq 3 ] && [ "$min" -lt 10 ]; }; then
  cat >&2 <<'MSG'
Python ${ver} detected. This project requires Python 3.10+. Install a newer Python (e.g. `brew install python@3.11`).
MSG
  exit 2
fi

# Default args: host 127.0.0.1 port 8099 — pass extra flags like --allow-remote
exec "$PY" server.py --host 127.0.0.1 --port 8099 "$@"

