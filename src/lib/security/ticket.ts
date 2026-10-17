import crypto from "node:crypto";
import { z } from "zod";
// NOTE: relative imports WITH .ts extensions and erasable-only TypeScript syntax (loaded by plain node in the
// multi-process test fixtures).
import { getDb, prepare, withTransaction } from "../db/database.ts";
import { corruptRow, type SqlRow } from "../db/records.ts";

export interface WebSocketTicket {
  ticket: string;
  operatorId: string;
  serverId: string;
  origin?: string;
  purpose?: "terminal_shell" | "sftp_session" | string;
  expiresAt: number;
  createdAt: number;
}

export interface IssueTicketOptions {
  ttlSeconds?: number;
  origin?: string;
  purpose?: "terminal_shell" | "sftp_session" | string;
}

export interface ConsumeTicketOptions {
  expectedOrigin?: string;
  expectedPurpose?: string;
}

function normalizeOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    return u.origin.toLowerCase();
  } catch {
    return origin.trim().toLowerCase();
  }
}

const TicketRowSchema = z.object({
  id: z.string().min(1),
  operator_id: z.string(),
  server_id: z.string(),
  origin: z.string().nullable(),
  purpose: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
});

const TICKET_ID_PATTERN = /^tkt_[a-zA-Z0-9_-]+$/;

/**
 * Only the SHA-256 digest of a ticket is stored (tickets.id). Tickets are 192-bit random bearer tokens, so a plain
 * digest is enough to make a copy of the database (or its WAL/backups) useless for replaying a live ticket.
 */
function hashTicket(ticket: string): string {
  return crypto.createHash("sha256").update(ticket, "utf8").digest("hex");
}

function rowToTicket(row: SqlRow, ticket: string): WebSocketTicket {
  const parsed = TicketRowSchema.safeParse(row);
  if (!parsed.success) throw corruptRow("tickets", String(row.id), parsed.error);
  const r = parsed.data;
  return {
    ticket,
    operatorId: r.operator_id,
    serverId: r.server_id,
    origin: r.origin === null ? undefined : r.origin,
    purpose: r.purpose,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/**
 * Single-use WebSocket tickets, stored (as digests) in the shared SQLite database so the Next.js process (issuer)
 * and the terminal gateway process (consumer) see the same rows. There is deliberately no in-memory cache:
 * the database is the only source of truth.
 */
export class TicketService {
  /**
   * Generates a single-use cryptographically random ticket valid for 60 seconds (or custom TTL),
   * persisted to shared storage for multi-process safety. Throws if it cannot be persisted.
   */
  static issueTicket(
    operatorId: string,
    serverId: string,
    ttlSecondsOrOptions: number | IssueTicketOptions = 60,
    maybeOptions?: IssueTicketOptions
  ): WebSocketTicket {
    let ttlSeconds = 60;
    let origin: string | undefined;
    let purpose: "terminal_shell" | "sftp_session" | string = "terminal_shell";

    if (typeof ttlSecondsOrOptions === "number") {
      ttlSeconds = ttlSecondsOrOptions;
      if (maybeOptions) {
        origin = maybeOptions.origin;
        if (maybeOptions.purpose) purpose = maybeOptions.purpose;
      }
    } else if (typeof ttlSecondsOrOptions === "object") {
      if (ttlSecondsOrOptions.ttlSeconds !== undefined) ttlSeconds = ttlSecondsOrOptions.ttlSeconds;
      origin = ttlSecondsOrOptions.origin;
      if (ttlSecondsOrOptions.purpose) purpose = ttlSecondsOrOptions.purpose;
    }

    const ticket = `tkt_${crypto.randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    const ticketObj: WebSocketTicket = {
      ticket,
      operatorId,
      serverId,
      origin: origin ? normalizeOrigin(origin) : undefined,
      purpose,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
    };

    withTransaction((db) => {
      prepare(
        db,
        "INSERT INTO tickets (id, operator_id, server_id, origin, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        hashTicket(ticketObj.ticket),
        ticketObj.operatorId,
        ticketObj.serverId,
        ticketObj.origin === undefined ? null : ticketObj.origin,
        purpose,
        ticketObj.createdAt,
        ticketObj.expiresAt
      );
    });

    return ticketObj;
  }

  /**
   * Atomically retrieves and removes a single-use ticket across process boundaries
   * (`DELETE ... RETURNING` is one statement under the write lock, so exactly one caller gets the row).
   * Replay attempts immediately return null. A ticket that is expired or fails its origin/purpose binding
   * is still consumed (burned) and yields null.
   */
  static consumeTicket(ticketStr: string, options?: ConsumeTicketOptions): WebSocketTicket | null {
    if (!ticketStr || typeof ticketStr !== "string") return null;

    // Same format check as the file-backed store had (also keeps garbage out of the query).
    if (!TICKET_ID_PATTERN.test(ticketStr)) {
      return null;
    }

    const row = withTransaction((db) =>
      prepare(
        db,
        "DELETE FROM tickets WHERE id = ? RETURNING id, operator_id, server_id, origin, purpose, created_at, expires_at"
      ).get(hashTicket(ticketStr))
    );
    // Ticket doesn't exist or was already consumed atomically.
    if (row === undefined) return null;

    const ticketObj = rowToTicket(row as SqlRow, ticketStr);

    // Verify expiration
    if (Date.now() > ticketObj.expiresAt) {
      return null;
    }

    // Verify origin binding if ticket has origin and expectedOrigin is provided
    if (ticketObj.origin && options?.expectedOrigin) {
      const normalizedExpected = normalizeOrigin(options.expectedOrigin);
      if (ticketObj.origin !== normalizedExpected) {
        return null;
      }
    }

    // Verify purpose binding if specified
    if (options?.expectedPurpose && ticketObj.purpose) {
      if (ticketObj.purpose !== options.expectedPurpose) {
        return null;
      }
    }

    return ticketObj;
  }

  /** Deletes expired tickets and returns how many were removed. */
  static pruneExpiredTickets(): number {
    return withTransaction((db) => {
      const result = prepare(db, "DELETE FROM tickets WHERE expires_at < ?").run(Date.now());
      return Number(result.changes);
    });
  }

  static getActiveTicketCount(): number {
    const row = prepare(getDb(), "SELECT COUNT(*) AS n FROM tickets").get();
    return row === undefined ? 0 : Number(row.n);
  }

  static clear(): void {
    withTransaction((db) => {
      prepare(db, "DELETE FROM tickets").run();
    });
  }
}
