import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  closeDb,
  DatabaseOpenError,
  getDb,
  getDbPath,
  prepare,
  TransactionMisuseError,
  withTransaction,
} from "./database";
import { LATEST_VERSION, MIGRATIONS, runMigrations, type Migration } from "./migrations";
import { isSqliteBusy } from "./sqliteUtil";

const EXPECTED_TABLES = [
  "audit_events",
  "deployments",
  "diagnostics",
  "known_hosts",
  "meta",
  "metrics_samples",
  "operators",
  "proposals",
  "schema_migrations",
  "server_health",
  "servers",
  "tickets",
];

/** Runs `fn` against a fresh, empty data dir, restoring the previous one afterwards. */
function withFreshDataDir<T>(fn: (dir: string) => T): T {
  const previous = process.env.PRAXELOPS_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "praxelops-db-"));
  process.env.PRAXELOPS_DATA_DIR = dir;
  try {
    return fn(dir);
  } finally {
    closeDb();
    process.env.PRAXELOPS_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => String(r.name));
}

describe("getDb / schema", () => {
  it("creates the database file, applies migration 1 and records it", () => {
    withFreshDataDir((dir) => {
      const db = getDb();
      expect(getDbPath()).toBe(path.join(dir, "praxelops.db"));
      expect(fs.existsSync(getDbPath())).toBe(true);
      expect(tableNames(db)).toEqual(EXPECTED_TABLES);

      const applied = db.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all();
      expect(applied.map((r) => Number(r.version))).toEqual(MIGRATIONS.map((m) => m.version));
      expect(Number(applied[0].version)).toBe(1);
      expect(new Date(String(applied[0].applied_at)).toISOString()).toBe(applied[0].applied_at);

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .all()
        .map((r) => String(r.name));
      expect(indexes).toEqual(expect.arrayContaining(["idx_audit_events_timestamp", "idx_tickets_expires_at"]));
    });
  });

  it("caches one connection per resolved path and switches when the data dir changes", () => {
    withFreshDataDir(() => {
      const a = getDb();
      expect(getDb()).toBe(a);
      withFreshDataDir((otherDir) => {
        const b = getDb();
        expect(b).not.toBe(a);
        expect(getDbPath()).toBe(path.join(otherDir, "praxelops.db"));
      });
    });
  });

  it("is idempotent across re-opens: data survives and migrations are not re-applied", () => {
    withFreshDataDir(() => {
      getDb().prepare("INSERT INTO meta (key, value) VALUES ('k', 'v')").run();
      const appliedAt = getDb().prepare("SELECT applied_at FROM schema_migrations WHERE version = 1").get()?.applied_at;

      closeDb();
      const db = getDb();
      expect(db.prepare("SELECT value FROM meta WHERE key = 'k'").get()?.value).toBe("v");
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n).toBe(MIGRATIONS.length);
      expect(db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 1").get()?.applied_at).toBe(appliedAt);

      // Direct re-run is a no-op too.
      runMigrations(db);
      runMigrations(db);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n).toBe(MIGRATIONS.length);
    });
  });

  it("applies only the missing migrations, in order, in one transaction (a failing one rolls everything back)", () => {
    const db = new DatabaseSync(":memory:");
    try {
      runMigrations(db);
      const v2: Migration = {
        version: LATEST_VERSION + 1,
        name: "add_widgets",
        up: (d) => d.exec("CREATE TABLE widgets (id TEXT PRIMARY KEY)"),
      };
      const v3Bad: Migration = {
        version: LATEST_VERSION + 2,
        name: "explodes",
        up: (d) => {
          d.exec("CREATE TABLE gadgets (id TEXT PRIMARY KEY)");
          throw new Error("boom");
        },
      };
      expect(() => runMigrations(db, [...MIGRATIONS, v2, v3Bad])).toThrow(/boom/);
      // v2 shared the failed transaction, so it was rolled back as well.
      expect(tableNames(db)).not.toContain("widgets");
      expect(tableNames(db)).not.toContain("gadgets");
      expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v).toBe(LATEST_VERSION);

      runMigrations(db, [...MIGRATIONS, v2]);
      runMigrations(db, [...MIGRATIONS, v2]);
      expect(tableNames(db)).toContain("widgets");
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(v2.version)?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("refuses to run against a database created by a newer build", () => {
    const db = new DatabaseSync(":memory:");
    try {
      runMigrations(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        LATEST_VERSION + 50,
        new Date().toISOString()
      );
      expect(() => runMigrations(db)).toThrow(/newer than this build/);
    } finally {
      db.close();
    }
  });

  it("fails with DatabaseOpenError (and caches nothing) when the file is not a database", () => {
    withFreshDataDir((dir) => {
      fs.writeFileSync(path.join(dir, "praxelops.db"), "this is definitely not an sqlite database file ".repeat(20));
      expect(() => getDb()).toThrow(DatabaseOpenError);
      expect(() => getDb()).toThrow(DatabaseOpenError); // not cached as half-open
    });
  });

  it("creates missing data dirs and uses private permissions on POSIX", () => {
    withFreshDataDir((dir) => {
      const nested = path.join(dir, "a", "b");
      process.env.PRAXELOPS_DATA_DIR = nested;
      getDb();
      expect(fs.existsSync(path.join(nested, "praxelops.db"))).toBe(true);
      if (process.platform !== "win32") {
        expect(fs.statSync(nested).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.join(nested, "praxelops.db")).mode & 0o777).toBe(0o600);
      }
      closeDb();
      process.env.PRAXELOPS_DATA_DIR = dir;
    });
  });
});

describe("withTransaction", () => {
  beforeAll(() => {
    getDb().exec("CREATE TABLE IF NOT EXISTS tx_probe (id INTEGER PRIMARY KEY, label TEXT)");
  });

  afterAll(() => {
    getDb().exec("DROP TABLE IF EXISTS tx_probe");
  });

  const labels = (): string[] =>
    prepare(getDb(), "SELECT label FROM tx_probe ORDER BY id").all().map((r) => String(r.label));
  const insert = (label: string) => prepare(getDb(), "INSERT INTO tx_probe (label) VALUES (?)").run(label);
  const reset = () => getDb().exec("DELETE FROM tx_probe");

  it("commits on success and returns the callback's value", () => {
    reset();
    const out = withTransaction(() => {
      insert("a");
      insert("b");
      return 42;
    });
    expect(out).toBe(42);
    expect(labels()).toEqual(["a", "b"]);
    expect(getDb().isTransaction).toBe(false);
  });

  it("rolls everything back and rethrows when the callback throws", () => {
    reset();
    expect(() =>
      withTransaction(() => {
        insert("lost-1");
        insert("lost-2");
        throw new Error("kaboom");
      })
    ).toThrow("kaboom");
    expect(labels()).toEqual([]);
    expect(getDb().isTransaction).toBe(false);
    // The connection is healthy afterwards.
    withTransaction(() => insert("after"));
    expect(labels()).toEqual(["after"]);
  });

  it("supports nesting via savepoints: a caught inner failure only undoes the inner work", () => {
    reset();
    withTransaction(() => {
      insert("outer-1");
      try {
        withTransaction(() => {
          insert("inner-lost");
          throw new Error("inner failed");
        });
      } catch (err) {
        expect((err as Error).message).toBe("inner failed");
      }
      withTransaction(() => insert("inner-kept"));
      insert("outer-2");
    });
    expect(labels()).toEqual(["outer-1", "inner-kept", "outer-2"]);
    expect(getDb().isTransaction).toBe(false);
  });

  it("an inner failure that propagates rolls back the whole outer transaction", () => {
    reset();
    expect(() =>
      withTransaction(() => {
        insert("outer");
        withTransaction(() => {
          insert("inner");
          throw new Error("propagates");
        });
      })
    ).toThrow("propagates");
    expect(labels()).toEqual([]);
    expect(getDb().isTransaction).toBe(false);
    withTransaction(() => insert("ok")); // depth bookkeeping was reset
    expect(labels()).toEqual(["ok"]);
  });

  it("supports deeper nesting and a failing outer after a successful inner", () => {
    reset();
    expect(() =>
      withTransaction(() => {
        withTransaction(() => {
          insert("lvl2");
          withTransaction(() => insert("lvl3"));
        });
        throw new Error("outer fails late");
      })
    ).toThrow("outer fails late");
    expect(labels()).toEqual([]);
  });

  it("rejects asynchronous callbacks (the commit would not wait) and rolls back", () => {
    reset();
    expect(() =>
      withTransaction(() => {
        insert("async-lost");
        return Promise.resolve(1);
      })
    ).toThrow(TransactionMisuseError);
    expect(labels()).toEqual([]);
    expect(getDb().isTransaction).toBe(false);
  });
});

describe("busy handling", () => {
  it("isSqliteBusy recognises a real SQLITE_BUSY from a competing writer", () => {
    withFreshDataDir(() => {
      const holder = getDb();
      const contender = new DatabaseSync(getDbPath());
      try {
        contender.exec("PRAGMA busy_timeout = 0");
        holder.exec("BEGIN IMMEDIATE");
        let caught: unknown;
        try {
          contender.exec("BEGIN IMMEDIATE");
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        expect(isSqliteBusy(caught)).toBe(true);
        expect(isSqliteBusy(new Error("something else"))).toBe(false);
        holder.exec("ROLLBACK");
      } finally {
        contender.close();
      }
    });
  });
});
