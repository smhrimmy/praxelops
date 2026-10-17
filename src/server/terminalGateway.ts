import http from "node:http";
import net from "node:net";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SSHAdapter } from "@/lib/ssh/adapter";
import { StorageService } from "@/lib/storage";
import { TicketService } from "@/lib/security/ticket";
import type { AuditEvent } from "@/types/audit";

export interface TerminalGatewayConfig {
  port?: number;
  server?: http.Server;
  maxSessions?: number;
  /** Per-operator concurrent session cap (env TERMINAL_MAX_SESSIONS_PER_OPERATOR, default 5). */
  maxSessionsPerOperator?: number;
  maxMessageBytes?: number;
  maxBufferedAmount?: number;
  idleTimeoutMs?: number;
  /** Time an unauthenticated socket may stay open (env TERMINAL_AUTH_TIMEOUT_MS, default 5000). */
  authTimeoutMs?: number;
  /** Global cap on concurrent unauthenticated sockets (default 50). */
  maxUnauthenticatedSockets?: number;
  /** Per-client-IP cap on concurrent unauthenticated sockets (default 10). */
  maxUnauthenticatedPerIp?: number;
  allowedOrigins?: string[];
}

export interface ClientInboundMessage {
  type: "auth" | "input" | "resize" | "ping" | "close";
  ticket?: string;
  data?: string;
  cols?: number;
  rows?: number;
  term?: string;
}

export interface GatewaySessionMeta {
  sessionId: string;
  operatorId: string;
  serverId: string;
  serverName: string;
  ws: WebSocket;
  connectedAt: number;
  lastActiveAt: number;
}

const InboundMessageSchema = z.object({
  type: z.enum(["auth", "input", "resize", "ping", "close"]),
  ticket: z.string().optional(),
  data: z.string().optional(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  term: z.string().optional(),
});

type SocketState = "unauthenticated" | "authenticating" | "active" | "closed";

interface SocketContext {
  ws: WebSocket;
  state: SocketState;
  sessionId: string | null;
  clientIp: string;
  origin: string | undefined;
  authTimer: NodeJS.Timeout | null;
  countedUnauth: boolean;
}

interface ConnectParams {
  ticket: string;
  cols: number;
  rows: number;
  term: string;
}

type AuditInput = Omit<AuditEvent, "id" | "timestamp">;

const MAX_WS_PAYLOAD_BYTES = 65536;
const DEFAULT_TERM = "xterm-256color";
const ALLOWED_TERMS: ReadonlySet<string> = new Set([
  "xterm",
  "xterm-256color",
  "vt100",
  "screen-256color",
]);
const TICKET_FORMAT = /^tkt_[a-zA-Z0-9_-]+$/;
const PRE_AUTH_AUDIT_WINDOW_MS = 60000;
const PRE_AUTH_AUDIT_MAX_PER_WINDOW = 20;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parses an untrusted dimension; non-numeric values fall back to the default, others are clamped. */
export function clampDimension(value: unknown, min: number, max: number, fallback: number): number {
  let n: number;
  if (typeof value === "number") {
    n = Math.trunc(value);
  } else if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) {
    n = Number.parseInt(value, 10);
  } else {
    return fallback;
  }
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function sanitizeTerm(value: unknown): string {
  return typeof value === "string" && ALLOWED_TERMS.has(value) ? value : DEFAULT_TERM;
}

/** Strips brackets, ports and the IPv4-mapped prefix; returns null unless the result is a valid IP. */
function normalizeIp(raw: string): string | null {
  let s = raw.trim();
  const bracketed = s.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) {
    s = bracketed[1];
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) {
    s = s.slice(0, s.lastIndexOf(":"));
  }
  s = s.replace(/^::ffff:/i, "");
  return net.isIP(s) ? s.toLowerCase() : null;
}

function rawDataToBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

export class TerminalGateway {
  private server: http.Server;
  private wss: WebSocketServer;
  private isExternalServer: boolean;
  /** Active (fully established) sessions. */
  private sessions = new Map<string, GatewaySessionMeta>();
  /** Slots held by pending AND active sessions: sessionId -> operatorId. */
  private reservations = new Map<string, string>();
  private drainTimers = new Map<string, NodeJS.Timeout>();
  private unauthTotal = 0;
  private unauthByIp = new Map<string, number>();
  private preAuthAudit = new Map<string, { windowStart: number; count: number }>();
  private reaperTimer: NodeJS.Timeout | null = null;
  private allowedOrigins: string[];

  public readonly port: number;
  public readonly maxSessions: number;
  public readonly maxSessionsPerOperator: number;
  public readonly maxMessageBytes: number;
  public readonly maxBufferedAmount: number;
  public readonly idleTimeoutMs: number;
  public readonly authTimeoutMs: number;
  public readonly maxUnauthenticatedSockets: number;
  public readonly maxUnauthenticatedPerIp: number;

  constructor(config: TerminalGatewayConfig = {}) {
    this.port = config.port !== undefined ? config.port : (process.env.TERMINAL_GATEWAY_PORT ? parseInt(process.env.TERMINAL_GATEWAY_PORT, 10) : 3001);
    this.maxSessions = config.maxSessions || 25;
    this.maxSessionsPerOperator =
      config.maxSessionsPerOperator || parsePositiveInt(process.env.TERMINAL_MAX_SESSIONS_PER_OPERATOR, 5);
    this.maxMessageBytes = config.maxMessageBytes || 65536; // 64 KB
    this.maxBufferedAmount = config.maxBufferedAmount || 1048576; // 1 MB backpressure limit
    this.idleTimeoutMs = config.idleTimeoutMs || 900000; // 15 minutes
    this.authTimeoutMs = config.authTimeoutMs || parsePositiveInt(process.env.TERMINAL_AUTH_TIMEOUT_MS, 5000);
    this.maxUnauthenticatedSockets = config.maxUnauthenticatedSockets || 50;
    this.maxUnauthenticatedPerIp = config.maxUnauthenticatedPerIp || 10;
    this.allowedOrigins = config.allowedOrigins || [];

    if (config.server) {
      this.server = config.server;
      this.isExternalServer = true;
    } else {
      this.server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          service: "PraxelOps Authenticated SSH Terminal Gateway",
          status: "healthy",
          activeSessions: this.sessions.size,
        }));
      });
      this.isExternalServer = false;
    }

    // maxPayload makes ws itself close oversized frames (1009) before they are buffered whole.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
    this.setupHttpUpgrade();
    this.setupWebSocketServer();
    this.startReaper();
  }

  public isValidOrigin(originHeader?: string, remoteAddress?: string): boolean {
    const isProduction = process.env.NODE_ENV === "production";

    // In production, Origin is MANDATORY for all WebSocket upgrades to prevent CSWSH
    if (!originHeader) {
      if (isProduction) {
        return false;
      }
      // In dev/test: allow if connection originates from local machine
      const remote = (remoteAddress || "").replace(/^::ffff:/, "");
      return remote === "127.0.0.1" || remote === "::1" || remote === "";
    }

    try {
      const originUrl = new URL(originHeader);
      const originHost = originUrl.hostname.toLowerCase();
      const normalizedOrigin = originUrl.origin.toLowerCase();

      // Check configured allowlist
      if (this.allowedOrigins.length > 0) {
        if (
          this.allowedOrigins.some(
            (o) =>
              o.toLowerCase() === normalizedOrigin ||
              o.toLowerCase() === originHost ||
              o.toLowerCase() === originUrl.host.toLowerCase()
          )
        ) {
          return true;
        }
      }

      // Check environment allowed origins
      const envOrigins = process.env.ALLOWED_ORIGINS || process.env.NEXT_PUBLIC_APP_URL || "";
      const allowedList = envOrigins
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      for (const allowed of allowedList) {
        try {
          const allowedUrl = new URL(allowed);
          if (allowedUrl.origin.toLowerCase() === normalizedOrigin) {
            return true;
          }
        } catch {
          if (
            allowed === originHost ||
            allowed === originUrl.host.toLowerCase() ||
            allowed === originHeader.toLowerCase()
          ) {
            return true;
          }
        }
      }

      // In non-production only, allow loopback hosts
      if (!isProduction) {
        if (originHost === "localhost" || originHost === "127.0.0.1" || originHost === "::1") {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  public isTrustedProxy(remoteAddress?: string): boolean {
    if (!remoteAddress) return false;
    const cleanAddr = (normalizeIp(remoteAddress) ?? remoteAddress.replace(/^::ffff:/, "")).toLowerCase();
    const envProxies = (process.env.TRUSTED_PROXIES || "127.0.0.1,::1")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/^::ffff:/, ""))
      .filter(Boolean);

    return envProxies.includes(cleanAddr);
  }

  /**
   * Resolves the real client IP. X-Forwarded-For is only considered when the TCP peer is a trusted
   * proxy; the list is then walked from the RIGHT (the hops our own proxies appended), skipping
   * trusted proxies, and the first untrusted hop is the client. Anything left of that is
   * client-controlled and never used. Any malformed entry aborts the walk and the peer is returned.
   */
  public getClientIp(req: http.IncomingMessage): string {
    const rawPeer = req.socket.remoteAddress || "";
    const peer = normalizeIp(rawPeer) ?? rawPeer.replace(/^::ffff:/, "");

    if (this.isTrustedProxy(peer)) {
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string" && forwarded.trim()) {
        const hops = forwarded.split(",");
        for (let i = hops.length - 1; i >= 0; i--) {
          const candidate = normalizeIp(hops[i]);
          if (candidate === null) break;
          if (!this.isTrustedProxy(candidate)) {
            return candidate;
          }
        }
      }
    }
    return peer || "127.0.0.1";
  }

  private setupHttpUpgrade(): void {
    this.server.on("upgrade", (req, socket, head) => {
      // 1. Path check
      const reqUrl = req.url || "";
      const pathname = reqUrl.split("?")[0];
      if (pathname !== "/terminal" && pathname !== "/" && pathname !== "/ssh") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const clientIp = this.getClientIp(req);

      // 2. Validate Origin (Cross-Origin WebSocket Hijacking CSWSH prevention)
      const origin = req.headers.origin;
      if (!this.isValidOrigin(origin, req.socket.remoteAddress)) {
        this.auditPreAuth(clientIp, {
          actor: "unauthenticated",
          eventType: "security_alert",
          status: "denied",
          ipAddress: clientIp,
          details: {
            reason: "origin_rejected",
            transport: "websocket_gateway",
            origin: typeof origin === "string" ? origin.slice(0, 200) : null,
          },
        });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      // 3. Cap concurrent unauthenticated sockets (globally and per client IP)
      if (
        this.unauthTotal >= this.maxUnauthenticatedSockets ||
        (this.unauthByIp.get(clientIp) ?? 0) >= this.maxUnauthenticatedPerIp
      ) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });
  }

  private setupWebSocketServer(): void {
    this.wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
      const ctx: SocketContext = {
        ws,
        state: "unauthenticated",
        sessionId: null,
        clientIp: this.getClientIp(req),
        origin: req.headers.origin,
        authTimer: null,
        countedUnauth: false,
      };
      this.enterUnauthPool(ctx);

      // Extract parameters from URL query
      const fullUrl = new URL(req.url || "", `http://${req.headers.host || "127.0.0.1"}`);
      const queryTicket = fullUrl.searchParams.get("ticket");
      // Raw operator/session tokens are NOT an authentication mode in any environment.
      const presentedRawToken =
        fullUrl.searchParams.has("token") ||
        req.headers.authorization !== undefined ||
        req.headers["x-operator-token"] !== undefined;

      ws.on("close", () => this.onSocketGone(ctx, "WebSocket disconnected"));
      ws.on("error", () => this.onSocketGone(ctx, "WebSocket socket error"));

      if (!queryTicket && presentedRawToken) {
        this.sendSafeError(ws, "Authentication failed: Token authentication is not supported; a single-use ticket is required");
        ctx.state = "closed";
        this.leaveUnauthPool(ctx);
        ws.close(1008, "Ticket required");
        return;
      }

      // Connect immediately if a ticket is provided; otherwise wait for an auth frame carrying one
      if (queryTicket) {
        void this.startAuth(ctx, {
          ticket: queryTicket,
          cols: clampDimension(fullUrl.searchParams.get("cols"), 1, 500, 80),
          rows: clampDimension(fullUrl.searchParams.get("rows"), 1, 200, 24),
          term: sanitizeTerm(fullUrl.searchParams.get("term")),
        });
      } else {
        ctx.authTimer = setTimeout(() => this.onAuthTimeout(ctx), this.authTimeoutMs);
      }

      ws.on("message", (raw: RawData) => {
        this.handleMessage(ctx, raw).catch((error: unknown) => {
          this.sendSafeError(ws, `Internal error: ${error instanceof Error ? error.message : "unknown"}`);
        });
      });
    });
  }

  private enterUnauthPool(ctx: SocketContext): void {
    ctx.countedUnauth = true;
    this.unauthTotal++;
    this.unauthByIp.set(ctx.clientIp, (this.unauthByIp.get(ctx.clientIp) ?? 0) + 1);
  }

  /** Idempotent: removes the socket from the unauthenticated pool and stops its auth timer. */
  private leaveUnauthPool(ctx: SocketContext): void {
    if (ctx.authTimer) {
      clearTimeout(ctx.authTimer);
      ctx.authTimer = null;
    }
    if (!ctx.countedUnauth) return;
    ctx.countedUnauth = false;
    this.unauthTotal = Math.max(0, this.unauthTotal - 1);
    const remaining = (this.unauthByIp.get(ctx.clientIp) ?? 1) - 1;
    if (remaining <= 0) {
      this.unauthByIp.delete(ctx.clientIp);
    } else {
      this.unauthByIp.set(ctx.clientIp, remaining);
    }
  }

  private onAuthTimeout(ctx: SocketContext): void {
    ctx.authTimer = null;
    if (ctx.state !== "unauthenticated") return;
    ctx.state = "closed";
    this.leaveUnauthPool(ctx);
    this.auditPreAuth(ctx.clientIp, {
      actor: "unauthenticated",
      eventType: "security_alert",
      status: "denied",
      ipAddress: ctx.clientIp,
      details: { reason: "auth_timeout", transport: "websocket_gateway", timeoutMs: this.authTimeoutMs },
    });
    this.sendSafeError(ctx.ws, "Authentication timeout");
    ctx.ws.close(1008, "Authentication timeout");
  }

  private onSocketGone(ctx: SocketContext, reason: string): void {
    ctx.state = "closed";
    this.leaveUnauthPool(ctx);
    if (ctx.sessionId) {
      this.terminateSession(ctx.sessionId, reason);
      ctx.sessionId = null;
    }
  }

  private async handleMessage(ctx: SocketContext, raw: RawData): Promise<void> {
    const ws = ctx.ws;
    const buf = rawDataToBuffer(raw);
    if (buf.byteLength > this.maxMessageBytes) {
      this.sendSafeError(ws, `Message exceeds maximum size of ${this.maxMessageBytes} bytes`);
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(buf.toString("utf-8"));
    } catch {
      this.sendSafeError(ws, "Malformed JSON message frame");
      if (ctx.state === "unauthenticated") ws.close(1008, "Malformed frame");
      return;
    }
    const parsed = InboundMessageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      this.sendSafeError(ws, "Malformed message frame");
      if (ctx.state === "unauthenticated") ws.close(1008, "Malformed frame");
      return;
    }
    const msg = parsed.data;

    if (msg.type === "ping") {
      // Never answer before authentication completes.
      if (ctx.state === "active") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      }
      return;
    }

    if (msg.type === "auth") {
      // Exactly one authentication attempt per socket: anything after the first is refused.
      if (ctx.state !== "unauthenticated") {
        this.sendSafeError(ws, "Session already authenticated or authentication in progress");
        return;
      }
      if (typeof msg.ticket !== "string" || msg.ticket.length === 0) {
        ctx.state = "closed";
        this.leaveUnauthPool(ctx);
        this.sendSafeError(ws, "Auth message requires a single-use 'ticket'");
        ws.close(1008, "Missing auth credentials");
        return;
      }
      await this.startAuth(ctx, {
        ticket: msg.ticket,
        cols: clampDimension(msg.cols, 1, 500, 80),
        rows: clampDimension(msg.rows, 1, 200, 24),
        term: sanitizeTerm(msg.term),
      });
      return;
    }

    // All subsequent operations require an established, verified session
    if (ctx.state === "unauthenticated") {
      ctx.state = "closed";
      this.leaveUnauthPool(ctx);
      this.sendSafeError(ws, "Unauthorized: Authenticate via ticket or auth frame");
      ws.close(1008, "Unauthorized");
      return;
    }
    if (ctx.state !== "active" || !ctx.sessionId) {
      // Still authenticating (or already closing): drop the frame.
      this.sendSafeError(ws, "Session not ready");
      return;
    }

    const sessionId = ctx.sessionId;
    const sessionMeta = this.sessions.get(sessionId);
    if (!sessionMeta) {
      this.sendSafeError(ws, "Session expired or terminated");
      ws.close(1000, "Session expired");
      return;
    }

    sessionMeta.lastActiveAt = Date.now();

    if (msg.type === "input") {
      if (typeof msg.data === "string") {
        SSHAdapter.sendInput(sessionId, msg.data);
      }
    } else if (msg.type === "resize") {
      const cols = Math.max(10, Math.min(500, msg.cols || 80));
      const rows = Math.max(2, Math.min(200, msg.rows || 24));
      SSHAdapter.resizeSession(sessionId, rows, cols);
    } else if (msg.type === "close") {
      this.terminateSession(sessionId, "Client explicitly closed terminal");
      ws.close(1000, "Normal closure");
    }
  }

  /** Synchronously leaves `unauthenticated` (so a second attempt is refused) and runs the connect. */
  private async startAuth(ctx: SocketContext, params: ConnectParams): Promise<void> {
    if (ctx.state !== "unauthenticated") return;
    ctx.state = "authenticating";
    this.leaveUnauthPool(ctx);

    try {
      const meta = await this.handleInitialConnection(ctx, params);
      if (meta && ctx.state === "authenticating") {
        ctx.state = "active";
        ctx.sessionId = meta.sessionId;
      } else if (meta) {
        // Socket went away between setup finishing and activation: do not leave the session behind.
        this.terminateSession(meta.sessionId, "WebSocket disconnected");
      } else {
        ctx.state = "closed";
      }
    } catch (error) {
      ctx.state = "closed";
      this.sendSafeError(ctx.ws, error instanceof Error ? error.message : "Connection setup failed");
      ctx.ws.close(1008, "Connection setup failed");
    }
  }

  private countReservationsForOperator(operatorId: string): number {
    let n = 0;
    for (const op of this.reservations.values()) {
      if (op === operatorId) n++;
    }
    return n;
  }

  private async handleInitialConnection(ctx: SocketContext, params: ConnectParams): Promise<GatewaySessionMeta | null> {
    const ws = ctx.ws;
    const clientIp = ctx.clientIp;

    // 1. Authenticate via single-use ticket (the only supported mode, in every environment)
    const ticketData = TicketService.consumeTicket(params.ticket, {
      expectedOrigin: ctx.origin,
      expectedPurpose: "terminal_shell",
    });
    if (!ticketData) {
      // consumeTicket does not say why; only the format can be distinguished locally.
      this.auditPreAuth(clientIp, {
        actor: "unauthenticated",
        eventType: "security_alert",
        status: "denied",
        ipAddress: clientIp,
        details: {
          reason: TICKET_FORMAT.test(params.ticket) ? "ticket_invalid_expired_replayed_or_mismatched" : "ticket_malformed",
          transport: "websocket_gateway",
          origin: ctx.origin ? ctx.origin.slice(0, 200) : null,
        },
      });
      this.sendSafeError(ws, "Authentication failed: Invalid, expired, or previously consumed ticket");
      ws.close(1008, "Invalid ticket");
      return null;
    }
    const operatorId = ticketData.operatorId;
    const serverId = ticketData.serverId;

    // 2. Resolve target server from inventory (prevents open proxying)
    const server = StorageService.getServerById(serverId);
    if (!server) {
      this.safeAudit({
        actor: operatorId,
        eventType: "ssh_connect",
        targetServerId: serverId,
        status: "failure",
        ipAddress: clientIp,
        details: { reason: "server_not_found", transport: "websocket_gateway" },
      });
      this.sendSafeError(ws, `Server '${serverId}' not found in fleet inventory`);
      ws.close(1008, "Server not found");
      return null;
    }

    // 3. Reserve a slot SYNCHRONOUSLY (no await between check and insert), before the SSH connect.
    const sessionId = `pty-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let limitReason: "global_session_limit" | "operator_session_limit" | null = null;
    if (this.reservations.size >= this.maxSessions) {
      limitReason = "global_session_limit";
    } else if (this.countReservationsForOperator(operatorId) >= this.maxSessionsPerOperator) {
      limitReason = "operator_session_limit";
    }
    if (limitReason) {
      this.safeAudit({
        actor: operatorId,
        eventType: "ssh_connect",
        targetServerId: server.id,
        targetServerName: server.name,
        status: "denied",
        ipAddress: clientIp,
        details: { reason: limitReason, transport: "websocket_gateway" },
      });
      this.sendSafeError(
        ws,
        limitReason === "global_session_limit"
          ? `Connection limit reached: Maximum ${this.maxSessions} active terminal sessions`
          : `Per-operator limit reached: Maximum ${this.maxSessionsPerOperator} concurrent terminal sessions`
      );
      ws.close(1013, "Connection limit exceeded");
      return null;
    }
    this.reservations.set(sessionId, operatorId);

    // 4. Spawn genuine PTY session via SSHAdapter with streaming callbacks
    try {
      await SSHAdapter.createInteractiveSession(
        sessionId,
        server,
        {
          rows: params.rows,
          cols: params.cols,
          term: params.term,
          onData: (chunk: Buffer) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            // Backpressure handling: a single drain timer per session
            if (ws.bufferedAmount > this.maxBufferedAmount && !this.drainTimers.has(sessionId)) {
              SSHAdapter.pauseStream(sessionId);
              const timer = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN) {
                  this.clearDrainTimer(sessionId);
                  return;
                }
                if (ws.bufferedAmount < this.maxBufferedAmount / 2) {
                  this.clearDrainTimer(sessionId);
                  SSHAdapter.resumeStream(sessionId);
                }
              }, 50);
              this.drainTimers.set(sessionId, timer);
            }

            ws.send(JSON.stringify({
              type: "output",
              data: chunk.toString("utf-8"),
            }));
          },
          onClose: (code?: number) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "exit",
                code: code ?? 0,
              }));
              ws.close(1000, "Session closed");
            }
            this.cleanupSessionMeta(sessionId, "SSH stream closed");
          },
          onError: (err: Error) => {
            if (ws.readyState === WebSocket.OPEN) {
              this.sendSafeError(ws, `SSH Stream Error: ${err.message}`);
              ws.close(1011, "SSH session error");
            }
            this.cleanupSessionMeta(sessionId, "SSH stream error");
          },
        }
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "unknown error";
      SSHAdapter.closeSession(sessionId);
      this.releaseSlot(sessionId);
      this.safeAudit({
        actor: operatorId,
        eventType: "ssh_connect",
        targetServerId: server.id,
        targetServerName: server.name,
        status: "failure",
        ipAddress: clientIp,
        details: { sessionId, reason: "ssh_connect_failed", error: errMsg.slice(0, 200), transport: "websocket_gateway" },
      });
      this.sendSafeError(ws, `SSH Connection Failed: ${errMsg}`);
      ws.close(1011, "SSH connection failure");
      return null;
    }

    // 5. The socket may have gone away while SSH was connecting: tear the fresh session down now.
    if (ws.readyState !== WebSocket.OPEN || ctx.state === "closed") {
      SSHAdapter.closeSession(sessionId);
      this.releaseSlot(sessionId);
      this.safeAudit({
        actor: operatorId,
        eventType: "ssh_connect",
        targetServerId: server.id,
        targetServerName: server.name,
        status: "failure",
        ipAddress: clientIp,
        details: { sessionId, reason: "client_disconnected_during_connect", transport: "websocket_gateway" },
      });
      return null;
    }

    // 6. Register, audit (fail closed) and announce. Any failure here must not leak the SSH session.
    const meta: GatewaySessionMeta = {
      sessionId,
      operatorId,
      serverId: server.id,
      serverName: server.name,
      ws,
      connectedAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    this.sessions.set(sessionId, meta);

    try {
      // Audit event never contains credentials or the ticket secret
      const audited = this.safeAudit({
        actor: operatorId,
        eventType: "ssh_connect",
        targetServerId: server.id,
        targetServerName: server.name,
        status: "success",
        ipAddress: clientIp,
        details: { sessionId, transport: "websocket_gateway", cols: params.cols, rows: params.rows, term: params.term },
      });
      if (!audited) {
        this.abortSession(sessionId);
        this.sendSafeError(ws, "Audit subsystem unavailable; session refused");
        ws.close(1011, "Audit unavailable");
        return null;
      }

      // Notify client that connection is established
      ws.send(JSON.stringify({
        type: "connected",
        sessionId,
        serverId: server.id,
        serverName: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        cols: params.cols,
        rows: params.rows,
      }));

      return meta;
    } catch (error) {
      this.abortSession(sessionId);
      throw error;
    }
  }

  private sendSafeError(ws: WebSocket, message: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "error",
        error: message,
      }));
    }
  }

  /** Writes an audit event; a failing audit store is logged and never throws. */
  private safeAudit(event: AuditInput): boolean {
    try {
      StorageService.logAuditEvent(event);
      return true;
    } catch (error) {
      console.error("[TerminalGateway] Audit write failed:", error instanceof Error ? error.message : error);
      return false;
    }
  }

  /** Pre-authentication audit writes are rate limited per IP so an attacker cannot flood the log. */
  private auditPreAuth(ip: string, event: AuditInput): void {
    const now = Date.now();
    const entry = this.preAuthAudit.get(ip);
    if (!entry || now - entry.windowStart > PRE_AUTH_AUDIT_WINDOW_MS) {
      this.preAuthAudit.set(ip, { windowStart: now, count: 1 });
    } else if (entry.count >= PRE_AUTH_AUDIT_MAX_PER_WINDOW) {
      return;
    } else {
      entry.count++;
    }
    this.safeAudit(event);
  }

  private clearDrainTimer(sessionId: string): void {
    const timer = this.drainTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.drainTimers.delete(sessionId);
    }
  }

  private releaseSlot(sessionId: string): void {
    this.reservations.delete(sessionId);
    this.clearDrainTimer(sessionId);
  }

  /** Tears down a session without any ws/audit side effects (failure path of session setup). */
  private abortSession(sessionId: string): void {
    SSHAdapter.closeSession(sessionId);
    this.sessions.delete(sessionId);
    this.releaseSlot(sessionId);
  }

  private cleanupSessionMeta(sessionId: string, reason: string = "Terminated"): void {
    const meta = this.sessions.get(sessionId);
    this.releaseSlot(sessionId);
    if (meta) {
      this.sessions.delete(sessionId);
      this.safeAudit({
        actor: meta.operatorId,
        eventType: "ssh_disconnect",
        targetServerId: meta.serverId,
        targetServerName: meta.serverName,
        status: "success",
        details: { sessionId, durationMs: Date.now() - meta.connectedAt, reason },
      });
    }
  }

  public terminateSession(sessionId: string, reason: string = "Terminated"): void {
    const meta = this.sessions.get(sessionId);
    if (meta) {
      SSHAdapter.closeSession(sessionId);
      this.cleanupSessionMeta(sessionId, reason);
      if (meta.ws.readyState === WebSocket.OPEN) {
        meta.ws.send(JSON.stringify({ type: "disconnected", reason }));
        meta.ws.close(1000, reason);
      }
    }
  }

  private startReaper(): void {
    this.reaperTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, meta] of this.sessions.entries()) {
        if (now - meta.lastActiveAt > this.idleTimeoutMs) {
          this.terminateSession(sessionId, `Idle timeout after ${Math.round(this.idleTimeoutMs / 60000)} minutes`);
        }
      }
      for (const [ip, entry] of this.preAuthAudit.entries()) {
        if (now - entry.windowStart > PRE_AUTH_AUDIT_WINDOW_MS) {
          this.preAuthAudit.delete(ip);
        }
      }
      SSHAdapter.cleanIdleSessions(this.idleTimeoutMs);
      TicketService.pruneExpiredTickets();
    }, 30000);
  }

  public listen(): Promise<number> {
    if (this.isExternalServer) {
      return Promise.resolve(this.port);
    }
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, "127.0.0.1", () => {
        const addr = this.server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : this.port;
        resolve(actualPort);
      });
      this.server.on("error", (err) => {
        reject(err);
      });
    });
  }

  public async close(): Promise<void> {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }

    for (const sessionId of Array.from(this.sessions.keys())) {
      this.terminateSession(sessionId, "Gateway server shutting down");
    }
    for (const sessionId of Array.from(this.drainTimers.keys())) {
      this.clearDrainTimer(sessionId);
    }
    // Sockets that never established a session (unauthenticated / mid-connect) would hold the server open.
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.terminate();
      }
    }

    return new Promise<void>((resolve) => {
      this.wss.close(() => {
        if (!this.isExternalServer) {
          this.server.close(() => resolve());
        } else {
          resolve();
        }
      });
    });
  }

  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /** Slots held by pending + active sessions (what the caps are enforced against). */
  public getReservedSlotCount(): number {
    return this.reservations.size;
  }

  public getUnauthenticatedSocketCount(): number {
    return this.unauthTotal;
  }

  public getDrainTimerCount(): number {
    return this.drainTimers.size;
  }
}

/**
 * Fail-closed startup check for the standalone gateway process. Returns a fatal error message,
 * or null when the configuration is acceptable.
 */
export function getGatewayStartupError(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.NODE_ENV === "production") {
    const origins = (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    if (origins.length === 0) {
      return "FATAL: ALLOWED_ORIGINS must be set (comma-separated full origins) when NODE_ENV=production; refusing to start the terminal gateway.";
    }
  }
  return null;
}

// Standalone runner when executed directly via Node
if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("terminalGateway.ts")) {
  const startupError = getGatewayStartupError(process.env);
  if (startupError) {
    console.error(`[PraxelOps] ${startupError}`);
    process.exit(1);
  }
  const gateway = new TerminalGateway();
  gateway.listen().then((port) => {
    console.log(`[PraxelOps] Authenticated SSH Terminal WebSocket Gateway listening on ws://127.0.0.1:${port}`);
  }).catch((err) => {
    console.error(`[PraxelOps] Failed to start Terminal Gateway:`, err);
    process.exit(1);
  });
}
