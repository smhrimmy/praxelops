import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import http from "node:http";
import { WebSocket } from "ws";
import {
  TerminalGateway,
  TerminalGatewayConfig,
  clampDimension,
  sanitizeTerm,
} from "./terminalGateway";
import { SSHAdapter, CreateSessionOptions } from "@/lib/ssh/adapter";
import { StorageService } from "@/lib/storage";
import { TicketService, IssueTicketOptions } from "@/lib/security/ticket";
import { VaultError } from "@/lib/security/vault";
import { startTestSshServer, TestSshServerInstance } from "@/lib/ssh/testSshServer";
import type { ServerHost } from "@/types/server";
import type { AuditEvent } from "@/types/audit";

type Frame = { type?: string; [key: string]: unknown };
type AuditInput = Omit<AuditEvent, "id" | "timestamp">;

const WAIT = { timeout: 5000, interval: 10 };

class WsClient {
  public readonly ws: WebSocket;
  public readonly frames: Frame[] = [];
  public closed = false;
  public closeCode: number | undefined;

  constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on("message", (raw) => {
      try {
        this.frames.push(JSON.parse(raw.toString("utf-8")) as Frame);
      } catch {
        this.frames.push({ type: "unparseable" });
      }
    });
    this.ws.on("close", (code) => {
      this.closed = true;
      this.closeCode = code;
    });
    this.ws.on("error", () => {
      /* surfaced through close / open() */
    });
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (err) => reject(err));
    });
  }

  async nextFrame(): Promise<Frame> {
    await vi.waitFor(() => {
      if (this.frames.length === 0) throw new Error("no frame yet");
    }, WAIT);
    return this.frames.shift() as Frame;
  }

  async waitClose(): Promise<number> {
    await vi.waitFor(() => {
      if (!this.closed) throw new Error("still open");
    }, WAIT);
    return this.closeCode as number;
  }

  send(obj: unknown): void {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeServer(id: string, extra: Partial<ServerHost> = {}): ServerHost {
  const now = new Date().toISOString();
  return {
    id,
    name: `Server ${id}`,
    host: "10.0.0.60",
    port: 22,
    username: "operator",
    authType: "password",
    tags: ["test"],
    status: "online",
    osType: "linux",
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function fakeReq(remote: string | undefined, xff?: string): http.IncomingMessage {
  const headers: Record<string, string> = {};
  if (xff !== undefined) headers["x-forwarded-for"] = xff;
  return { socket: { remoteAddress: remote }, headers } as unknown as http.IncomingMessage;
}

/** Resolves with the HTTP status of a refused upgrade, or 101 when the handshake succeeded. */
function upgradeStatus(url: string, headers?: Record<string, string>): Promise<{ status: number; ws?: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    ws.on("error", () => {
      /* refused upgrades also error; status already reported */
    });
    ws.on("open", () => resolve({ status: 101, ws }));
  });
}

describe("TerminalGateway hardening", () => {
  const SRV = makeServer("srv-hard-01");
  const gateways: TerminalGateway[] = [];
  const clients: WsClient[] = [];
  let auditSpy: MockInstance<typeof StorageService.logAuditEvent>;

  const startGateway = async (config: TerminalGatewayConfig = {}): Promise<{ gw: TerminalGateway; port: number }> => {
    const gw = new TerminalGateway({ port: 0, ...config });
    gateways.push(gw);
    const port = await gw.listen();
    return { gw, port };
  };

  const connect = async (port: number, query = "", headers?: Record<string, string>): Promise<WsClient> => {
    const c = new WsClient(`ws://127.0.0.1:${port}/terminal${query}`, headers);
    clients.push(c);
    await c.open();
    return c;
  };

  const ticketFor = (operator: string, serverId: string = SRV.id, opts: IssueTicketOptions = {}): string =>
    TicketService.issueTicket(operator, serverId, { ttlSeconds: 60, purpose: "terminal_shell", ...opts }).ticket;

  const q = (ticket: string, extra = ""): string => `?ticket=${encodeURIComponent(ticket)}${extra ? `&${extra}` : ""}`;

  const auditEvents = (): AuditInput[] => auditSpy.mock.calls.map(([e]) => e);

  /** createInteractiveSession mock that blocks on `gate` and records the session ids it saw. */
  const mockHeldConnect = (gate: { promise: Promise<void> }): string[] => {
    const seen: string[] = [];
    vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(async (sessionId, server) => {
      seen.push(sessionId);
      await gate.promise;
      return { sessionId, serverId: server.id };
    });
    return seen;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(StorageService, "getServerById").mockImplementation((id: string) => (id === SRV.id ? SRV : undefined));
    auditSpy = vi.spyOn(StorageService, "logAuditEvent");
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const gw of gateways.splice(0)) await gw.close();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------- finding 3: client IP
  describe("getClientIp (X-Forwarded-For)", () => {
    let gw: TerminalGateway;
    const origProxies = process.env.TRUSTED_PROXIES;

    beforeEach(async () => {
      delete process.env.TRUSTED_PROXIES;
      gw = (await startGateway()).gw;
    });
    afterEach(() => {
      if (origProxies === undefined) delete process.env.TRUSTED_PROXIES;
      else process.env.TRUSTED_PROXIES = origProxies;
    });

    it("walks the list from the right and returns the first untrusted hop", () => {
      process.env.TRUSTED_PROXIES = "127.0.0.1,10.0.0.1,10.0.0.2";
      expect(gw.getClientIp(fakeReq("127.0.0.1", "198.51.100.7, 10.0.0.2, 10.0.0.1"))).toBe("198.51.100.7");
      expect(gw.getClientIp(fakeReq("127.0.0.1", "198.51.100.7"))).toBe("198.51.100.7");
    });

    it("never returns a client-supplied leftmost value (spoof case)", () => {
      process.env.TRUSTED_PROXIES = "127.0.0.1,10.0.0.1";
      // attacker sent "6.6.6.6"; our proxy chain appended the real client 198.51.100.9 and itself
      const ip = gw.getClientIp(fakeReq("127.0.0.1", "6.6.6.6, 198.51.100.9, 10.0.0.1"));
      expect(ip).toBe("198.51.100.9");
      expect(ip).not.toBe("6.6.6.6");
      // default trust list: the right-most untrusted hop still wins over the spoofed leftmost
      delete process.env.TRUSTED_PROXIES;
      expect(gw.getClientIp(fakeReq("127.0.0.1", "6.6.6.6, 198.51.100.9"))).toBe("198.51.100.9");
    });

    it("ignores X-Forwarded-For entirely when the peer is not a trusted proxy", () => {
      expect(gw.getClientIp(fakeReq("203.0.113.5", "6.6.6.6, 198.51.100.9"))).toBe("203.0.113.5");
      expect(gw.getClientIp(fakeReq("::ffff:203.0.113.5", "6.6.6.6"))).toBe("203.0.113.5");
    });

    it("falls back to the peer when a hop is not a valid IP or every hop is trusted", () => {
      process.env.TRUSTED_PROXIES = "127.0.0.1,10.0.0.1";
      expect(gw.getClientIp(fakeReq("127.0.0.1", "6.6.6.6, not-an-ip"))).toBe("127.0.0.1");
      expect(gw.getClientIp(fakeReq("127.0.0.1", "garbage, 10.0.0.1"))).toBe("127.0.0.1");
      expect(gw.getClientIp(fakeReq("127.0.0.1", "10.0.0.1, 127.0.0.1"))).toBe("127.0.0.1");
      expect(gw.getClientIp(fakeReq("127.0.0.1", ""))).toBe("127.0.0.1");
    });

    it("strips ports, brackets and the IPv4-mapped prefix from candidates", () => {
      expect(gw.getClientIp(fakeReq("::1", "198.51.100.3:51234"))).toBe("198.51.100.3");
      expect(gw.getClientIp(fakeReq("::ffff:127.0.0.1", "[2001:db8::1]:443"))).toBe("2001:db8::1");
      expect(gw.getClientIp(fakeReq("127.0.0.1", "::ffff:198.51.100.4"))).toBe("198.51.100.4");
      expect(gw.getClientIp(fakeReq(undefined))).toBe("127.0.0.1");
    });
  });

  // ---------------------------------------------------------------- finding 4: input validation
  describe("terminal parameter validation", () => {
    it("clampDimension / sanitizeTerm unit behaviour", () => {
      expect(clampDimension("9999", 1, 500, 80)).toBe(500);
      expect(clampDimension("-5", 1, 200, 24)).toBe(1);
      expect(clampDimension("0", 1, 200, 24)).toBe(1);
      expect(clampDimension("abc", 1, 500, 80)).toBe(80);
      expect(clampDimension("12abc", 1, 500, 80)).toBe(80);
      expect(clampDimension(null, 1, 500, 80)).toBe(80);
      expect(clampDimension(Number.NaN, 1, 500, 80)).toBe(80);
      expect(clampDimension(120.9, 1, 500, 80)).toBe(120);
      expect(sanitizeTerm("vt100")).toBe("vt100");
      expect(sanitizeTerm("screen-256color")).toBe("screen-256color");
      expect(sanitizeTerm("evil; rm -rf /")).toBe("xterm-256color");
      expect(sanitizeTerm(undefined)).toBe("xterm-256color");
    });

    it("clamps out-of-range query cols/rows and defaults an unknown term", async () => {
      const createSpy = vi
        .spyOn(SSHAdapter, "createInteractiveSession")
        .mockImplementation(async (sessionId, server) => ({ sessionId, serverId: server.id }));
      const { port } = await startGateway();

      const c = await connect(port, q(ticketFor("op-v"), "cols=9999&rows=-5&term=evil%3Brm"));
      const connected = await c.nextFrame();
      expect(connected.type).toBe("connected");
      expect(connected.cols).toBe(500);
      expect(connected.rows).toBe(1);
      const opts = createSpy.mock.calls[0][2] as CreateSessionOptions;
      expect(opts.cols).toBe(500);
      expect(opts.rows).toBe(1);
      expect(opts.term).toBe("xterm-256color");
    });

    it("defaults non-numeric query values and accepts an allowlisted term", async () => {
      const createSpy = vi
        .spyOn(SSHAdapter, "createInteractiveSession")
        .mockImplementation(async (sessionId, server) => ({ sessionId, serverId: server.id }));
      const { port } = await startGateway();

      const c = await connect(port, q(ticketFor("op-v"), "cols=abc&rows=&term=vt100"));
      const connected = await c.nextFrame();
      expect(connected.cols).toBe(80);
      expect(connected.rows).toBe(24);
      expect((createSpy.mock.calls[0][2] as CreateSessionOptions).term).toBe("vt100");
    });

    it("applies the same clamping to auth-frame dimensions and term", async () => {
      const createSpy = vi
        .spyOn(SSHAdapter, "createInteractiveSession")
        .mockImplementation(async (sessionId, server) => ({ sessionId, serverId: server.id }));
      const { port } = await startGateway();

      const c = await connect(port);
      c.send({ type: "auth", ticket: ticketFor("op-v"), cols: 100000, rows: 0, term: "bogus" });
      const connected = await c.nextFrame();
      expect(connected.cols).toBe(500);
      expect(connected.rows).toBe(1);
      expect((createSpy.mock.calls[0][2] as CreateSessionOptions).term).toBe("xterm-256color");
    });
  });

  // ---------------------------------------------------------------- finding 1: auth state machine
  describe("per-socket auth state machine", () => {
    it("creates exactly one session for two back-to-back auth frames; the second is refused and not consumed", async () => {
      const gate = deferred();
      const seen = mockHeldConnect(gate);
      const { gw, port } = await startGateway();

      const c = await connect(port);
      const t1 = ticketFor("op-a");
      const t2 = ticketFor("op-a");
      c.send({ type: "auth", ticket: t1 });
      c.send({ type: "auth", ticket: t2 });

      const refused = await c.nextFrame();
      expect(refused.type).toBe("error");
      expect(String(refused.error)).toContain("already");
      expect(seen).toHaveLength(1);

      gate.resolve();
      const connected = await c.nextFrame();
      expect(connected.type).toBe("connected");
      expect(seen).toHaveLength(1);
      expect(gw.getActiveSessionCount()).toBe(1);
      expect(gw.getReservedSlotCount()).toBe(1);

      // a late third attempt on the active socket is refused too
      c.send({ type: "auth", ticket: ticketFor("op-a") });
      const third = await c.nextFrame();
      expect(third.type).toBe("error");
      expect(seen).toHaveLength(1);

      // the second ticket was never consumed by the refused attempt
      expect(TicketService.consumeTicket(t2, { expectedPurpose: "terminal_shell" })).not.toBeNull();
    });

    it("a query ticket plus a fast auth frame yields one session", async () => {
      const gate = deferred();
      const seen = mockHeldConnect(gate);
      const { gw, port } = await startGateway();

      const c = await connect(port, q(ticketFor("op-a")));
      c.send({ type: "auth", ticket: ticketFor("op-a") });
      const refused = await c.nextFrame();
      expect(refused.type).toBe("error");

      gate.resolve();
      expect((await c.nextFrame()).type).toBe("connected");
      expect(seen).toHaveLength(1);
      expect(gw.getActiveSessionCount()).toBe(1);
      expect(gw.getReservedSlotCount()).toBe(1);
    });

    it("tears down a session whose client disconnected while SSH was still connecting (real ssh2 server)", async () => {
      const sshServer: TestSshServerInstance = await startTestSshServer({ username: "operator", password: "pw-hard" });
      const live = new Set<unknown>();
      let everConnected = 0;
      sshServer.server.on("connection", (client: unknown) => {
        everConnected++;
        live.add(client);
        (client as { on(ev: string, cb: () => void): void }).on("close", () => live.delete(client));
      });
      const realServer: ServerHost & { password: string } = {
        ...makeServer("srv-hard-real", { host: "127.0.0.1", port: sshServer.port }),
        password: "pw-hard",
      };
      vi.spyOn(StorageService, "getServerById").mockImplementation((id: string) =>
        id === realServer.id ? realServer : undefined
      );

      const original = SSHAdapter.createInteractiveSession.bind(SSHAdapter);
      const gate = deferred();
      const started = deferred();
      let sessionId = "";
      vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(async (sid, srv, opts, creds) => {
        sessionId = sid;
        started.resolve();
        await gate.promise;
        return original(sid, srv, opts, creds);
      });
      const closeSpy = vi.spyOn(SSHAdapter, "closeSession");

      try {
        const { gw, port } = await startGateway();
        const c = await connect(port, q(ticketFor("op-d", realServer.id)));
        await started.promise;
        expect(gw.getReservedSlotCount()).toBe(1);

        c.close();
        await c.waitClose();
        gate.resolve(); // SSH now connects for real, after the browser is gone

        // gateway must close the freshly created SSH session on its own
        await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledWith(sessionId), WAIT);
        await vi.waitFor(() => expect(live.size).toBe(0), WAIT);
        expect(everConnected).toBe(1);
        expect(SSHAdapter.getSession(sessionId)).toBeUndefined();
        expect(gw.getActiveSessionCount()).toBe(0);
        expect(gw.getReservedSlotCount()).toBe(0);
        expect(
          auditEvents().some(
            (e) => e.eventType === "ssh_connect" && e.status === "failure" && e.details?.reason === "client_disconnected_during_connect"
          )
        ).toBe(true);
      } finally {
        await sshServer.close();
      }
    });

    it("releases the reserved slot when the SSH connect fails", async () => {
      vi.spyOn(SSHAdapter, "createInteractiveSession").mockRejectedValue(new Error("connect refused"));
      const { gw, port } = await startGateway({ maxSessions: 1 });

      const c = await connect(port, q(ticketFor("op-f")));
      expect((await c.nextFrame()).type).toBe("error");
      expect(await c.waitClose()).toBe(1011);
      expect(gw.getReservedSlotCount()).toBe(0);

      const failure = auditEvents().find((e) => e.eventType === "ssh_connect" && e.status === "failure");
      expect(failure?.details?.reason).toBe("ssh_connect_failed");
    });
  });

  // ---------------------------------------------------------------- finding 1: caps
  describe("session caps", () => {
    it("enforces the global cap under a concurrent burst and keeps counts exact", async () => {
      const gate = deferred();
      const seen = mockHeldConnect(gate);
      const { gw, port } = await startGateway({ maxSessions: 3, maxSessionsPerOperator: 10 });

      const burst = await Promise.all(
        Array.from({ length: 6 }, (_, i) => connect(port, q(ticketFor(`op-burst-${i}`))))
      );
      // The 3 excess connects are refused while the first 3 are still mid-SSH-connect
      await vi.waitFor(() => expect(burst.filter((c) => c.closed)).toHaveLength(3), WAIT);
      expect(gw.getReservedSlotCount()).toBe(3);
      expect(gw.getActiveSessionCount()).toBe(0);
      expect(seen).toHaveLength(3);
      for (const c of burst.filter((x) => x.closed)) {
        expect(c.closeCode).toBe(1013);
        expect(String((await c.nextFrame()).error)).toContain("Connection limit reached");
      }

      gate.resolve();
      await vi.waitFor(() => expect(gw.getActiveSessionCount()).toBe(3), WAIT);
      expect(gw.getReservedSlotCount()).toBe(3);

      // freeing one slot lets a new connect in
      const open = burst.find((c) => !c.closed) as WsClient;
      open.close();
      await vi.waitFor(() => expect(gw.getReservedSlotCount()).toBe(2), WAIT);
      const again = await connect(port, q(ticketFor("op-again")));
      expect((await again.nextFrame()).type).toBe("connected");
      expect(gw.getReservedSlotCount()).toBe(3);
    });

    it("enforces the per-operator cap while other operators are unaffected", async () => {
      const gate = deferred();
      mockHeldConnect(gate);
      const { gw, port } = await startGateway({ maxSessions: 10, maxSessionsPerOperator: 2 });

      const sameOp = await Promise.all(Array.from({ length: 4 }, () => connect(port, q(ticketFor("op-heavy")))));
      await vi.waitFor(() => expect(sameOp.filter((c) => c.closed)).toHaveLength(2), WAIT);
      for (const c of sameOp.filter((x) => x.closed)) {
        expect(c.closeCode).toBe(1013);
        expect(String((await c.nextFrame()).error)).toContain("Per-operator limit");
      }
      expect(gw.getReservedSlotCount()).toBe(2);

      const other = await connect(port, q(ticketFor("op-light")));
      expect(gw.getReservedSlotCount()).toBe(3);

      gate.resolve();
      await vi.waitFor(() => expect(gw.getActiveSessionCount()).toBe(3), WAIT);
      expect(other.closed).toBe(false);
      const denied = auditEvents().filter((e) => e.status === "denied" && e.details?.reason === "operator_session_limit");
      expect(denied).toHaveLength(2);
    });

    it("reads the per-operator default (5) and auth timeout default (5000) when env is unset", async () => {
      const origOp = process.env.TERMINAL_MAX_SESSIONS_PER_OPERATOR;
      const origTimeout = process.env.TERMINAL_AUTH_TIMEOUT_MS;
      delete process.env.TERMINAL_MAX_SESSIONS_PER_OPERATOR;
      delete process.env.TERMINAL_AUTH_TIMEOUT_MS;
      try {
        const { gw } = await startGateway();
        expect(gw.maxSessionsPerOperator).toBe(5);
        expect(gw.authTimeoutMs).toBe(5000);
        process.env.TERMINAL_MAX_SESSIONS_PER_OPERATOR = "7";
        process.env.TERMINAL_AUTH_TIMEOUT_MS = "1234";
        const { gw: gw2 } = await startGateway();
        expect(gw2.maxSessionsPerOperator).toBe(7);
        expect(gw2.authTimeoutMs).toBe(1234);
      } finally {
        if (origOp === undefined) delete process.env.TERMINAL_MAX_SESSIONS_PER_OPERATOR;
        else process.env.TERMINAL_MAX_SESSIONS_PER_OPERATOR = origOp;
        if (origTimeout === undefined) delete process.env.TERMINAL_AUTH_TIMEOUT_MS;
        else process.env.TERMINAL_AUTH_TIMEOUT_MS = origTimeout;
      }
    });
  });

  // ---------------------------------------------------------------- finding 2: pre-auth exhaustion
  describe("pre-auth resource limits", () => {
    it("closes an unauthenticated socket after the auth timeout (env) with 1008 and never answers ping", async () => {
      const orig = process.env.TERMINAL_AUTH_TIMEOUT_MS;
      process.env.TERMINAL_AUTH_TIMEOUT_MS = "250";
      let started: { gw: TerminalGateway; port: number };
      try {
        started = await startGateway();
      } finally {
        if (orig === undefined) delete process.env.TERMINAL_AUTH_TIMEOUT_MS;
        else process.env.TERMINAL_AUTH_TIMEOUT_MS = orig;
      }
      const { gw, port } = started;
      expect(gw.authTimeoutMs).toBe(250);

      const c = await connect(port);
      expect(gw.getUnauthenticatedSocketCount()).toBe(1);
      c.send({ type: "ping" });
      await new Promise((r) => setTimeout(r, 100));
      expect(c.frames.filter((f) => f.type === "pong")).toHaveLength(0);

      expect(await c.waitClose()).toBe(1008);
      expect(c.frames.some((f) => f.type === "pong")).toBe(false);
      expect(gw.getUnauthenticatedSocketCount()).toBe(0);
      expect(
        auditEvents().some((e) => e.eventType === "security_alert" && e.details?.reason === "auth_timeout")
      ).toBe(true);
    });

    it("does not time out a socket that authenticates in time, and then answers ping", async () => {
      vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(async (sessionId, server) => ({
        sessionId,
        serverId: server.id,
      }));
      const { port } = await startGateway({ authTimeoutMs: 200 });
      const c = await connect(port);
      c.send({ type: "auth", ticket: ticketFor("op-t") });
      expect((await c.nextFrame()).type).toBe("connected");

      await new Promise((r) => setTimeout(r, 450));
      expect(c.closed).toBe(false);
      c.send({ type: "ping" });
      expect((await c.nextFrame()).type).toBe("pong");
    });

    it("closes an oversized pre-auth frame with 1009 and keeps serving other clients", async () => {
      vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(async (sessionId, server) => ({
        sessionId,
        serverId: server.id,
      }));
      const { port } = await startGateway();

      const bad = await connect(port);
      bad.send("A".repeat(65537));
      expect(await bad.waitClose()).toBe(1009);

      const good = await connect(port, q(ticketFor("op-ok")));
      expect((await good.nextFrame()).type).toBe("connected");
    });

    it("caps concurrent unauthenticated sockets per client IP and releases the count on close", async () => {
      const { gw, port } = await startGateway({ maxUnauthenticatedPerIp: 2, authTimeoutMs: 60000 });
      const c1 = await connect(port);
      const c2 = await connect(port);
      expect(gw.getUnauthenticatedSocketCount()).toBe(2);

      const refused = await upgradeStatus(`ws://127.0.0.1:${port}/terminal`);
      expect(refused.status).toBe(429);
      expect(gw.getUnauthenticatedSocketCount()).toBe(2);

      c1.close();
      await c1.waitClose();
      await vi.waitFor(() => expect(gw.getUnauthenticatedSocketCount()).toBe(1), WAIT);
      const accepted = await upgradeStatus(`ws://127.0.0.1:${port}/terminal`);
      expect(accepted.status).toBe(101);
      accepted.ws?.close();
      c2.close();
    });

    it("caps concurrent unauthenticated sockets globally", async () => {
      const { gw, port } = await startGateway({ maxUnauthenticatedSockets: 3, maxUnauthenticatedPerIp: 100, authTimeoutMs: 60000 });
      await connect(port);
      await connect(port);
      await connect(port);
      expect(gw.getUnauthenticatedSocketCount()).toBe(3);
      expect((await upgradeStatus(`ws://127.0.0.1:${port}/terminal`)).status).toBe(429);
    });

    it("a ticket-authenticating socket does not occupy the unauthenticated pool", async () => {
      const gate = deferred();
      mockHeldConnect(gate);
      const { gw, port } = await startGateway({ maxUnauthenticatedPerIp: 1, authTimeoutMs: 60000 });
      await connect(port, q(ticketFor("op-pool")));
      expect(gw.getUnauthenticatedSocketCount()).toBe(0);
      gate.resolve();
    });
  });

  // ---------------------------------------------------------------- finding 4: backpressure
  describe("backpressure", () => {
    it("uses one drain timer per session regardless of chunk count, and clears it when drained", async () => {
      let onData: ((chunk: Buffer) => void) | undefined;
      vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(async (sessionId, server, options) => {
        onData = options?.onData;
        return { sessionId, serverId: server.id };
      });
      const pauseSpy = vi.spyOn(SSHAdapter, "pauseStream").mockReturnValue(true);
      const resumeSpy = vi.spyOn(SSHAdapter, "resumeStream").mockReturnValue(true);
      const { gw, port } = await startGateway({ maxBufferedAmount: 1 });

      const c = await connect(port, q(ticketFor("op-bp")));
      await c.nextFrame(); // connected

      const big = Buffer.alloc(4 * 1024 * 1024, 0x61);
      for (let i = 0; i < 5; i++) onData?.(big);

      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(gw.getDrainTimerCount()).toBe(1);

      await vi.waitFor(() => expect(resumeSpy).toHaveBeenCalledTimes(1), { timeout: 10000, interval: 20 });
      expect(gw.getDrainTimerCount()).toBe(0);
    });

    it("clears the drain timer when the client goes away mid-backpressure", async () => {
      let onData: ((chunk: Buffer) => void) | undefined;
      vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(async (sessionId, server, options) => {
        onData = options?.onData;
        return { sessionId, serverId: server.id };
      });
      vi.spyOn(SSHAdapter, "pauseStream").mockReturnValue(true);
      vi.spyOn(SSHAdapter, "resumeStream").mockReturnValue(true);
      const { gw, port } = await startGateway({ maxBufferedAmount: 1 });

      const c = await connect(port, q(ticketFor("op-bp2")));
      await c.nextFrame();
      // early chunks fill the socket buffer; a later one sees the backlog and arms the timer
      for (let i = 0; i < 5; i++) onData?.(Buffer.alloc(4 * 1024 * 1024, 0x62));
      expect(gw.getDrainTimerCount()).toBe(1);

      c.ws.terminate();
      await vi.waitFor(() => expect(gw.getDrainTimerCount()).toBe(0), WAIT);
      expect(gw.getActiveSessionCount()).toBe(0);
      expect(gw.getReservedSlotCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------- finding 5: audit
  describe("audit events", () => {
    it.each([
      ["invalid ticket", async (): Promise<{ ticket: string; headers?: Record<string, string> }> => ({ ticket: "tkt_never-issued" })],
      [
        "replayed ticket",
        async (): Promise<{ ticket: string }> => {
          const t = ticketFor("op-r");
          TicketService.consumeTicket(t);
          return { ticket: t };
        },
      ],
      ["expired ticket", async (): Promise<{ ticket: string }> => ({ ticket: ticketFor("op-r", SRV.id, { ttlSeconds: -5 }) })],
      [
        "origin mismatch",
        async (): Promise<{ ticket: string }> => ({ ticket: ticketFor("op-r", SRV.id, { origin: "https://bound.example.com" }) }),
      ],
      ["purpose mismatch", async (): Promise<{ ticket: string }> => ({ ticket: ticketFor("op-r", SRV.id, { purpose: "sftp_session" }) })],
    ])("audits a rejected ticket (%s) without leaking the ticket value", async (_label, build) => {
      const createSpy = vi.spyOn(SSHAdapter, "createInteractiveSession");
      const { port } = await startGateway();
      const { ticket } = await build();

      const c = await connect(port, q(ticket), { Origin: "http://localhost:3000" });
      expect((await c.nextFrame()).type).toBe("error");
      expect(await c.waitClose()).toBe(1008);
      expect(createSpy).not.toHaveBeenCalled();

      const events = auditEvents().filter((e) => e.eventType === "security_alert");
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe("denied");
      expect(String(events[0].details?.reason)).toMatch(/^ticket_/);
      expect(events[0].ipAddress).toBe("127.0.0.1");
      expect(JSON.stringify(events)).not.toContain(ticket);
    });

    it("audits a malformed ticket string distinctly", async () => {
      const { port } = await startGateway();
      const c = await connect(port, "?ticket=not%20a%20ticket%21");
      await c.waitClose();
      expect(auditEvents().some((e) => e.details?.reason === "ticket_malformed")).toBe(true);
    });

    it("audits an Origin 403 rejection", async () => {
      const { port } = await startGateway();
      const res = await upgradeStatus(`ws://127.0.0.1:${port}/terminal`, { Origin: "https://evil.example.com" });
      expect(res.status).toBe(403);
      const ev = auditEvents().find((e) => e.details?.reason === "origin_rejected");
      expect(ev).toBeDefined();
      expect(ev?.status).toBe("denied");
      expect(ev?.eventType).toBe("security_alert");
      expect(ev?.details?.origin).toBe("https://evil.example.com");
    });

    it("audits session open and session close (with duration and reason)", async () => {
      vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(async (sessionId, server) => ({
        sessionId,
        serverId: server.id,
      }));
      const { gw, port } = await startGateway();
      const ticket = ticketFor("op-audit");

      const c = await connect(port, q(ticket));
      const connected = await c.nextFrame();
      const open = auditEvents().find((e) => e.eventType === "ssh_connect" && e.status === "success");
      expect(open?.actor).toBe("op-audit");
      expect(open?.targetServerId).toBe(SRV.id);
      expect(open?.details?.sessionId).toBe(connected.sessionId);
      expect(JSON.stringify(auditEvents())).not.toContain(ticket);

      await new Promise((r) => setTimeout(r, 30));
      c.send({ type: "close" });
      await vi.waitFor(() => expect(gw.getActiveSessionCount()).toBe(0), WAIT);
      const close = auditEvents().find((e) => e.eventType === "ssh_disconnect");
      expect(close?.actor).toBe("op-audit");
      expect(close?.details?.sessionId).toBe(connected.sessionId);
      expect(close?.details?.reason).toBe("Client explicitly closed terminal");
      expect(typeof close?.details?.durationMs).toBe("number");
      expect(close?.details?.durationMs as number).toBeGreaterThanOrEqual(30);

      // abrupt disconnect reports its own reason
      const c2 = await connect(port, q(ticketFor("op-audit")));
      await c2.nextFrame();
      c2.ws.terminate();
      await vi.waitFor(
        () => expect(auditEvents().some((e) => e.eventType === "ssh_disconnect" && e.details?.reason === "WebSocket disconnected")).toBe(true),
        WAIT
      );
    });

    it("fails closed when the session-open audit write throws: SSH session is terminated, gateway survives", async () => {
      vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(async (sessionId, server) => ({
        sessionId,
        serverId: server.id,
      }));
      const closeSpy = vi.spyOn(SSHAdapter, "closeSession");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      auditSpy.mockImplementation((e: AuditInput): AuditEvent => {
        if (e.eventType === "ssh_connect" && e.status === "success") throw new Error("disk full");
        return { ...e, id: "audit-test", timestamp: new Date().toISOString() };
      });
      const { gw, port } = await startGateway();

      const c = await connect(port, q(ticketFor("op-fc")));
      const err = await c.nextFrame();
      expect(err.type).toBe("error");
      expect(await c.waitClose()).toBe(1011);
      expect(c.frames.some((f) => f.type === "connected")).toBe(false);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(gw.getActiveSessionCount()).toBe(0);
      expect(gw.getReservedSlotCount()).toBe(0);
      expect(errSpy).toHaveBeenCalled();

      // gateway still works once auditing recovers
      auditSpy.mockImplementation((e: AuditInput): AuditEvent => ({ ...e, id: "audit-test", timestamp: new Date().toISOString() }));
      const c2 = await connect(port, q(ticketFor("op-fc")));
      expect((await c2.nextFrame()).type).toBe("connected");
    });

    it("a failing audit write on a rejected ticket and on session close never crashes the gateway", async () => {
      vi.spyOn(SSHAdapter, "createInteractiveSession").mockImplementation(async (sessionId, server) => ({
        sessionId,
        serverId: server.id,
      }));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      auditSpy.mockImplementation((e: AuditInput): AuditEvent => {
        if (e.eventType === "security_alert" || e.eventType === "ssh_disconnect") throw new Error("audit store down");
        return { ...e, id: "audit-test", timestamp: new Date().toISOString() };
      });
      const { gw, port } = await startGateway();

      const bad = await connect(port, q("tkt_bogus"));
      expect(await bad.waitClose()).toBe(1008);

      const good = await connect(port, q(ticketFor("op-resilient")));
      expect((await good.nextFrame()).type).toBe("connected");
      good.send({ type: "close" });
      await vi.waitFor(() => expect(gw.getActiveSessionCount()).toBe(0), WAIT);
      expect(gw.getReservedSlotCount()).toBe(0);
      expect(errSpy).toHaveBeenCalled();

      // still accepting connections afterwards
      const again = await connect(port, q(ticketFor("op-resilient")));
      expect((await again.nextFrame()).type).toBe("connected");
    });
  });
  // ---------------------------------------------------------------- credential vault (Milestone 7.2)
  describe("undecryptable server credentials", () => {
    it("refuses that one connection cleanly (generic client error, audited, gateway keeps serving)", async () => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const createSpy = vi
        .spyOn(SSHAdapter, "createInteractiveSession")
        .mockImplementation(async (sessionId, server) => ({ sessionId, serverId: server.id }));
      vi.spyOn(StorageService, "getServerById").mockImplementation((id: string) => {
        if (id === "srv-broken") {
          throw new VaultError("Credential decryption failed - PRAXELOPS_SECRET differs from the one used to encrypt, or data was tampered");
        }
        return id === SRV.id ? SRV : undefined;
      });
      const { port } = await startGateway();

      const bad = await connect(port, q(ticketFor("op-v", "srv-broken")));
      const frame = await bad.nextFrame();
      expect(frame.type).toBe("error");
      expect(String(frame.error)).toMatch(/could not be decrypted/);
      expect(String(frame.error)).not.toMatch(/PRAXELOPS_SECRET/);
      await vi.waitFor(() => expect(bad.closed).toBe(true), WAIT);
      expect(createSpy).not.toHaveBeenCalled();
      expect(auditEvents()).toContainEqual(
        expect.objectContaining({
          eventType: "ssh_connect",
          status: "failure",
          targetServerId: "srv-broken",
          details: expect.objectContaining({ reason: "credential_decryption_failed" }),
        })
      );
      expect(errorLog).toHaveBeenCalled();

      // The gateway process survives and still serves other servers.
      const good = await connect(port, q(ticketFor("op-v")));
      expect((await good.nextFrame()).type).toBe("connected");
    });
  });
});

