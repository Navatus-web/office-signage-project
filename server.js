const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const chokidar = require("chokidar");
const session = require("express-session");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ----------------------------
// Paths
// ----------------------------
const PUBLIC_DIR = path.join(__dirname, "public");
const MEDIA_DIR = path.join(PUBLIC_DIR, "media");
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const HTPASSWD_FILE = path.join(__dirname, "admin.htpasswd");

// ----------------------------
// Config
// ----------------------------
const DEFAULT_SETTINGS = {
  imageIntervalMs: 7000,
  imageDurations: {},
  mediaOrder: [],
};

const SESSION_SECRET = String(process.env.SESSION_SECRET || "change-me-in-prod");
const CHOKIDAR_USEPOLLING = String(process.env.CHOKIDAR_USEPOLLING || "true") === "true";
const CHOKIDAR_INTERVAL = Number(process.env.CHOKIDAR_INTERVAL || 500);
const ADMIN_USER = String(process.env.ADMIN_USER || "admin");
const PLAYER_HOST = String(process.env.PLAYER_HOST || "").trim();

// ----------------------------
// Middleware
// ----------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ----------------------------
// File Upload
// ----------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => {
      cb(null, file.originalname);
    },
  }),
  limits: {
    fileSize: 1024 * 1024 * 500,
    files: 10,
  }, // 500MB max, 10 files per upload
});

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    // secure: true, // enable behind HTTPS
    maxAge: 12 * 60 * 60 * 1000, // 12 hours
  },
});

app.use(sessionMiddleware);

// Prevent HTML caching
app.use((req, res, next) => {
  if (
    req.path.endsWith(".html") ||
    req.path === "/admin" ||
    req.path === "/player" ||
    req.path === "/admin-login"
  ) {
    res.set("Cache-Control", "no-store");
  }
  next();
});

// Ensure media folder exists
try {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
} catch (err) {
  console.warn("⚠️ Could not create media dir:", err.message);
}

// Explicit /media static route with no caching
app.use(
  "/media",
  express.static(MEDIA_DIR, {
    etag: false,
    lastModified: true,
    setHeaders(res, filePath) {
      res.setHeader("Cache-Control", "no-store");

      const lower = filePath.toLowerCase();
      if (lower.endsWith(".mp4")) res.setHeader("Content-Type", "video/mp4");
      if (lower.endsWith(".webm")) res.setHeader("Content-Type", "video/webm");
      if (lower.endsWith(".mov")) res.setHeader("Content-Type", "video/quicktime");
    },
  })
);

// Static public files
app.use(express.static(PUBLIC_DIR));

// ----------------------------
// htpasswd init
// ----------------------------
let htpasswd = null;

function to64(value, length) {
  const chars = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let output = "";
  let current = value;

  while (length > 0) {
    output += chars[current & 0x3f];
    current >>= 6;
    length -= 1;
  }

  return output;
}

function md5(input) {
  return crypto.createHash("md5").update(input).digest();
}

function createApr1Salt() {
  return crypto
    .randomBytes(6)
    .toString("base64")
    .replace(/[+/=]/g, ".")
    .slice(0, 8);
}

function apr1(password, salt) {
  const magic = "$apr1$";
  const salt8 = salt.replace(/^\$apr1\$/, "").split("$")[0].slice(0, 8);

  let ctx = Buffer.concat([
    Buffer.from(password + magic + salt8, "utf8"),
    Buffer.alloc(0),
  ]);

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

function createHtpasswdAuth(filePath) {
  return {
    async authenticate(username, password) {
      const raw = fs.readFileSync(filePath, "utf8");
      const line = raw
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry && !entry.startsWith("#") && entry.startsWith(`${username}:`));

      if (!line) return false;

      const hash = line.slice(username.length + 1);

      if (hash.startsWith("$apr1$")) {
        return apr1(password, hash) === hash;
      }

      throw new Error(`Unsupported htpasswd hash format for user ${username}`);
    },
  };
}

function initHtpasswd() {
  if (!fs.existsSync(HTPASSWD_FILE)) {
    console.warn(`⚠️ Missing ${HTPASSWD_FILE}`);
    console.warn("   Create it with: htpasswd -c admin.htpasswd admin");
    htpasswd = null;
    return;
  }

  htpasswd = createHtpasswdAuth(HTPASSWD_FILE);
}

function saveHtpasswdPassword(password) {
  const hash = apr1(password, createApr1Salt());
  fs.writeFileSync(HTPASSWD_FILE, `${ADMIN_USER}:${hash}\n`, "utf8");
  initHtpasswd();
}

initHtpasswd();

// ----------------------------
// Settings
// ----------------------------
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
      const parsed = JSON.parse(raw);
      settings = { ...DEFAULT_SETTINGS, ...parsed };
      if (!settings.imageDurations || typeof settings.imageDurations !== "object" || Array.isArray(settings.imageDurations)) {
        settings.imageDurations = {};
      }
      if (!Array.isArray(settings.mediaOrder)) {
        settings.mediaOrder = [];
      }
    } else {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    }
  } catch (err) {
    console.warn("⚠️ Could not load settings.json, using defaults:", err.message);
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.warn("⚠️ Failed to save settings.json:", err.message);
  }
}

loadSettings();

// ----------------------------
// Auth helpers
// ----------------------------
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Admin login required" });
  }
  return res.redirect("/admin-login");
}

// Basic login rate limiting per IP
const loginLimiter = new Map(); // ip -> { fails, lockUntil }

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function isLocked(ip) {
  const row = loginLimiter.get(ip);
  return !!(row && row.lockUntil && Date.now() < row.lockUntil);
}

function recordFail(ip) {
  const row = loginLimiter.get(ip) || { fails: 0, lockUntil: 0 };
  row.fails += 1;

  if (row.fails >= 5) {
    row.lockUntil = Date.now() + 60_000;
    row.fails = 0;
  }

  loginLimiter.set(ip, row);
}

function clearFails(ip) {
  loginLimiter.delete(ip);
}

// ----------------------------
// Routes
// ----------------------------
app.get("/player", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "player.html"));
});

app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.get("/admin-login", (req, res) => {
  const err = req.query.err ? "❌ Invalid login" : "";
  const missing = !htpasswd ? "⚠️ Server missing admin.htpasswd" : "";
  const locked = req.query.lock ? "⏳ Too many attempts. Try again shortly." : "";

  res.type("html").send(`
<!DOCTYPE html>
<html>
<head>
  <title>Admin Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    *{box-sizing:border-box}
    body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(180deg,#111827 0%,#0f172a 100%);color:#e5edf6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
    .card{background:rgba(15,23,42,.92);border:1px solid rgba(148,163,184,.22);box-shadow:0 24px 60px rgba(2,6,23,.32);padding:28px;border-radius:10px;max-width:380px;width:100%}
    h2{margin:0 0 18px 0;font-size:21px;font-weight:700;letter-spacing:.01em}
    input{width:100%;padding:12px 12px;font-size:17px;border-radius:6px;border:1px solid rgba(148,163,184,.26);background:rgba(2,6,23,.3);color:#e5edf6;outline:none}
    input:focus{border-color:#38bdf8;box-shadow:0 0 0 3px rgba(56,189,248,.15)}
    button{width:100%;margin-top:14px;padding:12px;border:1px solid rgba(56,189,248,.52);border-radius:6px;background:rgba(14,165,233,.18);color:#bae6fd;font-size:15px;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:.05em}
    button:hover{background:rgba(14,165,233,.28)}
    .msg{margin-top:12px;color:#94a3b8;font-size:13px;min-height:18px}
  </style>
</head>
<body>
  <div class="card">
    <h2>Office Signage Admin</h2>
    <form method="POST" action="/admin-login">
      <input
        name="pin"
        type="password"
        maxlength="20"
        placeholder="PIN / Password"
        autocomplete="current-password"
        required
      />
      <button type="submit">Unlock</button>
    </form>
    <div class="msg">${locked || missing || err}</div>
  </div>
</body>
</html>
  `);
});

app.post("/admin-login", async (req, res) => {
  const ip = getClientIp(req);

  if (isLocked(ip)) return res.redirect("/admin-login?lock=1");
  if (!htpasswd) return res.redirect("/admin-login?err=1");

  const password = String(req.body.pin || "").trim();

  try {
    const ok = await htpasswd.authenticate(ADMIN_USER, password);

    if (ok) {
      req.session.isAdmin = true;
      clearFails(ip);
      return res.redirect("/admin");
    }

    recordFail(ip);
    return res.redirect("/admin-login?err=1");
  } catch (err) {
    console.warn("htpasswd auth error:", err.message);
    recordFail(ip);
    return res.redirect("/admin-login?err=1");
  }
});

app.post("/admin-logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin-login"));
});

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
    lower.startsWith("._") ||
    lower.endsWith(".part") ||
    lower.endsWith(".tmp") ||
    lower.endsWith(".crdownload")
  );
}

// Videos first, then images, then alphabetical
function sortVideoFirst(a, b) {
  const extA = path.extname(a).toLowerCase();
  const extB = path.extname(b).toLowerCase();

  const aIsVideo = videoExt.has(extA);
  const bIsVideo = videoExt.has(extB);

  if (aIsVideo !== bIsVideo) return aIsVideo ? -1 : 1;

  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function getImageDuration(name, fallback) {
  const override = Number(settings.imageDurations?.[name]);
  if (Number.isFinite(override) && override >= 1000 && override <= 600000) {
    return Math.floor(override);
  }
  return fallback;
}

function sortByMediaOrder(a, b) {
  const order = Array.isArray(settings.mediaOrder) ? settings.mediaOrder : [];
  const indexA = order.indexOf(a);
  const indexB = order.indexOf(b);

  if (indexA !== -1 || indexB !== -1) {
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  }

  return sortVideoFirst(a, b);
}

function getPlayableMediaNames() {
  return fs
    .readdirSync(MEDIA_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !isJunk(name))
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      return imageExt.has(ext) || videoExt.has(ext);
    });
}

function buildPlaylist() {
  let files = [];

  try {
    files = getPlayableMediaNames();
  } catch (err) {
    console.warn("⚠️ Could not read media directory:", err.message);
    return [];
  }

  const interval = Number(settings.imageIntervalMs) || DEFAULT_SETTINGS.imageIntervalMs;

  return files
    .sort(sortByMediaOrder)
    .map((name) => {
      const ext = path.extname(name).toLowerCase();
      const isVideo = videoExt.has(ext);

      return {
        type: isVideo ? "video" : "image",
        src: `/media/${encodeURIComponent(name)}`,
        duration: isVideo ? undefined : getImageDuration(name, interval),
      };
    });
}

app.get("/api/playlist", (req, res) => {
  res.json(buildPlaylist());
});

// ----------------------------
// Sync state
// ----------------------------
let syncState = {
  startedAt: Date.now(),
  playlistVersion: 1,
  paused: false,
};

const playerStates = new Map();
let latestPlayerState = null;

function bumpSync(reason) {
  syncState.startedAt = Date.now();
  syncState.playlistVersion += 1;
  console.log(`🕒 Sync reset (${reason}). Version=${syncState.playlistVersion}`);
}

function broadcastSync() {
  io.emit("sync", syncState);
}

function setPaused(paused) {
  syncState.paused = paused;

  if (!paused) {
    bumpSync("resume");
  }

  console.log(paused ? "⏸️ Playback paused" : "▶️ Playback resumed");
  io.emit("playback-state", {
    paused: syncState.paused,
    syncState,
  });
  broadcastSync();
}

function broadcastReloadAndSync(reason) {
  bumpSync(reason);
  console.log(`🔁 Broadcasting reload (${reason})`);
  io.emit("reload");
  broadcastSync();
}

app.get("/api/sync", (req, res) => {
  res.json(syncState);
});

app.get("/api/playback", requireAdmin, (req, res) => {
  res.json({ paused: syncState.paused });
});

app.get("/api/network", requireAdmin, (req, res) => {
  const hostHeader = String(req.headers.host || "");
  const port = hostHeader.includes(":")
    ? hostHeader.split(":").pop()
    : String(process.env.PORT || 3000);
  const playerHost = PLAYER_HOST || req.hostname || "localhost";

  res.json({
    playerHost,
    playerUrl: `${req.protocol}://${playerHost}:${port}/player`,
  });
});

// ----------------------------
// Settings API
// ----------------------------
app.get("/api/settings", requireAdmin, (req, res) => {
  res.json(settings);
});

app.post("/api/settings", requireAdmin, (req, res) => {
  const interval = Number(req.body?.imageIntervalMs);

  if (!Number.isFinite(interval) || interval < 1000 || interval > 600000) {
    return res.status(400).json({
      error: "imageIntervalMs must be a number between 1000 and 600000",
    });
  }

  settings.imageIntervalMs = Math.floor(interval);
  settings.imageDurations = {};
  saveSettings();

  broadcastReloadAndSync("settings");

  res.json(settings);
});

app.post("/api/admin-password", requireAdmin, (req, res) => {
  const password = String(req.body?.password || "");
  const confirmPassword = String(req.body?.confirmPassword || "");

  if (password.length < 4 || password.length > 64) {
    return res.status(400).json({ error: "Password must be between 4 and 64 characters" });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ error: "Passwords do not match" });
  }

  try {
    saveHtpasswdPassword(password);
  } catch (err) {
    console.error("❌ Failed to update admin password:", err.message);
    return res.status(500).json({ error: "Failed to update admin password" });
  }

  res.json({ success: true });
});

app.post("/api/media-duration", requireAdmin, (req, res) => {
  const filename = String(req.body?.filename || "");
  const durationSeconds = req.body?.durationSeconds;

  if (!filename || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).json({ error: "Valid filename is required" });
  }

  const filePath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ error: "Media file not found" });
  }

  const ext = path.extname(filename).toLowerCase();
  if (!imageExt.has(ext)) {
    return res.status(400).json({ error: "Only images support custom durations" });
  }

  if (!settings.imageDurations || typeof settings.imageDurations !== "object") {
    settings.imageDurations = {};
  }

  if (durationSeconds === null || durationSeconds === "" || typeof durationSeconds === "undefined") {
    delete settings.imageDurations[filename];
  } else {
    const seconds = Number(durationSeconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
      return res.status(400).json({ error: "Duration must be between 1 and 600 seconds" });
    }
    settings.imageDurations[filename] = Math.floor(seconds * 1000);
  }

  saveSettings();
  broadcastReloadAndSync("media-duration");

  res.json({
    success: true,
    filename,
    durationMs: settings.imageDurations[filename] || null,
  });
});

// ----------------------------
// File Upload API
// ----------------------------
app.post("/api/upload", requireAdmin, upload.array("files", 10), (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];

  if (files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  if (Array.isArray(settings.mediaOrder) && settings.mediaOrder.length > 0) {
    let orderChanged = false;

    for (const file of files) {
      if (!settings.mediaOrder.includes(file.originalname)) {
        settings.mediaOrder.push(file.originalname);
        orderChanged = true;
      }
    }

    if (orderChanged) {
      saveSettings();
    }
  }

  console.log(`📁 Uploaded ${files.length} file${files.length === 1 ? "" : "s"}: ${files.map((file) => file.originalname).join(", ")}`);
  broadcastReloadAndSync("file");

  res.json({
    success: true,
    count: files.length,
    filenames: files.map((file) => file.originalname),
  });
});

app.get("/api/media", requireAdmin, (req, res) => {
  try {
    const files = fs
      .readdirSync(MEDIA_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .filter((entry) => !isJunk(entry.name))
      .map((entry) => {
        const filePath = path.join(MEDIA_DIR, entry.name);
        const stats = fs.statSync(filePath);
        const ext = path.extname(entry.name).toLowerCase();
        const type = videoExt.has(ext) ? "video" : imageExt.has(ext) ? "image" : "file";

        return {
          name: entry.name,
          type,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          durationMs: type === "image" ? settings.imageDurations?.[entry.name] || null : null,
        };
      })
      .sort((a, b) => sortByMediaOrder(a.name, b.name));

    res.json({ files });
  } catch (err) {
    console.error("❌ Failed to read media folder:", err.message);
    res.status(500).json({ error: "Failed to read media folder" });
  }
});

app.post("/api/media-order", requireAdmin, (req, res) => {
  const filenames = req.body?.filenames;

  if (!Array.isArray(filenames)) {
    return res.status(400).json({ error: "filenames must be an array" });
  }

  let playableNames = [];
  try {
    playableNames = getPlayableMediaNames();
  } catch (err) {
    console.error("❌ Failed to read media folder:", err.message);
    return res.status(500).json({ error: "Failed to read media folder" });
  }

  const playableSet = new Set(playableNames);
  const ordered = [];

  for (const filename of filenames) {
    const name = String(filename || "");

    if (!name || name.includes("/") || name.includes("\\")) {
      return res.status(400).json({ error: "Invalid filename in order" });
    }

    if (playableSet.has(name) && !ordered.includes(name)) {
      ordered.push(name);
    }
  }

  const remaining = playableNames
    .filter((name) => !ordered.includes(name))
    .sort(sortVideoFirst);

  settings.mediaOrder = [...ordered, ...remaining];
  saveSettings();
  broadcastReloadAndSync("media-order");

  res.json({
    success: true,
    mediaOrder: settings.mediaOrder,
  });
});

app.delete("/api/media-order", requireAdmin, (req, res) => {
  settings.mediaOrder = [];
  saveSettings();
  broadcastReloadAndSync("media-order-reset");

  res.json({
    success: true,
    mediaOrder: settings.mediaOrder,
  });
});

app.delete("/api/media/:filename", requireAdmin, (req, res) => {
  const filename = String(req.params.filename || "");

  if (!filename || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).json({ error: "Valid filename is required" });
  }

  const targetPath = path.resolve(MEDIA_DIR, filename);
  const mediaRoot = path.resolve(MEDIA_DIR);

  if (!targetPath.startsWith(`${mediaRoot}${path.sep}`)) {
    return res.status(400).json({ error: "Invalid media path" });
  }

  try {
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      return res.status(404).json({ error: "Media file not found" });
    }

    fs.rmSync(targetPath, { force: true });

    if (settings.imageDurations?.[filename]) {
      delete settings.imageDurations[filename];
    }

    if (Array.isArray(settings.mediaOrder)) {
      settings.mediaOrder = settings.mediaOrder.filter((name) => name !== filename);
    }

    saveSettings();
  } catch (err) {
    console.error("❌ Failed to remove media file:", err.message);
    return res.status(500).json({ error: "Failed to remove media file" });
  }

  console.log(`🗑️ Removed media file: ${filename}`);
  broadcastReloadAndSync("remove-media");

  res.json({
    success: true,
    filename,
  });
});

app.delete("/api/media", requireAdmin, (req, res) => {
  let deletedCount = 0;

  try {
    const entries = fs.readdirSync(MEDIA_DIR, { withFileTypes: true });

    for (const entry of entries) {
      const targetPath = path.join(MEDIA_DIR, entry.name);
      fs.rmSync(targetPath, { recursive: true, force: true });
      deletedCount += 1;
    }

    settings.imageDurations = {};
    settings.mediaOrder = [];
    saveSettings();
  } catch (err) {
    console.error("❌ Failed to clear media folder:", err.message);
    return res.status(500).json({ error: "Failed to clear media folder" });
  }

  console.log(`🧹 Cleared media folder. Removed ${deletedCount} item${deletedCount === 1 ? "" : "s"}.`);
  broadcastReloadAndSync("clear-media");

  res.json({
    success: true,
    deletedCount,
  });
});

// ----------------------------
// Socket.IO auth + handlers
// ----------------------------
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

function broadcastClientCount() {
  const count = io.of("/").sockets.size;
  io.emit("client-count", count);
}

io.on("connection", (socket) => {
  console.log(`🟢 Client connected: ${socket.id}`);

  // Send current sync state to new clients
  socket.emit("sync", syncState);
  socket.emit("playback-state", {
    paused: syncState.paused,
    syncState,
  });
  if (latestPlayerState) {
    socket.emit("player-state", latestPlayerState);
  }
  broadcastClientCount();

  socket.on("reload", () => {
    const isAdmin = socket.request?.session?.isAdmin === true;

    if (!isAdmin) {
      console.warn("❌ Blocked unauthorized reload from", socket.id);
      return;
    }

    broadcastReloadAndSync("manual");
  });

  socket.on("set-paused", (paused) => {
    const isAdmin = socket.request?.session?.isAdmin === true;

    if (!isAdmin) {
      console.warn("❌ Blocked unauthorized pause toggle from", socket.id);
      return;
    }

    setPaused(paused === true);
  });

  socket.on("player-state", (state) => {
    if (!state || typeof state !== "object" || typeof state.src !== "string") {
      return;
    }

    const payload = {
      socketId: socket.id,
      state: {
        type: state.type === "video" ? "video" : "image",
        src: state.src,
        paused: state.paused === true,
        updatedAt: Date.now(),
      },
    };

    playerStates.set(socket.id, payload);
    latestPlayerState = payload;
    io.emit("player-state", payload);
  });

  socket.on("disconnect", () => {
    console.log(`🔴 Client disconnected: ${socket.id}`);
    playerStates.delete(socket.id);
    if (latestPlayerState?.socketId === socket.id) {
      latestPlayerState = [...playerStates.values()].sort((a, b) => b.state.updatedAt - a.state.updatedAt)[0] || null;
    }
    broadcastClientCount();
  });
});

// ----------------------------
// Media watcher + debounced reload
// ----------------------------
let reloadTimer = null;

function triggerReload(reason) {
  if (reloadTimer) clearTimeout(reloadTimer);

  reloadTimer = setTimeout(() => {
    broadcastReloadAndSync(reason);
  }, 700);
}

const watcher = chokidar.watch(MEDIA_DIR, {
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 1000,
  },
  usePolling: CHOKIDAR_USEPOLLING,
  interval: CHOKIDAR_INTERVAL,
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
  .on("error", (err) => {
    console.error("Watcher error:", err);
  });

// ----------------------------
// Start
// ----------------------------
const PORT = Number(process.env.PORT || 3000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Signage server running on port ${PORT}`);
  console.log("Watching media folder:", MEDIA_DIR);
  console.log("Image interval (ms):", settings.imageIntervalMs);
  console.log("Chokidar polling:", CHOKIDAR_USEPOLLING, "interval:", CHOKIDAR_INTERVAL);
  console.log("Admin login:", `http://localhost:${PORT}/admin-login`);
  console.log("htpasswd file:", HTPASSWD_FILE);
});
