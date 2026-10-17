// Deletes the pre-SQLite JSON stores (and the import's backup copies) that still hold SSH credentials in PLAINTEXT.
//
//   node --experimental-strip-types scripts/purge-legacy-json.ts [--dry-run]
//
// Safety checks (all must pass, otherwise nothing is deleted):
//   - praxelops.db exists and meta.json_import_done is set (the import has really happened);
//   - every server in every legacy servers.json (live file and backups) exists in the database, and every
//     credential those files hold is present (as ciphertext) in the matching database column.
// Deletes: <data dir>/{servers,audit,proposals,deployments,diagnostics,known_hosts,operators}.json and every
// <data dir>/backup/json-* directory. --dry-run only lists them. Data dir: PRAXELOPS_DATA_DIR (default ./.peos/data).
// Deletion is an ordinary unlink: it does not securely wipe disk blocks (not possible on journaling/SSD storage).
// Rotate the SSH credentials themselves if the old plaintext files may have been exposed.
//
// NOTE: relative imports with explicit .ts extensions only; plain node cannot resolve "@/" aliases.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILENAME } from "../src/lib/db/database.ts";
import {
  JSON_IMPORT_META_KEY,
  legacyJsonFilesPresent,
  legacyPlaintextServerFiles,
  listLegacyBackupDirs,
} from "../src/lib/db/importJson.ts";
import { getDataDir } from "../src/lib/storage/dataDir.ts";

const CREDENTIAL_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["password", "password"],
  ["privateKey", "private_key"],
  ["passphrase", "passphrase"],
];

function fail(message: string): never {
  process.stderr.write(`Refusing to purge: ${message}\nNothing was deleted.\n`);
  process.exit(1);
}

function readServersJson(file: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    return fail(`${file} cannot be read as JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(parsed)) return fail(`${file} is not a JSON array`);
  const out: Array<Record<string, unknown>> = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || typeof (item as { id?: unknown }).id !== "string") {
      return fail(`${file} contains an entry without a string id`);
    }
    out.push(item as Record<string, unknown>);
  }
  return out;
}

function verifyAgainstDatabase(dataDir: string): void {
  const dbPath = path.join(dataDir, DB_FILENAME);
  if (!fs.existsSync(dbPath)) fail(`no database at ${dbPath}`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (db.prepare("SELECT 1 AS present FROM meta WHERE key = ?").get(JSON_IMPORT_META_KEY) === undefined) {
      fail(`the legacy JSON import has not completed (meta.${JSON_IMPORT_META_KEY} is not set); start the app once first`);
    }
    const select = db.prepare("SELECT password, private_key, passphrase FROM servers WHERE id = ?");
    for (const file of legacyPlaintextServerFiles(dataDir)) {
      for (const server of readServersJson(file)) {
        const id = String(server.id);
        const row = select.get(id);
        if (row === undefined) fail(`server '${id}' from ${file} does not exist in the database`);
        for (const [field, column] of CREDENTIAL_FIELDS) {
          const value = server[field];
          if (typeof value === "string" && value.length > 0 && typeof row[column] !== "string") {
            fail(`server '${id}' has a ${field} in ${file} but the database has none`);
          }
        }
      }
    }
  } finally {
    db.close();
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  if (args.some((a) => a !== "--dry-run")) {
    process.stderr.write("Usage: node --experimental-strip-types scripts/purge-legacy-json.ts [--dry-run]\n");
    process.exit(2);
  }

  const dataDir = getDataDir();
  const files = legacyJsonFilesPresent(dataDir).map((name) => path.join(dataDir, name));
  const backupDirs = listLegacyBackupDirs(dataDir);
  if (files.length === 0 && backupDirs.length === 0) {
    process.stdout.write(`No legacy JSON stores or import backups found in ${dataDir}. Nothing to do.\n`);
    return;
  }

  verifyAgainstDatabase(dataDir);

  const targets = [...files, ...backupDirs];
  process.stdout.write(`${dryRun ? "Would delete" : "Deleting"} (data dir ${dataDir}):\n`);
  for (const target of targets) process.stdout.write(`  ${target}\n`);
  if (dryRun) {
    process.stdout.write("Dry run: nothing was deleted.\n");
    return;
  }

  for (const target of targets) fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  const backupRoot = path.join(dataDir, "backup");
  try {
    if (fs.readdirSync(backupRoot).length === 0) fs.rmdirSync(backupRoot);
  } catch {
    // no backup dir, or not empty: leave it
  }
  process.stdout.write(`Deleted ${targets.length} legacy item(s).\n`);
}

main();
