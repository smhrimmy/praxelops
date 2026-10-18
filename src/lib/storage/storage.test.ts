import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { StorageService } from "./index";
import { getDataDir } from "./dataDir";
import { StorageCorruptError } from "./atomicFile";
import { getDb, getDbPath, withTransaction } from "../db/database";
import type { AIOperationProposal, ServerDiagnosticReport } from "@/types/ai";
import type { DeploymentWorkflow } from "@/types/deployment";
import type { ServerHost } from "@/types/server";

function makeServer(id: string, extra: Record<string, unknown> = {}): ServerHost {
  return {
    id,
    name: `Server ${id}`,
    host: "192.168.1.50",
    port: 22,
    username: "ubuntu",
    authType: "password" as const,
    tags: ["production"],
    status: "online" as const,
    osType: "linux" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

function makeProposal(id: string, status: AIOperationProposal["status"] = "pending_approval"): AIOperationProposal {
  return {
    id,
    targetServerId: "srv-1",
    targetServerName: "Server 1",
    title: `proposal ${id}`,
    rationale: "because",
    riskLevel: "low",
    commands: ["uptime"],
    commandsHash: "hash",
    requiresSudo: false,
    expectedOutcome: "ok",
    isDestructive: false,
    status,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    signature: "sig",
  };
}

describe("StorageService", () => {
  beforeEach(() => {
    StorageService.clearAllServers();
  });

  it("starts in a clean production state without fabricated servers", () => {
    const servers = StorageService.getServers();
    expect(servers.length).toBe(0);
  });

  it("saves, retrieves and deletes real server hosts", () => {
    const newServer = makeServer("srv-test-real-01", { name: "Test Cluster Node" });

    StorageService.saveServer(newServer);
    const retrieved = StorageService.getServerById("srv-test-real-01");
    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe("Test Cluster Node");

    const deleted = StorageService.deleteServer("srv-test-real-01");
    expect(deleted).toBe(true);
    expect(StorageService.getServerById("srv-test-real-01")).toBeUndefined();
    expect(StorageService.deleteServer("srv-test-real-01")).toBe(false);
  });

  it("round-trips secrets through dedicated columns, never through the JSON data column", () => {
    StorageService.saveServer(
      makeServer("srv-secret", { password: "pw-123", privateKey: "KEY-ABC", passphrase: "pp-456" })
    );
    const back = StorageService.getServerById("srv-secret") as unknown as Record<string, unknown>;
    expect(back.password).toBe("pw-123");
    expect(back.privateKey).toBe("KEY-ABC");
    expect(back.passphrase).toBe("pp-456");

    const row = getDb()
      .prepare("SELECT data, password, private_key, passphrase FROM servers WHERE id = ?")
      .get("srv-secret");
    // Credentials are envelope-encrypted at rest (see vault.test.ts for the full coverage).
    expect(String(row?.password)).toMatch(/^enc:v1:/);
    expect(String(row?.private_key)).toMatch(/^enc:v1:/);
    expect(String(row?.passphrase)).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row)).not.toMatch(/pw-123|KEY-ABC|pp-456/);
    expect(String(row?.data)).not.toMatch(/pw-123|KEY-ABC|pp-456/);
    expect(JSON.parse(String(row?.data))).not.toHaveProperty("id");

    // Saving again without secrets replaces the record entirely (as the JSON store did).
    StorageService.saveServer(makeServer("srv-secret"));
    const cleared = StorageService.getServerById("srv-secret") as unknown as Record<string, unknown>;
    expect(cleared.password).toBeUndefined();
    expect(cleared.privateKey).toBeUndefined();
  });

  it("keeps insertion order and updates in place", () => {
    StorageService.saveServer(makeServer("srv-a"));
    StorageService.saveServer(makeServer("srv-b"));
    StorageService.saveServer(makeServer("srv-a", { name: "renamed" }));
    const servers = StorageService.getServers();
    expect(servers.map((s) => s.id)).toEqual(["srv-a", "srv-b"]);
    expect(servers[0].name).toBe("renamed");
  });

  it("explicitly loads demo environment only when requested and labels it", () => {
    StorageService.saveServer(makeServer("srv-replaced"));
    const demo = StorageService.loadDemoEnvironment();
    expect(demo.length).toBeGreaterThan(0);
    expect(demo[0].name).toContain("[DEMO]");
    expect(demo[0].tags).toContain("demo");
    // Loading the demo replaces the server list, exactly like the JSON store did.
    expect(StorageService.getServers().map((s) => s.id)).toEqual([demo[0].id]);
    expect(StorageService.getServerById("srv-replaced")).toBeUndefined();
  });

  it("logs and retrieves audit events newest first", () => {
    const first = StorageService.logAuditEvent({
      actor: "test-operator",
      eventType: "ssh_connect",
      targetServerId: "srv-test-real-01",
      targetServerName: "Test Cluster Node",
      status: "success",
      ipAddress: "10.0.0.9",
      command: "uptime",
      details: { nested: { value: 1 } },
    });
    const second = StorageService.logAuditEvent({
      actor: "other",
      eventType: "ssh_disconnect",
      targetServerId: "srv-other",
      status: "failure",
    });

    expect(first.id).toMatch(/^audit-/);
    const events = StorageService.getAuditEvents();
    expect(events[0].id).toBe(second.id);
    expect(events[1]).toEqual(first);
    expect(events[1].details).toEqual({ nested: { value: 1 } });
    expect(events[0].command).toBeUndefined();
    expect(events[0].details).toBeUndefined();

    expect(StorageService.getAuditEvents({ limit: 1 }).map((e) => e.id)).toEqual([second.id]);
    expect(StorageService.getAuditEvents({ serverId: "srv-test-real-01" }).map((e) => e.id)).toEqual([first.id]);
    expect(StorageService.getAuditEvents({ limit: 1, offset: 1 }).map((e) => e.id)).toEqual([first.id]);
  });

  it("no longer silently drops audit events beyond the old 2000 cap", () => {
    const before = StorageService.getAuditEvents().length;
    // One outer transaction keeps this fast; each logAuditEvent nests as a savepoint.
    withTransaction(() => {
      for (let i = 0; i < 2100; i++) {
        StorageService.logAuditEvent({ actor: "bulk", eventType: "ssh_connect", targetServerId: "bulk", status: "success" });
      }
    });
    const events = StorageService.getAuditEvents();
    expect(events.length).toBe(before + 2100);
    const seqs = getDb().prepare("SELECT seq FROM audit_events ORDER BY seq").all().map((r) => Number(r.seq));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it("stores proposals newest-created first and updates them in place", () => {
    expect(StorageService.getProposals()).toEqual([]);
    StorageService.saveProposal(makeProposal("p1"));
    StorageService.saveProposal(makeProposal("p2"));
    StorageService.saveProposal({ ...makeProposal("p1"), status: "approved", approvedAt: "now" });
    const list = StorageService.getProposals();
    expect(list.map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(StorageService.getProposalById("p1")?.status).toBe("approved");
    expect(StorageService.getProposalById("missing")).toBeUndefined();
  });

  it("stores deployments newest-created first and updates them in place", () => {
    const dep = (id: string, status: DeploymentWorkflow["status"]): DeploymentWorkflow => ({
      id,
      name: id,
      serverId: "srv-1",
      serverName: "Server 1",
      appDirectory: "/srv/app",
      environment: "staging",
      status,
      steps: [],
      createdAt: new Date().toISOString(),
    });
    expect(StorageService.getDeployments()).toEqual([]);
    StorageService.saveDeployment(dep("d1", "queued"));
    StorageService.saveDeployment(dep("d2", "queued"));
    StorageService.saveDeployment(dep("d1", "healthy"));
    const list = StorageService.getDeployments();
    expect(list.map((d) => d.id)).toEqual(["d2", "d1"]);
    expect(list[1].status).toBe("healthy");
  });

  it("keeps only the 100 newest diagnostics", () => {
    for (let i = 0; i < 105; i++) {
      const report: ServerDiagnosticReport = {
        id: `diag-${i}`,
        serverId: "srv-1",
        serverName: "Server 1",
        timestamp: new Date().toISOString(),
        healthScore: 90,
        summary: "ok",
        anomalies: [],
        proposals: [],
      };
      StorageService.saveDiagnostic(report);
    }
    const list = StorageService.getDiagnostics();
    expect(list.length).toBe(100);
    expect(list[0].id).toBe("diag-104");
    expect(list[99].id).toBe("diag-5");
  });

  it("uses PRAXELOPS_DATA_DIR rather than the repo .peos directory", () => {
    StorageService.getServers();
    expect(getDataDir()).toBe(path.resolve(process.env.PRAXELOPS_DATA_DIR ?? "<unset>"));
    expect(getDbPath()).toBe(path.join(getDataDir(), "praxelops.db"));
    expect(fs.existsSync(getDbPath())).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(getDbPath()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(getDataDir()).mode & 0o777).toBe(0o700);
    }
  });

  it("no longer reads or writes the legacy JSON store files", () => {
    StorageService.saveServer(makeServer("srv-nojson"));
    StorageService.logAuditEvent({ actor: "x", eventType: "ssh_connect", targetServerId: "s", status: "success" });
    StorageService.saveProposal(makeProposal("p-nojson"));
    const jsonFiles = fs.readdirSync(getDataDir()).filter((f) => f.endsWith(".json"));
    expect(jsonFiles).toEqual([]);
  });

  it("uses WAL with the expected pragmas", () => {
    const db = getDb();
    expect(String(db.prepare("PRAGMA journal_mode").get()?.journal_mode)).toBe("wal");
    expect(Number(db.prepare("PRAGMA busy_timeout").get()?.timeout)).toBe(5000);
    expect(Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys)).toBe(1);
  });

  it("throws StorageCorruptError (never a default) for a malformed audit row and keeps it intact", () => {
    const event = StorageService.logAuditEvent({ actor: "x", eventType: "ssh_connect", targetServerId: "s", status: "success" });
    getDb().prepare("UPDATE audit_events SET status = 'bogus' WHERE id = ?").run(event.id);
    expect(() => StorageService.getAuditEvents()).toThrow(StorageCorruptError);
    getDb().prepare("UPDATE audit_events SET status = 'success', details = '{not json' WHERE id = ?").run(event.id);
    expect(() => StorageService.getAuditEvents()).toThrow(StorageCorruptError);
    const row = getDb().prepare("SELECT details FROM audit_events WHERE id = ?").get(event.id);
    expect(row?.details).toBe("{not json");
    getDb().prepare("DELETE FROM audit_events WHERE id = ?").run(event.id);
    expect(() => StorageService.getAuditEvents()).not.toThrow();
  });

  it("throws StorageCorruptError for a server row whose JSON column is malformed", () => {
    StorageService.saveServer(makeServer("srv-bad-json"));
    getDb().prepare("UPDATE servers SET data = '[1,2]' WHERE id = ?").run("srv-bad-json");
    expect(() => StorageService.getServers()).toThrow(StorageCorruptError);
    expect(() => StorageService.getServerById("srv-bad-json")).toThrow(StorageCorruptError);
  });

  it("leaves no lock or temp files behind after writes", () => {
    StorageService.logAuditEvent({
      actor: "x",
      eventType: "ssh_connect",
      targetServerId: "s",
      status: "success",
    });
    const leftovers = fs
      .readdirSync(getDataDir())
      .filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
