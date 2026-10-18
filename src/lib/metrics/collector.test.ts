import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SSHAdapter, SshExecError } from "@/lib/ssh/adapter";
import { KnownHostsService } from "@/lib/ssh/knownHosts";
import { generateTestRsaKey, startTestSshServer, type TestSshServerInstance } from "@/lib/ssh/testSshServer";
import { getDb, prepare } from "@/lib/db/database";
import { StorageService } from "@/lib/storage";
import type { ServerHost } from "@/types/server";
import { collectAndStore, collectAndStoreShared, sampleServer, ServerNotFoundError, HOST_KEY_NOT_PINNED_MESSAGE } from "./collector";
import { UBUNTU_2204_OUTPUT } from "./fixtures";
import { PROBE_COMMAND } from "./probe";
import { countSamples, getHealth, getLatestOkSample } from "./store";

const USER = "collector";
const PASS = "collector-pass-9981";

const servers: TestSshServerInstance[] = [];
const serverIds: string[] = [];

async function startSsh(options: Parameters<typeof startTestSshServer>[0] = {}): Promise<TestSshServerInstance> {
  const instance = await startTestSshServer({ username: USER, password: PASS, ...options });
  servers.push(instance);
  return instance;
}

function register(ssh: TestSshServerInstance, patch: Partial<ServerHost> & { password?: string | null } = {}): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const { password, ...rest } = patch;
  const record: ServerHost = {
    id,
    name: `collector-${id.slice(0, 6)}`,
    host: "127.0.0.1",
    port: ssh.port,
    username: USER,
    authType: "password",
    tags: [],
    status: "checking",
    osType: "linux",
    createdAt: now,
    updatedAt: now,
    ...rest,
  };
  if (password !== null) (record as unknown as Record<string, unknown>).password = password ?? PASS;
  StorageService.saveServer(record);
  serverIds.push(id);
  return id;
}

/** Pins the host key the way an interactive shell session does (trust on first use through the normal adapter path). */
async function pinViaTofu(id: string): Promise<void> {
  const server = StorageService.getServerById(id);
  if (!server) throw new Error("no such server");
  const result = await SSHAdapter.executeCommand(server, "uname -a", 10_000);
  expect(result.code).toBe(0);
  expect(KnownHostsService.getPin(server.host, server.port)).toBeDefined();
}

function pinCount(): number {
  return Number(prepare(getDb(), "SELECT COUNT(*) AS n FROM known_hosts").get()?.n ?? 0);
}

function healthEvents(serverId: string): Array<{ eventType: string; status: string; details?: Record<string, unknown> }> {
  return StorageService.getAuditEvents({ serverId })
    .filter((e) => e.eventType === "server_health_changed" || e.eventType === "security_alert")
    .reverse();
}

beforeAll(() => {
  getDb();
});

afterEach(() => {
  for (const s of servers) {
    s.probe.output = undefined;
    s.probe.nonLinuxOs = undefined;
    s.probe.delayMs = undefined;
    s.probe.exitCode = undefined;
  }
});

afterAll(async () => {
  for (const id of serverIds) StorageService.deleteServer(id);
  await Promise.all(servers.map((s) => s.close()));
});

describe("sampleServer: success", () => {
  it("runs exactly the fixed probe command on a pinned host and returns a parsed sample", async () => {
    const ssh = await startSsh();
    const id = register(ssh);
    await pinViaTofu(id);

    const outcome = await sampleServer(id);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.sample.cpuPercent).toBe(25);
    expect(outcome.sample.memUsedPercent).toBe(34.6);
    expect(outcome.sample.processes?.[0].command).toBe("postgres");
    expect(outcome.sample.services?.some((s) => s.unit === "nginx.service")).toBe(true);
    expect(new Date(outcome.collectedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Only the fixed probe was ever executed by the collector (the TOFU pin used `uname -a`).
    expect(ssh.execCommands.filter((c) => c !== "uname -a")).toEqual([PROBE_COMMAND]);
  });

  it("never exposes credentials in the outcome", async () => {
    const ssh = await startSsh();
    const id = register(ssh);
    await pinViaTofu(id);
    const text = JSON.stringify(await sampleServer(id));
    expect(text).not.toContain(PASS);
    expect(text).not.toMatch(/password/i);
  });

  it("throws ServerNotFoundError for an unknown id", async () => {
    await expect(sampleServer("00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(ServerNotFoundError);
  });
});

describe("sampleServer: host key policy (never trust on first use)", () => {
  it("unpinned host: host_key_not_pinned WITHOUT connecting, and no pin is created", async () => {
    const ssh = await startSsh();
    const id = register(ssh);
    const pinsBefore = pinCount();

    const outcome = await sampleServer(id);
    expect(outcome).toMatchObject({ ok: false, reason: "host_key_not_pinned", message: HOST_KEY_NOT_PINNED_MESSAGE });
    expect(ssh.connectionCount).toBe(0);
    expect(ssh.execCommands).toEqual([]);
    expect(KnownHostsService.getPin("127.0.0.1", ssh.port)).toBeUndefined();
    expect(pinCount()).toBe(pinsBefore);
  });

  it("adapter pinned_only policy refuses an unpinned key at the handshake and enrolls nothing", async () => {
    const ssh = await startSsh();
    const id = register(ssh);
    const server = StorageService.getServerById(id) as ServerHost;
    const auditBefore = StorageService.getAuditEvents({ limit: 500 }).length;

    const error = await SSHAdapter.executeCommand(server, PROBE_COMMAND, 10_000, undefined, { hostKeyPolicy: "pinned_only" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SshExecError);
    expect((error as SshExecError).kind).toBe("host_key_not_pinned");
    expect(ssh.execCommands).toEqual([]); // authentication/exec never happened
    expect(KnownHostsService.getPin("127.0.0.1", ssh.port)).toBeUndefined();
    expect(StorageService.getAuditEvents({ limit: 500 }).length).toBe(auditBefore); // no tofu_host_key_enrolled event

    // The default (interactive) policy still enrolls on first use.
    const tofu = await SSHAdapter.executeCommand(server, "uname -a", 10_000);
    expect(tofu.code).toBe(0);
    expect(KnownHostsService.getPin("127.0.0.1", ssh.port)).toBeDefined();
  });

  it("changed host key: host_key_mismatch, no command is executed, security_alert audited once per transition", async () => {
    const first = await startSsh();
    const port = first.port;
    const id = register(first);
    await pinViaTofu(id);
    const pinned = KnownHostsService.getPin("127.0.0.1", port);
    expect(pinned).toBeDefined();

    // Same host:port, different key (a man-in-the-middle / rebuilt host).
    await first.close();
    const impostor = await startSsh({ port, hostKeyPem: generateTestRsaKey() });

    const one = await collectAndStore(id);
    expect(one.outcome).toMatchObject({ ok: false, reason: "host_key_mismatch" });
    if (!one.outcome.ok) {
      expect(one.outcome.details?.expectedFingerprint).toBe(pinned?.fingerprint);
      expect(one.outcome.details?.receivedFingerprint).toMatch(/^SHA256:/);
    }
    expect(impostor.execCommands).toEqual([]);
    expect(KnownHostsService.getPin("127.0.0.1", port)?.fingerprint).toBe(pinned?.fingerprint); // pin untouched
    expect(getHealth(id)?.state).toBe("host_key_mismatch");

    const two = await collectAndStore(id);
    expect(two.outcome).toMatchObject({ ok: false, reason: "host_key_mismatch" });

    const alerts = healthEvents(id).filter((e) => e.eventType === "security_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe("denied");
    expect(alerts[0].details).toMatchObject({ alertType: "host_key_mismatch", source: "metrics_collector" });
    expect(healthEvents(id).filter((e) => e.eventType === "server_health_changed")).toHaveLength(0);

    // Restoring the pinned key recovers and audits the recovery as a health change.
    await impostor.close();
    await startSsh({ port, hostKeyPem: first.hostKeyPem });
    const three = await collectAndStore(id);
    expect(three.outcome.ok).toBe(true);
    expect(getHealth(id)?.state).toBe("reachable");
    const events = healthEvents(id);
    expect(events.filter((e) => e.eventType === "security_alert")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "server_health_changed")).toHaveLength(1);
  });
});

describe("sampleServer: failure modes", () => {
  it("auth_failed on a wrong password", async () => {
    const ssh = await startSsh();
    const id = register(ssh, { password: "definitely-wrong" });
    // Pin with the right credentials through a temporary record, then check the stored (wrong) credentials.
    const pinServer = register(ssh);
    await pinViaTofu(pinServer);
    const outcome = await sampleServer(id);
    expect(outcome).toMatchObject({ ok: false, reason: "auth_failed" });
    expect(JSON.stringify(outcome)).not.toContain("definitely-wrong");
  });

  it("timeout when the host does not answer within the hard timeout", async () => {
    const ssh = await startSsh({ probe: { delayMs: 5_000 } });
    const id = register(ssh);
    await pinViaTofu(id);
    const started = Date.now();
    const outcome = await sampleServer(id, { timeoutMs: 700 });
    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("the default hard timeout is 10 seconds", async () => {
    const { DEFAULT_PROBE_TIMEOUT_MS } = await import("./config");
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(10_000);
  });

  it("unreachable when nothing listens on the port", async () => {
    const ssh = await startSsh();
    const id = register(ssh);
    await pinViaTofu(id);
    await ssh.close();
    const outcome = await sampleServer(id, { timeoutMs: 5_000 });
    expect(outcome).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("unsupported_os for a non-Linux host", async () => {
    const ssh = await startSsh({ probe: { nonLinuxOs: "Darwin" } });
    const id = register(ssh);
    await pinViaTofu(id);
    const outcome = await sampleServer(id);
    expect(outcome).toMatchObject({ ok: false, reason: "unsupported_os" });
    if (!outcome.ok) expect(outcome.message).toContain("Darwin");
  });

  it("unsupported_os for a server declared as Windows, without connecting", async () => {
    const ssh = await startSsh();
    const id = register(ssh, { osType: "windows" });
    const outcome = await sampleServer(id);
    expect(outcome).toMatchObject({ ok: false, reason: "unsupported_os" });
    expect(ssh.connectionCount).toBe(0);
  });

  it("parse_error when the host answers with garbage or malformed numbers", async () => {
    const ssh = await startSsh({ probe: { output: "this is not the probe output\n" } });
    const id = register(ssh);
    await pinViaTofu(id);
    expect(await sampleServer(id)).toMatchObject({ ok: false, reason: "parse_error" });

    ssh.probe.output = UBUNTU_2204_OUTPUT.replace("/proc/loadavg", "x").replace(/0\.52 0\.58 0\.59 1\/467 123456/, "oops");
    expect(await sampleServer(id)).toMatchObject({ ok: false, reason: "parse_error" });

    ssh.probe.output = UBUNTU_2204_OUTPUT.replace(/@@praxel:end\n$/, "");
    expect(await sampleServer(id)).toMatchObject({ ok: false, reason: "parse_error" });
  });

  it("parse_error when the output exceeds the size limit", async () => {
    const ssh = await startSsh({ probe: { output: `@@praxel:uname\nLinux\n${"x".repeat(300_000)}\n` } });
    const id = register(ssh);
    await pinViaTofu(id);
    const outcome = await sampleServer(id);
    expect(outcome).toMatchObject({ ok: false, reason: "parse_error" });
  });

  it("credential_error when no password or key is stored", async () => {
    const ssh = await startSsh();
    const id = register(ssh, { password: null });
    const outcome = await sampleServer(id);
    expect(outcome).toMatchObject({ ok: false, reason: "credential_error" });
    expect(ssh.connectionCount).toBe(0);
  });
});

describe("collectAndStore: persistence and audit transitions", () => {
  it("stores the sample, updates health and audits only state transitions", async () => {
    const ssh = await startSsh();
    const id = register(ssh);
    await pinViaTofu(id);

    const first = await collectAndStore(id);
    expect(first.outcome.ok).toBe(true);
    expect(first.record).toEqual({ previousState: null, state: "reachable" });
    expect(getHealth(id)?.state).toBe("reachable");
    expect(getLatestOkSample(id)?.sample?.cpuPercent).toBe(25);
    expect(healthEvents(id)).toHaveLength(0); // first healthy observation is not news

    await collectAndStore(id);
    expect(countSamples(id)).toBe(2);
    expect(healthEvents(id)).toHaveLength(0);

    ssh.probe.nonLinuxOs = "FreeBSD";
    await collectAndStore(id);
    await collectAndStore(id);
    ssh.probe.nonLinuxOs = undefined;
    await collectAndStore(id);

    expect(countSamples(id)).toBe(5);
    const events = healthEvents(id);
    expect(events.map((e) => [e.eventType, e.status, e.details?.state])).toEqual([
      ["server_health_changed", "failure", "unsupported_os"],
      ["server_health_changed", "success", "reachable"],
    ]);
    const audit = JSON.stringify(StorageService.getAuditEvents({ serverId: id }));
    expect(audit).not.toContain(PASS);
  });

  it("a first observation that is a failure is audited", async () => {
    const ssh = await startSsh();
    const id = register(ssh); // never pinned
    await collectAndStore(id);
    await collectAndStore(id);
    const events = healthEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "server_health_changed", status: "failure" });
    expect(events[0].details).toMatchObject({ state: "host_key_not_pinned", reason: "host_key_not_pinned" });
  });

  it("throws ServerNotFoundError and stores nothing for an unknown id", async () => {
    await expect(collectAndStore("00000000-0000-4000-8000-000000000001")).rejects.toBeInstanceOf(ServerNotFoundError);
  });

  it("a server deleted while its probe is in flight stores nothing and does not throw", async () => {
    const ssh = await startSsh({ probe: { delayMs: 400 } });
    const id = register(ssh);
    await pinViaTofu(id);
    const pending = collectAndStore(id);
    await new Promise((r) => setTimeout(r, 100));
    StorageService.deleteServer(id);
    const result = await pending;
    expect(result.record).toBeNull();
    expect(countSamples(id)).toBe(0);
  });

  it("collectAndStoreShared runs one probe for concurrent callers", async () => {
    const ssh = await startSsh({ probe: { delayMs: 300 } });
    const id = register(ssh);
    await pinViaTofu(id);
    const before = ssh.execCommands.filter((c) => c === PROBE_COMMAND).length;
    const [a, b] = await Promise.all([collectAndStoreShared(id), collectAndStoreShared(id)]);
    expect(a).toBe(b);
    expect(ssh.execCommands.filter((c) => c === PROBE_COMMAND).length - before).toBe(1);
    expect(countSamples(id)).toBe(1);
  });
});
