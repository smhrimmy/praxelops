import type { DatabaseSync } from "node:sqlite";
// NOTE: node builtins / relative .ts imports and erasable-only syntax (loaded by plain node via create-operator.ts).
import { runRawTransaction } from "./sqliteUtil.ts";
import { encryptPlaintextCredentials } from "../security/vault.ts";

export interface Migration {
  /** Strictly increasing, starting at 1. Never renumber or edit a released migration; append a new one. */
  version: number;
  name: string;
  /** Runs inside the migration transaction (BEGIN IMMEDIATE already held). */
  up: (db: DatabaseSync) => void;
  /**
   * Set when `up` rewrites secret-bearing rows in place. SQLite keeps the replaced bytes in free space, so the
   * database layer then scrubs them (VACUUM + WAL truncate) right after the migration transaction commits.
   */
  scrubAfter?: boolean;
}

/**
 * Schema notes for upcoming milestones:
 *  - servers.password / private_key / passphrase are deliberately separate columns (migration 2 encrypts them in
 *    place as `enc:v1:` envelope-encrypted values; see src/lib/security/vault.ts) without touching the JSON `data` blob.
 *  - audit_events is append-only with a monotonically increasing `seq`; a later migration will
 *    `ALTER TABLE audit_events ADD COLUMN prev_hash TEXT` / `hash TEXT` for the tamper-evident chain.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE servers (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          password TEXT,
          private_key TEXT,
          passphrase TEXT
        );

        CREATE TABLE audit_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          timestamp TEXT NOT NULL,
          actor TEXT NOT NULL,
          event_type TEXT NOT NULL,
          target_server_id TEXT,
          target_server_name TEXT,
          command TEXT,
          status TEXT NOT NULL,
          ip_address TEXT,
          details TEXT
        );
        CREATE INDEX idx_audit_events_timestamp ON audit_events (timestamp);
        CREATE INDEX idx_audit_events_target_server ON audit_events (target_server_id, seq);

        CREATE TABLE proposals (
          id TEXT PRIMARY KEY,
          target_server_id TEXT,
          status TEXT,
          created_at TEXT,
          data TEXT NOT NULL
        );

        CREATE TABLE deployments (
          id TEXT PRIMARY KEY,
          server_id TEXT,
          status TEXT,
          created_at TEXT,
          data TEXT NOT NULL
        );

        CREATE TABLE diagnostics (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL,
          server_id TEXT,
          timestamp TEXT,
          data TEXT NOT NULL
        );

        CREATE TABLE known_hosts (
          host_port TEXT PRIMARY KEY,
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          fingerprint TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_verified_at TEXT NOT NULL
        );

        CREATE TABLE operators (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE tickets (
          id TEXT PRIMARY KEY,
          operator_id TEXT NOT NULL,
          server_id TEXT NOT NULL,
          origin TEXT,
          purpose TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX idx_tickets_expires_at ON tickets (expires_at);

        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: "encrypt_server_credentials",
    scrubAfter: true,
    // Encrypts any plaintext servers.password / private_key / passphrase in place, in the migration transaction.
    // Needs the master secret (PRAXELOPS_SECRET) only if there is at least one plaintext credential to encrypt.
    up: (db) => {
      encryptPlaintextCredentials(db);
    },
  },
  {
    version: 3,
    name: "metrics_samples_and_server_health",
    // Agentless SSH metrics. Both tables reference servers(id) with ON DELETE CASCADE (foreign_keys is ON for every
    // connection), so deleting a server removes its samples and health row.
    up: (db) => {
      db.exec(`
        CREATE TABLE metrics_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id TEXT NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
          collected_at TEXT NOT NULL,
          ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
          reason TEXT,
          data TEXT
        );
        CREATE INDEX idx_metrics_samples_server_time ON metrics_samples (server_id, collected_at);
        CREATE INDEX idx_metrics_samples_collected_at ON metrics_samples (collected_at);

        CREATE TABLE server_health (
          server_id TEXT PRIMARY KEY REFERENCES servers (id) ON DELETE CASCADE,
          last_checked_at TEXT NOT NULL,
          last_ok_at TEXT,
          state TEXT NOT NULL CHECK (state IN ('reachable', 'unreachable', 'auth_failed', 'host_key_mismatch', 'host_key_not_pinned', 'unsupported_os', 'error')),
          reason TEXT
        );
      `);
    },
  },
];

export const LATEST_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

const CREATE_MIGRATIONS_TABLE =
  "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)";

function appliedVersions(db: DatabaseSync): number[] {
  const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
  return rows.map((row) => Number(row.version));
}

function migrationsTableExists(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  return row !== undefined;
}

/** Refuses to run against a database from a newer build (it may contain tables/columns this code would corrupt). */
function assertNotNewer(applied: readonly number[], latest: number): void {
  const max = applied.length > 0 ? applied[applied.length - 1] : 0;
  if (max > latest) {
    throw new Error(
      `Database schema version ${max} is newer than this build supports (${latest}); upgrade PraxelOps`
    );
  }
}

/**
 * Brings the schema up to LATEST_VERSION. Safe to call repeatedly and from several processes at once:
 * the work happens in one BEGIN IMMEDIATE transaction that re-checks the applied versions, so a process that
 * loses the race finds everything already applied and does nothing. Returns the migrations this call applied.
 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): Migration[] {
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);

  // Fast path (read only): already up to date.
  if (migrationsTableExists(db)) {
    const applied = appliedVersions(db);
    assertNotNewer(applied, latest);
    if (applied.length > 0 && applied[applied.length - 1] >= latest) return [];
  }

  return runRawTransaction(db, () => {
    const ran: Migration[] = [];
    db.exec(CREATE_MIGRATIONS_TABLE);
    const applied = appliedVersions(db);
    assertNotNewer(applied, latest);
    const done = new Set(applied);
    const insert = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(migration.version)) continue;
      migration.up(db);
      insert.run(migration.version, new Date().toISOString());
      ran.push(migration);
    }
    return ran;
  });
}
