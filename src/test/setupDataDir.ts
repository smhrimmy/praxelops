import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Every test file gets its own throwaway data dir so the suite never touches the repo's .peos/.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "praxelops-test-"));
process.env.PRAXELOPS_DATA_DIR = dataDir;

afterAll(() => {
  delete process.env.PRAXELOPS_DATA_DIR;
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Windows may briefly hold handles; a leftover temp dir is harmless.
  }
});
