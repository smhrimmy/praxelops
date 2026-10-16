import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { SSHAdapter } from "@/lib/ssh/adapter";
import { AuthService } from "@/lib/security/auth";
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
  token?: string;
  serverId?: string;
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

  private isValidOrigin(originHeader?: string): boolean {
    if (!originHeader) {
      return true;
    }

    try {
      const originUrl = new URL(originHeader);
      const originHost = originUrl.hostname.toLowerCase();

      // Safe loopback hosts
      if (originHost === "localhost" || originHost === "127.0.0.1" || originHost === "::1") {
        return true;
      }

      // Check configured allowlist
      if (this.allowedOrigins.length > 0) {
        if (this.allowedOrigins.some(o => o.toLowerCase() === originUrl.origin.toLowerCase() || o.toLowerCase() === originHost)) {
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
          if (allowedUrl.origin.toLowerCase() === originUrl.origin.toLowerCase()) {
            return true;
          }
        } catch {
          if (allowed === originHost || allowed === originHeader.toLowerCase()) {
            return true;
          }
        }
      }

      return false;
    } catch {
      return false;
    }
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
      if (origin && !this.isValidOrigin(origin)) {
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
      const queryToken = fullUrl.searchParams.get("token");
      const queryServerId = fullUrl.searchParams.get("serverId");
      const authHeader = req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
        (req.headers["x-operator-token"] as string | undefined);

      const initialTicket = queryTicket;
      const initialToken = queryToken || authHeader;
      const initialServerId = queryServerId;
      const initialCols = parseInt(fullUrl.searchParams.get("cols") || "80", 10);
      const initialRows = parseInt(fullUrl.searchParams.get("rows") || "24", 10);
      const initialTerm = fullUrl.searchParams.get("term") || "xterm-256color";

      // Connect immediately if ticket is provided, or if dev/test credentials are provided
      if (initialTicket || (initialToken && initialServerId)) {
        this.handleInitialConnection(ws, {
          ticket: initialTicket || undefined,
          token: initialToken || undefined,
          serverId: initialServerId || undefined,
          cols: initialCols,
          rows: initialRows,
          term: initialTerm,
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
            if (!msg.ticket && (!msg.token || !msg.serverId)) {
              this.sendSafeError(ws, "Auth message requires 'ticket' or 'token' and 'serverId'");
              ws.close(1008, "Missing auth credentials");
              return;
            }

            const meta = await this.handleInitialConnection(ws, {
              ticket: msg.ticket,
              token: msg.token,
              serverId: msg.serverId,
              cols: msg.cols || 80,
              rows: msg.rows || 24,
              term: msg.term || "xterm-256color",
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
      ticket?: string;
      token?: string;
      serverId?: string;
      cols: number;
      rows: number;
      term: string;
    }
  ): Promise<GatewaySessionMeta | null> {
    let operatorId = "";
    let serverId = "";

    // 1. Authenticate via single-use ticket if provided
    if (params.ticket) {
      const ticketData = TicketService.consumeTicket(params.ticket);
      if (!ticketData) {
        this.sendSafeError(ws, "Authentication failed: Invalid, expired, or previously consumed ticket");
        ws.close(1008, "Invalid ticket");
        return null;
      }
      operatorId = ticketData.operatorId;
      serverId = ticketData.serverId;
    } else if (params.token && params.serverId) {
      // In production, reject raw query tokens to enforce short-lived single-use tickets
      if (process.env.NODE_ENV === "production") {
        this.sendSafeError(ws, "Authentication failed: Single-use ticket required in production");
        ws.close(1008, "Ticket required");
        return null;
      }

      const auth = AuthService.verifyToken(params.token);
      if (!auth.valid || !auth.operatorId) {
        this.sendSafeError(ws, `Authentication failed: ${auth.error || "Invalid operator token"}`);
        ws.close(1008, "Authentication failed");
        return null;
      }
      operatorId = auth.operatorId;
      serverId = params.serverId;
    } else {
      this.sendSafeError(ws, "Authentication failed: Missing ticket or credentials");
      ws.close(1008, "Missing credentials");
      return null;
    }

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

// Standalone runner when executed directly via Node
if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("terminalGateway.ts")) {
  const gateway = new TerminalGateway();
  gateway.listen().then((port) => {
    console.log(`[PraxelOps] Authenticated SSH Terminal WebSocket Gateway listening on ws://127.0.0.1:${port}`);
  }).catch((err) => {
    console.error(`[PraxelOps] Failed to start Terminal Gateway:`, err);
    process.exit(1);
  });
}
