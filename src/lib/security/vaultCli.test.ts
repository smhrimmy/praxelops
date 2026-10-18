import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb } from "../db/database";
import { StorageService } from "../storage";
import { VaultError } from "./vault";
import type { ServerHost } from "@/types/server";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const ROTATE = path.join(REPO_ROOT, "scripts", "rotate-vault-key.ts");
const secret = () => crypto.randomBytes(32).toString("hex");

function server(id: string, extra: Record<string, unknown>): ServerHost {
  return {
    id,
    name: id,
    host: "10.0.0.1",
    port: 22,
    username: "u",
    authType: "password",
    tags: [],
    status: "offline",
    osType: "linux",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  } as ServerHost;
}

function runRotate(dataDir: string, oldSecret: string | undefined, newSecret: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env, PRAXELOPS_DATA_DIR: dataDir };
  delete env.PRAXELOPS_SECRET_OLD;
  delete env.PRAXELOPS_SECRET_NEW;
  if (oldSecret !== undefined) env.PRAXELOPS_SECRET_OLD = oldSecret;
  if (newSecret !== undefined) env.PRAXELOPS_SECRET_NEW = newSecret;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", ROTATE], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf-8",
    windowsHide: true,
    timeout: 60_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function withDir<T>(fn: (dir: string) => T): T {
  const previousDir = process.env.PRAXELOPS_DATA_DIR;
  const previousSecret = process.env.PRAXELOPS_SECRET;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "praxelops-rot-"));
  process.env.PRAXELOPS_DATA_DIR = dir;
  try {
    return fn(dir);
  } finally {
    closeDb();
    process.env.PRAXELOPS_DATA_DIR = previousDir;
    process.env.PRAXELOPS_SECRET = previousSecret;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function readPassword(id: string): unknown {
  closeDb(); // fresh connection => fresh key cache => the current PRAXELOPS_SECRET is really exercised
  return (StorageService.getServerById(id) as unknown as Record<string, unknown>).password;
}

describe("scripts/rotate-vault-key.ts", { timeout: 90_000 }, () => {
  it("re-wraps the key: old secret works before, new secret works after, old no longer works", () => {
    withDir((dir) => {
      const oldSecret = secret();
      const newSecret = secret();
      process.env.PRAXELOPS_SECRET = oldSecret;
      StorageService.saveServer(server("srv-1", { password: "pw-one", privateKey: "key-one" }));
      expect(readPassword("srv-1")).toBe("pw-one");
      closeDb();

      const run = runRotate(dir, oldSecret, newSecret);
      expect(run.err).toBe("");
      expect(run.code).toBe(0);
      expect(run.out).toMatch(/verified 2 credential\(s\)/);
      expect(run.out + run.err).not.toContain(oldSecret);
      expect(run.out + run.err).not.toContain(newSecret);

      process.env.PRAXELOPS_SECRET = oldSecret;
      expect(() => readPassword("srv-1")).toThrow(VaultError);
      process.env.PRAXELOPS_SECRET = newSecret;
      expect(readPassword("srv-1")).toBe("pw-one");
    });
  });

  it("refuses a wrong OLD secret and changes nothing", () => {
    withDir((dir) => {
      const oldSecret = secret();
      process.env.PRAXELOPS_SECRET = oldSecret;
      StorageService.saveServer(server("srv-1", { password: "pw-one" }));
      closeDb();
      const metaBefore = fs.readFileSync(path.join(dir, "praxelops.db")).length;

      const run = runRotate(dir, secret(), secret());
      expect(run.code).toBe(1);
      expect(run.err).toMatch(/cannot be unlocked/);
      expect(run.err).toMatch(/Nothing was changed/);
      expect(metaBefore).toBeGreaterThan(0);

      process.env.PRAXELOPS_SECRET = oldSecret;
      expect(readPassword("srv-1")).toBe("pw-one");
    });
  });

  it("validates its inputs (missing, short, identical secrets, missing database)", () => {
    withDir((dir) => {
      const s = secret();
      expect(runRotate(dir, undefined, s).code).toBe(1);
      expect(runRotate(dir, s, "short").err).toMatch(/at least 32/);
      expect(runRotate(dir, s, s).err).toMatch(/identical/);
      const missing = runRotate(path.join(dir, "nope"), s, secret());
      expect(missing.code).toBe(1);
      expect(missing.err).toMatch(/No database/);
      expect(fs.existsSync(path.join(dir, "nope"))).toBe(false);
    });
  });

  it("is a harmless no-op when no credentials were ever stored", () => {
    withDir((dir) => {
      StorageService.saveServer(server("srv-plain", {}));
      closeDb();
      const run = runRotate(dir, secret(), secret());
      expect(run.code).toBe(0);
      expect(run.out).toMatch(/nothing to rotate/);
    });
  });
});
