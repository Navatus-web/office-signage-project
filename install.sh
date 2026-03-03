cat > install.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="office-signage"
PORT="${PORT:-3000}"
DATA_DIR="${DATA_DIR:-./data}"
MEDIA_DIR="$DATA_DIR/media"
SETTINGS_FILE="$DATA_DIR/settings.json"

echo "== $PROJECT_NAME installer =="

# --- Helpers ---
has_cmd() { command -v "$1" >/dev/null 2>&1; }
die() { echo "ERROR: $*" >&2; exit 1; }

# --- Checks ---
has_cmd docker || die "Docker not found. Install Docker Desktop (macOS) or Docker Engine (Linux)."
docker info >/dev/null 2>&1 || die "Docker daemon not running. Start Docker Desktop / Docker service and re-run."

# docker compose can be either 'docker compose' or 'docker-compose'
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif has_cmd docker-compose; then
  COMPOSE=(docker-compose)
else
  die "docker compose not found. Install Docker Compose plugin (recommended) or docker-compose."
fi

# --- Prepare persistent data dirs/files ---
mkdir -p "$MEDIA_DIR"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo '{ "imageIntervalMs": 7000 }' > "$SETTINGS_FILE"
  echo "Created $SETTINGS_FILE"
fi

# --- Ensure docker-compose.yml uses ./data paths (best effort warning only) ---
if [ ! -f docker-compose.yml ]; then
  die "docker-compose.yml not found in current directory. Run this from the repo root."
fi

echo "Starting containers..."
"${COMPOSE[@]}" up -d --build

echo ""
echo "✅ Done!"
echo "Admin:  http://localhost:$PORT/admin"
echo "Player: http://localhost:$PORT/player"
echo ""
echo "Media folder:"
echo "  $MEDIA_DIR"
echo ""
echo "Tip: drop images/videos into the media folder; screens will update automatically."
EOF

chmod +x install.sh