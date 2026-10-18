import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseProbeOutput } from "./parse";
import { PROBE_COMMAND, PROBE_SECTIONS, PROBE_SECTION_PREFIX } from "./probe";

describe("PROBE_COMMAND", () => {
  it("runs under POSIX sh with LC_ALL=C regardless of the login shell", () => {
    expect(PROBE_COMMAND.startsWith("env LC_ALL=C sh -c '")).toBe(true);
    expect(PROBE_COMMAND.endsWith("'")).toBe(true);
  });

  it("is a single-quoted script that contains no further single quote (the quoting cannot be broken)", () => {
    const script = PROBE_COMMAND.slice("env LC_ALL=C sh -c '".length, -1);
    expect(script).not.toContain("'");
    expect(script.length).toBeGreaterThan(100);
  });

  it("is read-only: no writes, no sudo, no network tools, no destructive commands", () => {
    const stripped = PROBE_COMMAND.replace(/2>&1/g, "").replace(/2>\/dev\/null/g, "").replace(/>\/dev\/null/g, "");
    expect(stripped).not.toMatch(/>/); // no output redirection other than to /dev/null
    // systemctl is only ever used for `list-units` (read-only).
    expect(PROBE_COMMAND.match(/systemctl [a-z-]+/g)).toEqual(["systemctl list-units"]);
    expect(stripped.replace(/@@praxel:[a-z0-9]+/g, "").replace(/command -v systemctl/, "").replace(/systemctl list-units/, "")).not.toMatch(
      /\b(sudo|rm|mv|cp|chmod|chown|kill|curl|wget|nc|dd|tee|touch|mkdir|systemctl|apt|yum)\b/
    );
  });

  it("only reads the documented sources", () => {
    for (const source of ["uname -s", "/proc/uptime", "/proc/loadavg", "nproc", "/proc/stat", "/proc/meminfo", "df -kP", "/proc/net/dev"]) {
      expect(PROBE_COMMAND).toContain(source);
    }
    // /proc/stat is read twice with a one second pause in between (CPU %).
    expect(PROBE_COMMAND.match(/\/proc\/stat/g)?.length).toBe(2);
    expect(PROBE_COMMAND).toContain("sleep 1");
    // Top processes by CPU (header + 25 rows) and systemd services; both are optional on the host.
    expect(PROBE_COMMAND).toContain("ps -eo pid,user,pcpu,pmem,rss,etimes,comm --sort=-pcpu");
    expect(PROBE_COMMAND).toContain("head -n 26");
    expect(PROBE_COMMAND).toContain("systemctl list-units --type=service --all --no-legend --no-pager --plain");
    // GNU df excludes pseudo filesystems at the source; the parser also filters.
    expect(PROBE_COMMAND).toContain("-x tmpfs -x devtmpfs -x overlay -x squashfs");
  });

  it("prints every section marker and stops after uname on non-Linux hosts", () => {
    for (const name of PROBE_SECTIONS) expect(PROBE_COMMAND).toContain(`${PROBE_SECTION_PREFIX}${name}`);
    expect(PROBE_COMMAND).toContain('if [ "$u" != "Linux" ]');
  });

  it("is deterministic (a constant, nothing interpolated)", () => {
    expect(PROBE_COMMAND).toBe(PROBE_COMMAND);
    expect(PROBE_COMMAND).not.toMatch(/\$\{|\$\(\(/);
  });

  it("is syntactically valid POSIX sh (sh -n)", () => {
    const script = PROBE_COMMAND.slice("env LC_ALL=C sh -c '".length, -1);
    const check = spawnSync("sh", ["-n", "-c", script], { encoding: "utf-8", timeout: 10_000, windowsHide: true });
    if (check.error) return; // no sh on PATH
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  it("actually runs through sh on this machine: parses on Linux, reports unsupported_os elsewhere", () => {
    const run = spawnSync("sh", ["-c", PROBE_COMMAND], { encoding: "utf-8", timeout: 20_000, windowsHide: true });
    if (run.error) return; // no sh available on PATH (plain Windows shell): covered by the fixtures instead
    expect(run.status).toBe(0);
    const parsed = parseProbeOutput(run.stdout);
    if (run.stdout.split("\n")[1]?.trim() === "Linux") {
      // Real kernel output must satisfy the strict parser.
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    } else {
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe("unsupported_os");
    }
  }, 30_000);
});
