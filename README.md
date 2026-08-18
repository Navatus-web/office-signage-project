
# Office Signage Project

Version: `1.0.4`

A lightweight, real-time **digital signage system** built with **Node.js**, **Socket.IO**, and **Docker**.

Designed to run on **any PC** (Windows, macOS, or Linux) and keep multiple display screens perfectly synchronized.

---

# Features

-  Real-time synchronized playback across multiple screens
-  Dynamic media detection (no restart required)
-  Central web-based admin panel
-  Adjustable global image interval
-  Per-image display duration overrides
-  Drag-and-drop media ordering with saved playlist priority
-  Live preview panel inside the admin console
-  Validated multi-file uploads for JPG, JPEG, PNG, WEBP, GIF, MP4, WEBM, and MOV media
-  Per-file media removal and confirmation-protected media clearing
-  Global pause/resume control for all connected displays
-  Built-in admin password reset flow
-  Automatic screen re-synchronization
-  Player URL generation based on the host machine LAN IP at install/start time
-  Docker-ready deployment
-  Runs on any device with a web browser
-  One-command setup/update flow for presentation machines

---

## 🏗 How It Works

The signage server acts as a **central time authority**.

All connected player screens receive synchronization updates via **Socket.IO**, ensuring media changes occur at the same time across all displays.

---

## Quick Setup

Install Docker Desktop, clone or copy this project, then run the installer from the project root.

macOS / Linux:

```sh
./install.sh
```

Windows PowerShell:

```powershell
.\install.ps1
```

The installer creates the media folder, settings file, an Argon2id admin password file, and a local runtime env file used to pass the host LAN IP into Docker. It then builds and starts the container. Existing APR1 credentials remain usable and are upgraded to Argon2id automatically after the next successful login.

Default URLs:

- Admin: `http://localhost:3000/admin-login`
- Player: shown in the admin panel and based on the detected host LAN IP
- Media folder: `./public/media`

Useful options:

```sh
PORT=8080 ./install.sh
RESET_ADMIN_PASSWORD=true ./install.sh
ADMIN_PASSWORD="new-password" RESET_ADMIN_PASSWORD=true ./install.sh
```

```powershell
$env:PORT="8080"; .\install.ps1
$env:RESET_ADMIN_PASSWORD="true"; .\install.ps1
$env:ADMIN_PASSWORD="new-password"; $env:RESET_ADMIN_PASSWORD="true"; .\install.ps1
```

Useful Docker commands:

```sh
docker compose logs -f signage
docker compose restart signage
docker compose down
```

## Security Configuration

Uploads are staged outside the public media directory and are only moved into it after the extension, browser-supplied MIME type, and file signature all pass validation. The defaults allow 10 files per request, 250 MB per file, and 1,000 MB total. You can tune the limits before running the installer:

```sh
UPLOAD_MAX_FILES=6 UPLOAD_MAX_FILE_MB=150 UPLOAD_MAX_TOTAL_MB=600 ./install.sh
```

```powershell
$env:UPLOAD_MAX_FILES="6"; $env:UPLOAD_MAX_FILE_MB="150"; $env:UPLOAD_MAX_TOTAL_MB="600"; .\install.ps1
```

When the admin interface is served through one trusted HTTPS reverse proxy, enable proxy awareness and secure cookies. Use `COOKIE_SECURE=true` when admin access is HTTPS-only, or `auto` when retaining direct HTTP access on the isolated LAN:

```sh
TRUST_PROXY=true COOKIE_SECURE=true ./install.sh
```

```powershell
$env:TRUST_PROXY="true"; $env:COOKIE_SECURE="true"; .\install.ps1
```

For Tailscale, the service can remain on localhost and be exposed over your tailnet with HTTPS:

```sh
tailscale serve --bg localhost:3000
```

Only enable `TRUST_PROXY` when requests actually pass through a trusted reverse proxy. Direct HTTP remains the default for isolated LAN deployments.

## Update For Presentation

On a machine that has already been set up once:

```sh
git pull
./install.sh
```

Windows PowerShell:

```powershell
git pull
.\install.ps1
```

The installer is idempotent: it keeps the existing admin password, media folder, and settings file, re-detects the current machine LAN IP, rebuilds the app, and starts the server. When it finishes, it prints the local and LAN URLs for the admin console and player.

First setup on a new machine will ask you to create the admin password. For a hands-off install, provide it as an environment variable:

```sh
ADMIN_PASSWORD="your-password" ./install.sh
```

```powershell
$env:ADMIN_PASSWORD="your-password"; .\install.ps1
```

---

## Release Notes

### v1.0.4

- Added private upload quarantine, MIME/extension matching, signature checks, and configurable upload limits.
- Replaced new APR1 password hashes with Argon2id and added transparent migration for existing credentials.
- Added login session regeneration plus configurable reverse-proxy and secure-cookie support.
- Updated the Docker runtime to Node.js 24 for built-in Argon2id support.

### v1.0.3

- Added drag-and-drop media ordering with saved playlist priority.
- Added a live preview panel in Playback Management.
- Added multi-file upload support with a 10-file limit.
- Added per-file media removal and a confirmation-protected media clear action.
- Added per-image duration overrides and a default apply-to-all image time control.
- Added global pause/resume controls and player-side sync refinements to reduce flicker.
- Added an in-app password reset flow under Account.
- Updated the admin UI with cleaner styling and muted symbolic panel icons.
- Updated installers to detect the current machine LAN IP and pass it into Docker so the admin panel exposes a usable player URL for other devices on the network.
