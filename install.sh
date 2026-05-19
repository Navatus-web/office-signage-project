#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="office-signage"
PORT="${PORT:-3000}"
MEDIA_DIR="${MEDIA_DIR:-./public/media}"
SETTINGS_FILE="${SETTINGS_FILE:-./settings.json}"
HTPASSWD_FILE="${HTPASSWD_FILE:-./admin.htpasswd}"
ADMIN_USER="${ADMIN_USER:-admin}"

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

    if [ -z "$password" ]; then
      echo "Password cannot be empty."
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

  if has_cmd openssl; then
    hash="$(openssl passwd -apr1 "$password")"
  else
    echo "OpenSSL not found; using Docker to generate the admin password hash."
    hash="$(
      docker run --rm -e ADMIN_PASSWORD="$password" node:20-alpine node -e '
const crypto = require("crypto");
const password = process.env.ADMIN_PASSWORD || "";
const chars = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const salt = crypto.randomBytes(6).toString("base64").replace(/[+/=]/g, ".").slice(0, 8);
function to64(value, length) {
  let output = "";
  while (length > 0) {
    output += chars[value & 0x3f];
    value >>= 6;
    length -= 1;
  }
  return output;
}
function md5(input) {
  return crypto.createHash("md5").update(input).digest();
}
function apr1(password, salt) {
  const magic = "$apr1$";
  const salt8 = salt.replace(/^\$apr1\$/, "").split("$")[0].slice(0, 8);
  let ctx = Buffer.concat([Buffer.from(password + magic + salt8, "utf8"), Buffer.alloc(0)]);
  let final = md5(password + salt8 + password);
  for (let remaining = password.length; remaining > 0; remaining -= 16) {
    ctx = Buffer.concat([ctx, final.subarray(0, Math.min(16, remaining))]);
  }
  for (let bits = password.length; bits > 0; bits >>= 1) {
    ctx = Buffer.concat([ctx, Buffer.from(bits & 1 ? "\x00" : password[0], "binary")]);
  }
  final = md5(ctx);
  for (let i = 0; i < 1000; i += 1) {
    const parts = [];
    parts.push(Buffer.from(i % 2 ? password : final));
    if (i % 3) parts.push(Buffer.from(salt8));
    if (i % 7) parts.push(Buffer.from(password));
    parts.push(Buffer.from(i % 2 ? final : password));
    final = md5(Buffer.concat(parts));
  }
  const encoded =
    to64((final[0] << 16) | (final[6] << 8) | final[12], 4) +
    to64((final[1] << 16) | (final[7] << 8) | final[13], 4) +
    to64((final[2] << 16) | (final[8] << 8) | final[14], 4) +
    to64((final[3] << 16) | (final[9] << 8) | final[15], 4) +
    to64((final[4] << 16) | (final[10] << 8) | final[5], 4) +
    to64(final[11], 2);
  return `${magic}${salt8}$${encoded}`;
}
process.stdout.write(apr1(password, salt));
'
    )"
  fi

  printf "%s:%s\n" "$ADMIN_USER" "$hash" > "$HTPASSWD_FILE"
  chmod 600 "$HTPASSWD_FILE" 2>/dev/null || true
  echo "Created $HTPASSWD_FILE"
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

mkdir -p "$MEDIA_DIR"

if [ ! -f "$SETTINGS_FILE" ]; then
  printf '{ "imageIntervalMs": 7000, "imageDurations": {} }\n' > "$SETTINGS_FILE"
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

echo "Starting containers..."
"${COMPOSE[@]}" up -d --build

echo ""
echo "Done."
echo "Admin:  http://localhost:$PORT/admin-login"
echo "Player: http://localhost:$PORT/player"

LAN_IPS="$(local_ips | awk '!seen[$0]++')"
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
