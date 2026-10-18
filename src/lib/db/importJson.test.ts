import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeDb, DatabaseOpenError, getDb } from "./database";
import { JSON_IMPORT_META_KEY, LEGACY_JSON_FILES } from "./importJson";
import type { ServerHost } from "@/types/server";
import { StorageService } from "../storage";
import { KnownHostsService } from "../ssh/knownHosts";
import { findOperatorByUsername, listOperators } from "../security/operators";

function withFreshDataDir<T>(fn: (dir: string) => T): T {
  const previous = process.env.PRAXELOPS_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "praxelops-import-"));
  process.env.PRAXELOPS_DATA_DIR = dir;
  try {
    return fn(dir);
  } finally {
    closeDb();
    process.env.PRAXELOPS_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const FP = "SHA256:legacyFingerprint";

const SERVERS = [
  {
    id: "srv-legacy-1",
    name: "Legacy One",
    host: "10.0.0.1",
    port: 22,
    username: "root",
    authType: "password",
    password: "legacy-secret-pw",
    tags: ["a"],
    status: "online",
    osType: "linux",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "srv-legacy-2",
    name: "Legacy Two",
    host: "10.0.0.2",
    port: 2222,
    username: "ubuntu",
    authType: "privateKey",
    privateKey: "LEGACY-PRIVATE-KEY",
    passphrase: "legacy-passphrase",
    tags: [],
    status: "offline",
    osType: "linux",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

// Legacy audit.json was newest-first.
const AUDIT = [
  {
    id: "audit-3",
    timestamp: "2026-01-03T00:00:00.000Z",
    actor: "alice",
    eventType: "server_deleted",
    targetServerId: "srv-legacy-1",
    status: "success",
  },
  {
    id: "audit-2",
    timestamp: "2026-01-02T00:00:00.000Z",
    actor: "system",
    eventType: "security_alert",
    targetServerId: "10.0.0.1:22",
    status: "success",
    details: { alertType: "tofu_host_key_enrolled", fingerprint: FP },
    ipAddress: "10.9.9.9",
  },
  {
    id: "audit-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    actor: "alice",
    eventType: "server_created",
    targetServerId: "srv-legacy-1",
    targetServerName: "Legacy One",
    command: "echo hi",
    status: "success",
  },
];

const KNOWN_HOSTS = {
  "10.0.0.1:22": {
    host: "10.0.0.1",
    port: 22,
    fingerprint: FP,
    firstSeenAt: "2026-01-02T00:00:00.000Z",
    lastVerifiedAt: "2026-01-02T00:00:00.000Z",
  },
};

const OPERATORS = [
  { id: "op_legacy01", username: "legacy-alice", passwordHash: "scrypt$32768$8$1$c2FsdA==$aGFzaA==", createdAt: "2026-01-01T00:00:00.000Z" },
];

const PROPOSALS = [
  { id: "prop-2", targetServerId: "srv-legacy-1", status: "approved", createdAt: "2026-01-02T00:00:00.000Z", title: "second" },
  { id: "prop-1", targetServerId: "srv-legacy-1", status: "pending_approval", createdAt: "2026-01-01T00:00:00.000Z", title: "first" },
];

const DEPLOYMENTS = [
  { id: "dep-2", serverId: "srv-legacy-1", status: "healthy", createdAt: "2026-01-02T00:00:00.000Z", name: "d2", steps: [] },
  { id: "dep-1", serverId: "srv-legacy-1", status: "failed", createdAt: "2026-01-01T00:00:00.000Z", name: "d1", steps: [] },
];

const DIAGNOSTICS = [
  { id: "diag-2", serverId: "srv-legacy-1", timestamp: "2026-01-02T00:00:00.000Z", summary: "two" },
  { id: "diag-1", serverId: "srv-legacy-1", timestamp: "2026-01-01T00:00:00.000Z", summary: "one" },
];

function writeLegacy(dir: string, overrides: Record<string, string> = {}): void {
  const files: Record<string, string> = {
    "servers.json": JSON.stringify(SERVERS, null, 2),
    "audit.json": JSON.stringify(AUDIT, null, 2),
    "known_hosts.json": JSON.stringify(KNOWN_HOSTS, null, 2),
    "operators.json": JSON.stringify(OPERATORS, null, 2),
    "proposals.json": JSON.stringify(PROPOSALS, null, 2),
    "deployments.json": JSON.stringify(DEPLOYMENTS, null, 2),
    "diagnostics.json": JSON.stringify(DIAGNOSTICS, null, 2),
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf-8");
  }
}

function backupDirs(dir: string): string[] {
  const root = path.join(dir, "backup");
  return fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
}

/** Counts rows through a separate connection, so it works even when getDb() refuses to open. */
function countRows(dir: string, table: string): number {
  const db = new DatabaseSync(path.join(dir, "praxelops.db"));
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
  } finally {
    db.close();
  }
}

function metaValue(dir: string, key: string): string | undefined {
  const db = new DatabaseSync(path.join(dir, "praxelops.db"));
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row === undefined ? undefined : String(row.value);
  } finally {
    db.close();
  }
}

describe("legacy JSON import", () => {
  it("imports servers, audit, known_hosts, operators, proposals and deployments (and diagnostics)", () => {
    withFreshDataDir((dir) => {
      writeLegacy(dir);

      const servers = StorageService.getServers();
      expect(servers.map((s) => s.id)).toEqual(["srv-legacy-1", "srv-legacy-2"]);
      const one = servers[0] as unknown as Record<string, unknown>;
      expect(one.password).toBe("legacy-secret-pw");
      expect(one.name).toBe("Legacy One");
      const two = servers[1] as unknown as Record<string, unknown>;
      expect(two.privateKey).toBe("LEGACY-PRIVATE-KEY");
      expect(two.passphrase).toBe("legacy-passphrase");
      // Secrets live in their own columns, not in the JSON blob.
      const raw = getDb().prepare("SELECT data, password, private_key, passphrase FROM servers WHERE id = ?").get("srv-legacy-2");
      expect(String(raw?.data)).not.toContain("LEGACY-PRIVATE-KEY");
      expect(String(raw?.private_key)).toMatch(/^enc:v1:/); // encrypted on the way in, never stored as plaintext

      // Same newest-first order as the legacy file, and seq increases with age.
      const audit = StorageService.getAuditEvents();
      expect(audit.map((e) => e.id)).toEqual(["audit-3", "audit-2", "audit-1"]);
      expect(audit[1]).toEqual(AUDIT[1]);
      expect(audit[2]).toEqual(AUDIT[2]);
      const seqs = getDb().prepare("SELECT id FROM audit_events ORDER BY seq").all().map((r) => String(r.id));
      expect(seqs).toEqual(["audit-1", "audit-2", "audit-3"]);

      expect(KnownHostsService.getKnownHosts()).toEqual(KNOWN_HOSTS);
      const op = findOperatorByUsername("legacy-alice");
      expect(op?.id).toBe("op_legacy01");
      expect(op?.passwordHash).toBe(OPERATORS[0].passwordHash);
      expect(listOperators().map((o) => o.username)).toEqual(["legacy-alice"]);

      expect(StorageService.getProposals().map((p) => p.id)).toEqual(["prop-2", "prop-1"]);
      expect(StorageService.getProposalById("prop-1")?.status).toBe("pending_approval");
      expect(StorageService.getDeployments().map((d) => d.id)).toEqual(["dep-2", "dep-1"]);
      expect(StorageService.getDiagnostics().map((d) => d.id)).toEqual(["diag-2", "diag-1"]);

      expect(getDb().prepare("SELECT value FROM meta WHERE key = ?").get(JSON_IMPORT_META_KEY)).toBeDefined();
    });
  });

  it("keeps imported pins authoritative: a matching key verifies, a different key is a mismatch", () => {
    withFreshDataDir((dir) => {
      writeLegacy(dir);
      // Fingerprint of key bytes "x" does not equal FP, so this must be reported as a mismatch against the imported pin.
      const res = KnownHostsService.verifyHostKey("10.0.0.1", 22, Buffer.from("x"));
      expect(res.verified).toBe(false);
      expect(res.isNew).toBe(false);
      expect(res.error).toContain(FP);
    });
  });

  it("copies the legacy files to backup/json-<timestamp>/ before importing and leaves the originals", () => {
    withFreshDataDir((dir) => {
      writeLegacy(dir);
      const originals = new Map(LEGACY_JSON_FILES.map((name) => [name, fs.readFileSync(path.join(dir, name))]));

      getDb();

      const dirs = backupDirs(dir);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toMatch(/^json-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
      expect(dirs[0]).not.toContain(":");
      for (const [name, bytes] of originals) {
        expect(fs.readFileSync(path.join(dir, "backup", dirs[0], name)).equals(bytes), name).toBe(true);
        // Originals are left in place, untouched.
        expect(fs.readFileSync(path.join(dir, name)).equals(bytes), `original ${name}`).toBe(true);
      }
      // The marker records where the backup went.
      const summary = JSON.parse(metaValue(dir, JSON_IMPORT_META_KEY) ?? "{}") as { backupDir?: string };
      expect(summary.backupDir).toBe(path.join(dir, "backup", dirs[0]));
    });
  });

  it("does not re-import on a later open, and the unused JSON files no longer influence anything", () => {
    withFreshDataDir((dir) => {
      writeLegacy(dir);
      StorageService.getServers();
      StorageService.deleteServer("srv-legacy-1");
      StorageService.saveServer({ ...SERVERS[1], name: "Edited in SQLite" } as unknown as ServerHost);
      closeDb();

      // Legacy files change after the import; they must be ignored.
      writeLegacy(dir, { "servers.json": JSON.stringify([{ ...SERVERS[0], id: "srv-resurrected" }]) });

      const servers = StorageService.getServers();
      expect(servers.map((s) => s.id)).toEqual(["srv-legacy-2"]);
      expect(servers[0].name).toBe("Edited in SQLite");
      expect(countRows(dir, "audit_events")).toBe(AUDIT.length);
      expect(backupDirs(dir)).toHaveLength(1);
    });
  });

  it("ignores the ephemeral legacy tickets directory", () => {
    withFreshDataDir((dir) => {
      fs.mkdirSync(path.join(dir, "tickets"));
      fs.writeFileSync(
        path.join(dir, "tickets", "tkt_old.json"),
        JSON.stringify({ ticket: "tkt_old", operatorId: "o", serverId: "s", expiresAt: Date.now() + 60000, createdAt: Date.now() })
      );
      writeLegacy(dir);
      getDb();
      expect(countRows(dir, "tickets")).toBe(0);
      expect(backupDirs(dir)).toHaveLength(1);
      expect(fs.readdirSync(path.join(dir, "backup", backupDirs(dir)[0]))).not.toContain("tickets");
    });
  });

  it("does nothing (no marker, no backup) when there are no legacy files", () => {
    withFreshDataDir((dir) => {
      getDb();
      expect(backupDirs(dir)).toEqual([]);
      expect(metaValue(dir, JSON_IMPORT_META_KEY)).toBeUndefined();
    });
  });

  it("imports only the legacy files that exist", () => {
    withFreshDataDir((dir) => {
      fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify(SERVERS));
      expect(StorageService.getServers()).toHaveLength(2);
      expect(StorageService.getAuditEvents()).toEqual([]);
      expect(fs.readdirSync(path.join(dir, "backup", backupDirs(dir)[0]))).toEqual(["servers.json"]);
    });
  });

  describe("fails closed", () => {
    it("a corrupt legacy file aborts the open: nothing is imported and the marker stays unset", () => {
      withFreshDataDir((dir) => {
        // servers.json is fine; audit.json is truncated JSON. Nothing at all may be imported.
        writeLegacy(dir, { "audit.json": '[{"id": "audit-1", "act' });

        expect(() => getDb()).toThrow(DatabaseOpenError);
        expect(() => getDb()).toThrow(/corrupt/i);

        for (const table of ["servers", "audit_events", "known_hosts", "operators", "proposals", "deployments", "diagnostics"]) {
          expect(countRows(dir, table), table).toBe(0);
        }
        expect(metaValue(dir, JSON_IMPORT_META_KEY)).toBeUndefined();
        // The offending file is left exactly as found.
        expect(fs.readFileSync(path.join(dir, "audit.json"), "utf-8")).toBe('[{"id": "audit-1", "act');
        // Higher-level API surfaces the failure too instead of returning empty data.
        expect(() => StorageService.getServers()).toThrow(DatabaseOpenError);
      });
    });

    it("a wrong-shaped legacy known_hosts file aborts the open", () => {
      withFreshDataDir((dir) => {
        writeLegacy(dir, { "known_hosts.json": "[]" });
        expect(() => getDb()).toThrow(DatabaseOpenError);
        writeLegacy(dir, { "known_hosts.json": '{"h:22": {"fingerprint": 5}}' });
        expect(() => getDb()).toThrow(DatabaseOpenError);
        writeLegacy(dir, {
          "known_hosts.json": JSON.stringify({
            "wrong:22": { host: "other", port: 22, fingerprint: FP, firstSeenAt: "a", lastVerifiedAt: "b" },
          }),
        });
        expect(() => getDb()).toThrow(DatabaseOpenError);
        expect(countRows(dir, "known_hosts")).toBe(0);
        expect(metaValue(dir, JSON_IMPORT_META_KEY)).toBeUndefined();
      });
    });

    it("can be retried after the corrupt file is fixed", () => {
      withFreshDataDir((dir) => {
        writeLegacy(dir, { "servers.json": "{oops" });
        expect(() => getDb()).toThrow(DatabaseOpenError);

        writeLegacy(dir); // operator repaired the file
        expect(StorageService.getServers().map((s) => s.id)).toEqual(["srv-legacy-1", "srv-legacy-2"]);
        expect(metaValue(dir, JSON_IMPORT_META_KEY)).toBeDefined();
        expect(countRows(dir, "audit_events")).toBe(AUDIT.length);
      });
    });
  });
});
