
# Office Signage Project

Version: `1.0.2`

A lightweight, real-time **digital signage system** built with **Node.js**, **Socket.IO**, and **Docker**.

Designed to run on **any PC** (Windows, macOS, or Linux) and keep multiple display screens perfectly synchronized.

---

# Features

-  Real-time synchronized playback across multiple screens
-  Dynamic media detection (no restart required)
-  Central web-based admin panel
-  Adjustable global image interval
-  Per-image display duration overrides
-  Automatic screen re-synchronization
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

The installer creates the media folder, settings file, and admin password file, then builds and starts the Docker container.

Default URLs:

- Admin: `http://localhost:3000/admin-login`
- Player: `http://localhost:3000/player`
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

The installer is idempotent: it keeps the existing admin password, media folder, and settings file, rebuilds the app, and starts the server. When it finishes, it prints the local and LAN URLs for the admin console and player.

First setup on a new machine will ask you to create the admin password. For a hands-off install, provide it as an environment variable:

```sh
ADMIN_PASSWORD="your-password" ./install.sh
```

```powershell
$env:ADMIN_PASSWORD="your-password"; .\install.ps1
```

---

## Release Notes

### v1.0.2

- Modernized the admin and login UI with cleaner typography, softer colors, and dashboard-style controls.
- Added media upload management from the admin panel.
- Added a confirmation-protected clear-media action.
- Added a media folder list in Interval Control with file size/type display.
- Added per-image duration overrides, while videos continue playing through naturally.
- Added global pause/resume controls for all connected player screens.
- Added copyable player URL from Screen Operations.
- Improved Docker Compose persistence for media, settings, and admin password files.
- Updated macOS/Linux and Windows installers for first-run setup, updates after `git pull`, and admin password resets.
