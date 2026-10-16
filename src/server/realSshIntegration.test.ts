import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import { startTestSshServer, TestSshServerInstance } from "@/lib/ssh/testSshServer";
import { SSHAdapter } from "@/lib/ssh/adapter";
import { KnownHostsService } from "@/lib/ssh/knownHosts";
import { ServerHost } from "@/types/server";
import { TerminalGateway } from "./terminalGateway";
import { StorageService } from "@/lib/storage";
import { TicketService } from "@/lib/security/ticket";

class IntegrationTestClient {
  public ws: WebSocket;
  public messages: any[] = [];
  private messageListeners: Array<(msg: any) => void> = [];

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

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

describe("Real SSH Wire Protocol Integration", () => {
  let sshServer: TestSshServerInstance;
  let testServerConfig: ServerHost;
  let gateway: TerminalGateway;
  let gatewayPort: number;

  beforeAll(async () => {
    // Start authentic TCP SSH server on localhost
    sshServer = await startTestSshServer({
      username: "operator",
      password: "correctpassword",
    });

    testServerConfig = {
      id: "srv-real-wire-01",
      name: "Real Wire Test Node",
      host: "127.0.0.1",
      port: sshServer.port,
      username: "operator",
      authType: "password",
      tags: ["real-test"],
      status: "online",
      osType: "linux",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (testServerConfig as any).password = "correctpassword";

    // Register in storage service for gateway lookups
    StorageService.saveServer(testServerConfig);

    // Start TerminalGateway on ephemeral port
    gateway = new TerminalGateway({ port: 0 });
    gatewayPort = await gateway.listen();
  });

  afterAll(async () => {
    await gateway.close();
    await sshServer.close();
  });

  it("authenticates and executes commands over genuine TCP SSH connection", async () => {
    const result = await SSHAdapter.executeCommand(
      testServerConfig,
      "uname -a",
      10000,
      { password: "correctpassword" }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Linux praxelops-test-node");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("rejects connection when credentials are invalid", async () => {
    await expect(
      SSHAdapter.executeCommand(
        testServerConfig,
        "uname -a",
        5000,
        { password: "wrongpassword" }
      )
    ).rejects.toThrow(/authentication|failed/i);
  });

  it("enforces TOFU host-key verification and records fingerprint", () => {
    const knownHosts = KnownHostsService.getKnownHosts();
    const entry = knownHosts[`127.0.0.1:${sshServer.port}`];

    expect(entry).toBeDefined();
    expect(entry.host).toBe("127.0.0.1");
    expect(entry.port).toBe(sshServer.port);
    expect(entry.fingerprint).toMatch(/^SHA256:/);
  });

  it("rejects connection when host key is altered (MITM attack prevention)", async () => {
    try {
      // Tamper with the known_hosts fingerprint for this port
      KnownHostsService.removeHostKey("127.0.0.1", sshServer.port);

      // Save a bogus fingerprint
      const fakeKeyBuffer = Buffer.from("fraudulent-server-key-material");
      KnownHostsService.verifyHostKey("127.0.0.1", sshServer.port, fakeKeyBuffer);

      // Attempting to connect now must fail with host key mismatch
      await expect(
        SSHAdapter.executeCommand(
          testServerConfig,
          "uname -a",
          5000,
          { password: "correctpassword" }
        )
      ).rejects.toThrow(/Host key mismatch/);
    } finally {
      // Clean up bogus key so TOFU re-enrolls authentic key
      KnownHostsService.removeHostKey("127.0.0.1", sshServer.port);
    }
  });

  it("spawns real interactive PTY shell and streams bidirectional data", async () => {
    const sessionId = `pty-wire-${Date.now()}`;
    const receivedChunks: string[] = [];

    const sessionPromise = new Promise<void>((resolve) => {
      SSHAdapter.createInteractiveSession(
        sessionId,
        testServerConfig,
        {
          rows: 24,
          cols: 80,
          term: "xterm-256color",
          onData: (chunk: Buffer) => {
            const text = chunk.toString("utf-8");
            receivedChunks.push(text);
            if (receivedChunks.join("").includes("PraxelOps Controlled Test Shell")) {
              resolve();
            }
          },
        },
        { password: "correctpassword" }
      );
    });

    await sessionPromise;
    expect(receivedChunks.join("")).toContain("PraxelOps Controlled Test Shell");

    // Test resize
    const resized = SSHAdapter.resizeSession(sessionId, 40, 120);
    expect(resized).toBe(true);

    // Test sending input
    const inputSent = SSHAdapter.sendInput(sessionId, "echo hello\r");
    expect(inputSent).toBe(true);

    // Clean up
    SSHAdapter.closeSession(sessionId);
    expect(SSHAdapter.getSession(sessionId)).toBeUndefined();
  });

  it("reads remote directories and files over real SFTP subsystem", async () => {
    // List directory
    const dirResult = await SSHAdapter.listSFTPDirectory(
      testServerConfig,
      "/etc",
      { password: "correctpassword" }
    );

    expect(dirResult.files.length).toBeGreaterThan(0);
    const appConf = dirResult.files.find((f) => f.name === "app.conf");
    expect(appConf).toBeDefined();
    expect(appConf?.isDirectory).toBe(false);

    // Read file
    const fileContent = await SSHAdapter.readSFTPFile(
      testServerConfig,
      "/etc/app.conf",
      1024,
      { password: "correctpassword" }
    );

    expect(fileContent).toContain("# PraxelOps Configuration File");
    expect(fileContent).toContain("PORT=8080");
  });

  it("bridges WebSocket client to real SSH daemon using secure single-use ticket", async () => {
    // 1. Issue secure ticket
    const ticketObj = TicketService.issueTicket("operator-wire", testServerConfig.id, 60);

    // 2. Connect WebSocket to Gateway using the ticket
    const client = new IntegrationTestClient(
      `ws://127.0.0.1:${gatewayPort}/terminal?ticket=${encodeURIComponent(ticketObj.ticket)}&cols=90&rows=30`
    );

    await client.waitForOpen();

    // 3. Receive frames from server (connected and initial output)
    const msg1 = await client.nextMessage();
    const msg2 = await client.nextMessage();
    const allMsgs = [msg1, msg2];

    const connMsg = allMsgs.find((m) => m.type === "connected");
    expect(connMsg).toBeDefined();
    expect(connMsg.serverId).toBe(testServerConfig.id);
    expect(connMsg.cols).toBe(90);
    expect(connMsg.rows).toBe(30);

    // 4. Verify shell output from real SSH daemon
    const outMsg = allMsgs.find((m) => m.type === "output");
    expect(outMsg).toBeDefined();
    expect(outMsg.data).toContain("PraxelOps Controlled Test Shell");

    // 5. Verify ticket cannot be reused (single-use enforcement)
    const reusedTicket = TicketService.consumeTicket(ticketObj.ticket);
    expect(reusedTicket).toBeNull();

    client.close();
  });
});
