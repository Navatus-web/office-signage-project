@'
$ErrorActionPreference = "Stop"

$ProjectName = "office-signage"
$Port = $env:PORT
if ([string]::IsNullOrWhiteSpace($Port)) { $Port = "3000" }

$DataDir = $env:DATA_DIR
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = ".\data" }

$MediaDir = Join-Path $DataDir "media"
$SettingsFile = Join-Path $DataDir "settings.json"

Write-Host "== $ProjectName installer =="

function Die($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# Check docker
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) { Die "Docker not found. Install Docker Desktop for Windows." }

# Check docker daemon
try { docker info | Out-Null } catch { Die "Docker daemon not running. Start Docker Desktop and re-run." }

# Create dirs/files
New-Item -ItemType Directory -Force -Path $MediaDir | Out-Null

if (-not (Test-Path $SettingsFile)) {
  '{ "imageIntervalMs": 7000 }' | Out-File -Encoding utf8 $SettingsFile
  Write-Host "Created $SettingsFile"
}

if (-not (Test-Path ".\docker-compose.yml")) {
  Die "docker-compose.yml not found in current directory. Run this from the repo root."
}

Write-Host "Starting containers..."
docker compose up -d --build

Write-Host ""
Write-Host "✅ Done!"
Write-Host "Admin:  http://localhost:$Port/admin"
Write-Host "Player: http://localhost:$Port/player"
Write-Host ""
Write-Host "Media folder:"
Write-Host "  $MediaDir"
Write-Host ""
Write-Host "Tip: drop images/videos into the media folder; screens will update automatically."
'@ | Set-Content -Encoding UTF8 install.ps1