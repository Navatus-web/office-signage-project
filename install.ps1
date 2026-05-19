$ErrorActionPreference = "Stop"

$ProjectName = "office-signage"
$Port = $env:PORT
if ([string]::IsNullOrWhiteSpace($Port)) { $Port = "3000" }

$MediaDir = $env:MEDIA_DIR
if ([string]::IsNullOrWhiteSpace($MediaDir)) { $MediaDir = "./public/media" }

$SettingsFile = $env:SETTINGS_FILE
if ([string]::IsNullOrWhiteSpace($SettingsFile)) { $SettingsFile = "./settings.json" }

$HtpasswdFile = $env:HTPASSWD_FILE
if ([string]::IsNullOrWhiteSpace($HtpasswdFile)) { $HtpasswdFile = "./admin.htpasswd" }

$AdminUser = $env:ADMIN_USER
if ([string]::IsNullOrWhiteSpace($AdminUser)) { $AdminUser = "admin" }
$RuntimeEnvFile = $env:RUNTIME_ENV_FILE
if ([string]::IsNullOrWhiteSpace($RuntimeEnvFile)) { $RuntimeEnvFile = "./.runtime.env" }

Write-Host "== $ProjectName installer =="

function Die($Message) {
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

function Require-File($Path) {
  if (-not (Test-Path $Path)) {
    Die "$Path not found. Run this script from the repo root."
  }
}

function Get-LocalIPv4Addresses {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.PrefixOrigin -ne "WellKnown"
    } |
    Select-Object -ExpandProperty IPAddress -Unique
}

function Read-AdminPassword {
  while ($true) {
    $Password = Read-Host "Create admin password" -AsSecureString
    $Confirm = Read-Host "Confirm admin password" -AsSecureString

    $PasswordText = ConvertFrom-SecureStringText $Password
    $ConfirmText = ConvertFrom-SecureStringText $Confirm

    if ([string]::IsNullOrEmpty($PasswordText)) {
      Write-Host "Password cannot be empty."
    }
    elseif ($PasswordText -ne $ConfirmText) {
      Write-Host "Passwords do not match."
    }
    else {
      return $PasswordText
    }
  }
}

function ConvertFrom-SecureStringText($SecureString) {
  $Ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr)
  }
}

function New-Apr1Htpasswd($Password) {
  $NodeScript = @'
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
'@

  $PreviousPassword = $env:ADMIN_PASSWORD
  $env:ADMIN_PASSWORD = $Password
  try {
    $Hash = docker run --rm -e ADMIN_PASSWORD node:20-alpine node -e $NodeScript
  }
  finally {
    $env:ADMIN_PASSWORD = $PreviousPassword
  }

  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Hash)) {
    Die "Failed to generate admin password hash with Docker."
  }

  "$AdminUser`:$Hash" | Out-File -Encoding ascii $HtpasswdFile
  Write-Host "Created $HtpasswdFile"
}

$Docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $Docker) { Die "Docker not found. Install Docker Desktop for Windows." }

try {
  docker info | Out-Null
}
catch {
  Die "Docker daemon not running. Start Docker Desktop and re-run."
}

try {
  docker compose version | Out-Null
}
catch {
  Die "Docker Compose not found. Install or update Docker Desktop."
}

Require-File ".\docker-compose.yml"
Require-File ".\package.json"
Require-File ".\server.js"

New-Item -ItemType Directory -Force -Path $MediaDir | Out-Null

if (-not (Test-Path $SettingsFile)) {
  '{ "imageIntervalMs": 7000, "imageDurations": {}, "mediaOrder": [] }' | Out-File -Encoding ascii $SettingsFile
  Write-Host "Created $SettingsFile"
}

$ResetPassword = $env:RESET_ADMIN_PASSWORD -eq "true"
if ($ResetPassword -or -not (Test-Path $HtpasswdFile)) {
  $AdminPassword = $env:ADMIN_PASSWORD
  if ([string]::IsNullOrEmpty($AdminPassword)) {
    $AdminPassword = Read-AdminPassword
  }
  New-Apr1Htpasswd $AdminPassword
}
else {
  Write-Host "Using existing $HtpasswdFile"
}

$env:PORT = $Port
$env:MEDIA_DIR = $MediaDir
$env:SETTINGS_FILE = $SettingsFile
$env:HTPASSWD_FILE = $HtpasswdFile
$env:ADMIN_USER = $AdminUser

$LocalIps = Get-LocalIPv4Addresses
$PlayerHost = if ($LocalIps) { $LocalIps | Select-Object -First 1 } else { "" }
"PLAYER_HOST=$PlayerHost" | Out-File -Encoding ascii $RuntimeEnvFile
Write-Host "Wrote $RuntimeEnvFile"

Write-Host "Starting containers..."
docker compose up -d --build

Write-Host ""
Write-Host "Done."
Write-Host "Admin:  http://localhost:$Port/admin-login"
Write-Host "Player: http://localhost:$Port/player"

if ($LocalIps) {
  Write-Host ""
  Write-Host "LAN URLs:"
  foreach ($Ip in $LocalIps) {
    Write-Host "  Admin:  http://$Ip`:$Port/admin-login"
    Write-Host "  Player: http://$Ip`:$Port/player"
  }
}

Write-Host ""
Write-Host "Media folder:"
Write-Host "  $MediaDir"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  docker compose logs -f signage"
Write-Host "  docker compose restart signage"
Write-Host ""
Write-Host "To reset the admin password later:"
Write-Host '  $env:RESET_ADMIN_PASSWORD="true"; .\install.ps1'
