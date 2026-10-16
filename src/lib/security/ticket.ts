import crypto from "crypto";

export interface WebSocketTicket {
  ticket: string;
  operatorId: string;
  serverId: string;
  expiresAt: number;
  createdAt: number;
}

export class TicketService {
  private static tickets = new Map<string, WebSocketTicket>();

  /**
   * Generates a single-use cryptographically random ticket valid for 60 seconds
   */
  static issueTicket(operatorId: string, serverId: string, ttlSeconds: number = 60): WebSocketTicket {
    const ticket = `tkt_${crypto.randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    const ticketObj: WebSocketTicket = {
      ticket,
      operatorId,
      serverId,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
    };
    this.tickets.set(ticket, ticketObj);
    return ticketObj;
  }

  /**
   * Atomically retrieves and removes a single-use ticket.
   * Replay attempts immediately return null.
   */
  static consumeTicket(ticketStr: string): WebSocketTicket | null {
    if (!ticketStr || typeof ticketStr !== "string") return null;
    const ticket = this.tickets.get(ticketStr);
    if (!ticket) return null;

    // Atomically delete to prevent replay or reuse
    this.tickets.delete(ticketStr);

    if (Date.now() > ticket.expiresAt) {
      return null;
    }

    return ticket;
  }

  /**
   * Clean expired tickets from memory
   */
  static pruneExpiredTickets(): number {
    const now = Date.now();
    let count = 0;
    for (const [k, v] of this.tickets.entries()) {
      if (now > v.expiresAt) {
        this.tickets.delete(k);
        count++;
      }
    }
    return count;
  }

  static getActiveTicketCount(): number {
    return this.tickets.size;
  }

  static clear(): void {
    this.tickets.clear();
  }
}
