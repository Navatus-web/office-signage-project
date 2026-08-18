const { hashPassword } = require("../lib/password");

async function main() {
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (password.length < 4 || password.length > 64) {
    throw new Error("ADMIN_PASSWORD must be between 4 and 64 characters");
  }

  process.stdout.write(await hashPassword(password));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
