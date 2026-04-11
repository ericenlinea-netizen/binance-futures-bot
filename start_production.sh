#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
pip install -e .

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "Se creó .env desde .env.example. Revísalo antes de operar."
fi

exec python3 main.py run --env-file .env
