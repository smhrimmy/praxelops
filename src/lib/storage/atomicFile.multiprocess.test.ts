import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync, readJsonStrict } from "./atomicFile";

const WORKER = path.resolve(__dirname, "fixtures", "counterWorker.mjs");
const WRITERS = 6;
const ITERATIONS = 150;

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runChild(args: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", WORKER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("atomicFile real multi-process behaviour", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "praxelops-mp-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it(
    "serializes read-modify-write across 6 processes with no lost updates and no torn reads",
    async () => {
      const counterFile = path.join(dir, "counter.json");
      const stopFile = path.join(dir, "stop");
      atomicWriteFileSync(counterFile, JSON.stringify({ count: 0 }));

      const reader = runChild(["reader", counterFile, stopFile]);
      const writers = Array.from({ length: WRITERS }, () =>
        runChild(["writer", counterFile, String(ITERATIONS)])
      );

      const writerResults = await Promise.all(writers);
      fs.writeFileSync(stopFile, "stop");
      const readerResult = await reader;

      for (const r of writerResults) {
        expect(r.code, r.stderr).toBe(0);
      }
      expect(readerResult.code, readerResult.stderr).toBe(0);
      const readerStats = JSON.parse(readerResult.stdout) as {
        reads: number;
        parseErrors: number;
        otherErrors: number;
        missing: number;
      };

      expect(readJsonStrict<{ count: number }>(counterFile)).toEqual({ count: WRITERS * ITERATIONS });
      expect(readerStats.parseErrors).toBe(0);
      expect(readerStats.otherErrors).toBe(0);
      expect(readerStats.missing).toBe(0);
      expect(readerStats.reads).toBeGreaterThan(0);

      const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    },
    180_000
  );
});
