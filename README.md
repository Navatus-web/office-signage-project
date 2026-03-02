
# Office Signage Project

A lightweight, real-time **digital signage system** built with **Node.js**, **Socket.IO**, and **Docker**.

Designed to run on **any PC** (Windows, macOS, or Linux) and keep multiple display screens perfectly synchronized.

---

# Features

-  Real-time synchronized playback across multiple screens
-  Dynamic media detection (no restart required)
-  Central web-based admin panel
-  Adjustable global image interval
-  Automatic screen re-synchronization
-  Docker-ready deployment
-  Runs on any device with a web browser

---

## 🏗 How It Works

The signage server acts as a **central time authority**.

All connected player screens receive synchronization updates via **Socket.IO**, ensuring media changes occur at the same time across all displays.
