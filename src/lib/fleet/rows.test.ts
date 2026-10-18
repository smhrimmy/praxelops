import { describe, it, expect } from "vitest";
import type { SystemMetrics } from "@/types/server";
import { buildRows, sortFleetRows } from "./rows";
import type { FleetServer } from "./types";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const iso = (ago: number) => new Date(NOW - ago * 1000).toISOString();

function metrics(cpu: number, mem: number): SystemMetrics {
  return {
    cpuPercent: cpu,
    memoryUsedGB: 1,
    memoryTotalGB: 2,
    memoryPercent: mem,
    diskUsedGB: 1,
    diskTotalGB: 10,
    diskPercent: 10,
    networkRxBytes: 1,
    networkTxBytes: 1,
    uptimeSeconds: 100,
    loadAverage: [cpu / 10, 0, 0],
    activeProcesses: 1,
    reportedAt: iso(5),
  };
}

function srv(id: string, name: string, extra: Partial<FleetServer> = {}): FleetServer {
  return {
    id,
    name,
    host: "h",
    port: 22,
    username: "u",
    authType: "password",
    tags: [],
    status: "checking",
    osType: "linux",
    createdAt: iso(100),
    updatedAt: iso(100),
    ...extra,
  };
}

const ok = (age: number) => ({
  health: { state: "reachable" as const, lastCheckedAt: iso(age), lastOkAt: iso(age), sampleAgeSeconds: age },
});

describe("buildRows", () => {
  const servers = [
    srv("a", "alpha", { metrics: metrics(50, 40), ...ok(5) }),
    srv("b", "beta", { metrics: metrics(10, 90), ...ok(20) }),
    srv("c", "gamma"),
    srv("d", "delta", { health: { state: "unreachable", lastCheckedAt: iso(3), lastOkAt: null, sampleAgeSeconds: null } }),
  ];
  const rates = { a: { rxBytesPerSec: 100, txBytesPerSec: 5 }, b: null };

  it("keeps unknown values null instead of zero", () => {
    const rows = buildRows(servers, rates, NOW, NOW);
    expect(rows[0]).toMatchObject({ cpu: 50, mem: 40, rx: 100, tx: 5, ageSeconds: 5 });
    expect(rows[1]).toMatchObject({ cpu: 10, rx: null, tx: null });
    expect(rows[2]).toMatchObject({ cpu: null, mem: null, disk: null, load1: null, rx: null, ageSeconds: null });
    expect(rows[3].cpu).toBeNull();
  });

  it("sorts by a numeric column with unknowns last in both directions", () => {
    const rows = buildRows(servers, rates, NOW, NOW);
    expect(sortFleetRows(rows, "cpu", "desc").map((r) => r.server.id)).toEqual(["a", "b", "c", "d"]);
    expect(sortFleetRows(rows, "cpu", "asc").map((r) => r.server.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("sorts by name and by state severity (worst first when ascending)", () => {
    const rows = buildRows(servers, rates, NOW, NOW);
    expect(sortFleetRows(rows, "name", "asc").map((r) => r.server.name)).toEqual(["alpha", "beta", "delta", "gamma"]);
    const byState = sortFleetRows(rows, "state", "asc").map((r) => r.server.id);
    expect(byState[0]).toBe("d");
    expect(byState[byState.length - 1]).not.toBe("d");
  });

  it("sorts by age with no-sample hosts last", () => {
    const rows = buildRows(servers, rates, NOW, NOW);
    expect(sortFleetRows(rows, "age", "asc").map((r) => r.server.id).slice(0, 2)).toEqual(["a", "b"]);
  });
});
