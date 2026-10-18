import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
// NOTE: relative imports WITH .ts extensions and erasable-only TypeScript syntax, so that plain
// `node --experimental-strip-types` (scripts/create-operator.ts, the multi-process test fixtures)
// can load this module and everything it imports.
import { getDataDir } from "../storage/dataDir.ts";
import { runMigrations } from "./migrations.ts";
import { importLegacyJsonIfNeeded, warnLegacyPlaintextOnce } from "./importJson.ts";
import {
  beginImmediate,
  isThenable,
  rollbackQuietly,
  TransactionMisuseError,
  withBusyRetry,
} from "./sqliteUtil.ts";

/**
 * PraxelOps SQLite access (node:sqlite, experimental in Node 24 - it prints an ExperimentalWarning).
 *
 * One synchronous connection per resolved database path per process, shared by every store.
 * Cross-process safety comes from SQLite itself: WAL mode, a busy timeout, and `BEGIN IMMEDIATE`
 * for every write (so a write transaction never has to upgrade a read lock and cannot deadlock).
 */

export const DB_FILENAME = "praxelops.db";
const BUSY_TIMEOUT_MS = 5000;
const OPEN_MAX_ATTEMPTS = 20;

interface DbEntry {
  readonly db: DatabaseSync;
  /** 0 = no open transaction; 1 = inside the outermost BEGIN; >1 = nested SAVEPOINT depth. */
  depth: number;
}

const CACHE_KEY = Symbol.for("praxelops.db.cache");
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: Map<string, DbEntry> };

/** Kept on globalThis so Next dev-mode module reloads do not leak extra connections. */
function cache(): Map<string, DbEntry> {
  const g = globalThis as GlobalWithCache;
  let map = g[CACHE_KEY];
  if (!map) {
    map = new Map<string, DbEntry>();
    g[CACHE_KEY] = map;
  }
  return map;
}

/** Thrown when the database cannot be opened, migrated or populated from legacy JSON. */
export class DatabaseOpenError extends Error {
  readonly dbPath: string;

  constructor(dbPath: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot open PraxelOps database ${dbPath}: ${reason}`, { cause });
    this.name = "DatabaseOpenError";
    this.dbPath = dbPath;
  }
}

export { TransactionMisuseError };

function ensureDataDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Pre-creates the file with 0600 so SQLite (which gives -wal/-shm the main file's mode) never exposes it. */
function ensureDbFile(dbPath: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dbPath, "a", 0o600);
  fs.closeSync(fd);
  fs.chmodSync(dbPath, 0o600);
}

function hasStoredCredentials(db: DatabaseSync): boolean {
  return (
    db
      .prepare("SELECT 1 AS present FROM servers WHERE password IS NOT NULL OR private_key IS NOT NULL OR passphrase IS NOT NULL LIMIT 1")
      .get() !== undefined
  );
}

/**
 * After a migration rewrote credentials in place (plaintext -> ciphertext), the old plaintext bytes are still in the
 * database file's free space and possibly in WAL frames. VACUUM rewrites the file; the TRUNCATE checkpoint then
 * empties the WAL. Best effort: a failure (e.g. another process holding a long read) leaves data intact and warns.
 */
function scrubFreedSpace(db: DatabaseSync): void {
  try {
    withBusyRetry(() => db.exec("VACUUM"), OPEN_MAX_ATTEMPTS);
    withBusyRetry(() => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"), OPEN_MAX_ATTEMPTS);
  } catch (err) {
    console.warn(
      `[PraxelOps] Could not scrub superseded plaintext credential bytes from the database after encrypting them: ${
        err instanceof Error ? err.message : String(err)
      }. Run VACUUM on praxelops.db while the app is stopped.`
    );
  }
}

function openAndInitialize(dbPath: string): DbEntry {
  const dataDir = path.dirname(dbPath);
  ensureDataDir(dataDir);
  ensureDbFile(dbPath);

  const db = new DatabaseSync(dbPath);
  try {
    // busy_timeout first so every later step (including the WAL switch) waits for concurrent openers.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    withBusyRetry(() => db.exec("PRAGMA journal_mode = WAL"), OPEN_MAX_ATTEMPTS);
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA foreign_keys = ON");
    // Zero-fill deleted/replaced content so superseded credential bytes do not linger in free space.
    db.exec("PRAGMA secure_delete = ON");
    const applied = withBusyRetry(() => runMigrations(db), OPEN_MAX_ATTEMPTS);
    if (applied.some((m) => m.scrubAfter === true) && hasStoredCredentials(db)) scrubFreedSpace(db);
    // Imports the legacy JSON stores exactly once (atomically, under BEGIN IMMEDIATE); throws if any is corrupt.
    withBusyRetry(() => importLegacyJsonIfNeeded(db, dataDir), OPEN_MAX_ATTEMPTS);
    warnLegacyPlaintextOnce(db, dataDir);
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore
    }
    throw new DatabaseOpenError(dbPath, err);
  }
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // best effort
    }
  }
  return { db, depth: 0 };
}

function getEntry(): DbEntry {
  const dbPath = path.join(getDataDir(), DB_FILENAME);
  const map = cache();
  let entry = map.get(dbPath);
  if (!entry) {
    entry = openAndInitialize(dbPath);
    map.set(dbPath, entry);
  }
  return entry;
}

/** The shared connection for the current data dir (opened, migrated and legacy-imported on first use). */
export function getDb(): DatabaseSync {
  return getEntry().db;
}

export function getDbPath(): string {
  return path.join(getDataDir(), DB_FILENAME);
}

/** Closes every cached connection. Tests call this before deleting a data dir or switching to a fresh one. */
export function closeDb(): void {
  const map = cache();
  for (const entry of map.values()) {
    try {
      entry.db.close();
    } catch {
      // already closed
    }
  }
  map.clear();
}

const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** Prepared-statement cache (per connection). Never build SQL from user input; pass values as parameters. */
export function prepare(db: DatabaseSync, sql: string): StatementSync {
  let perDb = statementCache.get(db);
  if (!perDb) {
    perDb = new Map<string, StatementSync>();
    statementCache.set(db, perDb);
  }
  let stmt = perDb.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    perDb.set(sql, stmt);
  }
  return stmt;
}

/**
 * Atomic unit of work on the shared connection: `BEGIN IMMEDIATE` (retried on SQLITE_BUSY beyond the
 * busy timeout), COMMIT on success, ROLLBACK if `fn` throws.
 *
 * Re-entrant: a nested call becomes a SAVEPOINT, so an inner failure that the caller catches rolls back
 * only the inner work; one that propagates rolls back everything. `fn` must be synchronous - a returned
 * promise is rejected with TransactionMisuseError (the commit would not wait for it).
 */
export function withTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const entry = getEntry();
  const { db } = entry;

  if (entry.depth === 0) {
    beginImmediate(db);
    entry.depth = 1;
    try {
      const result = fn(db);
      if (isThenable(result)) {
        throw new TransactionMisuseError("withTransaction callbacks must be synchronous");
      }
      db.exec("COMMIT");
      entry.depth = 0;
      return result;
    } catch (err) {
      rollbackQuietly(db, "ROLLBACK");
      entry.depth = 0;
      throw err;
    }
  }

  const parentDepth = entry.depth;
  const name = `praxelops_sp_${parentDepth}`;
  db.exec(`SAVEPOINT ${name}`);
  entry.depth = parentDepth + 1;
  try {
    const result = fn(db);
    if (isThenable(result)) {
      throw new TransactionMisuseError("withTransaction callbacks must be synchronous");
    }
    entry.depth = parentDepth;
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    entry.depth = parentDepth;
    rollbackQuietly(db, `ROLLBACK TO ${name}`);
    rollbackQuietly(db, `RELEASE ${name}`);
    throw err;
  }
}
