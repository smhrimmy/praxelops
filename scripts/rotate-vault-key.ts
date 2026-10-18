// Rotates the master secret that protects the credential vault (Milestone 7.2).
//
//   PRAXELOPS_SECRET_OLD=<current secret> PRAXELOPS_SECRET_NEW=<new secret> \
//     node --experimental-strip-types scripts/rotate-vault-key.ts
//
// What it does: unlocks the vault with the OLD secret, verifies that EVERY stored credential decrypts, then re-wraps
// the data-encryption key under a key derived from the NEW secret, all in one transaction. The credentials
// themselves are not re-encrypted. A wrong OLD secret (or any undecryptable credential) aborts with nothing changed.
//
// After it succeeds, restart the web app and the terminal gateway with PRAXELOPS_SECRET set to the NEW secret.
// Note that PRAXELOPS_SECRET also keys session cookies and AI approval signatures, so changing it signs operators out.
// Data dir: PRAXELOPS_DATA_DIR (default ./.peos/data). Running processes keep working until they restart (they hold
// the unwrapped key in memory) but must then be started with the new secret.
//
// NOTE: relative imports with explicit .ts extensions only; plain node cannot resolve "@/" aliases.
import fs from "node:fs";
import { closeDb, getDb, getDbPath } from "../src/lib/db/database.ts";
import { rotateVaultKey, VaultError } from "../src/lib/security/vault.ts";

const MIN_SECRET_LENGTH = 32; // same floor as getMasterSecret()

function readSecret(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be set to a secret of at least ${MIN_SECRET_LENGTH} characters`);
  }
  return value;
}

function main(): void {
  const oldSecret = readSecret("PRAXELOPS_SECRET_OLD");
  const newSecret = readSecret("PRAXELOPS_SECRET_NEW");
  if (oldSecret === newSecret) throw new Error("PRAXELOPS_SECRET_OLD and PRAXELOPS_SECRET_NEW are identical");

  // Any pending schema migration that has to encrypt legacy plaintext credentials must use the OLD secret.
  process.env.PRAXELOPS_SECRET = oldSecret;
  if (!fs.existsSync(getDbPath())) throw new Error(`No database at ${getDbPath()}; nothing to rotate`);

  try {
    const result = rotateVaultKey(getDb(), oldSecret, newSecret);
    if (!result.rotated) {
      process.stdout.write(
        `No credential vault in ${getDbPath()} (no credentials have been stored yet); nothing to rotate. ` +
          `Use the new secret as PRAXELOPS_SECRET from now on.\n`
      );
    } else {
      process.stdout.write(
        `Rotated the vault key in ${getDbPath()}: verified ${result.credentialsVerified} credential(s) with the old secret and ` +
          `re-wrapped the data key under the new secret. Restart the web app and terminal gateway with ` +
          `PRAXELOPS_SECRET set to the new secret.\n`
      );
    }
  } finally {
    closeDb();
  }
}

try {
  main();
} catch (err: unknown) {
  const detail =
    err instanceof VaultError ? `${err.message}. Nothing was changed.` : err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${detail}\n`);
  process.exit(1);
}
