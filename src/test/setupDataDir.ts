import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { closeDb } from "../lib/db/database";

// Every test file gets its own throwaway data dir so the suite never touches the repo's .peos/.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "praxelops-test-"));
process.env.PRAXELOPS_DATA_DIR = dataDir;
// A random master secret per test file: keeps the suite from reading/creating the repo's .peos/config/master.key and
// isolates the credential vault (each data dir gets its own DEK wrapped under this file's secret).
process.env.PRAXELOPS_SECRET = crypto.randomBytes(32).toString("hex");

afterAll(() => {
  closeDb(); // release the SQLite handle first (Windows cannot delete an open file)
  delete process.env.PRAXELOPS_DATA_DIR;
  delete process.env.PRAXELOPS_SECRET;
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Windows may briefly hold handles; a leftover temp dir is harmless.
  }
});
