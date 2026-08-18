#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="office-signage"
PORT="${PORT:-3000}"
MEDIA_DIR="${MEDIA_DIR:-./public/media}"
SETTINGS_FILE="${SETTINGS_FILE:-./settings.json}"
HTPASSWD_FILE="${HTPASSWD_FILE:-./admin.htpasswd}"
ADMIN_USER="${ADMIN_USER:-admin}"
RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-./.runtime.env}"

echo "== $PROJECT_NAME installer =="

has_cmd() { command -v "$1" >/dev/null 2>&1; }
die() { echo "ERROR: $*" >&2; exit 1; }

require_file() {
  [ -f "$1" ] || die "$1 not found. Run this script from the repo root."
}

local_ips() {
  if has_cmd hostname; then
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true
  fi

  if has_cmd ipconfig; then
    ipconfig getifaddr en0 2>/dev/null || true
    ipconfig getifaddr en1 2>/dev/null || true
  fi
}

prompt_password() {
  local password=""
  local confirm=""

  while true; do
    read -r -s -p "Create admin password: " password
    echo ""
    read -r -s -p "Confirm admin password: " confirm
    echo ""

    if [ "${#password}" -lt 4 ] || [ "${#password}" -gt 64 ]; then
      echo "Password must be between 4 and 64 characters."
    elif [ "$password" != "$confirm" ]; then
      echo "Passwords do not match."
    else
      ADMIN_PASSWORD="$password"
      break
    fi
  done
}

create_htpasswd() {
  local password="$1"
  local hash=""

  if has_cmd node && node -e 'process.exit(typeof require("node:crypto").argon2 === "function" ? 0 : 1)' >/dev/null 2>&1; then
    hash="$(ADMIN_PASSWORD="$password" node scripts/hash-password.js)"
  else
    echo "Node.js 24.7+ not found; using Docker to generate the admin password hash."
    hash="$(
      docker run --rm \
        -e ADMIN_PASSWORD="$password" \
        -v "$(pwd -P):/work:ro" \
        -w /work \
        node:24-alpine \
        node scripts/hash-password.js
    )"
  fi

  printf "%s:%s\n" "$ADMIN_USER" "$hash" > "$HTPASSWD_FILE"
  chmod 600 "$HTPASSWD_FILE" 2>/dev/null || true
  echo "Created $HTPASSWD_FILE"
}

read_runtime_var() {
  local key="$1"
  [ -f "$RUNTIME_ENV_FILE" ] || return 0
  grep -E "^${key}=" "$RUNTIME_ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

create_session_secret() {
  local existing=""
  existing="$(read_runtime_var "SESSION_SECRET")"
  if [ -n "$existing" ]; then
    printf "%s" "$existing"
    return
  fi

  if [ -n "${SESSION_SECRET:-}" ]; then
    printf "%s" "$SESSION_SECRET"
    return
  fi

  if has_cmd openssl; then
    openssl rand -hex 32
  else
    docker run --rm node:24-alpine node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'
  fi
}

has_cmd docker || die "Docker not found. Install Docker Desktop or Docker Engine."
docker info >/dev/null 2>&1 || die "Docker daemon not running. Start Docker and re-run."

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif has_cmd docker-compose; then
  COMPOSE=(docker-compose)
else
  die "Docker Compose not found. Install the Docker Compose plugin."
fi

require_file "docker-compose.yml"
require_file "package.json"
require_file "server.js"
require_file "scripts/hash-password.js"

mkdir -p "$MEDIA_DIR"

if [ ! -f "$SETTINGS_FILE" ]; then
  printf '{ "imageIntervalMs": 7000, "imageDurations": {}, "mediaOrder": [] }\n' > "$SETTINGS_FILE"
  echo "Created $SETTINGS_FILE"
fi

if [ "${RESET_ADMIN_PASSWORD:-false}" = "true" ] || [ ! -f "$HTPASSWD_FILE" ]; then
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    prompt_password
  fi
  create_htpasswd "$ADMIN_PASSWORD"
else
  echo "Using existing $HTPASSWD_FILE"
fi

export PORT
export MEDIA_DIR
export SETTINGS_FILE
export HTPASSWD_FILE
export ADMIN_USER

LAN_IPS="$(local_ips | awk '!seen[$0]++')"
PLAYER_HOST="$(printf '%s\n' "$LAN_IPS" | head -n 1)"
SESSION_SECRET="$(create_session_secret)"
EXISTING_TRUST_PROXY="$(read_runtime_var "TRUST_PROXY")"
EXISTING_COOKIE_SECURE="$(read_runtime_var "COOKIE_SECURE")"
EXISTING_UPLOAD_MAX_FILES="$(read_runtime_var "UPLOAD_MAX_FILES")"
EXISTING_UPLOAD_MAX_FILE_MB="$(read_runtime_var "UPLOAD_MAX_FILE_MB")"
EXISTING_UPLOAD_MAX_TOTAL_MB="$(read_runtime_var "UPLOAD_MAX_TOTAL_MB")"
TRUST_PROXY="${TRUST_PROXY:-${EXISTING_TRUST_PROXY:-false}}"
COOKIE_SECURE="${COOKIE_SECURE:-${EXISTING_COOKIE_SECURE:-false}}"
UPLOAD_MAX_FILES="${UPLOAD_MAX_FILES:-${EXISTING_UPLOAD_MAX_FILES:-10}}"
UPLOAD_MAX_FILE_MB="${UPLOAD_MAX_FILE_MB:-${EXISTING_UPLOAD_MAX_FILE_MB:-250}}"
UPLOAD_MAX_TOTAL_MB="${UPLOAD_MAX_TOTAL_MB:-${EXISTING_UPLOAD_MAX_TOTAL_MB:-1000}}"

cat > "$RUNTIME_ENV_FILE" <<EOF
PLAYER_HOST=$PLAYER_HOST
SESSION_SECRET=$SESSION_SECRET
TRUST_PROXY=$TRUST_PROXY
COOKIE_SECURE=$COOKIE_SECURE
UPLOAD_MAX_FILES=$UPLOAD_MAX_FILES
UPLOAD_MAX_FILE_MB=$UPLOAD_MAX_FILE_MB
UPLOAD_MAX_TOTAL_MB=$UPLOAD_MAX_TOTAL_MB
EOF
echo "Wrote $RUNTIME_ENV_FILE"

echo "Starting containers..."
"${COMPOSE[@]}" up -d --build

echo ""
echo "Done."
echo "Admin:  http://localhost:$PORT/admin-login"
echo "Player: http://localhost:$PORT/player"

if [ -n "$LAN_IPS" ]; then
  echo ""
  echo "LAN URLs:"
  while IFS= read -r ip; do
    [ -n "$ip" ] || continue
    echo "  Admin:  http://$ip:$PORT/admin-login"
    echo "  Player: http://$ip:$PORT/player"
  done <<EOF
$LAN_IPS
EOF
fi

echo ""
echo "Media folder:"
echo "  $MEDIA_DIR"
echo ""
echo "Useful commands:"
echo "  ${COMPOSE[*]} logs -f signage"
echo "  ${COMPOSE[*]} restart signage"
echo ""
echo "To reset the admin password later:"
echo "  RESET_ADMIN_PASSWORD=true ./install.sh"
