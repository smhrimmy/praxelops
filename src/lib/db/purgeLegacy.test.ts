import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb } from "./database";
import { StorageService } from "../storage";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PURGE = path.join(REPO_ROOT, "scripts", "purge-legacy-json.ts");
const WARNED_KEY = Symbol.for("praxelops.legacyPlaintextWarned");

const SERVERS = [
  { id: "srv-1", name: "One", host: "10.0.0.1", port: 22, username: "root", authType: "password", password: "LEGACY-PW-NEEDLE", tags: [], status: "online", osType: "linux", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "srv-2", name: "Two", host: "10.0.0.2", port: 22, username: "root", authType: "privateKey", privateKey: "LEGACY-KEY-NEEDLE", tags: [], status: "online", osType: "linux", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
];

function resetWarned(): void {
  (globalThis as unknown as Record<symbol, unknown>)[WARNED_KEY] = undefined;
}

function withDir<T>(fn: (dir: string) => T): T {
  const previous = process.env.PRAXELOPS_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "praxelops-purge-"));
  process.env.PRAXELOPS_DATA_DIR = dir;
  try {
    return fn(dir);
  } finally {
    closeDb();
    process.env.PRAXELOPS_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function runPurge(dir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", PURGE, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, PRAXELOPS_DATA_DIR: dir },
    encoding: "utf-8",
    windowsHide: true,
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function backupDirs(dir: string): string[] {
  const root = path.join(dir, "backup");
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

afterEach(() => {
  vi.restoreAllMocks();
  resetWarned();
});

describe("legacy plaintext warning", () => {
  it("warns once per process after the import and points at the purge script", () => {
    withDir((dir) => {
      resetWarned();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify(SERVERS));
      getDb();
      const mine = () => warn.mock.calls.filter((c) => String(c[0]).includes("purge-legacy-json"));
      expect(mine()).toHaveLength(1);
      expect(String(mine()[0][0])).not.toMatch(/LEGACY-PW-NEEDLE|LEGACY-KEY-NEEDLE/);
      closeDb();
      getDb(); // second open in the same process: no repeat
      expect(mine()).toHaveLength(1);
    });
  });

  it("stays silent when no plaintext servers.json remains", () => {
    withDir(() => {
      resetWarned();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      getDb();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("purge-legacy-json"))).toHaveLength(0);
    });
  });
});

describe("scripts/purge-legacy-json.ts", { timeout: 90_000 }, () => {
  function importLegacy(dir: string): void {
    fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify(SERVERS));
    fs.writeFileSync(path.join(dir, "audit.json"), JSON.stringify([]));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getDb(); // performs the import (and encrypts the credentials)
    closeDb();
  }

  it("--dry-run lists what it would delete and deletes nothing; the real run deletes it", () => {
    withDir((dir) => {
      importLegacy(dir);
      expect(backupDirs(dir)).toHaveLength(1);

      const dry = runPurge(dir, "--dry-run");
      expect(dry.err).toBe("");
      expect(dry.code).toBe(0);
      expect(dry.out).toContain(path.join(dir, "servers.json"));
      expect(dry.out).toContain(path.join(dir, "audit.json"));
      expect(dry.out).toContain(path.join(dir, "backup", backupDirs(dir)[0]));
      expect(dry.out).toMatch(/Dry run/);
      expect(fs.existsSync(path.join(dir, "servers.json"))).toBe(true);
      expect(backupDirs(dir)).toHaveLength(1);

      const real = runPurge(dir);
      expect(real.err).toBe("");
      expect(real.code).toBe(0);
      expect(fs.existsSync(path.join(dir, "servers.json"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "audit.json"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "backup"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "praxelops.db"))).toBe(true);

      // The database is untouched and the credentials still decrypt.
      const back = StorageService.getServerById("srv-2") as unknown as Record<string, unknown>;
      expect(back.privateKey).toBe("LEGACY-KEY-NEEDLE");

      const again = runPurge(dir);
      expect(again.code).toBe(0);
      expect(again.out).toMatch(/Nothing to do/);
    });
  });

  it("refuses (deleting nothing) when the import marker is not set", () => {
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify(SERVERS));
      // No database yet.
      const noDb = runPurge(dir);
      expect(noDb.code).toBe(1);
      expect(noDb.err).toMatch(/no database/);

      // A database exists but never imported: remove the marker to simulate it.
      importLegacy(dir);
      const raw = getDb();
      raw.prepare("DELETE FROM meta WHERE key = 'json_import_done'").run();
      closeDb();
      const run = runPurge(dir);
      expect(run.code).toBe(1);
      expect(run.err).toMatch(/import has not completed/);
      expect(fs.existsSync(path.join(dir, "servers.json"))).toBe(true);
      expect(backupDirs(dir)).toHaveLength(1);
    });
  });

  it("refuses when a server in servers.json (or a backup copy) is missing from the database", () => {
    withDir((dir) => {
      importLegacy(dir);
      const extra = { ...SERVERS[0], id: "srv-never-imported" };
      fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify([...SERVERS, extra]));
      const run = runPurge(dir);
      expect(run.code).toBe(1);
      expect(run.err).toMatch(/srv-never-imported/);
      expect(fs.existsSync(path.join(dir, "servers.json"))).toBe(true);
      expect(backupDirs(dir)).toHaveLength(1);

      // Same check against a backup copy.
      fs.writeFileSync(path.join(dir, "servers.json"), JSON.stringify(SERVERS));
      const backup = path.join(dir, "backup", backupDirs(dir)[0], "servers.json");
      fs.writeFileSync(backup, JSON.stringify([...SERVERS, extra]));
      const run2 = runPurge(dir);
      expect(run2.code).toBe(1);
      expect(run2.err).toMatch(/srv-never-imported/);
      expect(fs.existsSync(backup)).toBe(true);
    });
  });

  it("refuses when a credential in servers.json has no counterpart in the database", () => {
    withDir((dir) => {
      importLegacy(dir);
      getDb().prepare("UPDATE servers SET private_key = NULL WHERE id = 'srv-2'").run();
      closeDb();
      const run = runPurge(dir);
      expect(run.code).toBe(1);
      expect(run.err).toMatch(/srv-2.*privateKey/);
      expect(fs.existsSync(path.join(dir, "servers.json"))).toBe(true);
    });
  });

  it("rejects unknown arguments", () => {
    withDir((dir) => {
      expect(runPurge(dir, "--nuke").code).toBe(2);
    });
  });
});
