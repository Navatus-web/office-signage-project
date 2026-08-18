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

    if ($PasswordText.Length -lt 4 -or $PasswordText.Length -gt 64) {
      Write-Host "Password must be between 4 and 64 characters."
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

function New-Argon2Htpasswd($Password) {
  $PreviousPassword = $env:ADMIN_PASSWORD
  $env:ADMIN_PASSWORD = $Password
  try {
    $Hash = $null
    $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($NodeCmd) {
      & node -e 'process.exit(typeof require("node:crypto").argon2 === "function" ? 0 : 1)' 2>$null
      if ($LASTEXITCODE -eq 0) {
        $Hash = & node .\scripts\hash-password.js 2>$null
      }
    }

    if ([string]::IsNullOrWhiteSpace($Hash)) {
      $ProjectRoot = (Get-Location).Path
      $Hash = docker run --rm -e ADMIN_PASSWORD -v "${ProjectRoot}:/work:ro" -w /work node:24-alpine node scripts/hash-password.js
    }
  }
  finally {
    $env:ADMIN_PASSWORD = $PreviousPassword
  }

  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Hash)) {
    Die "Failed to generate the Argon2id admin password hash with Node.js or Docker."
  }

  "$AdminUser`:$($Hash.Trim())" | Out-File -Encoding ascii $HtpasswdFile
  Write-Host "Created $HtpasswdFile"
}

function Get-RuntimeEnvValue($Key) {
  if (-not (Test-Path $RuntimeEnvFile)) { return "" }

  $Line = Get-Content $RuntimeEnvFile |
    Where-Object { $_ -like "$Key=*" } |
    Select-Object -Last 1

  if ([string]::IsNullOrWhiteSpace($Line)) { return "" }
  return $Line.Substring($Key.Length + 1)
}

function New-SessionSecret {
  $Existing = Get-RuntimeEnvValue "SESSION_SECRET"
  if (-not [string]::IsNullOrWhiteSpace($Existing)) { return $Existing }

  if (-not [string]::IsNullOrWhiteSpace($env:SESSION_SECRET)) { return $env:SESSION_SECRET }

  $Bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($Bytes)
  return ([System.BitConverter]::ToString($Bytes) -replace "-", "").ToLowerInvariant()
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
Require-File ".\scripts\hash-password.js"

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
  New-Argon2Htpasswd $AdminPassword
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
$SessionSecret = New-SessionSecret
$TrustProxy = $env:TRUST_PROXY
if ([string]::IsNullOrWhiteSpace($TrustProxy)) { $TrustProxy = Get-RuntimeEnvValue "TRUST_PROXY" }
if ([string]::IsNullOrWhiteSpace($TrustProxy)) { $TrustProxy = "false" }
$CookieSecure = $env:COOKIE_SECURE
if ([string]::IsNullOrWhiteSpace($CookieSecure)) { $CookieSecure = Get-RuntimeEnvValue "COOKIE_SECURE" }
if ([string]::IsNullOrWhiteSpace($CookieSecure)) { $CookieSecure = "false" }
$UploadMaxFiles = $env:UPLOAD_MAX_FILES
if ([string]::IsNullOrWhiteSpace($UploadMaxFiles)) { $UploadMaxFiles = Get-RuntimeEnvValue "UPLOAD_MAX_FILES" }
if ([string]::IsNullOrWhiteSpace($UploadMaxFiles)) { $UploadMaxFiles = "10" }
$UploadMaxFileMb = $env:UPLOAD_MAX_FILE_MB
if ([string]::IsNullOrWhiteSpace($UploadMaxFileMb)) { $UploadMaxFileMb = Get-RuntimeEnvValue "UPLOAD_MAX_FILE_MB" }
if ([string]::IsNullOrWhiteSpace($UploadMaxFileMb)) { $UploadMaxFileMb = "250" }
$UploadMaxTotalMb = $env:UPLOAD_MAX_TOTAL_MB
if ([string]::IsNullOrWhiteSpace($UploadMaxTotalMb)) { $UploadMaxTotalMb = Get-RuntimeEnvValue "UPLOAD_MAX_TOTAL_MB" }
if ([string]::IsNullOrWhiteSpace($UploadMaxTotalMb)) { $UploadMaxTotalMb = "1000" }
@(
  "PLAYER_HOST=$PlayerHost"
  "SESSION_SECRET=$SessionSecret"
  "TRUST_PROXY=$TrustProxy"
  "COOKIE_SECURE=$CookieSecure"
  "UPLOAD_MAX_FILES=$UploadMaxFiles"
  "UPLOAD_MAX_FILE_MB=$UploadMaxFileMb"
  "UPLOAD_MAX_TOTAL_MB=$UploadMaxTotalMb"
) | Out-File -Encoding ascii $RuntimeEnvFile
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
