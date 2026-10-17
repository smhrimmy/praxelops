import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { StorageService } from "./index";
import { getDataDir } from "./dataDir";
import { StorageCorruptError } from "./atomicFile";

describe("StorageService", () => {
  beforeEach(() => {
    StorageService.clearAllServers();
  });

  it("starts in a clean production state without fabricated servers", () => {
    const servers = StorageService.getServers();
    expect(servers.length).toBe(0);
  });

  it("saves, retrieves and deletes real server hosts", () => {
    const newServer = {
      id: "srv-test-real-01",
      name: "Test Cluster Node",
      host: "192.168.1.50",
      port: 22,
      username: "ubuntu",
      authType: "password" as const,
      tags: ["production"],
      status: "online" as const,
      osType: "linux" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    StorageService.saveServer(newServer);
    const retrieved = StorageService.getServerById("srv-test-real-01");
    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe("Test Cluster Node");

    const deleted = StorageService.deleteServer("srv-test-real-01");
    expect(deleted).toBe(true);
    expect(StorageService.getServerById("srv-test-real-01")).toBeUndefined();
  });

  it("explicitly loads demo environment only when requested and labels it", () => {
    const demo = StorageService.loadDemoEnvironment();
    expect(demo.length).toBeGreaterThan(0);
    expect(demo[0].name).toContain("[DEMO]");
    expect(demo[0].tags).toContain("demo");
  });

  it("logs and retrieves audit events in order", () => {
    const event = StorageService.logAuditEvent({
      actor: "test-operator",
      eventType: "ssh_connect",
      targetServerId: "srv-test-real-01",
      targetServerName: "Test Cluster Node",
      status: "success",
    });

    expect(event.id).toMatch(/^audit-/);
    const events = StorageService.getAuditEvents();
    expect(events[0].id).toBe(event.id);
    expect(events[0].actor).toBe("test-operator");
  });
  it("creates the default store file when missing", () => {
    const file = path.join(getDataDir(), "proposals.json");
    fs.rmSync(file, { force: true });
    expect(StorageService.getProposals()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual([]);
  });

  it("uses PRAXELOPS_DATA_DIR rather than the repo .peos directory", () => {
    StorageService.getServers();
    expect(getDataDir()).toBe(path.resolve(process.env.PRAXELOPS_DATA_DIR ?? "<unset>"));
    expect(fs.existsSync(path.join(getDataDir(), "servers.json"))).toBe(true);
  });

  it("throws StorageCorruptError (never returns a default) for a corrupt store and keeps it intact", () => {
    StorageService.getAuditEvents();
    const file = path.join(getDataDir(), "audit.json");
    fs.writeFileSync(file, '[{"id": "audit-1", "act', "utf-8");
    expect(() => StorageService.getAuditEvents()).toThrow(StorageCorruptError);
    expect(() =>
      StorageService.logAuditEvent({
        actor: "x",
        eventType: "ssh_connect",
        targetServerId: "s",
        status: "success",
      })
    ).toThrow(StorageCorruptError);
    expect(fs.readFileSync(file, "utf-8")).toBe('[{"id": "audit-1", "act');
    fs.writeFileSync(file, "[]", "utf-8"); // restore for later tests in this file
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
