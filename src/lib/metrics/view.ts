import type { ServerStatus, SystemMetrics } from "@/types/server";
import type { PublicServer } from "@/lib/servers/publicServer";
import { getFreshnessWindowMs } from "./config";
import { getAllHealth, getHealth, getLatestOkSample, getOkSamplesSince, type HealthRecord } from "./store";
import type { MetricsSample, ServerHealthView } from "./types";

/**
 * Read side of the metrics pipeline: maps stored samples onto the frozen `SystemMetrics` contract and builds the
 * `health` view. Nothing here ever invents a number; when there is no fresh successful sample there are no metrics.
 */

const KIB_PER_GIB = 1024 * 1024;

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Maps a sample to the frozen SystemMetrics shape.
 *  - disk* come from the "/" filesystem; if "/" is not listed (e.g. an overlay root, which the probe excludes) the
 *    largest listed filesystem is used; with no filesystems at all they are 0.
 *  - activeProcesses is the kernel's count of scheduling entities (threads) from /proc/loadavg; SystemMetrics has no
 *    better field for it.
 */
export function sampleToSystemMetrics(sample: MetricsSample, reportedAt: string): SystemMetrics {
  const disk = sample.disks.find((d) => d.mount === "/") ?? [...sample.disks].sort((a, b) => b.totalKb - a.totalKb)[0];
  return {
    cpuPercent: sample.cpuPercent,
    memoryUsedGB: round((sample.memTotalKb - sample.memAvailableKb) / KIB_PER_GIB, 2),
    memoryTotalGB: round(sample.memTotalKb / KIB_PER_GIB, 2),
    memoryPercent: sample.memUsedPercent,
    diskUsedGB: disk ? round(disk.usedKb / KIB_PER_GIB, 2) : 0,
    diskTotalGB: disk ? round(disk.totalKb / KIB_PER_GIB, 2) : 0,
    diskPercent: disk ? disk.usedPercent : 0,
    networkRxBytes: sample.netRxBytes,
    networkTxBytes: sample.netTxBytes,
    uptimeSeconds: Math.floor(sample.uptimeSeconds),
    loadAverage: [sample.load1, sample.load5, sample.load15],
    activeProcesses: sample.totalTasks,
    reportedAt,
  };
}

export interface Telemetry {
  metrics: SystemMetrics;
  detail: MetricsSample;
  collectedAt: string;
}

export function sampleAgeSeconds(collectedAt: string, nowMs: number): number {
  return Math.max(0, Math.round((nowMs - Date.parse(collectedAt)) / 1000));
}

function healthView(health: HealthRecord, nowMs: number): ServerHealthView {
  const view: ServerHealthView = {
    state: health.state,
    lastCheckedAt: health.lastCheckedAt,
    lastOkAt: health.lastOkAt,
    sampleAgeSeconds: health.lastOkAt === null ? null : sampleAgeSeconds(health.lastOkAt, nowMs),
  };
  if (health.reason !== null) view.reason = health.reason;
  return view;
}

/**
 * The newest SUCCESSFUL sample as telemetry, only if it is no older than 3x the collection interval. A failed check
 * after a good one does not hide the good sample until it ages out; `health` tells the operator what is wrong now.
 */
export function getFreshTelemetry(serverId: string, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): Telemetry | undefined {
  const latest = getLatestOkSample(serverId);
  if (!latest || !latest.sample) return undefined;
  const collectedMs = Date.parse(latest.collectedAt);
  if (!Number.isFinite(collectedMs) || nowMs - collectedMs > getFreshnessWindowMs(env)) return undefined;
  return { metrics: sampleToSystemMetrics(latest.sample, latest.collectedAt), detail: latest.sample, collectedAt: latest.collectedAt };
}

export interface LatestView {
  /** The newest successful sample including processes and services; null if the host was never sampled successfully. */
  sample: MetricsSample | null;
  collectedAt: string | null;
  ageSeconds: number | null;
  /** True when the sample is young enough (3x interval) to be shown as current telemetry. */
  fresh: boolean;
  metrics: SystemMetrics | null;
  health: ServerHealthView | null;
}

export function getLatestView(serverId: string, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): LatestView {
  const latest = getLatestOkSample(serverId);
  const health = getHealthView(serverId, nowMs) ?? null;
  if (!latest || !latest.sample) return { sample: null, collectedAt: null, ageSeconds: null, fresh: false, metrics: null, health };
  const ageSeconds = sampleAgeSeconds(latest.collectedAt, nowMs);
  return {
    sample: latest.sample,
    collectedAt: latest.collectedAt,
    ageSeconds,
    fresh: ageSeconds * 1000 <= getFreshnessWindowMs(env),
    metrics: sampleToSystemMetrics(latest.sample, latest.collectedAt),
    health,
  };
}

export function getHealthView(serverId: string, nowMs: number = Date.now()): ServerHealthView | undefined {
  const health = getHealth(serverId);
  return health === undefined ? undefined : healthView(health, nowMs);
}

/** Server as returned by GET /api/servers: the public server plus real telemetry and health. */
export type ServerWithTelemetry = PublicServer & {
  health?: ServerHealthView;
  /** Latest sample without processes/services (disks, swap, cpu count, ...) when `metrics` is present. */
  metricsDetail?: Omit<MetricsSample, "processes" | "services">;
};

function statusFromHealth(health: HealthRecord, fresh: boolean): ServerStatus | undefined {
  switch (health.state) {
    case "reachable":
      return fresh ? "online" : undefined;
    case "unreachable":
    case "auth_failed":
    case "host_key_mismatch":
    case "error":
      return "offline";
    case "host_key_not_pinned":
    case "unsupported_os":
      return undefined;
  }
}

/**
 * Overlays real telemetry on the stored servers. The `metrics` stored inside a server record (demo seed data) is
 * never returned: `metrics` is present only for a fresh successful sample. `status` / `lastChecked` follow the health
 * row when it is conclusive; otherwise the stored values are left as they are.
 */
export function withTelemetry(servers: readonly PublicServer[], nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): ServerWithTelemetry[] {
  const healthById = getAllHealth();
  const freshWindow = getFreshnessWindowMs(env);
  return servers.map((server) => {
    const { metrics: _stored, ...rest } = server;
    void _stored;
    const result: ServerWithTelemetry = { ...rest };
    const health = healthById.get(server.id);
    if (health) {
      result.health = healthView(health, nowMs);
      const checkedAgo = nowMs - Date.parse(health.lastCheckedAt);
      const status = statusFromHealth(health, Number.isFinite(checkedAgo) && checkedAgo <= freshWindow);
      if (status !== undefined) result.status = status;
      result.lastChecked = health.lastCheckedAt;
    }
    const telemetry = getFreshTelemetry(server.id, nowMs, env);
    if (telemetry) {
      result.metrics = telemetry.metrics;
      // The listing is polled often: keep the bulky process / service lists out of it (see GET .../metrics/latest).
      const { processes: _processes, services: _services, ...detail } = telemetry.detail;
      void _processes;
      void _services;
      result.metricsDetail = detail;
    }
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

export const MAX_HISTORY_POINTS = 360;

export interface HistoryPoint {
  /** Timestamp of the last sample in the bucket. */
  t: string;
  cpuPercent: number;
  memUsedPercent: number;
  load1: number;
  rootDiskUsedPercent: number | null;
  /** Network throughput in bytes per second (derived from the cumulative counters); null if it cannot be derived. */
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
}

interface TimedSample {
  collectedAt: string;
  sample: MetricsSample;
}

interface RatedSample extends TimedSample {
  rxRate: number | null;
  txRate: number | null;
}

/** A counter delta over more than this gap is not turned into a rate (the host was not being sampled). */
const MAX_RATE_GAP_MS = 15 * 60 * 1000;

/** Adds per-second network rates from consecutive samples; null for the first sample, a counter reset or a long gap. */
export function withRates(samples: readonly TimedSample[]): RatedSample[] {
  return samples.map((entry, i) => {
    const prev = i > 0 ? samples[i - 1] : undefined;
    if (!prev) return { ...entry, rxRate: null, txRate: null };
    const dtMs = Date.parse(entry.collectedAt) - Date.parse(prev.collectedAt);
    if (!(dtMs > 0) || dtMs > MAX_RATE_GAP_MS) return { ...entry, rxRate: null, txRate: null };
    const rate = (cur: number, before: number): number | null => (cur >= before ? round(((cur - before) * 1000) / dtMs, 1) : null);
    return { ...entry, rxRate: rate(entry.sample.netRxBytes, prev.sample.netRxBytes), txRate: rate(entry.sample.netTxBytes, prev.sample.netTxBytes) };
  });
}

function pointOf(entry: RatedSample): HistoryPoint {
  const s = entry.sample;
  return {
    t: entry.collectedAt,
    cpuPercent: s.cpuPercent,
    memUsedPercent: s.memUsedPercent,
    load1: s.load1,
    rootDiskUsedPercent: s.rootDiskUsedPercent,
    netRxBytesPerSec: entry.rxRate,
    netTxBytesPerSec: entry.txRate,
  };
}

function mean(values: readonly number[], digits: number): number | null {
  return values.length === 0 ? null : round(values.reduce((a, b) => a + b, 0) / values.length, digits);
}

function nonNull(values: ReadonlyArray<number | null>): number[] {
  return values.filter((v): v is number => v !== null);
}

/**
 * Reduces samples (oldest first) to at most `maxPoints` points by splitting the time range into equal buckets and
 * averaging every metric inside a bucket (network rates ignore unknown values). The point's timestamp is the last
 * sample of the bucket. Empty buckets produce no point.
 */
export function downsample(samples: readonly TimedSample[], maxPoints: number = MAX_HISTORY_POINTS): HistoryPoint[] {
  const rated = withRates(samples);
  if (rated.length <= maxPoints) return rated.map(pointOf);
  const first = Date.parse(rated[0].collectedAt);
  const last = Date.parse(rated[rated.length - 1].collectedAt);
  const span = Math.max(1, last - first + 1);
  const bucketMs = span / maxPoints;
  const buckets = new Map<number, RatedSample[]>();
  for (const entry of rated) {
    const index = Math.min(maxPoints - 1, Math.floor((Date.parse(entry.collectedAt) - first) / bucketMs));
    const bucket = buckets.get(index);
    if (bucket) bucket.push(entry);
    else buckets.set(index, [entry]);
  }
  const points: HistoryPoint[] = [];
  for (const index of [...buckets.keys()].sort((a, b) => a - b)) {
    const bucket = buckets.get(index) ?? [];
    const lastEntry = bucket[bucket.length - 1];
    points.push({
      t: lastEntry.collectedAt,
      cpuPercent: mean(bucket.map((e) => e.sample.cpuPercent), 2) ?? 0,
      memUsedPercent: mean(bucket.map((e) => e.sample.memUsedPercent), 2) ?? 0,
      load1: mean(bucket.map((e) => e.sample.load1), 2) ?? 0,
      rootDiskUsedPercent: mean(nonNull(bucket.map((e) => e.sample.rootDiskUsedPercent)), 2),
      netRxBytesPerSec: mean(nonNull(bucket.map((e) => e.rxRate)), 1),
      netTxBytesPerSec: mean(nonNull(bucket.map((e) => e.txRate)), 1),
    });
  }
  return points;
}

export function getHistory(serverId: string, hours: number, nowMs: number = Date.now()): { points: HistoryPoint[]; rawCount: number } {
  const since = new Date(nowMs - hours * 3600 * 1000).toISOString();
  const samples = getOkSamplesSince(serverId, since);
  return { points: downsample(samples), rawCount: samples.length };
}
