// Child process for sqlite.multiprocess.test.ts. Plain node (type stripping), not vitest.
//   node sqliteWorker.mjs <role> <ctlDir> [arg...]      (PRAXELOPS_DATA_DIR comes from the environment)
//
//   consume <ticketsFile>      attempt to consume every ticket id listed in the JSON file, in order
//   audit   <count> <label>    append <count> audit events
//   open                       first-open the database (runs migrations + legacy JSON import)
//
// Every role first writes <ctlDir>/ready-<pid> and then spins until <ctlDir>/go exists, so that all children
// start their real work at the same moment.
import fs from "node:fs";
import path from "node:path";
import { getDb, closeDb } from "../database.ts";
import { TicketService } from "../../security/ticket.ts";
import { StorageService } from "../../storage/index.ts";

const [role, ctlDir, ...args] = process.argv.slice(2);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function waitForGo() {
  // For the throughput roles, pay the database-open cost BEFORE the start signal so the real work overlaps across
  // processes. The "open" role must not: its first open is exactly the race under test.
  if (role !== "open") getDb();
  fs.writeFileSync(path.join(ctlDir, `ready-${process.pid}`), "1");
  const deadline = Date.now() + 120000;
  while (!fs.existsSync(path.join(ctlDir, "go"))) {
    if (Date.now() > deadline) throw new Error("timed out waiting for go signal");
    Atomics.wait(sleepCell, 0, 0, 2);
  }
}

function report(value) {
  process.stdout.write(JSON.stringify(value));
}

function message(err) {
  return String(err && err.message ? err.message : err);
}

waitForGo();

if (role === "consume") {
  const ids = JSON.parse(fs.readFileSync(args[0], "utf-8"));
  const consumed = [];
  const errors = [];
  for (const id of ids) {
    try {
      if (TicketService.consumeTicket(id) !== null) {
        consumed.push(id);
        // Short random pause after a WIN only. SQLite's busy handler polls (it is not fair), so without a pause
        // the first process drains the list alone; with it, the processes that lost skip ahead quickly, catch up
        // with the leader and then genuinely race it for the very same tickets.
        Atomics.wait(sleepCell, 0, 0, Math.random() * 3);
      }
    } catch (err) {
      errors.push(message(err));
    }
  }
  report({ role, pid: process.pid, consumed, errors });
} else if (role === "audit") {
  const count = Number(args[0]);
  const label = args[1];
  let appended = 0;
  const errors = [];
  for (let i = 0; i < count; i++) {
    try {
      StorageService.logAuditEvent({
        actor: label,
        eventType: "ssh_connect",
        targetServerId: "srv-mp",
        status: "success",
        details: { worker: label, i },
      });
      appended++;
    } catch (err) {
      errors.push(message(err));
    }
  }
  report({ role, pid: process.pid, appended, errors });
} else if (role === "open") {
  const errors = [];
  try {
    getDb();
  } catch (err) {
    errors.push(message(err));
  }
  closeDb();
  report({ role, pid: process.pid, errors });
} else {
  process.stderr.write(`unknown role ${role}`);
  process.exit(2);
}
