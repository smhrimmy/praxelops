import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteFileSync,
  readJsonStrict,
  StorageCorruptError,
  withFileLockSync,
} from "./atomicFile";

describe("atomicFile", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "praxelops-atomic-"));
    file = path.join(dir, "store.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe("readJsonStrict", () => {
    it("returns undefined for a missing file", () => {
      expect(readJsonStrict(file)).toBeUndefined();
    });

    it("parses valid JSON", () => {
      fs.writeFileSync(file, '{"a":1}');
      expect(readJsonStrict<{ a: number }>(file)).toEqual({ a: 1 });
    });

    it("throws StorageCorruptError (with the path) for corrupt or empty files, never a default", () => {
      fs.writeFileSync(file, '{"a":');
      let caught: unknown;
      try {
        readJsonStrict(file);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StorageCorruptError);
      expect((caught as StorageCorruptError).filePath).toBe(file);
      expect((caught as StorageCorruptError).message).toContain(file);

      fs.writeFileSync(file, "");
      expect(() => readJsonStrict(file)).toThrow(StorageCorruptError);
    });
  });

  describe("atomicWriteFileSync", () => {
    it("writes content, replaces existing content and leaves no temp files", () => {
      atomicWriteFileSync(file, "one");
      atomicWriteFileSync(file, "two");
      expect(fs.readFileSync(file, "utf-8")).toBe("two");
      expect(fs.readdirSync(dir)).toEqual(["store.json"]);
    });

    it("creates missing parent directories", () => {
      const nested = path.join(dir, "a", "b", "x.json");
      atomicWriteFileSync(nested, "{}");
      expect(fs.readFileSync(nested, "utf-8")).toBe("{}");
    });

    it("applies the requested mode on POSIX", () => {
      atomicWriteFileSync(file, "x");
      if (process.platform !== "win32") {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    });

    it("cleans up the temp file and rethrows when the rename cannot succeed", () => {
      // Target is a non-empty directory: rename fails with a non-transient error.
      fs.mkdirSync(file);
      fs.writeFileSync(path.join(file, "child"), "x");
      expect(() => atomicWriteFileSync(file, "data")).toThrow();
      expect(fs.readdirSync(dir)).toEqual(["store.json"]);
    });
  });

  describe("withFileLockSync", () => {
    it("returns the value from fn and releases the lock", () => {
      const out = withFileLockSync(file, () => 42);
      expect(out).toBe(42);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });

    it("releases the lock when fn throws", () => {
      expect(() =>
        withFileLockSync(file, () => {
          throw new Error("boom");
        })
      ).toThrow("boom");
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });

    it("times out with a clear error while a live lock is held", () => {
      fs.writeFileSync(`${file}.lock`, "someone-else 0\n");
      const started = Date.now();
      expect(() => withFileLockSync(file, () => 1, { timeoutMs: 150, staleMs: 60_000 })).toThrow(
        /Timed out after 150ms waiting for file lock/
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
      // the foreign lock is untouched
      expect(fs.readFileSync(`${file}.lock`, "utf-8")).toBe("someone-else 0\n");
    });

    it("breaks a lock older than staleMs", () => {
      const lock = `${file}.lock`;
      fs.writeFileSync(lock, "dead-process 0\n");
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);
      const out = withFileLockSync(file, () => "ok", { timeoutMs: 1000, staleMs: 10_000 });
      expect(out).toBe("ok");
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.readdirSync(dir).filter((f) => f.includes(".stale."))).toEqual([]);
    });
  });
});
