const crypto = require("node:crypto");

const ARGON2_PARAMETERS = Object.freeze({
  memory: 19 * 1024,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
  saltLength: 16,
});

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

function encodeBase64(buffer) {
  return buffer.toString("base64").replace(/=+$/u, "");
}

function deriveArgon2id(password, salt, parameters) {
  if (typeof crypto.argon2 !== "function") {
    throw new Error("Argon2id requires Node.js 24.7.0 or newer");
  }

  return new Promise((resolve, reject) => {
    crypto.argon2("argon2id", {
      message: Buffer.from(password, "utf8"),
      nonce: salt,
      parallelism: parameters.parallelism,
      tagLength: parameters.tagLength,
      memory: parameters.memory,
      passes: parameters.passes,
    }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(ARGON2_PARAMETERS.saltLength);
  const derivedKey = await deriveArgon2id(password, salt, ARGON2_PARAMETERS);
  const params = `m=${ARGON2_PARAMETERS.memory},t=${ARGON2_PARAMETERS.passes},p=${ARGON2_PARAMETERS.parallelism}`;
  return `$argon2id$v=19$${params}$${encodeBase64(salt)}$${encodeBase64(derivedKey)}`;
}

function parseArgon2idHash(encodedHash) {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u.exec(encodedHash);
  if (!match) return null;

  const memory = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  const salt = Buffer.from(match[4], "base64");
  const expected = Buffer.from(match[5], "base64");

  if (
    !Number.isInteger(memory) || memory < 8192 || memory > 262144 ||
    !Number.isInteger(passes) || passes < 1 || passes > 10 ||
    !Number.isInteger(parallelism) || parallelism < 1 || parallelism > 16 ||
    salt.length < 8 || salt.length > 64 ||
    expected.length < 16 || expected.length > 128
  ) {
    return null;
  }

  return { memory, passes, parallelism, salt, expected };
}

async function verifyPassword(password, encodedHash) {
  if (encodedHash.startsWith("$argon2id$")) {
    const parsed = parseArgon2idHash(encodedHash);
    if (!parsed) return { valid: false, needsRehash: false };

    const actual = await deriveArgon2id(password, parsed.salt, {
      memory: parsed.memory,
      passes: parsed.passes,
      parallelism: parsed.parallelism,
      tagLength: parsed.expected.length,
    });
    const valid = crypto.timingSafeEqual(actual, parsed.expected);
    const needsRehash = valid && (
      parsed.memory !== ARGON2_PARAMETERS.memory ||
      parsed.passes !== ARGON2_PARAMETERS.passes ||
      parsed.parallelism !== ARGON2_PARAMETERS.parallelism ||
      parsed.expected.length !== ARGON2_PARAMETERS.tagLength
    );
    return { valid, needsRehash };
  }

  if (encodedHash.startsWith("$apr1$")) {
    const actual = Buffer.from(apr1(password, encodedHash), "utf8");
    const expected = Buffer.from(encodedHash, "utf8");
    const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    return { valid, needsRehash: valid };
  }

  return { valid: false, needsRehash: false };
}

module.exports = {
  ARGON2_PARAMETERS,
  apr1,
  hashPassword,
  verifyPassword,
};
