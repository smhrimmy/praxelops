import { describe, it, expect } from "vitest";
import type { SystemMetrics } from "@/types/server";
import type { HealthState } from "@/lib/metrics/types";
import {
  FAILING_HOST_CHECK_WINDOW_SECONDS,
  collectorLooksStopped,
  deriveServerStatus,
  isStale,
  liveAgeSeconds,
  meterTone,
  stateInfo,
  stateSeverity,
  staleThresholdSeconds,
  summarizeFleet,
  type DisplayState,
} from "./health";
import type { FleetServer } from "./types";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const iso = (agoSeconds: number) => new Date(NOW - agoSeconds * 1000).toISOString();

const METRICS: SystemMetrics = {
  cpuPercent: 10,
  memoryUsedGB: 1,
  memoryTotalGB: 4,
  memoryPercent: 25,
  diskUsedGB: 10,
  diskTotalGB: 100,
  diskPercent: 10,
  networkRxBytes: 1,
  networkTxBytes: 1,
  uptimeSeconds: 100,
  loadAverage: [0.1, 0.1, 0.1],
  activeProcesses: 100,
  reportedAt: iso(5),
};

function server(overrides: Partial<FleetServer> = {}): FleetServer {
  return {
    id: "s1",
    name: "web-1",
    host: "10.0.0.1",
    port: 22,
    username: "root",
    authType: "password",
    tags: [],
    status: "checking",
    osType: "linux",
    createdAt: iso(1000),
    updatedAt: iso(1000),
    ...overrides,
  };
}

function withHealth(state: HealthState, checkedAgo: number, sampleAge: number | null, reason?: string): Partial<FleetServer> {
  return {
    health: {
      state,
      lastCheckedAt: iso(checkedAgo),
      lastOkAt: sampleAge === null ? null : iso(sampleAge),
      sampleAgeSeconds: sampleAge,
      ...(reason ? { reason } : {}),
    },
  };
}

describe("stateInfo", () => {
  const all: DisplayState[] = [
    "reachable",
    "unreachable",
    "auth_failed",
    "host_key_mismatch",
    "host_key_not_pinned",
    "unsupported_os",
    "error",
    "never_checked",
  ];

  it("has a label, tone, shape and explanation for every state", () => {
    for (const state of all) {
      const info = stateInfo(state);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.description.length).toBeGreaterThan(10);
    }
  });

  it("maps states to tones; a host key mismatch is an alert, not an ordinary failure", () => {
    expect(stateInfo("reachable").tone).toBe("ok");
    expect(stateInfo("unreachable").tone).toBe("bad");
    expect(stateInfo("auth_failed").tone).toBe("bad");
    expect(stateInfo("host_key_mismatch").tone).toBe("alert");
    expect(stateInfo("host_key_not_pinned").tone).toBe("warn");
    expect(stateInfo("unsupported_os").tone).toBe("warn");
    expect(stateInfo("never_checked").tone).toBe("muted");
  });

  it("uses a shape that differs from the healthy dot for every non-healthy state (not colour alone)", () => {
    for (const state of all.filter((s) => s !== "reachable")) expect(stateInfo(state).shape).not.toBe("dot");
  });

  it("ranks a host key mismatch as most urgent and reachable as least", () => {
    const ranked = [...all].sort((a, b) => stateSeverity(a) - stateSeverity(b));
    expect(ranked[0]).toBe("host_key_mismatch");
    expect(ranked[ranked.length - 1]).toBe("reachable");
    expect(new Set(all.map(stateSeverity)).size).toBe(all.length);
  });
});

describe("staleness", () => {
  it("is stale only beyond 3x the interval", () => {
    expect(staleThresholdSeconds()).toBe(90);
    expect(staleThresholdSeconds(60)).toBe(180);
    expect(isStale(90)).toBe(false);
    expect(isStale(91)).toBe(true);
    expect(isStale(100, 60)).toBe(false);
  });

  it("does not call a missing sample stale", () => {
    expect(isStale(null)).toBe(false);
  });

  it("keeps ageing the reported age between polls", () => {
    expect(liveAgeSeconds(10, NOW - 25_000, NOW)).toBe(35);
    expect(liveAgeSeconds(10, NOW + 5_000, NOW)).toBe(10);
    expect(liveAgeSeconds(null, NOW - 25_000, NOW)).toBeNull();
  });
});

describe("deriveServerStatus", () => {
  it("never-checked host has no numbers and says so", () => {
    const view = deriveServerStatus(server(), NOW, NOW);
    expect(view.state).toBe("never_checked");
    expect(view.metrics).toBeUndefined();
    expect(view.sampleAgeSeconds).toBeNull();
    expect(view.note).toMatch(/not checked/i);
  });

  it("reachable host with fresh metrics shows them with their age and no note", () => {
    const view = deriveServerStatus(server({ metrics: METRICS, ...withHealth("reachable", 10, 10) }), NOW, NOW + 5000);
    expect(view.metrics).toBe(METRICS);
    expect(view.sampleAgeSeconds).toBe(15);
    expect(view.stale).toBe(false);
    expect(view.note).toBe("");
  });

  it("hides metrics that aged out since the listing and labels them stale", () => {
    const view = deriveServerStatus(server({ metrics: METRICS, ...withHealth("reachable", 10, 80) }), NOW, NOW + 20_000);
    expect(view.stale).toBe(true);
    expect(view.metrics).toBeUndefined();
    expect(view.note).toMatch(/stale/i);
  });

  it("reachable host without metrics (the API dropped them) is stale, with the age in the note", () => {
    const view = deriveServerStatus(server(withHealth("reachable", 5, 600)), NOW, NOW);
    expect(view.stale).toBe(true);
    expect(view.note).toContain("10m ago");
  });

  it("reachable host that never produced a sample explains that", () => {
    const view = deriveServerStatus(server(withHealth("reachable", 5, null)), NOW, NOW);
    expect(view.stale).toBe(false);
    expect(view.note).toMatch(/no successful sample/i);
  });

  it("a failure after a good sample keeps the numbers but flags them as last known", () => {
    const view = deriveServerStatus(server({ metrics: METRICS, ...withHealth("unreachable", 5, 40, "timeout") }), NOW, NOW);
    expect(view.metrics).toBe(METRICS);
    expect(view.lastKnown).toBe(true);
    expect(view.note).toContain("timeout");
    expect(view.note).toContain("40s ago");
  });

  it("a failing host that never produced a sample says so", () => {
    const view = deriveServerStatus(server(withHealth("auth_failed", 5, null)), NOW, NOW);
    expect(view.metrics).toBeUndefined();
    expect(view.note).toMatch(/ever been collected/i);
  });

  it("host_key_not_pinned explains how to resolve it", () => {
    const view = deriveServerStatus(server(withHealth("host_key_not_pinned", 5, null)), NOW, NOW);
    expect(view.note).toMatch(/open a terminal/i);
  });
});

describe("collectorLooksStopped", () => {
  it("is false for an empty fleet", () => {
    expect(collectorLooksStopped([], NOW)).toBe(false);
  });

  it("is false while any reachable host was checked within 3x the interval", () => {
    const servers = [server(withHealth("reachable", 60, 60)), server({ id: "s2", ...withHealth("reachable", 600, 600) })];
    expect(collectorLooksStopped(servers, NOW)).toBe(false);
  });

  it("is true when every reachable host's last check is older than 3x the interval", () => {
    const servers = [server(withHealth("reachable", 120, 120)), server({ id: "s2", ...withHealth("reachable", 600, 600) })];
    expect(collectorLooksStopped(servers, NOW)).toBe(true);
  });

  it("is true when no host has ever been checked", () => {
    expect(collectorLooksStopped([server(), server({ id: "s2" })], NOW)).toBe(true);
  });

  it("does not blame the collector for failing hosts that are simply backed off", () => {
    expect(collectorLooksStopped([server(withHealth("unreachable", 300, null))], NOW)).toBe(false);
    expect(collectorLooksStopped([server(withHealth("unreachable", FAILING_HOST_CHECK_WINDOW_SECONDS + 5, null))], NOW)).toBe(true);
  });

  it("honours a custom interval", () => {
    expect(collectorLooksStopped([server(withHealth("reachable", 120, 120))], NOW, 60)).toBe(false);
  });
});

describe("summarizeFleet", () => {
  it("counts states and reports the most urgent one", () => {
    const summary = summarizeFleet([
      server(withHealth("reachable", 5, 5)),
      server({ id: "b", ...withHealth("host_key_mismatch", 5, null) }),
      server({ id: "c" }),
      server({ id: "d", ...withHealth("unreachable", 5, null) }),
    ]);
    expect(summary).toEqual({ total: 4, reachable: 1, attention: 2, neverChecked: 1, worst: "host_key_mismatch" });
  });

  it("has no worst state for an empty fleet", () => {
    expect(summarizeFleet([]).worst).toBeNull();
  });
});

describe("meterTone", () => {
  it("switches at 75 and 90 percent", () => {
    expect(meterTone(74.9)).toBe("ok");
    expect(meterTone(75)).toBe("warn");
    expect(meterTone(89.9)).toBe("warn");
    expect(meterTone(90)).toBe("bad");
  });
});
