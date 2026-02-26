const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const chokidar = require("chokidar");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PUBLIC_DIR = path.join(__dirname, "public");
const MEDIA_DIR = path.join(PUBLIC_DIR, "media");
const SETTINGS_FILE = path.join(__dirname, "settings.json");

app.use(express.json()); // for POST /api/settings
app.use(express.static(PUBLIC_DIR));

// ----------------------------
// Settings (persisted)
// ----------------------------
const DEFAULT_SETTINGS = { imageIntervalMs: 7000 };
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
      const parsed = JSON.parse(raw);
      settings = { ...DEFAULT_SETTINGS, ...parsed };
    } else {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    }
  } catch (e) {
    console.warn("⚠️ Could not load settings.json, using defaults:", e.message);
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.warn("⚠️ Failed to save settings.json:", e.message);
  }
}

loadSettings();

// Ensure media folder exists
try {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
} catch (e) {
  console.warn("⚠️ Could not create media dir:", e.message);
}

// ----------------------------
// Clean routes
// ----------------------------
app.get("/player", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "player.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

// ----------------------------
// Playlist
// ----------------------------
const imageExt = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const videoExt = new Set([".mp4", ".webm", ".mov"]);

function isJunk(name) {
  const lower = name.toLowerCase();
  return (
    lower === ".ds_store" ||
    lower === "thumbs.db" ||
    lower.startsWith("._") || // macOS resource fork
    lower.endsWith(".part") ||
    lower.endsWith(".tmp") ||
    lower.endsWith(".crdownload")
  );
}

function buildPlaylist() {
  let files = [];
  try {
    files = fs
      .readdirSync(MEDIA_DIR, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch (e) {
    return [];
  }

  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  const interval = Number(settings.imageIntervalMs) || DEFAULT_SETTINGS.imageIntervalMs;

  return files
    .filter((name) => !isJunk(name))
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      return imageExt.has(ext) || videoExt.has(ext);
    })
    .map((name) => {
      const ext = path.extname(name).toLowerCase();
      const isVideo = videoExt.has(ext);

      return {
        type: isVideo ? "video" : "image",
        src: `/media/${encodeURIComponent(name)}`,
        duration: isVideo ? undefined : interval,
      };
    });
}

app.get("/api/playlist", (req, res) => {
  res.json(buildPlaylist());
});

// ----------------------------
// Sync State
// ----------------------------
let syncState = {
  startedAt: Date.now(),
  playlistVersion: 1,
};

function bumpSync(reason) {
  syncState.startedAt = Date.now();
  syncState.playlistVersion += 1;
  console.log(`🕒 Sync reset (${reason}). Version=${syncState.playlistVersion}`);
}

app.get("/api/sync", (req, res) => {
  res.json(syncState);
});

// Heartbeat to help clients correct drift
setInterval(() => {
  io.emit("sync", syncState);
}, 2000);

// ----------------------------
// Settings API (Admin uses this)
// ----------------------------
app.get("/api/settings", (req, res) => {
  res.json(settings);
});

app.post("/api/settings", (req, res) => {
  const interval = Number(req.body?.imageIntervalMs);

  // 1s to 10min
  if (!Number.isFinite(interval) || interval < 1000 || interval > 600000) {
    return res.status(400).json({
      error: "imageIntervalMs must be a number between 1000 and 600000",
    });
  }

  settings.imageIntervalMs = Math.floor(interval);
  saveSettings();

  // Re-sync all screens so timing changes apply immediately and in-sync
  bumpSync("settings");
  io.emit("reload");
  io.emit("sync", syncState);

  res.json(settings);
});

// ----------------------------
// Socket.io
// ----------------------------
io.on("connection", (socket) => {
  console.log("Screen connected:", socket.id);

  // push sync state immediately
  socket.emit("sync", syncState);

  // manual reload button in admin
  socket.on("reload", () => {
    bumpSync("manual");
    io.emit("reload");
    io.emit("sync", syncState);
  });

  socket.on("disconnect", () => console.log("Screen disconnected:", socket.id));
});

// ----------------------------
// File watcher (dynamic media)
// ----------------------------
let reloadTimer = null;
function triggerReload(reason) {
  if (reloadTimer) clearTimeout(reloadTimer);

  reloadTimer = setTimeout(() => {
    bumpSync(reason);
    console.log(`🔁 Broadcasting reload (${reason})`);
    io.emit("reload");
    io.emit("sync", syncState);
  }, 700);
}

const watcher = chokidar.watch(MEDIA_DIR, {
  ignoreInitial: true,
  persistent: true,

  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 1000,
  },

  usePolling: true,
  interval: 500,
});

watcher
  .on("add", (filePath) => {
    console.log("Media added:", filePath);
    triggerReload("add");
  })
  .on("change", (filePath) => {
    console.log("Media changed:", filePath);
    triggerReload("change");
  })
  .on("unlink", (filePath) => {
    console.log("Media removed:", filePath);
    triggerReload("unlink");
  })
  .on("error", (err) => console.error("Watcher error:", err));

// ----------------------------
// Start server
// ----------------------------
server.listen(3000, "0.0.0.0", () => {
  console.log("Signage server running on port 3000");
  console.log("Watching media folder:", MEDIA_DIR);
  console.log("Current image interval (ms):", settings.imageIntervalMs);
});