import { describe, it, expect, beforeEach } from "vitest";
import { StorageService } from "./index";

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
});
