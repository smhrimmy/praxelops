import { afterAll, describe, expect, it } from "vitest";
import { StorageService } from "@/lib/storage";
import { toPublicServer } from "@/lib/servers/publicServer";
import type { ServerHost } from "@/types/server";
import { UBUNTU_2204_OUTPUT } from "./fixtures";
import { parseProbeOutput } from "./parse";
import { recordSampleResult } from "./store";
import type { MetricsSample, SampleOutcome } from "./types";
import { MAX_HISTORY_POINTS, downsample, getFreshTelemetry, getHistory, getLatestView, sampleToSystemMetrics, withRates, withTelemetry } from "./view";

const parsed = parseProbeOutput(UBUNTU_2204_OUTPUT);
if (!parsed.ok) throw new Error("fixture must parse");
const BASE: MetricsSample = parsed.sample;

const created: string[] = [];

function makeServer(label: string): ServerHost {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const server: ServerHost = {
    id,
    name: `metrics-view-${label}`,
    host: `10.98.0.${created.length + 1}`,
    port: 22,
    username: "ops",
    authType: "password",
    tags: [],
    status: "checking",
    osType: "linux",
    createdAt: now,
    updatedAt: now,
    // Demo-style stored metrics that must never be surfaced.
    metrics: {
      cpuPercent: 99,
      memoryUsedGB: 1,
      memoryTotalGB: 2,
      memoryPercent: 50,
      diskUsedGB: 1,
      diskTotalGB: 2,
      diskPercent: 50,
      networkRxBytes: 1,
      networkTxBytes: 1,
      uptimeSeconds: 1,
      loadAverage: [1, 1, 1],
      activeProcesses: 1,
      reportedAt: new Date().toISOString(),
    },
  };
  (server as unknown as Record<string, unknown>).password = "pw-not-used";
  StorageService.saveServer(server);
  created.push(server.id);
  return server;
}

function ok(at: string, patch: Partial<MetricsSample> = {}): SampleOutcome {
  return { ok: true, sample: { ...BASE, ...patch }, collectedAt: at };
}

afterAll(() => {
  for (const id of created) StorageService.deleteServer(id);
});

describe("sampleToSystemMetrics", () => {
  it("maps a sample onto the frozen SystemMetrics contract", () => {
    const m = sampleToSystemMetrics(BASE, "2026-01-01T00:00:00.000Z");
    expect(m.cpuPercent).toBe(25);
    expect(m.memoryPercent).toBe(34.6);
    expect(m.memoryTotalGB).toBeCloseTo(7.77, 2);
    expect(m.memoryUsedGB).toBeCloseTo(2.69, 2);
    expect(m.diskPercent).toBe(33.8);
    expect(m.diskTotalGB).toBeCloseTo(60.4, 1);
    expect(m.networkRxBytes).toBe(BASE.netRxBytes);
    expect(m.loadAverage).toEqual([0.52, 0.58, 0.59]);
    expect(m.uptimeSeconds).toBe(351735);
    expect(m.activeProcesses).toBe(467);
    expect(m.reportedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("falls back to the largest listed filesystem when / is not listed, and to 0 with none", () => {
    const noRoot = sampleToSystemMetrics({ ...BASE, disks: [{ mount: "/data", totalKb: 2048 * 1024, usedKb: 1024 * 1024, usedPercent: 50 }], rootDiskUsedPercent: null }, "t");
    expect(noRoot.diskPercent).toBe(50);
    expect(noRoot.diskTotalGB).toBe(2);
    const none = sampleToSystemMetrics({ ...BASE, disks: [], rootDiskUsedPercent: null }, "t");
    expect(none.diskPercent).toBe(0);
    expect(none.diskTotalGB).toBe(0);
  });
});

describe("freshness and the servers listing overlay", () => {
  it("returns telemetry only for a sample no older than 3x the interval", () => {
    const server = makeServer("fresh");
    const now = Date.now();
    recordSampleResult(server.id, ok(new Date(now - 80_000).toISOString()));
    const env = { METRICS_INTERVAL_SECONDS: "30" } as unknown as NodeJS.ProcessEnv; // window = 90s
    expect(getFreshTelemetry(server.id, now, env)).toBeDefined();
    expect(getFreshTelemetry(server.id, now + 20_000, env)).toBeUndefined(); // 100s old
    expect(getFreshTelemetry(server.id, now + 20_000, { METRICS_INTERVAL_SECONDS: "60" } as unknown as NodeJS.ProcessEnv)).toBeDefined();
  });

  it("withTelemetry: never returns stored/demo metrics; adds metrics + health only for fresh samples", () => {
    const withSample = makeServer("overlay-fresh");
    const stale = makeServer("overlay-stale");
    const never = makeServer("overlay-never");
    const now = Date.now();
    recordSampleResult(withSample.id, ok(new Date(now - 10_000).toISOString()));
    recordSampleResult(stale.id, ok(new Date(now - 600_000).toISOString()));

    const result = withTelemetry([withSample, stale, never].map((s) => toPublicServer(s)), now, { METRICS_INTERVAL_SECONDS: "30" } as unknown as NodeJS.ProcessEnv);
    const [a, b, c] = result;

    expect(a.metrics?.cpuPercent).toBe(25);
    expect(a.health).toMatchObject({ state: "reachable", sampleAgeSeconds: 10 });
    expect(a.status).toBe("online");
    expect(a.metricsDetail).toBeDefined();
    expect(a.metricsDetail).not.toHaveProperty("processes");
    expect(a.metricsDetail).not.toHaveProperty("services");

    expect(b.metrics).toBeUndefined();
    expect(b.health?.state).toBe("reachable");
    expect(b.health?.sampleAgeSeconds).toBe(600);
    expect(b.status).not.toBe("online"); // not currently confirmed

    expect(c.metrics).toBeUndefined(); // the stored demo metrics (cpu 99) are not returned
    expect(c.health).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('"cpuPercent":99');
  });

  it("a failed check after a good one reports the failure in health but keeps the still-fresh sample", () => {
    const server = makeServer("fail-after-ok");
    const now = Date.now();
    recordSampleResult(server.id, ok(new Date(now - 20_000).toISOString()));
    recordSampleResult(server.id, { ok: false, reason: "timeout", message: "Probe timed out after 10000ms", collectedAt: new Date(now - 5_000).toISOString() });
    const [view] = withTelemetry([toPublicServer(server)], now, { METRICS_INTERVAL_SECONDS: "30" } as unknown as NodeJS.ProcessEnv);
    expect(view.health).toMatchObject({ state: "unreachable", reason: "Probe timed out after 10000ms" });
    expect(view.status).toBe("offline");
    expect(view.metrics?.cpuPercent).toBe(25);
  });

  it("getLatestView returns the full latest sample with processes and services, age and freshness", () => {
    const server = makeServer("latest");
    const now = Date.now();
    recordSampleResult(server.id, ok(new Date(now - 7_000).toISOString()));
    const latest = getLatestView(server.id, now, { METRICS_INTERVAL_SECONDS: "30" } as unknown as NodeJS.ProcessEnv);
    expect(latest.ageSeconds).toBe(7);
    expect(latest.fresh).toBe(true);
    expect(latest.sample?.processes?.length).toBeGreaterThan(0);
    expect(latest.sample?.services?.length).toBeGreaterThan(0);
    expect(latest.metrics?.cpuPercent).toBe(25);
    expect(latest.health?.state).toBe("reachable");

    const old = getLatestView(server.id, now + 1_000_000, { METRICS_INTERVAL_SECONDS: "30" } as unknown as NodeJS.ProcessEnv);
    expect(old.fresh).toBe(false);
    expect(old.sample).not.toBeNull();

    const none = getLatestView(makeServer("latest-none").id, now);
    expect(none).toMatchObject({ sample: null, collectedAt: null, ageSeconds: null, fresh: false, metrics: null, health: null });
  });
});

describe("history", () => {
  function series(count: number, stepMs: number, startMs: number, rxPerStep = 1000): Array<{ collectedAt: string; sample: MetricsSample }> {
    return Array.from({ length: count }, (_, i) => ({
      collectedAt: new Date(startMs + i * stepMs).toISOString(),
      sample: { ...BASE, cpuPercent: i % 100, netRxBytes: 1_000_000 + i * rxPerStep, netTxBytes: 500_000 + i * 500, processes: undefined, services: undefined },
    }));
  }

  it("derives network rates (bytes per second) from consecutive counters", () => {
    const rated = withRates(series(3, 10_000, Date.UTC(2026, 0, 1)));
    expect(rated[0].rxRate).toBeNull();
    expect(rated[1].rxRate).toBe(100); // 1000 bytes / 10 s
    expect(rated[1].txRate).toBe(50);
  });

  it("does not invent a rate across a counter reset or a long gap", () => {
    const s = series(4, 10_000, Date.UTC(2026, 0, 1));
    s[2] = { ...s[2], sample: { ...s[2].sample, netRxBytes: 10 } }; // reboot
    const rated = withRates(s);
    expect(rated[2].rxRate).toBeNull();
    expect(rated[3].rxRate).not.toBeNull();
    const gap = withRates([s[0], { ...s[1], collectedAt: new Date(Date.UTC(2026, 0, 1) + 3600_000).toISOString() }]);
    expect(gap[1].rxRate).toBeNull();
  });

  it("returns every point when there are at most 360 samples", () => {
    const points = downsample(series(100, 30_000, Date.UTC(2026, 0, 1)));
    expect(points).toHaveLength(100);
    expect(points[5]).toMatchObject({ cpuPercent: 5, load1: 0.52, memUsedPercent: 34.6, rootDiskUsedPercent: 33.8 });
  });

  it("downsamples 24h of 10s samples to at most 360 points by averaging buckets", () => {
    const samples = series(8640, 10_000, Date.UTC(2026, 0, 1));
    const points = downsample(samples);
    expect(points.length).toBeLessThanOrEqual(MAX_HISTORY_POINTS);
    expect(points.length).toBeGreaterThan(300);
    // Chronological, within the range, rates preserved (1000 bytes per 10 s = 100 B/s).
    for (let i = 1; i < points.length; i += 1) expect(points[i].t > points[i - 1].t).toBe(true);
    expect(points[points.length - 1].t).toBe(samples[samples.length - 1].collectedAt);
    expect(points[10].netRxBytesPerSec).toBe(100);
    expect(points[10].netTxBytesPerSec).toBe(50);
    // cpu cycles 0..99 repeatedly, so every bucket average sits well inside the range.
    for (const p of points) {
      expect(p.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(p.cpuPercent).toBeLessThanOrEqual(99);
    }
  });

  it("getHistory reads stored ok samples for the requested window", () => {
    const server = makeServer("history");
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) recordSampleResult(server.id, ok(new Date(now - (4 - i) * 60_000).toISOString(), { netRxBytes: 1000 + i * 6000 }));
    recordSampleResult(server.id, { ok: false, reason: "unreachable", message: "x", collectedAt: new Date(now).toISOString() });
    const { points, rawCount } = getHistory(server.id, 1, now);
    expect(rawCount).toBe(5);
    expect(points).toHaveLength(5);
    expect(points[1].netRxBytesPerSec).toBe(100);
    expect(getHistory(server.id, 1, now + 2 * 3600_000).rawCount).toBe(0);
  });
});
