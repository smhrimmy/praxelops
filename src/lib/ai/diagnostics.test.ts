import { describe, it, expect } from "vitest";
import { AIDiagnosticsEngine } from "./diagnostics";
import { ServerHost } from "@/types/server";

describe("AIDiagnosticsEngine", () => {
  const baseServer: ServerHost = {
    id: "srv-test-01",
    name: "Test Server Node",
    host: "10.0.0.1",
    port: 22,
    username: "operator",
    authType: "password",
    tags: ["test"],
    status: "online",
    osType: "linux",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("detects critical CPU bottleneck and generates remedial proposal", () => {
    const highCpuServer: ServerHost = {
      ...baseServer,
      metrics: {
        cpuPercent: 92.4,
        memoryUsedGB: 4,
        memoryTotalGB: 16,
        memoryPercent: 25,
        diskUsedGB: 20,
        diskTotalGB: 100,
        diskPercent: 20,
        networkRxBytes: 1000,
        networkTxBytes: 1000,
        uptimeSeconds: 10000,
        loadAverage: [5.2, 4.1, 3.2],
        activeProcesses: 120,
        reportedAt: new Date().toISOString(),
      },
    };

    const report = AIDiagnosticsEngine.analyzeServer(highCpuServer);
    expect(report.healthScore).toBeLessThan(80);
    expect(report.anomalies.some((a) => a.category === "cpu")).toBe(true);

    const cpuProp = report.proposals.find((p) => p.title.includes("runaway"));
    expect(cpuProp).toBeDefined();
    expect(cpuProp?.riskLevel).toBe("medium");
    expect(cpuProp?.status).toBe("pending_approval");
    expect(cpuProp?.requiresSudo).toBe(true);
  });

  it("detects high memory exhaustion with high risk rating", () => {
    const highMemServer: ServerHost = {
      ...baseServer,
      metrics: {
        cpuPercent: 12.0,
        memoryUsedGB: 15.2,
        memoryTotalGB: 16,
        memoryPercent: 95.0,
        diskUsedGB: 20,
        diskTotalGB: 100,
        diskPercent: 20,
        networkRxBytes: 1000,
        networkTxBytes: 1000,
        uptimeSeconds: 10000,
        loadAverage: [0.2, 0.1, 0.1],
        activeProcesses: 80,
        reportedAt: new Date().toISOString(),
      },
    };

    const report = AIDiagnosticsEngine.analyzeServer(highMemServer);
    expect(report.anomalies.some((a) => a.category === "memory")).toBe(true);
    const memProp = report.proposals.find((p) => p.title.includes("caches"));
    expect(memProp?.riskLevel).toBe("high");
  });

  it("produces low-risk proposal for healthy servers", () => {
    const healthyServer: ServerHost = {
      ...baseServer,
      metrics: {
        cpuPercent: 15.0,
        memoryUsedGB: 4.0,
        memoryTotalGB: 16,
        memoryPercent: 25.0,
        diskUsedGB: 20,
        diskTotalGB: 100,
        diskPercent: 20,
        networkRxBytes: 1000,
        networkTxBytes: 1000,
        uptimeSeconds: 10000,
        loadAverage: [0.2, 0.1, 0.1],
        activeProcesses: 80,
        reportedAt: new Date().toISOString(),
      },
    };

    const report = AIDiagnosticsEngine.analyzeServer(healthyServer);
    expect(report.healthScore).toBe(100);
    expect(report.anomalies.length).toBe(0);
    expect(report.proposals[0].riskLevel).toBe("low");
  });
});
