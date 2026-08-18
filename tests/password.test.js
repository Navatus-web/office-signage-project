const assert = require("node:assert/strict");
const test = require("node:test");
const { apr1, hashPassword, verifyPassword } = require("../lib/password");

test("Argon2id passwords verify and reject incorrect credentials", async () => {
  const hash = await hashPassword("a strong test password");
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);

  assert.deepEqual(
    await verifyPassword("a strong test password", hash),
    { valid: true, needsRehash: false }
  );
  assert.deepEqual(
    await verifyPassword("incorrect password", hash),
    { valid: false, needsRehash: false }
  );
});

test("valid APR1 credentials are accepted only as a migration path", async () => {
  const hash = apr1("legacy password", "testsalt");

  assert.deepEqual(
    await verifyPassword("legacy password", hash),
    { valid: true, needsRehash: true }
  );
  assert.deepEqual(
    await verifyPassword("incorrect password", hash),
    { valid: false, needsRehash: false }
  );
});
