import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { TerminalGateway, getGatewayStartupError } from "./terminalGateway";
import { SSHAdapter, CreateSessionOptions } from "@/lib/ssh/adapter";
import { StorageService } from "@/lib/storage";
import { AuthService } from "@/lib/security/auth";
import { TicketService } from "@/lib/security/ticket";
import { ServerHost } from "@/types/server";

class TestClient {
  public ws: WebSocket;
  public messages: any[] = [];
  private messageListeners: Array<(msg: any) => void> = [];
  public isClosed = false;
  public closeCode?: number;
  private closeListeners: Array<(code: number) => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      let parsed: any;
      try {
        parsed = JSON.parse(raw.toString("utf-8"));
      } catch {
        parsed = raw.toString("utf-8");
      }
      if (this.messageListeners.length > 0) {
        const listener = this.messageListeners.shift()!;
        listener(parsed);
      } else {
        this.messages.push(parsed);
      }
    });

    this.ws.on("close", (code) => {
      this.isClosed = true;
      this.closeCode = code;
      while (this.closeListeners.length > 0) {
        this.closeListeners.shift()!(code);
      }
    });
  }

  waitForOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.on("open", () => resolve());
      this.ws.on("error", (err) => reject(err));
    });
  }

  nextMessage(): Promise<any> {
    if (this.messages.length > 0) {
      return Promise.resolve(this.messages.shift());
    }
    return new Promise((resolve) => {
      this.messageListeners.push(resolve);
    });
  }

  waitForClose(): Promise<number> {
    if (this.isClosed && this.closeCode !== undefined) {
      return Promise.resolve(this.closeCode);
    }
    return new Promise((resolve) => {
      this.closeListeners.push(resolve);
    });
  }

  send(data: string) {
    this.ws.send(data);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

describe("TerminalGateway WebSocket Transport", () => {
  let gateway: TerminalGateway;
  let gatewayPort: number;

  const mockServer: ServerHost = {
    id: "srv-pty-test-01",
    name: "PTY Test Server",
    host: "10.0.0.50",
    port: 22,
    username: "operator",
    authType: "password",
    tags: ["test"],
    status: "online",
    osType: "linux",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockServer2: ServerHost = {
    id: "srv-pty-test-02",
    name: "Secondary PTY Server",
    host: "10.0.0.51",
    port: 22,
    username: "admin",
    authType: "password",
    tags: ["test"],
    status: "online",
    osType: "linux",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    vi.restoreAllMocks();

    vi.spyOn(StorageService, "getServerById").mockImplementation((id: string) => {
      if (id === mockServer.id) return mockServer;
      if (id === mockServer2.id) return mockServer2;
      return undefined;
    });

    gateway = new TerminalGateway({ port: 0, idleTimeoutMs: 1000 });
    gatewayPort = await gateway.listen();
  });

  afterEach(async () => {
    await gateway.close();
    vi.restoreAllMocks();
  });

  const createClient = async (path: string): Promise<TestClient> => {
    const client = new TestClient(`ws://127.0.0.1:${gatewayPort}${path}`);
    await client.waitForOpen();
    return client;
  };

  /** Issues a real single-use ticket and returns the gateway path that presents it. */
  const ticketPath = (serverId: string, extraQuery?: string): string => {
    const t = TicketService.issueTicket("test-operator", serverId, { ttlSeconds: 60, purpose: "terminal_shell" });
    return `/terminal?ticket=${encodeURIComponent(t.ticket)}${extraQuery ? `&${extraQuery}` : ""}`;
  };

  it("rejects an invalid or already-consumed ticket", async () => {
    const client = await createClient(`/terminal?ticket=tkt_does-not-exist`);
    const msg = await client.nextMessage();

    expect(msg.type).toBe("error");
    expect(msg.error).toContain("Authentication failed");

    const closeCode = await client.waitForClose();
    expect(closeCode).toBe(1008);
  });

  it("rejects every ?token= credential (including the legacy dev literal and a real session token) with 1008", async () => {
    const createSpy = vi.spyOn(SSHAdapter, "createInteractiveSession");
    const realSession = AuthService.createOperatorSession("op-real", 1);

    for (const token of ["local-operator-token", "bad-token", realSession.token]) {
      const client = await createClient(`/terminal?serverId=${mockServer.id}&token=${encodeURIComponent(token)}`);
      const msg = await client.nextMessage();
      expect(msg.type).toBe("error");
      expect(msg.error).toContain("Authentication failed");
      expect(await client.waitForClose()).toBe(1008);
    }

    // Header-carried tokens are rejected too.
    const headerWs = new WebSocket(`ws://127.0.0.1:${gatewayPort}/terminal?serverId=${mockServer.id}`, {
      headers: { Authorization: `Bearer ${realSession.token}` },
    });
    const headerClose = await new Promise<number>((resolve) => headerWs.on("close", (code) => resolve(code)));
    expect(headerClose).toBe(1008);

    expect(createSpy).not.toHaveBeenCalled();
    expect(gateway.getActiveSessionCount()).toBe(0);
  });

  it("rejects an auth frame that carries a token instead of a ticket", async () => {
    const createSpy = vi.spyOn(SSHAdapter, "createInteractiveSession");
    const client = await createClient(`/terminal`);
    client.send(JSON.stringify({ type: "auth", token: "local-operator-token", serverId: mockServer.id }));

    const msg = await client.nextMessage();
    expect(msg.type).toBe("error");
    expect(await client.waitForClose()).toBe(1008);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("authenticates via an auth frame carrying a valid ticket", async () => {
    vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(async (sessionId, server) => ({
      sessionId,
      serverId: server.id,
    }));
    const t = TicketService.issueTicket("test-operator", mockServer.id, { ttlSeconds: 60, purpose: "terminal_shell" });

    const client = await createClient(`/terminal`);
    client.send(JSON.stringify({ type: "auth", ticket: t.ticket, cols: 90, rows: 33 }));

    const connMsg = await client.nextMessage();
    expect(connMsg.type).toBe("connected");
    expect(connMsg.serverId).toBe(mockServer.id);
    client.close();
  });

  it("rejects connection when target server is not found in inventory", async () => {
    const client = await createClient(ticketPath("non-existent-server"));
    const msg = await client.nextMessage();

    expect(msg.type).toBe("error");
    expect(msg.error).toContain("not found in fleet inventory");

    const closeCode = await client.waitForClose();
    expect(closeCode).toBe(1008);
  });

  it("streams input and output bidirectionally between WebSocket client and SSH PTY", async () => {
    let capturedOnData: ((chunk: Buffer) => void) | undefined;
    const createSpy = vi
      .spyOn(SSHAdapter, "createInteractiveSession")
      .mockImplementation(async (sessionId, server, options?: CreateSessionOptions) => {
        capturedOnData = options?.onData;
        return { sessionId, serverId: server.id };
      });

    const sendInputSpy = vi.spyOn(SSHAdapter, "sendInput").mockReturnValue(true);

    const client = await createClient(ticketPath(mockServer.id, "cols=100&rows=30"));

    const connMsg = await client.nextMessage();
    expect(connMsg.type).toBe("connected");
    expect(connMsg.serverId).toBe(mockServer.id);
    expect(connMsg.cols).toBe(100);
    expect(connMsg.rows).toBe(30);
    expect(createSpy).toHaveBeenCalled();

    // Stream output from SSH PTY to WS
    expect(capturedOnData).toBeDefined();
    capturedOnData!(Buffer.from("Welcome to PraxelOps PTY\r\n"));

    const outMsg = await client.nextMessage();
    expect(outMsg.type).toBe("output");
    expect(outMsg.data).toBe("Welcome to PraxelOps PTY\r\n");

    // Send input from WS to SSH PTY
    client.send(JSON.stringify({ type: "input", data: "uname -a\r" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(sendInputSpy).toHaveBeenCalledWith(expect.any(String), "uname -a\r");

    client.close();
  });

  it("propagates terminal resize events to SSH PTY with boundary validation", async () => {
    vi.spyOn(SSHAdapter, "createInteractiveSession").mockResolvedValue({
      sessionId: "test-sess",
      serverId: mockServer.id,
    });

    const resizeSpy = vi.spyOn(SSHAdapter, "resizeSession").mockReturnValue(true);

    const client = await createClient(ticketPath(mockServer.id));
    await client.nextMessage(); // connected frame

    // Send valid resize
    client.send(JSON.stringify({ type: "resize", cols: 140, rows: 45 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(resizeSpy).toHaveBeenCalledWith(expect.any(String), 45, 140);

    // Send out-of-bounds resize (clamped to max cols 500, rows 200)
    client.send(JSON.stringify({ type: "resize", cols: 9999, rows: 9999 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(resizeSpy).toHaveBeenCalledWith(expect.any(String), 200, 500);

    client.close();
  });

  it("transfers complex ANSI escape sequences and multi-byte Unicode strings with fidelity", async () => {
    let capturedOnData: ((chunk: Buffer) => void) | undefined;
    vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(
      async (sessionId, server, options?: CreateSessionOptions) => {
        capturedOnData = options?.onData;
        return { sessionId, serverId: server.id };
      }
    );

    const client = await createClient(ticketPath(mockServer.id));
    await client.nextMessage(); // connected frame

    const testPayload = "\x1b[38;2;255;100;0m🔥 PraxelOps Quantum Node — 宇宙 [한국어 / 日本語] \x1b[0m\r\n";
    capturedOnData!(Buffer.from(testPayload, "utf-8"));

    const received = await client.nextMessage();
    expect(received.type).toBe("output");
    expect(received.data).toBe(testPayload);

    client.close();
  });

  it("handles multiple simultaneous independent terminal sessions without cross-talk", async () => {
    const callbacks = new Map<string, (chunk: Buffer) => void>();

    vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(
      async (sessionId, server, options?: CreateSessionOptions) => {
        if (options?.onData) {
          callbacks.set(sessionId, options.onData);
        }
        return { sessionId, serverId: server.id };
      }
    );

    const client1 = await createClient(ticketPath(mockServer.id));
    const conn1 = await client1.nextMessage();

    const client2 = await createClient(ticketPath(mockServer2.id));
    const conn2 = await client2.nextMessage();

    expect(conn1.sessionId).not.toBe(conn2.sessionId);
    expect(gateway.getActiveSessionCount()).toBe(2);

    const cb1 = callbacks.get(conn1.sessionId);
    expect(cb1).toBeDefined();
    cb1!(Buffer.from("Output strictly for session 1\r\n"));

    const res1 = await client1.nextMessage();
    expect(res1.data).toBe("Output strictly for session 1\r\n");

    client1.close();
    client2.close();
  });

  it("enforces maximum inbound message payload limits", async () => {
    vi.spyOn(SSHAdapter, "createInteractiveSession").mockResolvedValue({
      sessionId: "test-sess",
      serverId: mockServer.id,
    });

    const client = await createClient(ticketPath(mockServer.id));
    await client.nextMessage(); // connected frame

    const giantPayload = JSON.stringify({
      type: "input",
      data: "A".repeat(70000),
    });

    client.send(giantPayload);

    const errMsg = await client.nextMessage();
    expect(errMsg.type).toBe("error");
    expect(errMsg.error).toContain("Message exceeds maximum size");

    client.close();
  });

  it("rejects connection and cleans up when SSH host-key verification fails", async () => {
    vi.spyOn(SSHAdapter, "createInteractiveSession").mockRejectedValue(
      new Error("SSH_HOST_KEY_MISMATCH: Fingerprint altered from known_hosts")
    );

    const client = await createClient(ticketPath(mockServer.id));
    const msg = await client.nextMessage();

    expect(msg.type).toBe("error");
    expect(msg.error).toContain("SSH_HOST_KEY_MISMATCH");

    const code = await client.waitForClose();
    expect(code).toBe(1011);
  });

  it("cleans up SSH channels and audit logs when client disconnects or closes session", async () => {
    const closeSessionSpy = vi.spyOn(SSHAdapter, "closeSession");
    const auditSpy = vi.spyOn(StorageService, "logAuditEvent");

    vi.spyOn(SSHAdapter, "createInteractiveSession").mockResolvedValue({
      sessionId: "session-cleanup-test",
      serverId: mockServer.id,
    });

    const client = await createClient(ticketPath(mockServer.id));
    const connMsg = await client.nextMessage();

    expect(gateway.getActiveSessionCount()).toBe(1);

    client.send(JSON.stringify({ type: "close" }));

    await new Promise((r) => setTimeout(r, 100));

    expect(closeSessionSpy).toHaveBeenCalledWith(connMsg.sessionId);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "ssh_disconnect",
        targetServerId: mockServer.id,
      })
    );
    expect(gateway.getActiveSessionCount()).toBe(0);
  });

  it("rejects WebSocket upgrade when Origin is missing in production mode", async () => {
    const origEnv = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";

      const gw = new TerminalGateway({ port: 0 });
      const p = await gw.listen();

      // Attempt WebSocket connection without Origin header
      const ws = new WebSocket(`ws://127.0.0.1:${p}/terminal?serverId=${mockServer.id}`);

      const errPromise = new Promise<{ code?: number; error?: Error }>((resolve) => {
        ws.on("error", (err) => resolve({ error: err }));
        ws.on("unexpected-response", (_req, res) => {
          resolve({ code: res.statusCode });
        });
      });

      const outcome = await errPromise;
      expect(outcome.code).toBe(403);

      await gw.close();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnv;
    }
  });

  it("rejects raw query tokens in production mode even when the token is a VALID session token", async () => {
    // A real, live session: if the token guard were removed this credential would be usable.
    const realSession = AuthService.createOperatorSession("op-prod", 1);
    const createSpy = vi.spyOn(SSHAdapter, "createInteractiveSession");
    const origEnv = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";

      const gw = new TerminalGateway({
        port: 0,
        allowedOrigins: ["http://localhost:3000"],
      });
      const p = await gw.listen();

      const ws = new WebSocket(
        `ws://127.0.0.1:${p}/terminal?serverId=${mockServer.id}&token=${encodeURIComponent(realSession.token)}`,
        { headers: { Origin: "http://localhost:3000" } }
      );

      const code = await new Promise<number>((resolve) => {
        ws.on("close", (c) => resolve(c));
      });
      expect(code).toBe(1008);
      expect(createSpy).not.toHaveBeenCalled();
      expect(gw.getActiveSessionCount()).toBe(0);

      await gw.close();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnv;
    }
  });

  it("accepts a valid single-use ticket in production mode and refuses its replay", async () => {
    vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(async (sessionId, server) => ({
      sessionId,
      serverId: server.id,
    }));
    const origin = "https://ops.example.com";
    const t = TicketService.issueTicket("op-prod", mockServer.id, { ttlSeconds: 60, purpose: "terminal_shell", origin });
    const origEnv = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      const gw = new TerminalGateway({ port: 0, allowedOrigins: [origin] });
      const p = await gw.listen();
      const url = `ws://127.0.0.1:${p}/terminal?ticket=${encodeURIComponent(t.ticket)}`;

      const ws = new WebSocket(url, { headers: { Origin: origin } });
      const first = await new Promise<{ type?: string }>((resolve, reject) => {
        ws.once("message", (raw) => resolve(JSON.parse(raw.toString("utf-8"))));
        ws.once("error", reject);
      });
      expect(first.type).toBe("connected");
      ws.close();

      const replay = new WebSocket(url, { headers: { Origin: origin } });
      const replayCode = await new Promise<number>((resolve) => replay.on("close", (c) => resolve(c)));
      expect(replayCode).toBe(1008);

      await gw.close();
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = origEnv;
    }
  });

  it("refuses to start in production without ALLOWED_ORIGINS", () => {
    expect(getGatewayStartupError({ NODE_ENV: "production" })).toContain("ALLOWED_ORIGINS");
    expect(getGatewayStartupError({ NODE_ENV: "production", ALLOWED_ORIGINS: " , " })).toContain("ALLOWED_ORIGINS");
    expect(getGatewayStartupError({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://ops.example.com" })).toBeNull();
    expect(getGatewayStartupError({ NODE_ENV: "development" })).toBeNull();
  });

  it("validates client IP from X-Forwarded-For only when peer is a trusted proxy", () => {
    const gw = new TerminalGateway();

    // From untrusted remote IP: X-Forwarded-For is ignored
    const untrustedReq = {
      socket: { remoteAddress: "203.0.113.195" },
      headers: { "x-forwarded-for": "198.51.100.2" },
    } as any;
    expect(gw.getClientIp(untrustedReq)).toBe("203.0.113.195");

    // From trusted loopback proxy (127.0.0.1): X-Forwarded-For is extracted
    const trustedReq = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "x-forwarded-for": "198.51.100.2, 10.0.0.1" },
    } as any;
    expect(gw.getClientIp(trustedReq)).toBe("198.51.100.2");
  });
});

