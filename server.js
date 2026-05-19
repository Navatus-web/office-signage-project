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
};

const SESSION_SECRET = String(process.env.SESSION_SECRET || "change-me-in-prod");
const CHOKIDAR_USEPOLLING = String(process.env.CHOKIDAR_USEPOLLING || "true") === "true";
const CHOKIDAR_INTERVAL = Number(process.env.CHOKIDAR_INTERVAL || 500);
const ADMIN_USER = String(process.env.ADMIN_USER || "admin");

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
  limits: { fileSize: 1024 * 1024 * 500 }, // 500MB max
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
    body{font-family:Arial;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .card{background:#1c1c1c;padding:24px;border-radius:12px;max-width:360px;width:92%}
    h2{margin:0 0 14px 0;font-size:20px}
    input{width:100%;padding:12px 10px;font-size:18px;letter-spacing:8px;text-align:center;border-radius:10px;border:1px solid #333;background:#0f0f0f;color:#fff;box-sizing:border-box}
    button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#2d7dff;color:#fff;font-size:16px;cursor:pointer}
    button:hover{background:#1e5fd1}
    .msg{margin-top:10px;opacity:.9;font-size:13px;min-height:18px}
  </style>
</head>
<body>
  <div class="card">
    <h2>Office Signage Admin</h2>
    <form method="POST" action="/admin-login">
      <input
        name="pin"
        inputmode="numeric"
        pattern="\\d{5,20}"
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

function buildPlaylist() {
  let files = [];

  try {
    files = fs
      .readdirSync(MEDIA_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (err) {
    console.warn("⚠️ Could not read media directory:", err.message);
    return [];
  }

  const interval = Number(settings.imageIntervalMs) || DEFAULT_SETTINGS.imageIntervalMs;

  return files
    .filter((name) => !isJunk(name))
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      return imageExt.has(ext) || videoExt.has(ext);
    })
    .sort(sortVideoFirst)
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
// Sync state
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

function broadcastSync() {
  io.emit("sync", syncState);
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
  saveSettings();

  broadcastReloadAndSync("settings");

  res.json(settings);
});

// ----------------------------
// File Upload API
// ----------------------------
app.post("/api/upload", requireAdmin, upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  console.log(`📁 Uploaded: ${req.file.originalname}`);
  broadcastReloadAndSync("file");

  res.json({
    success: true,
    filename: req.file.originalname,
    size: req.file.size,
  });
});

// ----------------------------
// Socket.IO auth + handlers
// ----------------------------
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.on("connection", (socket) => {
  console.log(`🟢 Client connected: ${socket.id}`);

  // Send current sync state to new clients
  socket.emit("sync", syncState);

  socket.on("reload", () => {
    const isAdmin = socket.request?.session?.isAdmin === true;

    if (!isAdmin) {
      console.warn("❌ Blocked unauthorized reload from", socket.id);
      return;
    }

    broadcastReloadAndSync("manual");
  });

  socket.on("disconnect", () => {
    console.log(`🔴 Client disconnected: ${socket.id}`);
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
