import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { SSHAdapter } from "@/lib/ssh/adapter";
import { StorageService } from "@/lib/storage";
import { TicketService } from "@/lib/security/ticket";

export interface TerminalGatewayConfig {
  port?: number;
  server?: http.Server;
  maxSessions?: number;
  maxMessageBytes?: number;
  maxBufferedAmount?: number;
  idleTimeoutMs?: number;
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

export class TerminalGateway {
  private server: http.Server;
  private wss: WebSocketServer;
  private isExternalServer: boolean;
  private sessions = new Map<string, GatewaySessionMeta>();
  private reaperTimer: NodeJS.Timeout | null = null;
  private allowedOrigins: string[];

  public readonly port: number;
  public readonly maxSessions: number;
  public readonly maxMessageBytes: number;
  public readonly maxBufferedAmount: number;
  public readonly idleTimeoutMs: number;

  constructor(config: TerminalGatewayConfig = {}) {
    this.port = config.port !== undefined ? config.port : (process.env.TERMINAL_GATEWAY_PORT ? parseInt(process.env.TERMINAL_GATEWAY_PORT, 10) : 3001);
    this.maxSessions = config.maxSessions || 25;
    this.maxMessageBytes = config.maxMessageBytes || 65536; // 64 KB
    this.maxBufferedAmount = config.maxBufferedAmount || 1048576; // 1 MB backpressure limit
    this.idleTimeoutMs = config.idleTimeoutMs || 900000; // 15 minutes
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

    this.wss = new WebSocketServer({ noServer: true });
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
    const cleanAddr = remoteAddress.replace(/^::ffff:/, "");
    const envProxies = (process.env.TRUSTED_PROXIES || "127.0.0.1,::1")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/^::ffff:/, ""))
      .filter(Boolean);

    return envProxies.includes(cleanAddr.toLowerCase());
  }

  public getClientIp(req: http.IncomingMessage): string {
    const directIp = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    if (this.isTrustedProxy(directIp)) {
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string" && forwarded.trim()) {
        const parts = forwarded.split(",").map((p) => p.trim());
        if (parts.length > 0 && parts[0]) {
          return parts[0];
        }
      }
    }
    return directIp || "127.0.0.1";
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

      // 2. Validate Origin (Cross-Origin WebSocket Hijacking CSWSH prevention)
      const origin = req.headers.origin;
      if (!this.isValidOrigin(origin, req.socket.remoteAddress)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
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
      let activeSessionId: string | null = null;
      let authenticatedOperator: string | null = null;

      // Extract parameters from URL query
      const fullUrl = new URL(req.url || "", `http://${req.headers.host || "127.0.0.1"}`);
      const queryTicket = fullUrl.searchParams.get("ticket");
      // Raw operator/session tokens are NOT an authentication mode in any environment.
      const presentedRawToken =
        fullUrl.searchParams.has("token") ||
        req.headers.authorization !== undefined ||
        req.headers["x-operator-token"] !== undefined;

      const initialTicket = queryTicket;
      const initialCols = parseInt(fullUrl.searchParams.get("cols") || "80", 10);
      const initialRows = parseInt(fullUrl.searchParams.get("rows") || "24", 10);
      const initialTerm = fullUrl.searchParams.get("term") || "xterm-256color";
      const requestOrigin = req.headers.origin;
      const clientIp = this.getClientIp(req);

      if (!initialTicket && presentedRawToken) {
        this.sendSafeError(ws, "Authentication failed: Token authentication is not supported; a single-use ticket is required");
        ws.close(1008, "Ticket required");
        return;
      }

      // Connect immediately if a ticket is provided; otherwise wait for an auth frame carrying one
      if (initialTicket) {
        this.handleInitialConnection(ws, {
          ticket: initialTicket,
          cols: initialCols,
          rows: initialRows,
          term: initialTerm,
          origin: requestOrigin,
          clientIp,
        })
          .then((meta) => {
            if (meta) {
              activeSessionId = meta.sessionId;
              authenticatedOperator = meta.operatorId;
            }
          })
          .catch((err) => {
            this.sendSafeError(ws, err.message);
            ws.close(1008, "Connection setup failed");
          });
      }

      // Handle incoming frames from client
      ws.on("message", async (raw: Buffer | string) => {
        try {
          const rawStr = typeof raw === "string" ? raw : raw.toString("utf-8");
          if (rawStr.length > this.maxMessageBytes) {
            this.sendSafeError(ws, `Message exceeds maximum size of ${this.maxMessageBytes} bytes`);
            return;
          }

          let msg: ClientInboundMessage;
          try {
            msg = JSON.parse(rawStr);
          } catch {
            this.sendSafeError(ws, "Malformed JSON message frame");
            return;
          }

          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            return;
          }

          // Handshake auth frame if not authenticated on upgrade
          if (msg.type === "auth") {
            if (activeSessionId) {
              this.sendSafeError(ws, "Session already authenticated and initialized");
              return;
            }
            if (typeof msg.ticket !== "string" || msg.ticket.length === 0) {
              this.sendSafeError(ws, "Auth message requires a single-use 'ticket'");
              ws.close(1008, "Missing auth credentials");
              return;
            }

            const meta = await this.handleInitialConnection(ws, {
              ticket: msg.ticket,
              cols: msg.cols || 80,
              rows: msg.rows || 24,
              term: msg.term || "xterm-256color",
              origin: requestOrigin,
              clientIp,
            });
            if (meta) {
              activeSessionId = meta.sessionId;
              authenticatedOperator = meta.operatorId;
            }
            return;
          }

          // All subsequent operations require an established, verified session
          if (!activeSessionId) {
            this.sendSafeError(ws, "Unauthorized: Authenticate via ticket or auth frame");
            ws.close(1008, "Unauthorized");
            return;
          }

          const sessionMeta = this.sessions.get(activeSessionId);
          if (!sessionMeta) {
            this.sendSafeError(ws, "Session expired or terminated");
            ws.close(1000, "Session expired");
            return;
          }

          sessionMeta.lastActiveAt = Date.now();

          if (msg.type === "input") {
            if (typeof msg.data === "string") {
              SSHAdapter.sendInput(activeSessionId, msg.data);
            }
          } else if (msg.type === "resize") {
            const cols = Math.max(10, Math.min(500, msg.cols || 80));
            const rows = Math.max(2, Math.min(200, msg.rows || 24));
            SSHAdapter.resizeSession(activeSessionId, rows, cols);
          } else if (msg.type === "close") {
            this.terminateSession(activeSessionId, "Client explicitly closed terminal");
            ws.close(1000, "Normal closure");
          }
        } catch (error) {
          this.sendSafeError(ws, `Internal error: ${(error as Error).message}`);
        }
      });

      // Handle socket closure and error
      ws.on("close", () => {
        if (activeSessionId) {
          this.terminateSession(activeSessionId, "WebSocket disconnected");
          activeSessionId = null;
        }
      });

      ws.on("error", () => {
        if (activeSessionId) {
          this.terminateSession(activeSessionId, "WebSocket socket error");
          activeSessionId = null;
        }
      });
    });
  }

  private async handleInitialConnection(
    ws: WebSocket,
    params: {
      ticket: string;
      cols: number;
      rows: number;
      term: string;
      origin?: string;
      clientIp?: string;
    }
  ): Promise<GatewaySessionMeta | null> {
    // 1. Authenticate via single-use ticket (the only supported mode, in every environment)
    const ticketData = TicketService.consumeTicket(params.ticket, {
      expectedOrigin: params.origin,
      expectedPurpose: "terminal_shell",
    });
    if (!ticketData) {
      this.sendSafeError(ws, "Authentication failed: Invalid, expired, or previously consumed ticket");
      ws.close(1008, "Invalid ticket");
      return null;
    }
    const operatorId = ticketData.operatorId;
    const serverId = ticketData.serverId;

    // 2. Enforce concurrent session limit
    if (this.sessions.size >= this.maxSessions) {
      this.sendSafeError(ws, `Connection limit reached: Maximum ${this.maxSessions} active terminal sessions`);
      ws.close(1013, "Connection limit exceeded");
      return null;
    }

    // 3. Resolve target server from inventory (prevents open proxying)
    const server = StorageService.getServerById(serverId);
    if (!server) {
      this.sendSafeError(ws, `Server '${serverId}' not found in fleet inventory`);
      ws.close(1008, "Server not found");
      return null;
    }

    // 4. Generate unique session ID
    const sessionId = `pty-${Date.now()}-${randomUUID().slice(0, 8)}`;

    try {
      // 5. Spawn genuine PTY session via SSHAdapter with streaming callbacks
      await SSHAdapter.createInteractiveSession(
        sessionId,
        server,
        {
          rows: params.rows,
          cols: params.cols,
          term: params.term,
          onData: (chunk: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) {
              // Backpressure handling: check buffered amount
              if (ws.bufferedAmount > this.maxBufferedAmount) {
                SSHAdapter.pauseStream(sessionId);
                const checkDrain = setInterval(() => {
                  if (ws.bufferedAmount < this.maxBufferedAmount / 2) {
                    clearInterval(checkDrain);
                    SSHAdapter.resumeStream(sessionId);
                  }
                }, 50);
              }

              ws.send(JSON.stringify({
                type: "output",
                data: chunk.toString("utf-8"),
              }));
            }
          },
          onClose: (code?: number) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: "exit",
                code: code ?? 0,
              }));
              ws.close(1000, "Session closed");
            }
            this.cleanupSessionMeta(sessionId);
          },
          onError: (err: Error) => {
            if (ws.readyState === WebSocket.OPEN) {
              this.sendSafeError(ws, `SSH Stream Error: ${err.message}`);
              ws.close(1011, "SSH session error");
            }
            this.cleanupSessionMeta(sessionId);
          },
        }
      );

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

      // Log audit event (without logging credentials or ticket secrets)
      StorageService.logAuditEvent({
        actor: operatorId,
        eventType: "ssh_connect",
        targetServerId: server.id,
        targetServerName: server.name,
        status: "success",
        ipAddress: params.clientIp,
        details: { sessionId, transport: "websocket_gateway", cols: params.cols, rows: params.rows, term: params.term },
      });

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
      const errMsg = (error as Error).message;
      this.sendSafeError(ws, `SSH Connection Failed: ${errMsg}`);
      ws.close(1011, "SSH connection failure");
      return null;
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

  private cleanupSessionMeta(sessionId: string): void {
    const meta = this.sessions.get(sessionId);
    if (meta) {
      this.sessions.delete(sessionId);
      StorageService.logAuditEvent({
        actor: meta.operatorId,
        eventType: "ssh_disconnect",
        targetServerId: meta.serverId,
        targetServerName: meta.serverName,
        status: "success",
        details: { sessionId, durationMs: Date.now() - meta.connectedAt },
      });
    }
  }

  public terminateSession(sessionId: string, reason: string = "Terminated"): void {
    const meta = this.sessions.get(sessionId);
    if (meta) {
      SSHAdapter.closeSession(sessionId);
      this.cleanupSessionMeta(sessionId);
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
