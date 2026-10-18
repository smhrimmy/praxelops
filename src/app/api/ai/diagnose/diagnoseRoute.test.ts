import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as diagnosePost } from "@/app/api/ai/diagnose/route";
import { createOperator } from "@/lib/security/operators";
import { StorageService } from "@/lib/storage";
import { UBUNTU_2204_OUTPUT } from "@/lib/metrics/fixtures";
import { parseProbeOutput } from "@/lib/metrics/parse";
import { recordSampleResult } from "@/lib/metrics/store";
import type { ServerDiagnosticReport } from "@/types/ai";
import type { ServerHost } from "@/types/server";

const ORIGIN = "http://localhost:3000";
const USERNAME = "diagnose-route-operator";
const PASSWORD = "diagnose route operator pass 123";

const parsed = parseProbeOutput(UBUNTU_2204_OUTPUT);
if (!parsed.ok) throw new Error("fixture must parse");
const SAMPLE = parsed.sample;

let cookie = "";
let csrf = "";
const createdIds: string[] = [];

function register(label: string, storedCpu?: number): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const record: ServerHost = {
    id,
    name: `diagnose-${label}`,
    host: `203.0.113.${createdIds.length + 10}`,
    port: 22,
    username: "ops",
    authType: "password",
    tags: [],
    status: "online",
    osType: "linux",
    createdAt: now,
    updatedAt: now,
  };
  if (storedCpu !== undefined) {
    // Demo-style metrics stored on the record itself: the diagnosis must ignore them.
    record.metrics = {
      cpuPercent: storedCpu,
      memoryUsedGB: 1,
      memoryTotalGB: 2,
      memoryPercent: 50,
      diskUsedGB: 1,
      diskTotalGB: 2,
      diskPercent: 50,
      networkRxBytes: 0,
      networkTxBytes: 0,
      uptimeSeconds: 10,
      loadAverage: [0, 0, 0],
      activeProcesses: 1,
      reportedAt: now,
    };
  }
  (record as unknown as Record<string, unknown>).password = "diag-pass-7788";
  StorageService.saveServer(record);
  createdIds.push(id);
  return id;
}

async function diagnose(serverId: string): Promise<ServerDiagnosticReport> {
  const res = await diagnosePost(
    new Request("http://localhost:3000/api/ai/diagnose", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ serverId }),
    })
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("diag-pass-7788");
  return (JSON.parse(text) as { data: ServerDiagnosticReport }).data;
}

beforeAll(async () => {
  await createOperator(USERNAME, PASSWORD);
  const login = await loginPost(
    new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.95", origin: ORIGIN },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    })
  );
  csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
  cookie = `praxel_session=${(login.headers.get("set-cookie") ?? "").match(/praxel_session=([^;]+)/)![1]}`;
});

afterAll(() => {
  for (const id of createdIds) StorageService.deleteServer(id);
});

describe("POST /api/ai/diagnose uses real collected telemetry", () => {
  it("analyses the latest fresh sample (a CPU-saturated host is flagged with the sampled value)", async () => {
    const id = register("hot");
    recordSampleResult(id, { ok: true, collectedAt: new Date(Date.now() - 5_000).toISOString(), sample: { ...SAMPLE, cpuPercent: 97.3, memUsedPercent: 40 } });
    const report = await diagnose(id);
    const cpu = report.anomalies.find((a) => a.category === "cpu");
    expect(cpu?.severity).toBe("critical");
    expect(cpu?.metricValue).toBe("97.3%");
    expect(report.summary).not.toMatch(/No live telemetry/);
  });

  it("ignores metrics stored on the server record (demo data) in favour of the real sample", async () => {
    const id = register("calm", 99); // the record claims 99% CPU, the real sample says 25%
    recordSampleResult(id, { ok: true, collectedAt: new Date().toISOString(), sample: SAMPLE });
    const report = await diagnose(id);
    expect(report.anomalies.find((a) => a.category === "cpu")).toBeUndefined();
    expect(report.healthScore).toBeGreaterThan(80);
  });

  it("without any sample it says honestly that there is no telemetry, even if the record has stored metrics", async () => {
    const id = register("never", 99);
    const report = await diagnose(id);
    expect(report.summary).toMatch(/No live telemetry available/);
    expect(report.summary).toMatch(/no metrics sample has been collected/);
    expect(report.anomalies.some((a) => a.category === "cpu")).toBe(false);
    expect(report.proposals).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("99%");
  });

  it("with only failures it reports the health reason instead of numbers", async () => {
    const id = register("unpinned");
    recordSampleResult(id, {
      ok: false,
      reason: "host_key_not_pinned",
      message: "Host key not yet verified - open a terminal session to this server first.",
      collectedAt: new Date().toISOString(),
    });
    const report = await diagnose(id);
    expect(report.summary).toMatch(/No live telemetry available/);
    expect(report.summary).toContain("Host key not yet verified");
    expect(report.anomalies[0].detail).toContain("Host key not yet verified");
    expect(report.proposals).toEqual([]);
  });

  it("treats a sample older than 3x the interval as no telemetry", async () => {
    const id = register("stale");
    recordSampleResult(id, { ok: true, collectedAt: new Date(Date.now() - 20 * 60_000).toISOString(), sample: { ...SAMPLE, cpuPercent: 99 } });
    const report = await diagnose(id);
    expect(report.summary).toMatch(/No live telemetry available/);
    expect(report.summary).toMatch(/too old to analyse/);
    expect(report.anomalies.some((a) => a.category === "cpu")).toBe(false);
  });
});
