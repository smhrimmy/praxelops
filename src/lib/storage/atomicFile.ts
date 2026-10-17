import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Crash-safe, multi-process-safe primitives for the JSON stores.
 *
 * NOTE: relative imports / node builtins only, so plain node can load this module.
 *
 * Guarantees:
 *  - atomicWriteFileSync: readers observe either the old or the new file, never a partial one
 *    (write to temp file in the same directory, fsync, rename over the target).
 *  - withFileLockSync: cross-process mutual exclusion for read-modify-write sequences.
 *  - readJsonStrict: never substitutes a default for a corrupt file; it throws instead.
 */

/** Thrown when a store exists but does not contain valid (or valid-shaped) JSON. */
export class StorageCorruptError extends Error {
  readonly filePath: string;

  constructor(filePath: string, detail?: unknown) {
    const reason =
      detail instanceof Error ? detail.message : detail !== undefined ? String(detail) : "invalid contents";
    super(`Storage file is corrupt and was not modified: ${filePath} (${reason})`, {
      cause: detail,
    });
    this.name = "StorageCorruptError";
    this.filePath = filePath;
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Windows reports these transiently when another handle is open on / being replaced under the file. */
const TRANSIENT_FS_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

function isTransientFsError(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && TRANSIENT_FS_CODES.has(code);
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous sleep (works on the main thread and in workers). */
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, Math.max(1, Math.floor(ms)));
}

function jitteredBackoff(attempt: number, minMs: number, maxMs: number): number {
  const base = Math.min(maxMs, minMs + attempt * 3);
  return base / 2 + Math.random() * (base / 2);
}

function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // best effort
  }
}

const RENAME_MAX_ATTEMPTS = 20;

export interface AtomicWriteOptions {
  mode?: number;
}

export function atomicWriteFileSync(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {}
): void {
  const mode = options.mode ?? 0o600;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );

  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (err) {
        if (!isTransientFsError(err) || attempt + 1 >= RENAME_MAX_ATTEMPTS) {
          throw err;
        }
        sleepSync(jitteredBackoff(attempt, 5, 50));
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort
      }
    }
    safeUnlink(tmp);
    throw err;
  }

  if (process.platform !== "win32") {
    // Best-effort durability of the rename itself (directory entry).
    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // not fatal
    }
  }
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

const LOCK_RETRY_CODES: ReadonlySet<string> = new Set(["EEXIST", "EPERM", "EBUSY", "EACCES"]);

function tryBreakStaleLock(lockPath: string, staleMs: number, token: string): void {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) {
      // rename is atomic: at most one contender removes a given stale lock file.
      const graveyard = `${lockPath}.stale.${token.replace(/[^A-Za-z0-9]/g, "_")}`;
      fs.renameSync(lockPath, graveyard);
      safeUnlink(graveyard);
    }
  } catch {
    // lock vanished or is held by someone else; the caller just retries
  }
}

function releaseLock(lockPath: string, token: string): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const owner = fs.readFileSync(lockPath, "utf-8");
      // Do not delete a lock that was stale-broken and re-acquired by someone else.
      if (!owner.startsWith(token)) return;
      fs.unlinkSync(lockPath);
      return;
    } catch (err) {
      if (errorCode(err) === "ENOENT") return;
      if (!isTransientFsError(err)) return;
      sleepSync(jitteredBackoff(attempt, 2, 20));
    }
  }
}

/**
 * Runs fn while holding an exclusive cross-process lock for file
 * (implemented as "<file>.lock", created with O_EXCL). Not re-entrant.
 */
export function withFileLockSync<T>(file: string, fn: () => T, options: FileLockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 10000;
  const lockPath = `${file}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const token = `${process.pid}:${crypto.randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 0; ; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, `${token} ${Date.now()}\n`);
      } catch (writeErr) {
        try {
          fs.closeSync(fd);
        } catch {
          // best effort
        }
        safeUnlink(lockPath);
        throw writeErr;
      }
      fs.closeSync(fd);
      break;
    } catch (err) {
      const code = errorCode(err);
      if (code === undefined || !LOCK_RETRY_CODES.has(code)) {
        throw err;
      }
      tryBreakStaleLock(lockPath, staleMs, token);
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for file lock ${lockPath} (last error: ${code})`
        );
      }
      sleepSync(jitteredBackoff(attempt, 2, 25));
    }
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath, token);
  }
}

const READ_MAX_ATTEMPTS = 20;

function readFileTextRetrying(file: string): string | undefined {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(file, "utf-8");
    } catch (err) {
      if (errorCode(err) === "ENOENT") return undefined;
      if (!isTransientFsError(err) || attempt + 1 >= READ_MAX_ATTEMPTS) throw err;
      sleepSync(jitteredBackoff(attempt, 2, 30));
    }
  }
}

/**
 * Reads and parses a JSON file.
 *  - Missing file  -> undefined.
 *  - Unreadable    -> the underlying fs error (after retrying transient Windows sharing errors).
 *  - Unparseable   -> StorageCorruptError. A default is NEVER substituted: writes are atomic
 *                     renames, so a parse failure means genuine corruption, and callers must fail closed.
 */
export function readJsonStrict<T>(file: string): T | undefined {
  const raw = readFileTextRetrying(file);
  if (raw === undefined) return undefined;
  try {
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(text) as T;
  } catch (err) {
    throw new StorageCorruptError(file, err);
  }
}
