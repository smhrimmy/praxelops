import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import { TicketService } from "./ticket";

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

  it("supports cross-process persistence and survives process memory restarts", () => {
    const t = TicketService.issueTicket("operator-1", "srv-shared-01", 60);

    // Simulate process A shutting down by wiping in-memory Map
    // (mimicking process B starting up or gateway running in a separate process)
    (TicketService as unknown as { tickets: Map<string, unknown> }).tickets.clear();

    // Process B should successfully consume the ticket from shared disk store
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

  it("stores ticket files inside the configured data dir, not the repo", () => {
    const t = TicketService.issueTicket("operator-1", "srv-101", 60);
    const dir = TicketService.getStorageDir();
    expect(dir.startsWith(process.env.PRAXELOPS_DATA_DIR ?? "<unset>")).toBe(true);
    expect(fs.existsSync(`${dir}/${t.ticket}.json`)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(`${dir}/${t.ticket}.json`).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects expired tickets", () => {
    // Issue ticket with -1 second TTL (already expired)
    const t = TicketService.issueTicket("operator-1", "srv-101", -1);
    const consumed = TicketService.consumeTicket(t.ticket);
    expect(consumed).toBeNull();
  });

  it("prunes expired tickets correctly from both memory and disk", () => {
    TicketService.issueTicket("operator-1", "srv-1", -5);
    TicketService.issueTicket("operator-1", "srv-2", 60);

    const pruned = TicketService.pruneExpiredTickets();
    expect(pruned).toBe(1);
    expect(TicketService.getActiveTicketCount()).toBe(1);
  });
});
