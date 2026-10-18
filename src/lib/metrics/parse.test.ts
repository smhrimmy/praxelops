import { describe, expect, it } from "vitest";
import {
  ALPINE_319_OUTPUT,
  DEBIAN_12_OUTPUT,
  DEBIAN_12_PARTS,
  UBUNTU_2204_OUTPUT,
  UBUNTU_2204_PARTS,
  assembleProbeOutput,
  nonLinuxProbeOutput,
  type ProbeParts,
} from "./fixtures";
import { MAX_PROBE_OUTPUT_BYTES, parseProbeOutput, parseProcesses, parseServices } from "./parse";
import { MetricsSampleSchema, type MetricsSample } from "./types";

function mustParse(output: string): MetricsSample {
  const result = parseProbeOutput(output);
  if (!result.ok) throw new Error(`expected a sample, got ${result.reason}: ${result.message}`);
  return result.sample;
}

function mustFail(output: string): string {
  const result = parseProbeOutput(output);
  if (result.ok) throw new Error("expected a parse failure");
  expect(result.reason).toBe("parse_error");
  return result.message;
}

function withPart(base: ProbeParts, part: Partial<ProbeParts>): string {
  return assembleProbeOutput({ ...base, ...part });
}

describe("parseProbeOutput: Ubuntu 22.04 (GNU df already filtered)", () => {
  const sample = mustParse(UBUNTU_2204_OUTPUT);

  it("computes CPU % from the two /proc/stat lines", () => {
    // deltas: user +80, system +20, idle +290, iowait +10 -> busy 100 of 400
    expect(sample.cpuPercent).toBe(25);
  });

  it("reads load, cpu count, uptime and task counts", () => {
    expect([sample.load1, sample.load5, sample.load15]).toEqual([0.52, 0.58, 0.59]);
    expect(sample.cpuCount).toBe(4);
    expect(sample.uptimeSeconds).toBeCloseTo(351735.47, 2);
    expect(sample.runningTasks).toBe(1);
    expect(sample.totalTasks).toBe(467);
  });

  it("derives memory and swap from /proc/meminfo", () => {
    expect(sample.memTotalKb).toBe(8142344);
    expect(sample.memAvailableKb).toBe(5321672);
    expect(sample.memUsedPercent).toBe(34.6);
    expect(sample.swapTotalKb).toBe(2097148);
    expect(sample.swapFreeKb).toBe(2097148);
  });

  it("lists local disks with df's used/(used+avail) convention and finds the root disk", () => {
    expect(sample.disks).toEqual([
      { mount: "/", totalKb: 63341436, usedKb: 21405968, usedPercent: 33.8 },
      { mount: "/boot/efi", totalKb: 106858, usedKb: 6186, usedPercent: 5.8 },
    ]);
    expect(sample.rootDiskUsedPercent).toBe(33.8);
  });

  it("sums network counters over all interfaces except lo", () => {
    expect(sample.netRxBytes).toBe(8482934021 + 1129382); // eth0 + docker0
    expect(sample.netTxBytes).toBe(1923847211);
  });

  it("produces output that satisfies the sample schema", () => {
    expect(MetricsSampleSchema.safeParse(sample).success).toBe(true);
  });
});

describe("parseProbeOutput: Debian 12 (plain df -kP fallback, no swap)", () => {
  const sample = mustParse(DEBIAN_12_OUTPUT);

  it("drops udev, tmpfs and /dev/shm rows from df", () => {
    expect(sample.disks.map((d) => d.mount)).toEqual(["/", "/boot/efi"]);
    expect(sample.rootDiskUsedPercent).toBe(16.9);
  });

  it("handles a host without swap", () => {
    expect(sample.swapTotalKb).toBe(0);
    expect(sample.swapFreeKb).toBe(0);
    expect(sample.cpuCount).toBe(2);
    expect(sample.cpuPercent).toBe(50);
    expect(sample.memUsedPercent).toBe(66);
  });

  it("excludes lo from the network totals", () => {
    expect(sample.netRxBytes).toBe(412983220);
    expect(sample.netTxBytes).toBe(98212003);
  });
});

describe("parseProbeOutput: Alpine 3.19 (busybox df header, overlay/shm mounts)", () => {
  const sample = mustParse(ALPINE_319_OUTPUT);

  it("accepts the busybox df header and filters devtmpfs, shm, tmpfs and overlay", () => {
    expect(sample.disks.map((d) => d.mount)).toEqual(["/", "/boot"]);
    expect(sample.rootDiskUsedPercent).toBe(45);
  });

  it("computes cpu and memory", () => {
    expect(sample.cpuPercent).toBe(12.5);
    expect(sample.memUsedPercent).toBe(60);
    expect(sample.swapTotalKb).toBe(524284);
  });
});

describe("parseProbeOutput: df handling", () => {
  it("excludes tmpfs/devtmpfs/overlay/squashfs and system mount points, collapses duplicate devices", () => {
    const df = `Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/sda2         50000000 10000000  37000000      22% /
tmpfs               800000     1000    799000       1% /run
devtmpfs            700000       0    700000       0% /dev
overlay           50000000 10000000  37000000      22% /var/lib/docker/overlay2/abc/merged
/dev/loop0           56832   56832         0     100% /snap/core20/1974
squashfs             56832   56832         0     100% /mnt/squash
/dev/sda2         50000000 10000000  37000000      22% /var/lib/docker
/dev/sdb1        200000000 90000000 100000000      47% /data
/dev/sdc1           100000        0    100000       0% /mnt/with space`;
    const sample = mustParse(withPart(UBUNTU_2204_PARTS, { df }));
    // loop0 is under /snap (excluded); sda2 appears once; root first, then largest first.
    expect(sample.disks.map((d) => d.mount)).toEqual(["/", "/data", "/mnt/with space"]);
    expect(sample.rootDiskUsedPercent).toBe(21.3);
  });

  it("reports rootDiskUsedPercent as null when / is not a listed filesystem", () => {
    const df = `Filesystem 1024-blocks Used Available Capacity Mounted on
overlay 50000000 10000000 37000000 22% /
/dev/sdb1 200000000 90000000 100000000 47% /data`;
    const sample = mustParse(withPart(UBUNTU_2204_PARTS, { df }));
    expect(sample.disks.map((d) => d.mount)).toEqual(["/data"]);
    expect(sample.rootDiskUsedPercent).toBeNull();
  });

  it("caps the disk list at 20 entries", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `/dev/sdx${i} ${1000 + i} 100 ${900 + i} 10% /mnt/d${i}`);
    const df = ["Filesystem 1024-blocks Used Available Capacity Mounted on", "/dev/root 5000 1000 4000 20% /", ...rows].join("\n");
    const sample = mustParse(withPart(UBUNTU_2204_PARTS, { df }));
    expect(sample.disks).toHaveLength(20);
    expect(sample.disks[0].mount).toBe("/");
  });

  it("skips zero-sized filesystems (capacity '-')", () => {
    const df = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1 1000 500 500 50% /
fusectl 0 0 0 - /mnt/fuse`;
    expect(mustParse(withPart(UBUNTU_2204_PARTS, { df })).disks.map((d) => d.mount)).toEqual(["/"]);
  });
});

describe("parseProbeOutput: CPU percent", () => {
  const cases: Array<[string, string, string, number]> = [
    ["idle host", "cpu  100 0 100 1000 0 0 0 0 0 0", "cpu  100 0 100 1100 0 0 0 0 0 0", 0],
    ["fully busy", "cpu  100 0 100 1000 0 0 0 0 0 0", "cpu  200 0 100 1000 0 0 0 0 0 0", 100],
    ["counts iowait as idle", "cpu  100 0 100 1000 100 0 0 0 0 0", "cpu  150 0 100 1000 150 0 0 0 0 0", 50],
    ["counts steal as busy", "cpu  100 10 100 1000 0 0 0 0 0 0", "cpu  100 10 100 1050 0 0 0 50 0 0", 50],
    ["rounds to one decimal", "cpu  0 0 0 0 0 0 0 0", "cpu  1 0 0 2 0 0 0 0", 33.3],
  ];
  it.each(cases)("%s", (_name, stat1, stat2, expected) => {
    expect(mustParse(withPart(UBUNTU_2204_PARTS, { stat1, stat2 })).cpuPercent).toBe(expected);
  });

  it("rejects counters that do not advance or go backwards", () => {
    const same = "cpu  100 0 100 1000 0 0 0 0 0 0";
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { stat1: same, stat2: same }))).toMatch(/did not advance/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { stat1: "cpu  500 0 0 1000 0 0 0 0", stat2: "cpu  100 0 0 900 0 0 0 0" }))).toMatch(/did not advance/);
  });

  it("rejects a cpu line with too few or non-numeric counters", () => {
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { stat1: "cpu  1 2 3" }))).toMatch(/at least 8 counters/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { stat2: "cpu  1 2 x 4 5 6 7 8" }))).toMatch(/expected an integer/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { stat1: "cpu0 1 2 3 4 5 6 7 8 9" }))).toMatch(/aggregate cpu line/);
  });
});

describe("parseProbeOutput: unsupported operating systems", () => {
  it.each(["Darwin", "FreeBSD", "SunOS", "MINGW64_NT-10.0-19045"])("%s -> unsupported_os with the OS name and no parsing", (os) => {
    const result = parseProbeOutput(nonLinuxProbeOutput(os));
    expect(result).toMatchObject({ ok: false, reason: "unsupported_os", os });
    if (!result.ok) expect(result.message).toContain(os);
  });

  it("sanitises a hostile OS name", () => {
    const result = parseProbeOutput(nonLinuxProbeOutput("Evil\u001b[31mOS with spaces and a very long tail ".repeat(5)));
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "unsupported_os") {
      expect(result.os).not.toMatch(/[\u0000-\u001f\s]/);
      expect(result.os.length).toBeLessThanOrEqual(32);
    }
  });
});

describe("parseProbeOutput: malformed and partial input is a parse error, never invented numbers", () => {
  it("rejects empty output and output without a recognisable section", () => {
    mustFail("");
    mustFail("bash: env: command not found\n");
    mustFail("@@praxel:end\n");
  });

  it("rejects truncated output (missing end marker)", () => {
    const truncated = UBUNTU_2204_OUTPUT.replace(/@@praxel:end\n$/, "");
    expect(mustFail(truncated)).toMatch(/truncated/);
    expect(mustFail(UBUNTU_2204_OUTPUT.slice(0, 400))).toMatch(/truncated/);
  });

  it.each(["uptime", "loadavg", "nproc", "stat1", "stat2", "meminfo", "df", "netdev"] as const)("rejects a missing '%s' section", (name) => {
    const output = UBUNTU_2204_OUTPUT.replace(new RegExp(`@@praxel:${name}\\n`), "");
    // Without its marker the body merges into the previous section, which then fails its own strict checks.
    mustFail(output);
  });

  it("rejects an empty section body", () => {
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { loadavg: "" }))).toMatch(/exactly one line/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { meminfo: "" }))).toMatch(/MemTotal/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { netdev: "" }))).toMatch(/no interfaces/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { df: "" }))).toMatch(/header/);
  });

  it("rejects malformed numbers", () => {
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { loadavg: "abc 0.5 0.5 1/100 1" }))).toMatch(/load1/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { loadavg: "0.1 0.2 0.3 NaN 1" }))).toMatch(/running\/total/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { uptime: "-5.0 3.0" }))).toMatch(/uptime/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { uptime: "123" }))).toMatch(/two fields/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { nproc: "four" }))).toMatch(/nproc/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { nproc: "0" }))).toMatch(/cpuCount/);
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { nproc: "4\n8" }))).toMatch(/exactly one line/);
  });

  it("rejects /proc/meminfo without MemAvailable / swap fields or with inconsistent values", () => {
    const noAvailable = UBUNTU_2204_PARTS.meminfo.replace(/MemAvailable:.*\n/, "");
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { meminfo: noAvailable }))).toMatch(/MemAvailable/);
    const noSwap = UBUNTU_2204_PARTS.meminfo.replace(/SwapFree:.*\n/, "");
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { meminfo: noSwap }))).toMatch(/SwapFree/);
    const availableTooBig = UBUNTU_2204_PARTS.meminfo.replace(/MemAvailable:\s+\d+/, "MemAvailable: 99999999");
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { meminfo: availableTooBig }))).toMatch(/validation failed/);
    const zeroTotal = UBUNTU_2204_PARTS.meminfo.replace(/MemTotal:\s+\d+/, "MemTotal: 0");
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { meminfo: zeroTotal }))).toMatch(/MemTotal is zero/);
  });

  it("rejects malformed df and /proc/net/dev rows", () => {
    const badDf = `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 lots used free 50% /`;
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { df: badDf }))).toMatch(/malformed row/);
    const truncatedDf = `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 500 500 50%`;
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { df: truncatedDf }))).toMatch(/malformed row/);
    const badNet = `${UBUNTU_2204_PARTS.netdev}\n  eth1: 1 2 3`;
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { netdev: badNet }))).toMatch(/malformed row for 'eth1'/);
    const noColon = `${UBUNTU_2204_PARTS.netdev}\n garbage line`;
    expect(mustFail(withPart(UBUNTU_2204_PARTS, { netdev: noColon }))).toMatch(/malformed row/);
  });

  it("rejects duplicate or unknown sections and oversized output", () => {
    expect(mustFail(UBUNTU_2204_OUTPUT.replace("@@praxel:nproc", "@@praxel:uptime"))).toMatch(/duplicate section/);
    expect(mustFail(UBUNTU_2204_OUTPUT.replace("@@praxel:nproc", "@@praxel:evil"))).toMatch(/unknown section/);
    expect(mustFail("x".repeat(MAX_PROBE_OUTPUT_BYTES + 1))).toMatch(/size limit/);
  });

  it("ignores a login banner before the first marker and tolerates CRLF line endings", () => {
    const withBanner = `Welcome to Ubuntu!\nLast login: yesterday\n${UBUNTU_2204_OUTPUT}`;
    expect(mustParse(withBanner)).toEqual(mustParse(UBUNTU_2204_OUTPUT));
    expect(mustParse(UBUNTU_2204_OUTPUT.replace(/\n/g, "\r\n"))).toEqual(mustParse(UBUNTU_2204_OUTPUT));
  });

  it("never returns a partial sample: ok:false carries no sample", () => {
    const result = parseProbeOutput(withPart(UBUNTU_2204_PARTS, { stat2: "cpu  garbage" }));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("sample");
  });
});

describe("parseProbeOutput: processes (ps)", () => {
  it("parses the top processes, including a command name with spaces", () => {
    const sample = mustParse(UBUNTU_2204_OUTPUT);
    expect(sample.processes).toHaveLength(5);
    expect(sample.processes?.[0]).toEqual({ pid: 1204, user: "postgres", cpu: 12.4, mem: 3.1, rssKb: 253112, elapsedSeconds: 351000, command: "postgres" });
    expect(sample.processes?.[4].command).toBe("tmux: server");
  });

  it("is null (not an error) when ps produced nothing, e.g. busybox ps without --sort/etimes", () => {
    expect(mustParse(ALPINE_319_OUTPUT).processes).toBeNull();
  });

  it("is null when the section is missing entirely", () => {
    const stripped = UBUNTU_2204_OUTPUT.replace(/@@praxel:ps\n[\s\S]*?(?=@@praxel:systemctl)/, "");
    expect(stripped).not.toContain("@@praxel:ps");
    expect(mustParse(stripped).processes).toBeNull();
  });

  it("is null for anything that does not look like procps output", () => {
    expect(parseProcesses(["  PID USER TIME COMMAND", "1 root 0:00 init"])).toBeNull(); // busybox style rows
    expect(parseProcesses(["PID USER %CPU %MEM RSS ELAPSED COMMAND", "12 root x 0.1 100 5 sshd"])).toBeNull();
    expect(parseProcesses(["PID USER %CPU %MEM RSS ELAPSED COMMAND", "12 root 1.0"])).toBeNull();
    expect(parseProcesses(["ps: unrecognized option"])).toBeNull();
    expect(parseProcesses(undefined)).toBeNull();
  });

  it("allows CPU above 100 (multi-threaded) and caps the list at 25 rows", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `${100 + i} root ${(130 - i).toFixed(1)} 0.1 1000 60 worker${i}`);
    const result = parseProcesses(["PID USER %CPU %MEM RSS ELAPSED COMMAND", ...rows]);
    expect(result).toHaveLength(25);
    expect(result?.[0].cpu).toBe(130);
  });

  it("returns an empty list for a header-only listing", () => {
    expect(parseProcesses(["PID USER %CPU %MEM RSS ELAPSED COMMAND"])).toEqual([]);
  });
});

describe("parseProbeOutput: systemd services", () => {
  it("parses units, states and descriptions, sorted by unit", () => {
    const sample = mustParse(UBUNTU_2204_OUTPUT);
    expect(sample.services).toHaveLength(7);
    expect(sample.services?.[0]).toEqual({ unit: "accounts-daemon.service", load: "loaded", active: "active", sub: "running", description: "Accounts Service" });
    const pg = sample.services?.find((s) => s.unit === "postgresql@14-main.service");
    expect(pg).toMatchObject({ active: "failed", sub: "failed", description: "PostgreSQL Cluster 14-main" });
  });

  it("is null when systemctl is absent or systemd is not running (empty output)", () => {
    expect(mustParse(DEBIAN_12_OUTPUT).services).toBeNull();
    expect(mustParse(ALPINE_319_OUTPUT).services).toBeNull();
  });

  it("tolerates a status bullet and a missing description", () => {
    const result = parseServices(["● foo.service not-found inactive dead foo.service", "bar.service loaded active running"]);
    expect(result).toEqual([
      { unit: "bar.service", load: "loaded", active: "active", sub: "running", description: "" },
      { unit: "foo.service", load: "not-found", active: "inactive", sub: "dead", description: "foo.service" },
    ]);
  });

  it("is null when a row is malformed", () => {
    expect(parseServices(["Failed to connect to bus: No such file or directory"])).toBeNull();
    expect(parseServices(["a.service loaded active running ok", "garbage"])).toBeNull();
  });

  it("caps at 300 services, keeping failed units first, and returns them sorted", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `u${String(i).padStart(3, "0")}.service loaded ${i >= 390 ? "failed" : "active"} running d`);
    const result = parseServices(lines) ?? [];
    expect(result).toHaveLength(300);
    expect(result.filter((s) => s.active === "failed")).toHaveLength(10);
    expect(result.map((s) => s.unit)).toEqual([...result.map((s) => s.unit)].sort());
  });
});

describe("DEBIAN_12_PARTS sanity", () => {
  it("still reports its single process when systemctl is missing", () => {
    expect(DEBIAN_12_PARTS.systemctl).toBeUndefined();
    expect(mustParse(DEBIAN_12_OUTPUT).processes?.map((p) => p.command)).toEqual(["redis-server"]);
  });
});
