import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { AuditEvent } from "@/types/audit";
import type { ServerHost } from "@/types/server";
// NOTE: only `import type` for "@/..." aliases and relative .ts imports for values (loaded by plain node).
import { readJsonStrict, StorageCorruptError } from "../storage/atomicFile.ts";
import { runRawTransaction } from "./sqliteUtil.ts";
import {
  AUDIT_INSERT_SQL,
  auditToParams,
  docString,
  KNOWN_HOST_INSERT_SQL,
  knownHostToParams,
  serverToRow,
  type KnownHostEntry,
} from "./records.ts";

/**
 * One-time import of the pre-SQLite JSON stores (Milestone 7.1).
 *
 * Runs at first open of a data dir whose `meta.json_import_done` is absent and that still contains legacy
 * `*.json` stores. Everything happens inside ONE `BEGIN IMMEDIATE` transaction:
 *   1. re-check the marker (a concurrent process may have finished first -> do nothing),
 *   2. copy every legacy file to `<dataDir>/backup/json-<timestamp>/` BEFORE reading them,
 *   3. parse strictly (a corrupt file throws and aborts the whole import: nothing is written or marked),
 *   4. insert everything with INSERT OR IGNORE (rows already in the database win; the import never overwrites),
 *   5. set `meta.json_import_done`.
 * The original JSON files are left in place but are never read again. The ephemeral legacy `tickets/` dir is ignored.
 */

export const JSON_IMPORT_META_KEY = "json_import_done";

export const LEGACY_JSON_FILES = [
  "servers.json",
  "audit.json",
  "proposals.json",
  "deployments.json",
  "diagnostics.json",
  "known_hosts.json",
  "operators.json",
] as const;

export class LegacyImportError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "LegacyImportError";
  }
}

const IdObject = z.object({ id: z.string().min(1) }).passthrough();
const ObjectArray = z.array(IdObject);

const AuditArray = z.array(
  z
    .object({
      id: z.string().min(1),
      timestamp: z.string(),
      actor: z.string(),
      eventType: z.string().min(1),
      status: z.enum(["success", "failure", "denied"]),
      targetServerId: z.string().optional(),
      targetServerName: z.string().optional(),
      command: z.string().optional(),
      ipAddress: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
);

const KnownHostsRecord = z.record(
  z.string(),
  z.object({
    host: z.string(),
    port: z.number(),
    fingerprint: z.string().min(1),
    firstSeenAt: z.string(),
    lastVerifiedAt: z.string(),
  })
);

const OperatorsArray = z.array(
  z.object({
    id: z.string().min(1),
    username: z.string().min(1),
    passwordHash: z.string().min(1),
    createdAt: z.string().min(1),
  })
);

function importMarkerPresent(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 AS present FROM meta WHERE key = ?").get(JSON_IMPORT_META_KEY) !== undefined;
}

export function legacyJsonFilesPresent(dataDir: string): string[] {
  // The data dir is a runtime location, not a project path: tell Turbopack not to trace it at build time.
  return LEGACY_JSON_FILES.filter((name) =>
    fs.existsSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ dataDir, name))
  );
}

function backupDirName(): string {
  return `json-${new Date().toISOString().replace(/:/g, "-")}`;
}

/** Copies the legacy files into a fresh, uniquely named backup directory and returns its path. */
function backupLegacyFiles(dataDir: string, present: readonly string[]): string {
  const backupRoot = path.join(dataDir, "backup");
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  let dir = path.join(backupRoot, backupDirName());
  for (let n = 1; fs.existsSync(dir); n++) {
    dir = path.join(backupRoot, `${backupDirName()}-${n}`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of present) {
    fs.copyFileSync(path.join(dataDir, name), path.join(dir, name));
  }
  return dir;
}

function readArray<S extends z.ZodTypeAny>(file: string, schema: S): z.infer<S> | undefined {
  const raw = readJsonStrict<unknown>(file);
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new StorageCorruptError(file, parsed.error);
  return parsed.data;
}

function importAll(db: DatabaseSync, dataDir: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const file = (name: string) => path.join(dataDir, name);

  const servers = readArray(file("servers.json"), ObjectArray);
  const audit = readArray(file("audit.json"), AuditArray);
  const proposals = readArray(file("proposals.json"), ObjectArray);
  const deployments = readArray(file("deployments.json"), ObjectArray);
  const diagnostics = readArray(file("diagnostics.json"), ObjectArray);
  const operators = readArray(file("operators.json"), OperatorsArray);
  const knownHostsRaw = readJsonStrict<unknown>(file("known_hosts.json"));
  let knownHosts: Record<string, KnownHostEntry> | undefined;
  if (knownHostsRaw !== undefined) {
    const parsed = KnownHostsRecord.safeParse(knownHostsRaw);
    if (!parsed.success) throw new StorageCorruptError(file("known_hosts.json"), parsed.error);
    for (const [key, entry] of Object.entries(parsed.data)) {
      if (key !== `${entry.host}:${entry.port}`) {
        throw new StorageCorruptError(file("known_hosts.json"), `entry key '${key}' does not match its host and port`);
      }
    }
    knownHosts = parsed.data;
  }

  // Newest-first arrays are inserted oldest-first so that rowid / seq order reproduces the original ordering.
  if (servers) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO servers (id, data, password, private_key, passphrase) VALUES (?, ?, ?, ?, ?)"
    );
    for (const s of servers) {
      const row = serverToRow(s as unknown as ServerHost);
      insert.run(row.id, row.data, row.password, row.privateKey, row.passphrase);
    }
    counts.servers = servers.length;
  }

  if (audit) {
    const insert = db.prepare(`INSERT OR IGNORE ${AUDIT_INSERT_SQL.slice("INSERT ".length)}`);
    for (const event of [...audit].reverse()) {
      insert.run(...auditToParams(event as unknown as AuditEvent));
    }
    counts.audit_events = audit.length;
  }

  if (proposals) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO proposals (id, target_server_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)"
    );
    for (const p of [...proposals].reverse()) {
      insert.run(p.id, docString(p, "targetServerId"), docString(p, "status"), docString(p, "createdAt"), JSON.stringify(p));
    }
    counts.proposals = proposals.length;
  }

  if (deployments) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO deployments (id, server_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)"
    );
    for (const d of [...deployments].reverse()) {
      insert.run(d.id, docString(d, "serverId"), docString(d, "status"), docString(d, "createdAt"), JSON.stringify(d));
    }
    counts.deployments = deployments.length;
  }

  if (diagnostics) {
    const insert = db.prepare("INSERT INTO diagnostics (id, server_id, timestamp, data) VALUES (?, ?, ?, ?)");
    for (const d of [...diagnostics].reverse()) {
      insert.run(d.id, docString(d, "serverId"), docString(d, "timestamp"), JSON.stringify(d));
    }
    counts.diagnostics = diagnostics.length;
  }

  if (knownHosts) {
    const insert = db.prepare(`INSERT OR IGNORE ${KNOWN_HOST_INSERT_SQL.slice("INSERT ".length)}`);
    for (const [key, entry] of Object.entries(knownHosts)) {
      insert.run(...knownHostToParams(key, entry));
    }
    counts.known_hosts = Object.keys(knownHosts).length;
  }

  if (operators) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO operators (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)"
    );
    for (const op of operators) {
      insert.run(op.id, op.username, op.passwordHash, op.createdAt);
    }
    counts.operators = operators.length;
  }

  return counts;
}

/**
 * Imports the legacy JSON stores if that has not been done for this database yet.
 * Throws LegacyImportError (database open fails closed) if any legacy file is unreadable/corrupt; in that case
 * nothing is imported and the marker stays unset, so the operator can fix or move the file and retry.
 */
export function importLegacyJsonIfNeeded(db: DatabaseSync, dataDir: string): void {
  if (importMarkerPresent(db)) return;
  if (legacyJsonFilesPresent(dataDir).length === 0) return;

  try {
    runRawTransaction(db, () => {
      // Re-check under the write lock: a concurrent first-opener may have imported while we waited.
      if (importMarkerPresent(db)) return;

      const present = legacyJsonFilesPresent(dataDir);
      if (present.length === 0) return;

      const backupDir = backupLegacyFiles(dataDir, present);
      const counts = importAll(db, dataDir);
      const summary = JSON.stringify({
        at: new Date().toISOString(),
        backupDir,
        files: present,
        counts,
      });
      db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(JSON_IMPORT_META_KEY, summary);
    });
  } catch (err) {
    if (err instanceof Error && "errcode" in err) throw err; // SQLite errors (e.g. BUSY) keep their identity for retry logic
    throw new LegacyImportError(
      `Legacy JSON import aborted; nothing was imported. Fix or move the offending file in ${dataDir} and restart. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
}
