// Child process for atomicFile.multiprocess.test.ts. Plain node (type stripping), not vitest.
//   writer: node counterWorker.mjs writer <file> <iterations>
//   reader: node counterWorker.mjs reader <file> <stopFile>
import fs from "node:fs";
import {
  atomicWriteFileSync,
  readJsonStrict,
  StorageCorruptError,
  withFileLockSync,
} from "../atomicFile.ts";

const [role, file, arg] = process.argv.slice(2);

if (role === "writer") {
  const iterations = Number(arg);
  for (let i = 0; i < iterations; i++) {
    withFileLockSync(file, () => {
      const current = readJsonStrict(file);
      const next = { count: (current ? current.count : 0) + 1 };
      atomicWriteFileSync(file, JSON.stringify(next));
    }, { timeoutMs: 120000 }); // stress test: the lock is unfair, so allow long waits under heavy load
  }
  process.stdout.write(JSON.stringify({ role, iterations }));
} else if (role === "reader") {
  const stopFile = arg;
  let reads = 0;
  let parseErrors = 0;
  let otherErrors = 0;
  let missing = 0;
  const deadline = Date.now() + 120000;
  while (!fs.existsSync(stopFile) && Date.now() < deadline) {
    try {
      const value = readJsonStrict(file);
      if (value === undefined) missing++;
      reads++;
    } catch (err) {
      if (err instanceof StorageCorruptError) parseErrors++;
      else otherErrors++;
    }
  }
  process.stdout.write(JSON.stringify({ role, reads, parseErrors, otherErrors, missing }));
} else {
  process.stderr.write("unknown role");
  process.exit(2);
}
