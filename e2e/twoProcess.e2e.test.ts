/**
 * Two-OS-process end-to-end test of the production topology (Milestone 6.7).
 *
 *   web app          : `next start`                          (separate OS process, port A)
 *   terminal gateway : `tsx src/server/terminalGateway.ts`   (separate OS process, port B)
 *   SSH server       : real ssh2 protocol server (src/lib/ssh/testSshServer.ts), in the test process
 *
 * Both child processes run with NODE_ENV=production and share ONE PRAXELOPS_DATA_DIR. Nothing is mocked:
 * the test only talks to the processes over HTTP / WebSocket and inspects the shared data dir.
 *
 * Run with `npm run test:e2e` (never picked up by the default `npm test`).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
import { WebSocket, type RawData } from "ws";
import { utils } from "ssh2";
import { z } from "zod";
import { generateTestRsaKey, startTestSshServer, type TestSshServerInstance } from "../src/lib/ssh/testSshServer";

// ---------------------------------------------------------------------------------------------
// Constants / paths
// ---------------------------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..");
const NEXT_BIN = path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const GATEWAY_ENTRY = path.join("src", "server", "terminalGateway.ts");
const SESSION_COOKIE = "praxel_session";
const SSH_USER = "testuser";

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
    await sleep(25);
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Resolves true while something accepts TCP connections on the port. */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function expectPortFree(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await isPortListening(port)) {
    if (Date.now() > deadline) throw new Error(`Port ${port} is still listening after ${timeoutMs}ms`);
    await sleep(100);
  }
}

function sshFingerprint(hostKeyPem: string): string {
  const parsed = utils.parseKey(hostKeyPem);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) throw new Error("Unable to parse SSH host key");
  // Same derivation as KnownHostsService.computeFingerprint over the public key blob.
  return "SHA256:" + crypto.createHash("sha256").update(key.getPublicSSH()).digest("base64");
}

function readJsonFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "PRAXELOPS_DATA_DIR",
    "PRAXELOPS_SECRET",
    "PRAXELOPS_OPERATOR_PASSWORD",
    "ALLOWED_ORIGINS",
    "ALLOWED_HOSTS",
    "NEXT_PUBLIC_APP_URL",
    "TRUSTED_PROXIES",
    "PORT",
    "TERMINAL_GATEWAY_PORT",
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

// ---------------------------------------------------------------------------------------------
// Process management (no shell, real PID, tree kill)
// ---------------------------------------------------------------------------------------------

function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // children are spawned detached => own process group
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

const MAX_LOG_CHARS = 200_000;

class ManagedProcess {
  private child: ChildProcess | null = null;
  private log = "";
  private exited = false;
  private exitDescription = "";

  constructor(
    readonly name: string,
    private readonly args: readonly string[],
    private readonly env: NodeJS.ProcessEnv
  ) {}

  start(): void {
    this.log += `\n--- ${this.name}: starting ---\n`;
    this.exited = false;
    this.exitDescription = "";
    const child = spawn(process.execPath, [...this.args], {
      cwd: REPO_ROOT,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.child = child;
    const append = (chunk: Buffer): void => {
      this.log += chunk.toString("utf-8");
      if (this.log.length > MAX_LOG_CHARS) this.log = this.log.slice(-MAX_LOG_CHARS);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("exit", (code, signal) => {
      this.exited = true;
      this.exitDescription = `exit code=${code} signal=${signal}`;
      this.log += `\n--- ${this.name}: ${this.exitDescription} ---\n`;
    });
    child.once("error", (err) => {
      this.exited = true;
      this.exitDescription = `spawn error: ${err.message}`;
      this.log += `\n--- ${this.name}: ${this.exitDescription} ---\n`;
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get description(): string {
    return this.exitDescription;
  }

  logs(): string {
    return this.log;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.pid === undefined) return;
    if (!this.exited) {
      killTree(child.pid);
      try {
        await waitUntil(() => this.exited, 15_000, `${this.name} to exit`);
      } catch {
        // fall through; the port checks in callers will surface a real leak
      }
    }
    // Make sure no grandchild survives (tsx spawns a worker node process).
    killTree(child.pid);
    this.child = null;
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP helper (node:http, so the Host / Origin / Cookie headers are fully under test control)
// ---------------------------------------------------------------------------------------------

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function httpRequest(opts: {
  port: number;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { host: "127.0.0.1", port: opts.port, method: opts.method ?? "GET", path: opts.path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf-8") })
        );
        res.on("error", reject);
      }
    );
    req.setTimeout(30_000, () => req.destroy(new Error(`HTTP request timeout: ${opts.method ?? "GET"} ${opts.path}`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const LoginResponse = z.object({ success: z.literal(true), operatorId: z.string(), csrfToken: z.string().min(1) });
const TicketResponse = z.object({ success: z.literal(true), ticket: z.string().min(16), serverId: z.string() });
const ServerCreateResponse = z.object({
  success: z.literal(true),
  data: z.object({ id: z.string() }).passthrough(),
});
const ServersListResponse = z.object({ success: z.literal(true), data: z.array(z.object({ id: z.string() }).passthrough()) });

// ---------------------------------------------------------------------------------------------
// WebSocket client wrapper
// ---------------------------------------------------------------------------------------------

type Frame = Record<string, unknown>;

class WsClient {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  upgradeStatus: number | null = null;
  closeInfo: { code: number; reason: string } | null = null;
  errorMessage: string | null = null;
  opened = false;
  private done = false;

  constructor(url: string, origin: string | undefined) {
    this.ws = new WebSocket(url, origin === undefined ? undefined : { origin });
    this.ws.on("open", () => {
      this.opened = true;
    });
    this.ws.on("message", (raw: RawData) => {
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString("utf-8")
        : Buffer.isBuffer(raw)
          ? raw.toString("utf-8")
          : Buffer.from(raw).toString("utf-8");
      const parsed: unknown = parseJson(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.frames.push(parsed as Frame);
      }
    });
    this.ws.on("unexpected-response", (req, res) => {
      this.upgradeStatus = res.statusCode ?? 0;
      res.destroy();
      req.destroy();
      this.done = true;
    });
    this.ws.on("close", (code, reason) => {
      this.closeInfo = { code, reason: reason.toString("utf-8") };
      this.done = true;
    });
    // Errors are surfaced through close / unexpected-response state; never leave them unhandled.
    this.ws.on("error", (err: Error) => {
      this.errorMessage = err.message;
      this.done = true;
    });
  }

  output(): string {
    return this.frames
      .filter((f) => f.type === "output" && typeof f.data === "string")
      .map((f) => f.data as string)
      .join("");
  }

  errors(): string[] {
    return this.frames.filter((f) => f.type === "error" && typeof f.error === "string").map((f) => f.error as string);
  }

  hasFrame(type: string): boolean {
    return this.frames.some((f) => f.type === type);
  }

  async waitForFrame(type: string, timeoutMs = 20_000): Promise<void> {
    await waitUntil(() => this.hasFrame(type) || this.done, timeoutMs, `'${type}' frame`);
    if (!this.hasFrame(type)) {
      throw new Error(
        `Socket ended before '${type}' frame. close=${JSON.stringify(this.closeInfo)} upgrade=${this.upgradeStatus} frames=${JSON.stringify(this.frames)}`
      );
    }
  }

  async waitForOutput(needle: string, timeoutMs = 20_000): Promise<void> {
    await waitUntil(() => this.output().includes(needle), timeoutMs, `terminal output containing '${needle}'`).catch(
      (err: unknown) => {
        throw new Error(`${err instanceof Error ? err.message : String(err)}; output so far: ${JSON.stringify(this.output())}`);
      }
    );
  }

  /** Waits until the socket is closed or rejected during upgrade. */
  async waitDone(timeoutMs = 20_000): Promise<void> {
    await waitUntil(() => this.done, timeoutMs, "socket to close / be rejected");
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  async closeGracefully(): Promise<void> {
    if (!this.done) {
      try {
        this.send({ type: "close" });
      } catch {
        // socket already closing
      }
      try {
        await this.waitDone(5_000);
      } catch {
        this.ws.terminate();
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------------------------

const operatorUsername = "e2eoperator";
const operatorPassword = crypto.randomBytes(18).toString("base64url"); // 24 chars, >= 12 required
const sshPassword = `ssh-${crypto.randomBytes(12).toString("hex")}`;
const masterSecret = crypto.randomBytes(48).toString("hex");

let dataDir = "";
let webPort = 0;
let gatewayPort = 0;
let origin = "";
let sshPort = 0;
let ssh: TestSshServerInstance | null = null;
let originalHostKeyPem = "";
let web: ManagedProcess;
let gateway: ManagedProcess;

let cookie = "";
let csrf = "";
let serverId = "";
let pinnedFingerprint = "";
const issuedTickets: string[] = [];
const activeClients: WsClient[] = [];

function sharedEnv(): Record<string, string> {
  return {
    NODE_ENV: "production",
    PRAXELOPS_DATA_DIR: dataDir,
    PRAXELOPS_SECRET: masterSecret,
    ALLOWED_ORIGINS: origin,
    PORT: String(webPort),
    TERMINAL_GATEWAY_PORT: String(gatewayPort),
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

function makeWeb(): ManagedProcess {
  return new ManagedProcess("web(next start)", [NEXT_BIN, "start", "-p", String(webPort), "-H", "127.0.0.1"], childEnv(sharedEnv()));
}

function makeGateway(): ManagedProcess {
  return new ManagedProcess("gateway(tsx)", [TSX_CLI, GATEWAY_ENTRY], childEnv(sharedEnv()));
}

function dumpLogs(): void {
  const parts = [web, gateway]
    .filter((p): p is ManagedProcess => p !== undefined)
    .map((p) => `===== ${p.name} (pid ${p.pid ?? "n/a"}) =====\n${p.logs()}`);
  process.stderr.write(`\n[e2e] child process output follows\n${parts.join("\n")}\n`);
}

async function waitWebReady(): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (web.hasExited) throw new Error(`web process exited during startup (${web.description})\n${web.logs()}`);
    try {
      const res = await httpRequest({ port: webPort, path: "/api/auth/session" });
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`web did not become ready\n${web.logs()}`);
    await sleep(250);
  }
}

async function waitGatewayReady(): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (gateway.hasExited) throw new Error(`gateway exited during startup (${gateway.description})\n${gateway.logs()}`);
    try {
      const res = await httpRequest({ port: gatewayPort, path: "/" });
      if (res.status === 200 && res.text.includes("healthy")) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`gateway did not become ready\n${gateway.logs()}`);
    await sleep(250);
  }
}

function authHeaders(): Record<string, string> {
  return { Cookie: `${SESSION_COOKIE}=${cookie}`, "x-csrf-token": csrf, Origin: origin };
}

async function login(password: string): Promise<HttpResult> {
  return httpRequest({
    port: webPort,
    method: "POST",
    path: "/api/auth/login",
    headers: { Origin: origin },
    body: { username: operatorUsername, password },
  });
}

/** Logs in with the right password and stores the cookie / csrf token. */
async function loginAndStoreSession(): Promise<void> {
  const res = await login(operatorPassword);
  expect(res.status).toBe(200);
  const body = LoginResponse.parse(parseJson(res.text));
  const setCookie = res.headers["set-cookie"];
  const header = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ?? "");
  const match = new RegExp(`${SESSION_COOKIE}=([0-9a-f]+)`).exec(header);
  if (!match) throw new Error(`No ${SESSION_COOKIE} cookie in login response: ${header}`);
  expect(header).toContain("HttpOnly");
  expect(header).toContain("Secure"); // NODE_ENV=production => Secure; we send the cookie manually over http
  cookie = match[1];
  csrf = body.csrfToken;
}

async function issueTicket(): Promise<string> {
  const res = await httpRequest({
    port: webPort,
    method: "POST",
    path: "/api/ssh/ticket",
    headers: authHeaders(),
    body: { serverId },
  });
  expect(res.status).toBe(200);
  const body = TicketResponse.parse(parseJson(res.text));
  issuedTickets.push(body.ticket);
  return body.ticket;
}

function terminalUrl(ticket: string): string {
  return `ws://127.0.0.1:${gatewayPort}/terminal?ticket=${encodeURIComponent(ticket)}&cols=100&rows=30`;
}

/** wsOrigin: null sends no Origin header at all. */
function connectTerminal(ticket: string, wsOrigin: string | null = origin): WsClient {
  const client = new WsClient(terminalUrl(ticket), wsOrigin ?? undefined);
  activeClients.push(client);
  return client;
}

async function echoRoundTrip(client: WsClient): Promise<void> {
  await client.waitForFrame("connected");
  await client.waitForOutput("PraxelOps Controlled Test Shell");
  const token = `praxel-e2e-${crypto.randomBytes(8).toString("hex")}`;
  expect(client.output()).not.toContain(token);
  client.send({ type: "input", data: `echo ${token}\n` });
  await client.waitForOutput(token);
}

interface AuditRecord {
  eventType: string;
  status: string;
  details?: Record<string, unknown>;
}

function readAudit(): AuditRecord[] {
  const raw = readJsonFile(path.join(dataDir, "audit.json"));
  return z
    .array(
      z.object({
        eventType: z.string(),
        status: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .parse(raw);
}

function assertAuditHasNoSecrets(): void {
  const rawAudit = fs.readFileSync(path.join(dataDir, "audit.json"), "utf-8");
  expect(rawAudit).not.toContain(sshPassword);
  expect(rawAudit).not.toContain(operatorPassword);
  for (const ticket of issuedTickets) {
    expect(rawAudit).not.toContain(ticket);
  }
}

function readPins(): Record<string, { fingerprint: string }> {
  return z
    .record(z.string(), z.object({ fingerprint: z.string() }).passthrough())
    .parse(readJsonFile(path.join(dataDir, "known_hosts.json")));
}

// ---------------------------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------------------------

describe("production topology: next start + terminal gateway as separate OS processes", () => {
  beforeAll(async () => {
    // 1. Production build (only when missing).
    if (!fs.existsSync(path.join(REPO_ROOT, ".next", "BUILD_ID")) || process.env.E2E_REBUILD === "1") {
      const build = spawnSync(process.execPath, [NEXT_BIN, "build"], {
        cwd: REPO_ROOT,
        env: childEnv({ NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" }),
        encoding: "utf-8",
        timeout: 600_000,
        windowsHide: true,
      });
      if (build.status !== 0) {
        throw new Error(`next build failed (status ${build.status})\n${build.stdout}\n${build.stderr}`);
      }
    }

    // 2. Temp data dir, ports, origin.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "praxelops-e2e-"));
    webPort = await getFreePort();
    gatewayPort = await getFreePort();
    origin = `http://127.0.0.1:${webPort}`;

    // 3. Real SSH protocol server (in this process).
    originalHostKeyPem = generateTestRsaKey();
    ssh = await startTestSshServer({ username: SSH_USER, password: sshPassword, hostKeyPem: originalHostKeyPem });
    sshPort = ssh.port;

    // 4. Operator via the real bootstrap CLI, as its own process.
    const created = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", path.join("scripts", "create-operator.ts"), operatorUsername],
      {
        cwd: REPO_ROOT,
        env: childEnv({ PRAXELOPS_DATA_DIR: dataDir, PRAXELOPS_OPERATOR_PASSWORD: operatorPassword }),
        encoding: "utf-8",
        timeout: 60_000,
        windowsHide: true,
      }
    );
    if (created.status !== 0) {
      throw new Error(`create-operator failed (status ${created.status})\n${created.stdout}\n${created.stderr}`);
    }

    // 5. Both long-lived processes.
    web = makeWeb();
    gateway = makeGateway();
    web.start();
    gateway.start();
    try {
      await Promise.all([waitWebReady(), waitGatewayReady()]);
    } catch (err) {
      dumpLogs();
      throw err;
    }
  });

  afterAll(async () => {
    for (const client of activeClients) {
      try {
        client.ws.terminate();
      } catch {
        // ignore
      }
    }
    const failures: string[] = [];
    for (const proc of [web, gateway]) {
      try {
        await proc?.stop();
      } catch (err) {
        failures.push(`${proc?.name}: ${String(err)}`);
      }
    }
    for (const port of [webPort, gatewayPort]) {
      if (port === 0) continue;
      try {
        await expectPortFree(port);
      } catch (err) {
        failures.push(String(err));
      }
    }
    if (ssh) {
      await Promise.race([ssh.close(), sleep(5_000)]);
    }
    if (dataDir) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch (err) {
        failures.push(`temp dir cleanup: ${String(err)}`);
      }
    }
    if (failures.length > 0) throw new Error(`E2E teardown problems:\n${failures.join("\n")}`);
  }, 120_000);

  it("a. production security preconditions hold on the real web process", async () => {
    onTestFailed(dumpLogs);

    const anon = await httpRequest({ port: webPort, path: "/api/servers" });
    expect(anon.status).toBe(401);

    const badHost = await httpRequest({
      port: webPort,
      path: "/api/auth/session",
      headers: { Host: "localhost.evil.example" },
    });
    expect(badHost.status).toBe(421);

    const wrong = await login("definitely-not-the-password");
    expect(wrong.status).toBe(401);
    expect(wrong.headers["set-cookie"]).toBeUndefined();

    await loginAndStoreSession();

    const servers = await httpRequest({ port: webPort, path: "/api/servers", headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(servers.status).toBe(200);

    // A cookie-authenticated mutation without the CSRF token must be refused.
    const noCsrf = await httpRequest({
      port: webPort,
      method: "POST",
      path: "/api/ssh/ticket",
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}`, Origin: origin },
      body: { serverId: "whatever" },
    });
    expect(noCsrf.status).toBe(403);
  });

  it("b. add server, open a real SSH shell through the gateway, TOFU-pin the host key, keep secrets out of the audit log", async () => {
    onTestFailed(dumpLogs);

    const added = await httpRequest({
      port: webPort,
      method: "POST",
      path: "/api/servers",
      headers: authHeaders(),
      body: {
        name: "e2e-ssh",
        host: "127.0.0.1",
        port: sshPort,
        username: SSH_USER,
        authType: "password",
        password: sshPassword,
      },
    });
    expect(added.status).toBe(201);
    expect(added.text).not.toContain(sshPassword);
    const created = ServerCreateResponse.parse(parseJson(added.text));
    expect(created.data).not.toHaveProperty("password");
    expect(created.data).toMatchObject({ hasPassword: true });
    serverId = created.data.id;

    const listed = await httpRequest({ port: webPort, path: "/api/servers", headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(listed.text).not.toContain(sshPassword);
    expect(ServersListResponse.parse(parseJson(listed.text)).data.map((s) => s.id)).toContain(serverId);

    const ticket = await issueTicket();
    const client = connectTerminal(ticket);
    await echoRoundTrip(client);
    expect(client.errors()).toEqual([]);

    // The session is live: the gateway's audit entry exists while it is open.
    const duringSession = readAudit();
    expect(
      duringSession.some(
        (e) => e.eventType === "ssh_connect" && e.status === "success" && e.details?.transport === "websocket_gateway" && typeof e.details?.sessionId === "string"
      )
    ).toBe(true);

    await client.closeGracefully();

    // Host key pinned (TOFU) in the shared data dir.
    const pins = readPins();
    const pin = pins[`127.0.0.1:${sshPort}`];
    expect(pin).toBeDefined();
    pinnedFingerprint = pin.fingerprint;
    expect(pinnedFingerprint).toBe(sshFingerprint(originalHostKeyPem));

    const audit = readAudit();
    expect(
      audit.some((e) => e.eventType === "security_alert" && e.status === "success" && e.details?.alertType === "tofu_host_key_enrolled" && e.details?.fingerprint === pinnedFingerprint)
    ).toBe(true);
    expect(audit.some((e) => e.eventType === "server_created")).toBe(true);
    assertAuditHasNoSecrets();
  });

  it("c. a consumed ticket cannot be replayed (1008, no output)", async () => {
    onTestFailed(dumpLogs);

    const spent = issuedTickets[issuedTickets.length - 1];
    const replay = connectTerminal(spent);
    await replay.waitDone();
    expect(replay.closeInfo?.code).toBe(1008);
    expect(replay.hasFrame("connected")).toBe(false);
    expect(replay.output()).toBe("");
    expect(replay.errors().join(" ")).toMatch(/ticket/i);
  });

  it("d. WebSocket upgrade with a foreign (or missing) Origin is rejected with 403", async () => {
    onTestFailed(dumpLogs);

    const evil = connectTerminal("0".repeat(64), "http://evil.example");
    await evil.waitDone();
    expect(evil.upgradeStatus, `upgrade status (error=${evil.errorMessage}, close=${JSON.stringify(evil.closeInfo)})`).toBe(403);
    expect(evil.opened).toBe(false);

    const noOrigin = connectTerminal("0".repeat(64), null);
    await noOrigin.waitDone();
    expect(noOrigin.upgradeStatus, `upgrade status (error=${noOrigin.errorMessage}, close=${JSON.stringify(noOrigin.closeInfo)})`).toBe(403);
    expect(noOrigin.opened).toBe(false);

    const audit = readAudit();
    expect(audit.some((e) => e.eventType === "security_alert" && e.details?.reason === "origin_rejected")).toBe(true);
  });

  it("e. killing and restarting the gateway process: tickets (shared on disk) still work", async () => {
    onTestFailed(dumpLogs);

    const oldPid = gateway.pid;
    await gateway.stop();
    await expectPortFree(gatewayPort);

    gateway = makeGateway();
    gateway.start();
    expect(gateway.pid).not.toBe(oldPid);
    await waitGatewayReady();

    // Ticket issued by the (still running) web process, consumed by the brand-new gateway process.
    const ticket = await issueTicket();
    const client = connectTerminal(ticket);
    await echoRoundTrip(client);
    await client.closeGracefully();

    // The restarted gateway verifies the existing pin without re-enrolling.
    expect(readPins()[`127.0.0.1:${sshPort}`].fingerprint).toBe(pinnedFingerprint);
  });

  it("f. restarting the web process drops in-memory sessions; a new login's ticket is accepted by the running gateway", async () => {
    onTestFailed(dumpLogs);

    const oldCookie = cookie;
    await web.stop();
    await expectPortFree(webPort);

    web = makeWeb();
    web.start();
    await waitWebReady();

    const stale = await httpRequest({ port: webPort, path: "/api/servers", headers: { Cookie: `${SESSION_COOKIE}=${oldCookie}` } });
    expect(stale.status).toBe(401);

    await loginAndStoreSession();
    expect(cookie).not.toBe(oldCookie);

    // Persistent state (servers.json) survived the restart.
    const listed = await httpRequest({ port: webPort, path: "/api/servers", headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(listed.status).toBe(200);
    expect(ServersListResponse.parse(parseJson(listed.text)).data.map((s) => s.id)).toContain(serverId);

    const ticket = await issueTicket();
    const client = connectTerminal(ticket);
    await echoRoundTrip(client);
    await client.closeGracefully();
  });

  it("g. a changed SSH host key is refused: mismatch error, audit entry, pin unchanged", async () => {
    onTestFailed(dumpLogs);

    // Replace the SSH server with one on the SAME port but a DIFFERENT host key.
    const oldInstance = ssh;
    if (!oldInstance) throw new Error("ssh server not running");
    await Promise.race([oldInstance.close(), sleep(5_000)]);
    await expectPortFree(sshPort);
    const impostorKeyPem = generateTestRsaKey();
    expect(sshFingerprint(impostorKeyPem)).not.toBe(pinnedFingerprint);
    ssh = await startTestSshServer({ username: SSH_USER, password: sshPassword, hostKeyPem: impostorKeyPem, port: sshPort });
    expect(ssh.port).toBe(sshPort);

    const ticket = await issueTicket();
    const client = connectTerminal(ticket);
    await client.waitDone(30_000);
    expect(client.hasFrame("connected")).toBe(false);
    expect(client.output()).toBe("");
    expect(client.errors().join(" ")).toMatch(/host key mismatch/i);
    expect(client.closeInfo?.code).toBe(1011);

    const audit = readAudit();
    const mismatch = audit.find((e) => e.eventType === "security_alert" && e.details?.alertType === "host_key_mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.status).toBe("denied");
    expect(mismatch?.details?.expectedFingerprint).toBe(pinnedFingerprint);
    expect(mismatch?.details?.receivedFingerprint).toBe(sshFingerprint(impostorKeyPem));
    expect(
      audit.some((e) => e.eventType === "ssh_connect" && e.status === "failure" && e.details?.reason === "ssh_connect_failed")
    ).toBe(true);

    // The pin is untouched.
    expect(readPins()[`127.0.0.1:${sshPort}`].fingerprint).toBe(pinnedFingerprint);
    assertAuditHasNoSecrets();
  });
});
