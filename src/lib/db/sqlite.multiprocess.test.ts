import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeDb } from "./database";
import { TicketService } from "../security/ticket";

const WORKER = path.resolve(__dirname, "fixtures", "sqliteWorker.mjs");
const PROCESSES = 6;

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function spawnChild(dataDir: string, ctlDir: string, role: string, ...args: string[]): Promise<ChildResult> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", WORKER, role, ctlDir, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, PRAXELOPS_DATA_DIR: dataDir },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
  return new Promise<ChildResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForReady(ctlDir: string, count: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ready = fs.readdirSync(ctlDir).filter((f) => f.startsWith("ready-")).length;
    if (ready >= count) return;
    if (Date.now() > deadline) throw new Error(`only ${ready}/${count} children became ready`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Starts N children, waits until all are initialised, releases them together, and returns their parsed reports. */
async function runSimultaneously<T>(
  dataDir: string,
  ctlDir: string,
  specs: { role: string; args: string[] }[]
): Promise<T[]> {
  const children = specs.map((s) => spawnChild(dataDir, ctlDir, s.role, ...s.args));
  await waitForReady(ctlDir, specs.length);
  fs.writeFileSync(path.join(ctlDir, "go"), "go");
  const results = await Promise.all(children);
  return results.map((r) => {
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as T;
  });
}

function withTempDirs<T>(fn: (dataDir: string, ctlDir: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "praxelops-sqlmp-"));
  const dataDir = path.join(root, "data");
  const ctlDir = path.join(root, "ctl");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(ctlDir);
  const previous = process.env.PRAXELOPS_DATA_DIR;
  process.env.PRAXELOPS_DATA_DIR = dataDir;
  return fn(dataDir, ctlDir).finally(() => {
    closeDb();
    process.env.PRAXELOPS_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
}

function query<T>(dataDir: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(dataDir, "praxelops.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

describe("SQLite real multi-process behaviour", () => {
  it(
    "(a) 6 processes racing over 300 tickets: every ticket is consumed exactly once in total, never twice",
    async () => {
      await withTempDirs(async (dataDir, ctlDir) => {
        const ids = Array.from({ length: 300 }, (_, i) => TicketService.issueTicket("op-1", `srv-${i}`, 120).ticket);
        const idsFile = path.join(ctlDir, "ids.json");
        fs.writeFileSync(idsFile, JSON.stringify(ids));
        expect(TicketService.getActiveTicketCount()).toBe(300);
        // Release the parent's connection so the children own the database.
        closeDb();

        const reports = await runSimultaneously<{ consumed: string[]; errors: string[] }>(
          dataDir,
          ctlDir,
          Array.from({ length: PROCESSES }, () => ({ role: "consume", args: [idsFile] }))
        );

        for (const r of reports) expect(r.errors).toEqual([]);
        const all = reports.flatMap((r) => r.consumed);
        expect(all).toHaveLength(300); // nothing lost
        expect(new Set(all).size).toBe(300); // nothing consumed twice
        expect([...new Set(all)].sort()).toEqual([...ids].sort());
        // More than one process actually did work (otherwise this proved nothing about contention).
        expect(reports.filter((r) => r.consumed.length > 0).length).toBeGreaterThan(1);

        expect(query(dataDir, (db) => Number(db.prepare("SELECT COUNT(*) AS n FROM tickets").get()?.n))).toBe(0);
      });
    },
    180_000
  );

  it(
    "(b) 6 processes x 150 audit appends: exactly 900 rows, strictly increasing seq, no BUSY failures surfaced",
    async () => {
      await withTempDirs(async (dataDir, ctlDir) => {
        const per = 150;
        const reports = await runSimultaneously<{ appended: number; errors: string[] }>(
          dataDir,
          ctlDir,
          Array.from({ length: PROCESSES }, (_, i) => ({ role: "audit", args: [String(per), `worker-${i}`] }))
        );

        for (const r of reports) {
          expect(r.errors).toEqual([]);
          expect(r.appended).toBe(per);
        }

        query(dataDir, (db) => {
          expect(Number(db.prepare("SELECT COUNT(*) AS n FROM audit_events").get()?.n)).toBe(PROCESSES * per);
          const rows = db.prepare("SELECT seq, id, actor, details FROM audit_events ORDER BY seq").all();
          expect(rows).toHaveLength(PROCESSES * per);

          let previousSeq = 0;
          const lastIndex = new Map<string, number>();
          const ids = new Set<string>();
          for (const row of rows) {
            const seq = Number(row.seq);
            expect(seq).toBeGreaterThan(previousSeq); // strictly increasing
            previousSeq = seq;
            ids.add(String(row.id));
            // Each worker's own events appear in the order that worker wrote them.
            const details = JSON.parse(String(row.details)) as { worker: string; i: number };
            const prior = lastIndex.get(details.worker) ?? -1;
            expect(details.i).toBe(prior + 1);
            lastIndex.set(details.worker, details.i);
          }
          expect(ids.size).toBe(PROCESSES * per);
          expect(lastIndex.size).toBe(PROCESSES);
        });
      });
    },
    180_000
  );

  it(
    "(c) 2 processes first-opening the same fresh data dir with legacy JSON: imported exactly once",
    async () => {
      await withTempDirs(async (dataDir, ctlDir) => {
        const servers = Array.from({ length: 5 }, (_, i) => ({
          id: `srv-${i}`,
          name: `Server ${i}`,
          host: `10.0.0.${i}`,
          port: 22,
          username: "u",
          tags: [],
        }));
        const audit = Array.from({ length: 40 }, (_, i) => ({
          id: `audit-${40 - i}`,
          timestamp: new Date(2026, 0, 1, 0, 0, 40 - i).toISOString(),
          actor: "legacy",
          eventType: "ssh_connect",
          status: "success",
        }));
        // diagnostics has no unique key, so a double import would show up as duplicated rows.
        const diagnostics = Array.from({ length: 7 }, (_, i) => ({ id: `diag-${i}`, serverId: "srv-0", summary: "s" }));
        const proposals = Array.from({ length: 3 }, (_, i) => ({ id: `prop-${i}`, status: "pending_approval" }));
        fs.writeFileSync(path.join(dataDir, "servers.json"), JSON.stringify(servers));
        fs.writeFileSync(path.join(dataDir, "audit.json"), JSON.stringify(audit));
        fs.writeFileSync(path.join(dataDir, "diagnostics.json"), JSON.stringify(diagnostics));
        fs.writeFileSync(path.join(dataDir, "proposals.json"), JSON.stringify(proposals));

        const reports = await runSimultaneously<{ errors: string[] }>(dataDir, ctlDir, [
          { role: "open", args: [] },
          { role: "open", args: [] },
        ]);
        for (const r of reports) expect(r.errors).toEqual([]);

        const backups = fs.readdirSync(path.join(dataDir, "backup"));
        expect(backups).toHaveLength(1); // one process imported, the other found the marker

        query(dataDir, (db) => {
          const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
          expect(count("servers")).toBe(5);
          expect(count("audit_events")).toBe(40);
          expect(count("diagnostics")).toBe(7);
          expect(count("proposals")).toBe(3);
          expect(count("meta")).toBe(1);
          expect(count("schema_migrations")).toBe(1);
        });
      });
    },
    180_000
  );
});
