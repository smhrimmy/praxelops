import { describe, it, expect, beforeEach } from "vitest";
import { TicketService } from "./ticket";

describe("TicketService", () => {
  beforeEach(() => {
    TicketService.clear();
  });

  it("issues high-entropy tickets bound to operator and server", () => {
    const t = TicketService.issueTicket("operator-1", "srv-101", 60);
    expect(t.ticket).toMatch(/^tkt_[A-Za-z0-9_-]+/);
    expect(t.operatorId).toBe("operator-1");
    expect(t.serverId).toBe("srv-101");
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

  it("rejects expired tickets", () => {
    // Issue ticket with -1 second TTL (already expired)
    const t = TicketService.issueTicket("operator-1", "srv-101", -1);
    const consumed = TicketService.consumeTicket(t.ticket);
    expect(consumed).toBeNull();
  });

  it("prunes expired tickets correctly", () => {
    TicketService.issueTicket("operator-1", "srv-1", -5);
    TicketService.issueTicket("operator-1", "srv-2", 60);

    const pruned = TicketService.pruneExpiredTickets();
    expect(pruned).toBe(1);
    expect(TicketService.getActiveTicketCount()).toBe(1);
  });
});
