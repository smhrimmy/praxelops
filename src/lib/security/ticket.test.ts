import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { TicketService } from "./ticket";
import { closeDb, getDb, getDbPath } from "../db/database";

describe("TicketService", () => {
  // Tickets live under the per-test-file PRAXELOPS_DATA_DIR (see src/test/setupDataDir.ts).
  afterAll(() => {
    TicketService.clear();
  });

  beforeEach(() => {
    TicketService.clear();
  });

  it("issues high-entropy tickets bound to operator, server, origin, and purpose", () => {
    const t = TicketService.issueTicket("operator-1", "srv-101", {
      ttlSeconds: 60,
      origin: "http://localhost:3000",
      purpose: "terminal_shell",
    });
    expect(t.ticket).toMatch(/^tkt_[A-Za-z0-9_-]+/);
    expect(t.operatorId).toBe("operator-1");
    expect(t.serverId).toBe("srv-101");
    expect(t.origin).toBe("http://localhost:3000");
    expect(t.purpose).toBe("terminal_shell");
    expect(t.expiresAt).toBeGreaterThan(Date.now());
  });

  it("atomically consumes a ticket and prevents replay or reuse", () => {
    const t = TicketService.issueTicket("operator-1", "srv-101", 60);

    // First consumption succeeds
    const consumed = TicketService.consumeTicket(t.ticket);
    expect(consumed).not.toBeNull();
    expect(consumed?.serverId).toBe("srv-101");

    // Second consumption attempt fails immediately (single-use)
    const replayed = TicketService.consumeTicket(t.ticket);
    expect(replayed).toBeNull();
  });

  it("validates origin binding on consumption", () => {
    const tBad = TicketService.issueTicket("operator-1", "srv-101", {
      ttlSeconds: 60,
      origin: "https://ops.example.com",
    });

    // Mismatched origin fails consumption
    const badOrigin = TicketService.consumeTicket(tBad.ticket, {
      expectedOrigin: "https://malicious-attacker.com",
    });
    expect(badOrigin).toBeNull();

    const tGood = TicketService.issueTicket("operator-1", "srv-101", {
      ttlSeconds: 60,
      origin: "https://ops.example.com",
    });

    // Correct origin succeeds consumption
    const goodOrigin = TicketService.consumeTicket(tGood.ticket, {
      expectedOrigin: "https://ops.example.com",
    });
    expect(goodOrigin).not.toBeNull();
    expect(goodOrigin?.serverId).toBe("srv-101");
  });

  it("validates session purpose binding on consumption", () => {
    const tBad = TicketService.issueTicket("operator-1", "srv-101", {
      ttlSeconds: 60,
      purpose: "terminal_shell",
    });

    // Mismatched purpose fails consumption
    const badPurpose = TicketService.consumeTicket(tBad.ticket, {
      expectedPurpose: "sftp_session",
    });
    expect(badPurpose).toBeNull();

    const tGood = TicketService.issueTicket("operator-1", "srv-101", {
      ttlSeconds: 60,
      purpose: "terminal_shell",
    });

    // Correct purpose succeeds consumption
    const goodPurpose = TicketService.consumeTicket(tGood.ticket, {
      expectedPurpose: "terminal_shell",
    });
    expect(goodPurpose).not.toBeNull();
  });

  it("supports cross-process persistence and survives process restarts", () => {
    const t = TicketService.issueTicket("operator-1", "srv-shared-01", 60);

    // Simulate process A shutting down and process B (e.g. the terminal gateway) starting up:
    // a brand-new connection to the shared database must see the ticket.
    closeDb();

    const consumedInProcessB = TicketService.consumeTicket(t.ticket);
    expect(consumedInProcessB).not.toBeNull();
    expect(consumedInProcessB?.operatorId).toBe("operator-1");
    expect(consumedInProcessB?.serverId).toBe("srv-shared-01");

    // Replay attempt fails
    expect(TicketService.consumeTicket(t.ticket)).toBeNull();
  });

  it("handles race conditions under concurrent consumption atomically", async () => {
    const t = TicketService.issueTicket("operator-concurrent", "srv-race-01", 60);

    // Simulate 5 simultaneous consumers trying to consume the same ticket at once
    const attempts = await Promise.all([
      Promise.resolve().then(() => TicketService.consumeTicket(t.ticket)),
      Promise.resolve().then(() => TicketService.consumeTicket(t.ticket)),
      Promise.resolve().then(() => TicketService.consumeTicket(t.ticket)),
      Promise.resolve().then(() => TicketService.consumeTicket(t.ticket)),
      Promise.resolve().then(() => TicketService.consumeTicket(t.ticket)),
    ]);

    // Exactly one consumption must succeed; all others must be null
    const successes = attempts.filter((res) => res !== null);
    const failures = attempts.filter((res) => res === null);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(4);
    expect(successes[0]?.serverId).toBe("srv-race-01");
  });

  it("stores tickets in the database inside the configured data dir, not the repo", () => {
    const t = TicketService.issueTicket("operator-1", "srv-101", 60);
    expect(getDbPath().startsWith(process.env.PRAXELOPS_DATA_DIR ?? "<unset>")).toBe(true);
    // Only a digest of the bearer token is stored.
    const digest = crypto.createHash("sha256").update(t.ticket).digest("hex");
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM tickets WHERE id = ?").get(t.ticket)?.n).toBe(0);
    const row = getDb().prepare("SELECT operator_id, server_id, purpose FROM tickets WHERE id = ?").get(digest);
    expect(row?.operator_id).toBe("operator-1");
    expect(row?.server_id).toBe("srv-101");
    expect(row?.purpose).toBe("terminal_shell");
    // ...so the bearer token itself is nowhere in the database file or its write-ahead log.
    const bytes = [getDbPath(), `${getDbPath()}-wal`]
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f).toString("latin1"))
      .join(" ");
    expect(bytes).not.toContain(t.ticket);
    // The legacy file-per-ticket directory is no longer used.
    expect(fs.existsSync(path.join(process.env.PRAXELOPS_DATA_DIR ?? "<unset>", "tickets"))).toBe(false);
  });

  it("burns a ticket even when origin or purpose binding fails (no second chance)", () => {
    const t = TicketService.issueTicket("operator-1", "srv-101", { ttlSeconds: 60, origin: "https://ops.example.com" });
    expect(TicketService.consumeTicket(t.ticket, { expectedOrigin: "https://evil.example" })).toBeNull();
    expect(TicketService.consumeTicket(t.ticket, { expectedOrigin: "https://ops.example.com" })).toBeNull();
    expect(TicketService.getActiveTicketCount()).toBe(0);
  });

  it("rejects malformed ticket ids without touching the database", () => {
    const t = TicketService.issueTicket("operator-1", "srv-101", 60);
    for (const bad of ["", "tkt_", "../etc/passwd", "tkt_a b", "tkt_a'; DELETE FROM tickets;--", "nope_abc", "tkt_abc/../x"]) {
      expect(TicketService.consumeTicket(bad)).toBeNull();
    }
    expect(TicketService.getActiveTicketCount()).toBe(1);
    expect(TicketService.consumeTicket(t.ticket)).not.toBeNull();
  });

  it("rejects expired tickets", () => {
    // Issue ticket with -1 second TTL (already expired)
    const t = TicketService.issueTicket("operator-1", "srv-101", -1);
    const consumed = TicketService.consumeTicket(t.ticket);
    expect(consumed).toBeNull();
    expect(TicketService.getActiveTicketCount()).toBe(0);
  });

  it("prunes expired tickets correctly from the database", () => {
    TicketService.issueTicket("operator-1", "srv-1", -5);
    TicketService.issueTicket("operator-1", "srv-2", 60);

    const pruned = TicketService.pruneExpiredTickets();
    expect(pruned).toBe(1);
    expect(TicketService.getActiveTicketCount()).toBe(1);
  });
});
