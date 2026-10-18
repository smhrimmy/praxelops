import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, prepare } from "@/lib/db/database";
import { LATEST_VERSION } from "@/lib/db/migrations";
import { StorageService } from "@/lib/storage";
import type { ServerHost } from "@/types/server";
import { UBUNTU_2204_OUTPUT } from "./fixtures";
import { parseProbeOutput } from "./parse";
import {
  countSamples,
  getAllHealth,
  getHealth,
  getLatestOkSample,
  getLatestSample,
  getOkSamplesSince,
  pruneSamples,
  recordSampleResult,
} from "./store";
import type { MetricsSample, SampleOutcome } from "./types";

const parsed = parseProbeOutput(UBUNTU_2204_OUTPUT);
if (!parsed.ok) throw new Error("fixture must parse");
const BASE: MetricsSample = parsed.sample;

const created: string[] = [];

function makeServer(label: string): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const server: ServerHost = {
    id,
    name: `metrics-store-${label}`,
    host: `10.99.0.${created.length + 1}`,
    port: 22,
    username: "ops",
    authType: "password",
    tags: [],
    status: "checking",
    osType: "linux",
    createdAt: now,
    updatedAt: now,
  };
  (server as unknown as Record<string, unknown>).password = "pw-not-used";
  StorageService.saveServer(server);
  created.push(id);
  return id;
}

function ok(at: string, sample: MetricsSample = BASE): SampleOutcome {
  return { ok: true, sample, collectedAt: at };
}

function failed(at: string, reason: "unreachable" | "host_key_mismatch" = "unreachable", message = "boom"): SampleOutcome {
  return { ok: false, reason, message, collectedAt: at };
}

beforeAll(() => {
  // Touch the database so migrations (including migration 3) have run.
  getDb();
});

describe("migration 3: metrics tables", () => {
  it("creates metrics_samples and server_health with the required columns and indexes", () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(3);
    const db = getDb();
    const cols = (table: string): string[] => prepare(db, `PRAGMA table_info(${table})`).all().map((r) => String(r.name));
    expect(cols("metrics_samples")).toEqual(["id", "server_id", "collected_at", "ok", "reason", "data"]);
    expect(cols("server_health")).toEqual(["server_id", "last_checked_at", "last_ok_at", "state", "reason"]);
    const indexes = prepare(db, "PRAGMA index_list(metrics_samples)").all().map((r) => String(r.name));
    expect(indexes).toContain("idx_metrics_samples_server_time");
    const indexCols = prepare(db, "PRAGMA index_info(idx_metrics_samples_server_time)").all().map((r) => String(r.name));
    expect(indexCols).toEqual(["server_id", "collected_at"]);
  });
});

describe("recordSampleResult", () => {
  afterAll(() => {
    for (const id of created) StorageService.deleteServer(id);
  });

  it("stores an ok sample and a reachable health row, then reads them back validated", () => {
    const id = makeServer("basic");
    const at = new Date().toISOString();
    const result = recordSampleResult(id, ok(at));
    expect(result).toEqual({ previousState: null, state: "reachable" });
    expect(getHealth(id)).toMatchObject({ serverId: id, state: "reachable", lastCheckedAt: at, lastOkAt: at, reason: null });
    const latest = getLatestSample(id);
    expect(latest?.ok).toBe(true);
    expect(latest?.sample?.cpuPercent).toBe(25);
  });

  it("calls onTransition only when the health state changes", () => {
    const id = makeServer("transitions");
    const seen: string[] = [];
    const record = (outcome: SampleOutcome): void => {
      recordSampleResult(id, outcome, { onTransition: (t) => seen.push(`${t.previousState}->${t.state}`) });
    };
    const t0 = Date.now();
    record(ok(new Date(t0).toISOString()));
    record(ok(new Date(t0 + 1000).toISOString()));
    record(failed(new Date(t0 + 2000).toISOString()));
    record(failed(new Date(t0 + 3000).toISOString()));
    record(failed(new Date(t0 + 4000).toISOString(), "host_key_mismatch"));
    record(ok(new Date(t0 + 5000).toISOString()));
    expect(seen).toEqual(["null->reachable", "reachable->unreachable", "unreachable->host_key_mismatch", "host_key_mismatch->reachable"]);
  });

  it("keeps lastOkAt across failures and stores the failure message", () => {
    const id = makeServer("lastok");
    const t0 = Date.now();
    recordSampleResult(id, ok(new Date(t0).toISOString()));
    recordSampleResult(id, failed(new Date(t0 + 5000).toISOString(), "unreachable", "connect ECONNREFUSED"));
    const health = getHealth(id);
    expect(health?.state).toBe("unreachable");
    expect(health?.lastOkAt).toBe(new Date(t0).toISOString());
    expect(health?.lastCheckedAt).toBe(new Date(t0 + 5000).toISOString());
    expect(health?.reason).toBe("connect ECONNREFUSED");
    const latest = getLatestSample(id);
    expect(latest).toMatchObject({ ok: false, failureReason: "unreachable", message: "connect ECONNREFUSED" });
    // The newest successful sample is still available.
    expect(getLatestOkSample(id)?.collectedAt).toBe(new Date(t0).toISOString());
    expect(getAllHealth().get(id)?.state).toBe("unreachable");
  });

  it("keeps processes/services only on the latest successful sample of a server", () => {
    const id = makeServer("strip");
    const other = makeServer("strip-other");
    expect(BASE.processes?.length).toBeGreaterThan(0);
    expect(BASE.services?.length).toBeGreaterThan(0);
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 4; i += 1) recordSampleResult(id, ok(new Date(t0 + i * 1000).toISOString()));
    recordSampleResult(other, ok(new Date(t0).toISOString()));

    const rows = prepare(getDb(), "SELECT data FROM metrics_samples WHERE server_id = ? AND ok = 1 ORDER BY collected_at ASC").all(id);
    expect(rows).toHaveLength(4);
    const data = rows.map((r) => JSON.parse(String(r.data)) as Record<string, unknown>);
    for (const older of data.slice(0, 3)) {
      expect(older).not.toHaveProperty("processes");
      expect(older).not.toHaveProperty("services");
      expect(older).toHaveProperty("cpuPercent");
    }
    expect(Array.isArray(data[3].processes)).toBe(true);
    expect(Array.isArray(data[3].services)).toBe(true);

    // Older rows still validate and are returned for history; only the newest has the lists.
    const history = getOkSamplesSince(id, new Date(t0 - 1000).toISOString());
    expect(history).toHaveLength(4);
    expect(history[0].sample.processes).toBeUndefined();
    expect(history[3].sample.processes?.length).toBeGreaterThan(0);
    expect(getLatestOkSample(id)?.sample?.services?.length).toBeGreaterThan(0);

    // Another server's latest sample is untouched.
    expect(getLatestOkSample(other)?.sample?.processes?.length).toBeGreaterThan(0);
  });

  it("a failed sample does not strip the last successful sample's lists", () => {
    const id = makeServer("strip-failure");
    const t0 = Date.now() - 10_000;
    recordSampleResult(id, ok(new Date(t0).toISOString()));
    recordSampleResult(id, failed(new Date(t0 + 1000).toISOString()));
    expect(getLatestOkSample(id)?.sample?.processes?.length).toBeGreaterThan(0);
  });
});

describe("retention", () => {
  it("prunes samples older than the retention window when recording and via pruneSamples", () => {
    const id = makeServer("retention");
    const now = Date.now();
    const hours = (h: number): string => new Date(now - h * 3600_000).toISOString();
    recordSampleResult(id, ok(hours(30)), { retentionHours: 100 });
    recordSampleResult(id, ok(hours(25)), { retentionHours: 100 });
    recordSampleResult(id, ok(hours(23)), { retentionHours: 100 });
    expect(countSamples(id)).toBe(3);

    // Recording a new sample prunes with the retention it is given.
    recordSampleResult(id, ok(hours(0)), { retentionHours: 24 });
    expect(countSamples(id)).toBe(2);

    expect(pruneSamples(1, now)).toBeGreaterThanOrEqual(1);
    expect(countSamples(id)).toBe(1);
    expect(getLatestSample(id)?.collectedAt).toBe(hours(0));
  });

  it("uses 24 hours when no retention is passed", () => {
    const id = makeServer("retention-default");
    recordSampleResult(id, ok(new Date(Date.now() - 26 * 3600_000).toISOString()));
    recordSampleResult(id, ok(new Date().toISOString()));
    expect(countSamples(id)).toBe(1);
  });
});

describe("deleting a server", () => {
  it("removes its samples and its health row (cascade) and leaves other servers alone", () => {
    const id = makeServer("cascade");
    const keep = makeServer("cascade-keep");
    const t0 = Date.now();
    recordSampleResult(id, ok(new Date(t0).toISOString()));
    recordSampleResult(id, failed(new Date(t0 + 1000).toISOString()));
    recordSampleResult(keep, ok(new Date(t0).toISOString()));
    expect(countSamples(id)).toBe(2);
    expect(getHealth(id)).toBeDefined();

    expect(StorageService.deleteServer(id)).toBe(true);
    expect(countSamples(id)).toBe(0);
    expect(getHealth(id)).toBeUndefined();
    expect(countSamples(keep)).toBe(1);
    expect(getHealth(keep)).toBeDefined();
  });

  it("clearAllServers removes all metrics rows too", () => {
    const id = makeServer("clear-all");
    recordSampleResult(id, ok(new Date().toISOString()));
    StorageService.clearAllServers();
    expect(countSamples(id)).toBe(0);
    expect(getHealth(id)).toBeUndefined();
  });
});
