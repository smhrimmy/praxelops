import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getDataDir } from "../storage/dataDir";

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

export class TicketService {
  private static tickets = new Map<string, WebSocketTicket>();
  private static customTicketsDir: string | null = null;

  static setStorageDir(dir: string | null): void {
    this.customTicketsDir = dir;
  }

  static getStorageDir(): string {
    return this.customTicketsDir || path.join(getDataDir(), "tickets");
  }

  private static ensureTicketsDir(): string {
    const dir = this.getStorageDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
  }

  /**
   * Generates a single-use cryptographically random ticket valid for 60 seconds (or custom TTL),
   * persisted to shared storage for multi-process safety.
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

    // Cache in memory
    this.tickets.set(ticket, ticketObj);

    // Persist to shared filesystem directory for multi-process coordination
    const ticketsDir = this.ensureTicketsDir();
    const filePath = path.join(ticketsDir, `${ticket}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(ticketObj, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (err) {
      console.error("[TicketService] Failed to persist ticket to shared store:", err);
    }

    return ticketObj;
  }

  /**
   * Atomically retrieves and removes a single-use ticket across process boundaries.
   * Replay attempts immediately return null.
   */
  static consumeTicket(ticketStr: string, options?: ConsumeTicketOptions): WebSocketTicket | null {
    if (!ticketStr || typeof ticketStr !== "string") return null;

    // Validate ticket string format to prevent directory traversal
    if (!/^tkt_[a-zA-Z0-9_-]+$/.test(ticketStr)) {
      return null;
    }

    // Evict from in-memory cache
    this.tickets.delete(ticketStr);

    const ticketsDir = this.ensureTicketsDir();
    const filePath = path.join(ticketsDir, `${ticketStr}.json`);
    const lockPath = path.join(
      ticketsDir,
      `${ticketStr}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.consuming`
    );

    // Atomic filesystem consumption: rename guarantees only one process/thread succeeds
    try {
      fs.renameSync(filePath, lockPath);
    } catch {
      // Ticket doesn't exist or was already consumed atomically
      return null;
    }

    let ticketObj: WebSocketTicket | null = null;
    try {
      const raw = fs.readFileSync(lockPath, "utf-8");
      ticketObj = JSON.parse(raw) as WebSocketTicket;
    } catch {
      ticketObj = null;
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }

    if (!ticketObj) return null;

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

  /**
   * Clean expired tickets from memory and shared filesystem storage
   */
  static pruneExpiredTickets(): number {
    const now = Date.now();
    const prunedIds = new Set<string>();

    for (const [k, v] of this.tickets.entries()) {
      if (now > v.expiresAt) {
        this.tickets.delete(k);
        prunedIds.add(k);
      }
    }

    const ticketsDir = this.getStorageDir();
    if (fs.existsSync(ticketsDir)) {
      try {
        const files = fs.readdirSync(ticketsDir);
        for (const file of files) {
          const fullPath = path.join(ticketsDir, file);
          try {
            if (file.endsWith(".consuming")) {
              const stat = fs.statSync(fullPath);
              if (now - stat.mtimeMs > 10000) {
                fs.unlinkSync(fullPath);
              }
            } else if (file.endsWith(".json")) {
              const raw = fs.readFileSync(fullPath, "utf-8");
              const data = JSON.parse(raw) as WebSocketTicket;
              if (now > data.expiresAt) {
                fs.unlinkSync(fullPath);
                prunedIds.add(data.ticket);
              }
            }
          } catch {}
        }
      } catch {}
    }

    return prunedIds.size;
  }

  static getActiveTicketCount(): number {
    const ticketsDir = this.getStorageDir();
    if (!fs.existsSync(ticketsDir)) return this.tickets.size;
    try {
      const files = fs.readdirSync(ticketsDir).filter((f) => f.endsWith(".json"));
      return files.length;
    } catch {
      return this.tickets.size;
    }
  }

  static clear(): void {
    this.tickets.clear();
    const ticketsDir = this.getStorageDir();
    if (fs.existsSync(ticketsDir)) {
      try {
        const files = fs.readdirSync(ticketsDir);
        for (const file of files) {
          try {
            fs.unlinkSync(path.join(ticketsDir, file));
          } catch {}
        }
      } catch {}
    }
  }
}
