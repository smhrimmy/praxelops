import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as serversGet } from "@/app/api/servers/route";
import { GET as historyGet } from "@/app/api/servers/[id]/metrics/route";
import { GET as latestGet } from "@/app/api/servers/[id]/metrics/latest/route";
import { POST as refreshPost } from "@/app/api/servers/[id]/metrics/refresh/route";
import { createOperator } from "@/lib/security/operators";
import { withTransaction } from "@/lib/db/database";
import { StorageService } from "@/lib/storage";
import { SSHAdapter } from "@/lib/ssh/adapter";
import { startTestSshServer, type TestSshServerInstance } from "@/lib/ssh/testSshServer";
import { UBUNTU_2204_OUTPUT } from "@/lib/metrics/fixtures";
import { parseProbeOutput } from "@/lib/metrics/parse";
import { recordSampleResult } from "@/lib/metrics/store";
import type { ServerHost } from "@/types/server";

const ORIGIN = "http://localhost:3000";
const SSH_USER = "route-user";
const SSH_PASS = "route-ssh-pass-4471";
const SECRET_KEYS = /"(password|privateKey|passphrase)"\s*:/;

interface Session {
  cookie: string;
  csrf: string;
}

async function login(username: string, password: string, ip: string): Promise<Session> {
  await createOperator(username, password);
  const res = await loginPost(
    new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip, origin: ORIGIN },
      body: JSON.stringify({ username, password }),
    })
  );
  expect(res.status).toBe(200);
  const csrf = ((await res.json()) as { csrfToken: string }).csrfToken;
  const match = (res.headers.get("set-cookie") ?? "").match(/praxel_session=([^;]+)/);
  expect(match).not.toBeNull();
  return { cookie: `praxel_session=${match![1]}`, csrf };
}

const parsed = parseProbeOutput(UBUNTU_2204_OUTPUT);
if (!parsed.ok) throw new Error("fixture must parse");
const SAMPLE = parsed.sample;

let session: Session;
let ssh: TestSshServerInstance;
let pinnedId = "";
let unpinnedId = "";
let neverId = "";
const createdIds: string[] = [];

function register(host: string, port: number, extra: Partial<ServerHost> = {}): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const record: ServerHost = {
    id,
    name: `routes-${id.slice(0, 6)}`,
    host,
    port,
    username: SSH_USER,
    authType: "password",
    tags: [],
    status: "checking",
    osType: "linux",
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  (record as unknown as Record<string, unknown>).password = SSH_PASS;
  StorageService.saveServer(record);
  createdIds.push(id);
  return id;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function getReq(path: string, s: Session | null = session): Request {
  return new Request(`http://localhost:3000${path}`, { headers: s ? { cookie: s.cookie, origin: ORIGIN } : {} });
}

function postReq(path: string, s: Session | null = session, withCsrf = true): Request {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (s) headers.cookie = s.cookie;
  if (s && withCsrf) headers["x-csrf-token"] = s.csrf;
  return new Request(`http://localhost:3000${path}`, { method: "POST", headers });
}

beforeAll(async () => {
  session = await login("metrics-routes-operator", "metrics routes operator pass 123", "203.0.113.90");
  ssh = await startTestSshServer({ username: SSH_USER, password: SSH_PASS });
  pinnedId = register("127.0.0.1", ssh.port);
  const pinnedServer = StorageService.getServerById(pinnedId) as ServerHost;
  // Pin the key like an interactive session does (trust on first use through the normal adapter path).
  await SSHAdapter.executeCommand(pinnedServer, "uname -a", 10_000);

  const second = await startTestSshServer({ username: SSH_USER, password: SSH_PASS });
  unpinnedId = register("127.0.0.1", second.port);
  neverId = register("192.0.2.77", 22);
  afterAllClosers.push(() => second.close());
});

const afterAllClosers: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const id of createdIds) StorageService.deleteServer(id);
  await ssh.close();
  await Promise.all(afterAllClosers.map((close) => close()));
});

describe("authentication on the metrics routes", () => {
  it("rejects unauthenticated requests", async () => {
    expect((await serversGet(getReq("/api/servers", null))).status).toBe(401);
    expect((await historyGet(getReq(`/api/servers/${pinnedId}/metrics`, null), params(pinnedId))).status).toBe(401);
    expect((await latestGet(getReq(`/api/servers/${pinnedId}/metrics/latest`, null), params(pinnedId))).status).toBe(401);
    expect((await refreshPost(postReq(`/api/servers/${pinnedId}/metrics/refresh`, null), params(pinnedId))).status).toBe(401);
  });

  it("refresh requires the CSRF token and a matching Origin", async () => {
    const noCsrf = await refreshPost(postReq(`/api/servers/${pinnedId}/metrics/refresh`, session, false), params(pinnedId));
    expect(noCsrf.status).toBe(403);
    const badOrigin = await refreshPost(
      new Request("http://localhost:3000/x", { method: "POST", headers: { cookie: session.cookie, "x-csrf-token": session.csrf, origin: "https://evil.example" } }),
      params(pinnedId)
    );
    expect(badOrigin.status).toBe(403);
    expect(ssh.execCommands.filter((c) => c.startsWith("env LC_ALL=C"))).toHaveLength(0); // nothing ran
  });

  it("returns 404 for an unknown server on every route", async () => {
    const missing = "00000000-0000-4000-8000-0000000000aa";
    expect((await historyGet(getReq(`/api/servers/${missing}/metrics`), params(missing))).status).toBe(404);
    expect((await latestGet(getReq(`/api/servers/${missing}/metrics/latest`), params(missing))).status).toBe(404);
    expect((await refreshPost(postReq(`/api/servers/${missing}/metrics/refresh`), params(missing))).status).toBe(404);
  });
});

describe("POST /api/servers/[id]/metrics/refresh", () => {
  it("unpinned host: ok:false host_key_not_pinned, nothing contacted, nothing enrolled", async () => {
    const res = await refreshPost(postReq(`/api/servers/${unpinnedId}/metrics/refresh`), params(unpinnedId));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(SECRET_KEYS);
    expect(text).not.toContain(SSH_PASS);
    const body = JSON.parse(text) as { success: boolean; data: { ok: boolean; reason: string; stored: boolean; health: { state: string } } };
    expect(body.data).toMatchObject({ ok: false, reason: "host_key_not_pinned", stored: true });
    expect(body.data.health.state).toBe("host_key_not_pinned");
  });

  it("pinned host: samples now, stores the result and returns metrics + sample", async () => {
    const res = await refreshPost(postReq(`/api/servers/${pinnedId}/metrics/refresh`), params(pinnedId));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(SECRET_KEYS);
    expect(text).not.toContain(SSH_PASS);
    const body = JSON.parse(text) as {
      data: { ok: boolean; stored: boolean; metrics: { cpuPercent: number }; sample: { cpuPercent: number; processes: unknown[] }; health: { state: string; sampleAgeSeconds: number } };
    };
    expect(body.data.ok).toBe(true);
    expect(body.data.stored).toBe(true);
    expect(body.data.metrics.cpuPercent).toBe(25);
    expect(body.data.sample.processes.length).toBeGreaterThan(0);
    expect(body.data.health).toMatchObject({ state: "reachable", sampleAgeSeconds: 0 });
  });

  it("is rate limited per operator", async () => {
    const other = await login("metrics-routes-ratelimit", "metrics routes ratelimit pass 123", "203.0.113.91");
    const missing = "00000000-0000-4000-8000-0000000000bb";
    let last = 0;
    for (let i = 0; i < 40; i += 1) {
      last = (await refreshPost(postReq(`/api/servers/${missing}/metrics/refresh`, other), params(missing))).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe("GET /api/servers with telemetry", () => {
  it("gives each server health and the latest fresh sample as metrics, never credentials", async () => {
    const res = await serversGet(getReq("/api/servers"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(SECRET_KEYS);
    expect(text).not.toContain(SSH_PASS);
    const body = JSON.parse(text) as {
      data: Array<{ id: string; metrics?: { cpuPercent: number; memoryPercent: number; diskPercent: number }; health?: { state: string; sampleAgeSeconds: number | null; lastCheckedAt: string }; metricsDetail?: Record<string, unknown> }>;
    };
    const pinned = body.data.find((s) => s.id === pinnedId);
    expect(pinned?.metrics).toMatchObject({ cpuPercent: 25, memoryPercent: 34.6, diskPercent: 33.8 });
    expect(pinned?.health?.state).toBe("reachable");
    expect(pinned?.health?.sampleAgeSeconds).toBeLessThan(30);
    expect(pinned?.metricsDetail).not.toHaveProperty("processes");

    const unpinned = body.data.find((s) => s.id === unpinnedId);
    expect(unpinned?.metrics).toBeUndefined();
    expect(unpinned?.health).toMatchObject({ state: "host_key_not_pinned", sampleAgeSeconds: null });

    const never = body.data.find((s) => s.id === neverId);
    expect(never?.metrics).toBeUndefined();
    expect(never?.health).toBeUndefined();
  });
});

describe("GET /api/servers/[id]/metrics/latest", () => {
  it("returns the full latest sample with processes, services, age, freshness and health", async () => {
    const res = await latestGet(getReq(`/api/servers/${pinnedId}/metrics/latest`), params(pinnedId));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(SECRET_KEYS);
    const body = JSON.parse(text) as {
      data: { serverId: string; fresh: boolean; ageSeconds: number; sample: { processes: Array<{ command: string }>; services: Array<{ unit: string }>; disks: unknown[] }; health: { state: string } };
    };
    expect(body.data.serverId).toBe(pinnedId);
    expect(body.data.fresh).toBe(true);
    expect(body.data.ageSeconds).toBeLessThan(30);
    expect(body.data.sample.processes[0].command).toBe("postgres");
    expect(body.data.sample.services.some((s) => s.unit === "nginx.service")).toBe(true);
    expect(body.data.sample.disks.length).toBe(2);
    expect(body.data.health.state).toBe("reachable");
  });

  it("returns sample:null (nothing invented) for a host that was never sampled", async () => {
    const res = await latestGet(getReq(`/api/servers/${neverId}/metrics/latest`), params(neverId));
    const body = (await res.json()) as { data: { sample: unknown; fresh: boolean; ageSeconds: unknown; metrics: unknown; health: unknown } };
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ sample: null, fresh: false, ageSeconds: null, metrics: null, health: null });
  });
});

describe("GET /api/servers/[id]/metrics (history)", () => {
  it("validates hours (1..24, default 1)", async () => {
    for (const hours of ["0", "25", "abc", "1.5", "-3"]) {
      const res = await historyGet(getReq(`/api/servers/${pinnedId}/metrics?hours=${hours}`), params(pinnedId));
      expect(res.status, `hours=${hours}`).toBe(400);
    }
    const def = await historyGet(getReq(`/api/servers/${pinnedId}/metrics`), params(pinnedId));
    expect(((await def.json()) as { data: { hours: number } }).data.hours).toBe(1);
  });

  it("downsamples to at most 360 points and exposes rates, not raw counters", async () => {
    const id = register("198.51.100.20", 22);
    const now = Date.now();
    const total = 2000; // ~ 5.5 hours at 10 s
    withTransaction(() => {
    for (let i = 0; i < total; i += 1) {
      const at = new Date(now - (total - 1 - i) * 10_000).toISOString();
      recordSampleResult(
        id,
        { ok: true, collectedAt: at, sample: { ...SAMPLE, cpuPercent: i % 100, netRxBytes: 5_000_000 + i * 2_000, netTxBytes: 1_000_000 + i * 500, processes: undefined, services: undefined } },
        { retentionHours: 24 }
      );
    }
    });
    const res = await historyGet(getReq(`/api/servers/${id}/metrics?hours=24`), params(id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { hours: number; rawCount: number; maxPoints: number; points: Array<Record<string, unknown>> };
    };
    expect(body.data.rawCount).toBe(total);
    expect(body.data.maxPoints).toBe(360);
    expect(body.data.points.length).toBeLessThanOrEqual(360);
    expect(body.data.points.length).toBeGreaterThan(300);
    const point = body.data.points[50];
    expect(Object.keys(point).sort()).toEqual(["cpuPercent", "load1", "memUsedPercent", "netRxBytesPerSec", "netTxBytesPerSec", "rootDiskUsedPercent", "t"]);
    expect(point.netRxBytesPerSec).toBe(200); // 2000 bytes per 10 s
    expect(point.netTxBytesPerSec).toBe(50);
    expect(point.rootDiskUsedPercent).toBe(33.8);

    // A shorter window only returns samples inside it.
    const oneHour = (await (await historyGet(getReq(`/api/servers/${id}/metrics?hours=1`), params(id))).json()) as { data: { rawCount: number; points: unknown[] } };
    expect(oneHour.data.rawCount).toBeGreaterThanOrEqual(355);
    expect(oneHour.data.rawCount).toBeLessThanOrEqual(361);
    expect(oneHour.data.points.length).toBeLessThanOrEqual(360);
  });
});
