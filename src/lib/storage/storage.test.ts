import { describe, it, expect, beforeEach } from "vitest";
import { StorageService } from "./index";
import fs from "fs";
import path from "path";

describe("StorageService", () => {
  it("initializes servers with valid seeds and structure", () => {
    const servers = StorageService.getServers();
    expect(servers.length).toBeGreaterThanOrEqual(3);
    const local = servers.find((s) => s.id === "srv-local-01");
    expect(local).toBeDefined();
    expect(local?.name).toBe("Localhost Hypervisor");
    expect(local?.metrics?.cpuPercent).toBeGreaterThanOrEqual(0);
  });

  it("logs and retrieves audit events in order", () => {
    const event = StorageService.logAuditEvent({
      actor: "test-user",
      eventType: "ssh_connect",
      targetServerId: "srv-local-01",
      targetServerName: "Localhost Hypervisor",
      status: "success",
    });

    expect(event.id).toMatch(/^audit-/);
    const events = StorageService.getAuditEvents();
    expect(events[0].id).toBe(event.id);
    expect(events[0].actor).toBe("test-user");
  });

  it("creates, saves and retrieves AI operation proposals", () => {
    const proposal = {
      id: "prop-test-01",
      targetServerId: "srv-local-01",
      targetServerName: "Localhost Hypervisor",
      title: "Rotate syslog journal",
      rationale: "Disk usage exceeded warning threshold",
      riskLevel: "medium" as const,
      commands: ["journalctl --vacuum-time=2d"],
      requiresSudo: true,
      expectedOutcome: "Frees disk space",
      isDestructive: false,
      status: "pending_approval" as const,
      createdAt: new Date().toISOString(),
    };

    StorageService.saveProposal(proposal);
    const retrieved = StorageService.getProposalById("prop-test-01");
    expect(retrieved).toBeDefined();
    expect(retrieved?.title).toBe("Rotate syslog journal");
  });
});
