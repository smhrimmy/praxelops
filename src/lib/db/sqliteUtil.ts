import type { DatabaseSync } from "node:sqlite";
// NOTE: node builtins only and erasable-only TypeScript syntax, so plain `node --experimental-strip-types`
// can load this module (it is on the import path of scripts/create-operator.ts).

/** Extra BEGIN attempts after SQLite's own busy timeout has already waited. */
export const BEGIN_EXTRA_ATTEMPTS = 4;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Synchronous sleep (works on the main thread and in workers). */
export function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, Math.max(1, Math.floor(ms)));
}

/** True for SQLITE_BUSY / SQLITE_LOCKED (including extended result codes). */
export function isSqliteBusy(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const errcode = (err as { errcode?: unknown }).errcode;
  if (typeof errcode === "number") {
    const primary = errcode & 0xff;
    return primary === 5 || primary === 6;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /database (table )?is locked|SQLITE_BUSY/i.test(message);
}

export function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Runs `fn`, retrying while SQLite reports BUSY (SQLite's own busy timeout has already waited on each attempt). */
export function withBusyRetry<T>(fn: () => T, attempts: number = BEGIN_EXTRA_ATTEMPTS + 1): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusy(err) || attempt >= attempts) throw err;
      sleepSync(10 + Math.random() * 40 * attempt);
    }
  }
}

/** Thrown when a transaction callback returns a promise (the commit would not wait for it). */
export class TransactionMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionMisuseError";
  }
}

export function beginImmediate(db: DatabaseSync): void {
  withBusyRetry(() => db.exec("BEGIN IMMEDIATE"));
}

export function rollbackQuietly(db: DatabaseSync, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // The transaction may already have been rolled back by SQLite itself.
  }
}

/** Non-re-entrant BEGIN IMMEDIATE ... COMMIT/ROLLBACK on a raw connection (used by migrations and the legacy import). */
export function runRawTransaction<T>(db: DatabaseSync, fn: () => T): T {
  beginImmediate(db);
  try {
    const result = fn();
    if (isThenable(result)) {
      throw new TransactionMisuseError("Transaction callbacks must be synchronous");
    }
    db.exec("COMMIT");
    return result;
  } catch (err) {
    rollbackQuietly(db, "ROLLBACK");
    throw err;
  }
}
