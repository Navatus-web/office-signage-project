const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const PORT = 3099;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = "test-password";

let serverProcess;
let tempDir;
let mediaDir;
let settingsFile;
let htpasswdFile;
let adminCookie;
let csrfToken;
let serverOutput = "";

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

function apr1(password, salt = "testsalt") {
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

function writeTestPng(filename) {
  fs.writeFileSync(
    path.join(mediaDir, filename),
    Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
  );
}

function waitForHealth(timeoutMs = 10_000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;

    const onExit = (code, signal) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Test server exited before startup (code=${code}, signal=${signal}):\n${serverOutput}`));
    };

    async function check() {
      try {
        const res = await fetch(`${BASE_URL}/api/health`);
        if (res.ok) {
          settled = true;
          serverProcess?.off("exit", onExit);
          return resolve();
        }
      } catch (err) {
        // Server is still starting.
      }

      if (Date.now() - startedAt > timeoutMs) {
        settled = true;
        serverProcess?.off("exit", onExit);
        reject(new Error(`Timed out waiting for test server:\n${serverOutput}`));
        return;
      }

      setTimeout(check, 150);
    }

    serverProcess?.once("exit", onExit);
    check();
  });
}

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-signage-test-"));
  mediaDir = path.join(tempDir, "media");
  settingsFile = path.join(tempDir, "settings.json");
  htpasswdFile = path.join(tempDir, "admin.htpasswd");

  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    imageIntervalMs: 7000,
    imageDurations: {},
    mediaOrder: [],
  }));
  fs.writeFileSync(htpasswdFile, `admin:${apr1(ADMIN_PASSWORD)}\n`);

  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      SESSION_SECRET: "test-session-secret",
      CHOKIDAR_USEPOLLING: "false",
      MEDIA_DIR: mediaDir,
      SETTINGS_FILE: settingsFile,
      HTPASSWD_FILE: htpasswdFile,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  serverProcess.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  await waitForHealth();
});

test.after(() => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function loginAdmin() {
  if (adminCookie && csrfToken) {
    return { cookie: adminCookie, csrfToken };
  }

  const loginRes = await fetch(`${BASE_URL}/admin-login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ pin: ADMIN_PASSWORD }),
  });

  assert.equal(loginRes.status, 302);

  adminCookie = loginRes.headers.get("set-cookie").split(";")[0];

  const csrfRes = await fetch(`${BASE_URL}/api/csrf-token`, {
    headers: {
      Cookie: adminCookie,
    },
  });

  assert.equal(csrfRes.status, 200);
  csrfToken = (await csrfRes.json()).csrfToken;
  assert.equal(typeof csrfToken, "string");

  return { cookie: adminCookie, csrfToken };
}

async function adminFetch(pathname, options = {}) {
  const auth = await loginAdmin();
  const headers = new Headers(options.headers || {});
  headers.set("Cookie", auth.cookie);

  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-CSRF-Token", auth.csrfToken);
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }

  return fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers,
  });
}

test("health endpoint reports server readiness", async () => {
  const res = await fetch(`${BASE_URL}/api/health`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.playlistVersion, "number");
  assert.equal(body.mediaDir, true);
});

test("playlist remains publicly readable for signage players", async () => {
  const res = await fetch(`${BASE_URL}/api/playlist`);
  assert.equal(res.status, 200);

  const playlist = await res.json();
  assert.equal(Array.isArray(playlist), true);
});

test("admin-only device API rejects anonymous requests", async () => {
  const res = await fetch(`${BASE_URL}/api/devices`);
  assert.equal(res.status, 401);

  const body = await res.json();
  assert.match(body.error, /Admin login required/);
});

test("authenticated admin can list display devices", async () => {
  const res = await adminFetch("/api/devices");
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(Array.isArray(body.devices), true);
});

test("bulk duration updates only valid image files", async () => {
  writeTestPng("screen-a.png");
  fs.writeFileSync(path.join(mediaDir, "notes.txt"), "not playable");

  const res = await adminFetch("/api/media-duration/bulk", {
    method: "POST",
    body: JSON.stringify({
      filenames: ["screen-a.png", "notes.txt", "../settings.json"],
      durationSeconds: 12,
    }),
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).updatedCount, 1);

  const mediaRes = await adminFetch("/api/media");
  const media = await mediaRes.json();
  const image = media.files.find((file) => file.name === "screen-a.png");
  assert.equal(image.durationMs, 12000);
});

test("transition setting is public sync state and can preserve image durations", async () => {
  writeTestPng("fade-check.png");

  const durationRes = await adminFetch("/api/media-duration/bulk", {
    method: "POST",
    body: JSON.stringify({
      filenames: ["fade-check.png"],
      durationSeconds: 9,
    }),
  });

  assert.equal(durationRes.status, 200);

  const settingsRes = await adminFetch("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      imageIntervalMs: 7000,
      transitionMode: "page",
      preserveDurations: true,
    }),
  });

  assert.equal(settingsRes.status, 200);
  const settings = await settingsRes.json();
  assert.equal(settings.transitionMode, "page");
  assert.equal(settings.fadeEnabled, true);

  const syncRes = await fetch(`${BASE_URL}/api/sync`);
  assert.equal(syncRes.status, 200);
  const sync = await syncRes.json();
  assert.equal(sync.transitionMode, "page");
  assert.equal(sync.fadeEnabled, true);

  const mediaRes = await adminFetch("/api/media");
  const media = await mediaRes.json();
  const image = media.files.find((file) => file.name === "fade-check.png");
  assert.equal(image.durationMs, 9000);
});

test("bulk delete ignores path traversal and removes selected media", async () => {
  writeTestPng("screen-delete.png");

  const res = await adminFetch("/api/media/bulk-delete", {
    method: "POST",
    body: JSON.stringify({
      filenames: ["../settings.json", "screen-delete.png"],
    }),
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).deletedCount, 1);
  assert.equal(fs.existsSync(path.join(mediaDir, "screen-delete.png")), false);
  assert.equal(fs.existsSync(settingsFile), true);
});
