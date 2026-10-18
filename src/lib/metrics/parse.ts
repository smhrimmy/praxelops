import { PROBE_SECTION_PREFIX, PROBE_SECTIONS, type ProbeSection } from "./probe";
import {
  MAX_DISKS,
  MAX_PROCESSES,
  MAX_SERVICES,
  MetricsSampleSchema,
  ProcessSchema,
  ServiceSchema,
  type DiskUsage,
  type ParseResult,
  type ProcessInfo,
  type ServiceInfo,
} from "./types";

/**
 * Pure, strict parser for the output of PROBE_COMMAND. Anything missing, truncated, out of range or not in the
 * expected format yields `{ok:false, reason:"parse_error"}`; no value is ever defaulted or guessed. A non-Linux
 * `uname -s` yields `unsupported_os` before anything else is parsed.
 */

export const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;

class ParseFailure extends Error {}

function fail(message: string): never {
  throw new ParseFailure(message);
}

const INT_RE = /^\d+$/;
const FLOAT_RE = /^\d+(?:\.\d+)?$/;

function toInt(text: string, what: string): number {
  if (!INT_RE.test(text)) fail(`${what}: expected an integer, got '${text.slice(0, 40)}'`);
  const n = Number(text);
  if (!Number.isSafeInteger(n)) fail(`${what}: integer out of range`);
  return n;
}

function toFloat(text: string, what: string): number {
  if (!FLOAT_RE.test(text)) fail(`${what}: expected a number, got '${text.slice(0, 40)}'`);
  const n = Number(text);
  if (!Number.isFinite(n)) fail(`${what}: number out of range`);
  return n;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function tokens(line: string): string[] {
  return line
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Sectioning
// ---------------------------------------------------------------------------------------------

type Sections = Map<ProbeSection, string[]>;

const KNOWN_SECTIONS: ReadonlySet<string> = new Set(PROBE_SECTIONS);

function splitSections(stdout: string): Sections {
  const sections: Sections = new Map();
  let current: string[] | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith(PROBE_SECTION_PREFIX)) {
      const name = line.slice(PROBE_SECTION_PREFIX.length);
      if (!KNOWN_SECTIONS.has(name)) fail(`unknown section '${name.slice(0, 40)}'`);
      const section = name as ProbeSection;
      if (sections.has(section)) fail(`duplicate section '${name}'`);
      current = [];
      sections.set(section, current);
      if (section === "end") break;
      continue;
    }
    // Text before the first marker (e.g. a login banner) is ignored; text after `end` never gets here.
    if (current !== undefined) current.push(line);
  }
  return sections;
}

function nonEmptyLines(lines: string[]): string[] {
  return lines.filter((l) => l.trim().length > 0);
}

function single(sections: Sections, name: ProbeSection): string {
  const lines = sections.get(name);
  if (lines === undefined) return fail(`missing section '${name}'`);
  const body = nonEmptyLines(lines);
  if (body.length !== 1) return fail(`section '${name}': expected exactly one line, got ${body.length}`);
  return body[0].trim();
}

function required(sections: Sections, name: ProbeSection): string[] {
  const lines = sections.get(name);
  if (lines === undefined) return fail(`missing section '${name}'`);
  return nonEmptyLines(lines);
}

// ---------------------------------------------------------------------------------------------
// Individual sections
// ---------------------------------------------------------------------------------------------

function parseUptime(line: string): number {
  const t = tokens(line);
  if (t.length < 2) fail("/proc/uptime: expected two fields");
  return toFloat(t[0], "/proc/uptime uptime");
}

function parseLoadavg(line: string): { load1: number; load5: number; load15: number; running: number; total: number } {
  const t = tokens(line);
  if (t.length < 4) fail("/proc/loadavg: expected at least four fields");
  const tasks = /^(\d+)\/(\d+)$/.exec(t[3]);
  if (!tasks) return fail("/proc/loadavg: malformed running/total field");
  return {
    load1: toFloat(t[0], "load1"),
    load5: toFloat(t[1], "load5"),
    load15: toFloat(t[2], "load15"),
    running: toInt(tasks[1], "running tasks"),
    total: toInt(tasks[2], "total tasks"),
  };
}

interface CpuTimes {
  total: number;
  idle: number;
}

/** user nice system idle iowait irq softirq steal (guest time is already inside user/nice). */
function parseCpuLine(line: string, what: string): CpuTimes {
  const t = tokens(line);
  if (t[0] !== "cpu") fail(`${what}: not the aggregate cpu line`);
  if (t.length < 9) fail(`${what}: expected at least 8 counters`);
  const v = t.slice(1, 9).map((x, i) => toInt(x, `${what} counter ${i + 1}`));
  const total = v.reduce((a, b) => a + b, 0);
  return { total, idle: v[3] + v[4] };
}

function cpuPercent(first: CpuTimes, second: CpuTimes): number {
  const dTotal = second.total - first.total;
  const dIdle = second.idle - first.idle;
  if (dTotal <= 0 || dIdle < 0 || dIdle > dTotal) fail("/proc/stat: counters did not advance consistently between samples");
  return round1(((dTotal - dIdle) / dTotal) * 100);
}

function parseMeminfo(lines: string[]): { memTotal: number; memAvailable: number; swapTotal: number; swapFree: number } {
  const values = new Map<string, number>();
  for (const line of lines) {
    const m = /^([A-Za-z_()0-9]+):\s+(\d+)\s*kB$/.exec(line.trim());
    if (m && !values.has(m[1])) values.set(m[1], toInt(m[2], `/proc/meminfo ${m[1]}`));
  }
  const get = (key: string): number => {
    const v = values.get(key);
    if (v === undefined) return fail(`/proc/meminfo: missing ${key}`);
    return v;
  };
  return { memTotal: get("MemTotal"), memAvailable: get("MemAvailable"), swapTotal: get("SwapTotal"), swapFree: get("SwapFree") };
}

const EXCLUDED_FILESYSTEMS: ReadonlySet<string> = new Set(["tmpfs", "devtmpfs", "overlay", "squashfs", "ramfs", "shm", "udev", "none"]);
const EXCLUDED_MOUNT_PREFIXES: readonly string[] = ["/proc", "/sys", "/dev", "/run", "/snap"];

function isExcludedMount(mount: string): boolean {
  return EXCLUDED_MOUNT_PREFIXES.some((p) => mount === p || mount.startsWith(`${p}/`));
}

/**
 * df -kP rows: `Filesystem 1024-blocks Used Available Capacity Mounted-on`. Parsed from the right so filesystem
 * names or mount points containing spaces still work. Pseudo filesystems are dropped (tmpfs, devtmpfs, overlay,
 * squashfs, ... and /proc, /sys, /dev, /run, /snap), bind-mount/subvolume duplicates (same device) are collapsed,
 * zero-sized filesystems are skipped, and the list is capped: root first, then the largest.
 */
function parseDf(lines: string[]): DiskUsage[] {
  const seenDevices = new Set<string>();
  const disks: DiskUsage[] = [];
  let sawHeader = false;
  for (const line of lines) {
    const t = tokens(line);
    if (t[0] === "Filesystem") {
      sawHeader = true; // repeated if the fallback df ran after a partially failing first one
      continue;
    }
    const capIndex = t.findIndex(
      (x, i) =>
        i >= 4 &&
        /^(?:\d+%|-)$/.test(x) &&
        INT_RE.test(t[i - 1] ?? "") &&
        INT_RE.test(t[i - 2] ?? "") &&
        INT_RE.test(t[i - 3] ?? "")
    );
    if (capIndex < 0 || capIndex === t.length - 1) fail(`df: malformed row '${line.trim().slice(0, 80)}'`);
    const device = t.slice(0, capIndex - 3).join(" ");
    const blocks = toInt(t[capIndex - 3], "df 1024-blocks");
    const used = toInt(t[capIndex - 2], "df used");
    const avail = toInt(t[capIndex - 1], "df available");
    const mount = t.slice(capIndex + 1).join(" ");
    if (EXCLUDED_FILESYSTEMS.has(device) || isExcludedMount(mount)) continue;
    if (blocks === 0 || used + avail === 0) continue;
    if (seenDevices.has(device)) continue;
    seenDevices.add(device);
    // Same convention as df's own Use%: used / (used + available), so reserved blocks do not skew the figure.
    const usedPercent = Math.min(100, round1((used / (used + avail)) * 100));
    disks.push({ mount, totalKb: blocks, usedKb: used, usedPercent });
  }
  if (!sawHeader) fail("df: missing header row");
  disks.sort((a, b) => (a.mount === "/" ? -1 : b.mount === "/" ? 1 : b.totalKb - a.totalKb));
  return disks.slice(0, MAX_DISKS);
}

function parseNetDev(lines: string[]): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  let interfaces = 0;
  for (const line of lines) {
    if (line.includes("|")) continue; // the two header lines
    const colon = line.indexOf(":");
    if (colon < 0) fail(`/proc/net/dev: malformed row '${line.trim().slice(0, 60)}'`);
    const name = line.slice(0, colon).trim();
    const t = tokens(line.slice(colon + 1));
    if (name.length === 0 || t.length < 16) fail(`/proc/net/dev: malformed row for '${name.slice(0, 20)}'`);
    const rxBytes = toInt(t[0], `/proc/net/dev ${name} rx_bytes`);
    const txBytes = toInt(t[8], `/proc/net/dev ${name} tx_bytes`);
    interfaces += 1;
    if (name === "lo") continue;
    rx += rxBytes;
    tx += txBytes;
  }
  if (interfaces === 0) fail("/proc/net/dev: no interfaces listed");
  if (!Number.isSafeInteger(rx) || !Number.isSafeInteger(tx)) fail("/proc/net/dev: totals out of range");
  return { rx, tx };
}

// ---------------------------------------------------------------------------------------------
// Optional sections: processes and services
// ---------------------------------------------------------------------------------------------

/**
 * `ps -eo pid,user,pcpu,pmem,rss,etimes,comm --sort=-pcpu | head -n 26`: a header row (PID ...) then up to 25 rows.
 * The command name (`comm`) is the last column and may contain spaces. An empty section means the host's ps does not
 * support these options (busybox) and yields null; so does anything that does not look exactly like procps output
 * (the figures are never guessed).
 */
export function parseProcesses(lines: readonly string[] | undefined): ProcessInfo[] | null {
  if (lines === undefined) return null;
  const body = nonEmptyLines([...lines]);
  if (body.length === 0) return null;
  if (tokens(body[0])[0] !== "PID") return null;
  const out: ProcessInfo[] = [];
  for (const line of body.slice(1)) {
    const t = tokens(line);
    if (t.length < 7) return null;
    const [pid, user, cpu, mem, rss, etimes] = t;
    if (!INT_RE.test(pid) || !FLOAT_RE.test(cpu) || !FLOAT_RE.test(mem) || !INT_RE.test(rss) || !INT_RE.test(etimes)) return null;
    const candidate = {
      pid: Number(pid),
      user,
      cpu: Number(cpu),
      mem: Number(mem),
      rssKb: Number(rss),
      elapsedSeconds: Number(etimes),
      command: t.slice(6).join(" ").slice(0, 256),
    };
    const checked = ProcessSchema.safeParse(candidate);
    if (!checked.success) return null;
    out.push(checked.data);
    if (out.length >= MAX_PROCESSES) break;
  }
  return out;
}

const SERVICE_UNIT_RE = /^[A-Za-z0-9:_.@\\-]+\.service$/;

/**
 * `systemctl list-units --type=service --all --no-legend --no-pager --plain`: `UNIT LOAD ACTIVE SUB DESCRIPTION...`
 * (a leading status bullet is tolerated). Empty output (no systemctl, or systemd not running) yields null, as does any
 * row that does not parse. When there are more than 300 units, failed units are kept first, then the rest in unit
 * order; the result is returned sorted by unit name.
 */
export function parseServices(lines: readonly string[] | undefined): ServiceInfo[] | null {
  if (lines === undefined) return null;
  const body = nonEmptyLines([...lines]);
  if (body.length === 0) return null;
  const all: ServiceInfo[] = [];
  for (const line of body) {
    let t = tokens(line);
    if (t.length > 0 && !SERVICE_UNIT_RE.test(t[0]) && t[0].length <= 2) t = t.slice(1); // status bullet
    if (t.length < 4 || !SERVICE_UNIT_RE.test(t[0])) return null;
    const checked = ServiceSchema.safeParse({
      unit: t[0],
      load: t[1],
      active: t[2],
      sub: t[3],
      description: t.slice(4).join(" ").slice(0, 512),
    });
    if (!checked.success) return null;
    all.push(checked.data);
  }
  const failedFirst = [...all.filter((s) => s.active === "failed"), ...all.filter((s) => s.active !== "failed")];
  return failedFirst.slice(0, MAX_SERVICES).sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

function sanitizeOsName(raw: string): string {
  const cleaned = raw.replace(/[^\x21-\x7e]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "unknown";
}

export function parseProbeOutput(stdout: string): ParseResult {
  try {
    if (stdout.length > MAX_PROBE_OUTPUT_BYTES) fail("probe output exceeds the size limit");
    const sections = splitSections(stdout);

    const unameLines = nonEmptyLines(sections.get("uname") ?? fail("missing section 'uname'"));
    if (unameLines.length !== 1) fail("section 'uname': expected exactly one line");
    const os = unameLines[0].trim();
    if (!sections.has("end")) fail("probe output was truncated (missing end marker)");
    if (os !== "Linux") {
      const name = sanitizeOsName(os);
      return {
        ok: false,
        reason: "unsupported_os",
        os: name,
        message: `Unsupported operating system '${name}': only Linux hosts are monitored`,
      };
    }

    const uptimeSeconds = parseUptime(single(sections, "uptime"));
    const load = parseLoadavg(single(sections, "loadavg"));
    const cpuCount = toInt(single(sections, "nproc"), "nproc");
    const first = parseCpuLine(single(sections, "stat1"), "/proc/stat (first sample)");
    const second = parseCpuLine(single(sections, "stat2"), "/proc/stat (second sample)");
    const mem = parseMeminfo(required(sections, "meminfo"));
    if (mem.memTotal <= 0) fail("/proc/meminfo: MemTotal is zero");
    const disks = parseDf(required(sections, "df"));
    const net = parseNetDev(required(sections, "netdev"));
    const root = disks.find((d) => d.mount === "/");

    const candidate = {
      cpuPercent: cpuPercent(first, second),
      load1: load.load1,
      load5: load.load5,
      load15: load.load15,
      cpuCount,
      runningTasks: load.running,
      totalTasks: load.total,
      memTotalKb: mem.memTotal,
      memAvailableKb: mem.memAvailable,
      memUsedPercent: round1(((mem.memTotal - mem.memAvailable) / mem.memTotal) * 100),
      swapTotalKb: mem.swapTotal,
      swapFreeKb: mem.swapFree,
      disks,
      rootDiskUsedPercent: root === undefined ? null : root.usedPercent,
      netRxBytes: net.rx,
      netTxBytes: net.tx,
      uptimeSeconds,
      processes: parseProcesses(sections.get("ps")),
      services: parseServices(sections.get("systemctl")),
    };
    const validated = MetricsSampleSchema.safeParse(candidate);
    if (!validated.success) {
      const issue = validated.error.issues[0];
      return fail(`validation failed at '${issue.path.join(".")}': ${issue.message}`);
    }
    return { ok: true, sample: validated.data };
  } catch (err) {
    if (err instanceof ParseFailure) return { ok: false, reason: "parse_error", message: err.message };
    throw err;
  }
}
