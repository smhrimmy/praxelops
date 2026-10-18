/**
 * The ONE command the metrics collector ever runs on a monitored host.
 *
 * Properties (all pinned by probe.test.ts):
 *  - a fixed, server-defined constant: nothing (no host name, no user input) is ever interpolated into it;
 *  - read-only: it only reads /proc, `uname`, `nproc`, `df`, `ps` and `systemctl list-units`, and sleeps one second
 *    between the two /proc/stat reads;
 *  - `ps` (top processes) and `systemctl` (services) are best effort: on a host without them (busybox ps without
 *    --sort/etimes, no systemd) their sections are simply empty and the parser reports `null`, not an error;
 *  - POSIX sh with LC_ALL=C: `env LC_ALL=C sh -c '...'` works regardless of the account's login shell (bash, dash,
 *    fish, csh), and the script itself contains no single quote, so the outer quoting cannot be broken;
 *  - if `uname -s` is not Linux it prints the OS name and stops (the collector then reports `unsupported_os`);
 *  - every section starts with a `@@praxel:<name>` line and the output ends with `@@praxel:end`, so the parser can
 *    detect truncated output.
 *
 * Kept free of imports so the in-process test SSH server can reuse it.
 */

export const PROBE_SECTION_PREFIX = "@@praxel:";

export const PROBE_SECTIONS = ["uname", "uptime", "loadavg", "nproc", "stat1", "stat2", "meminfo", "df", "netdev", "ps", "systemctl", "end"] as const;
export type ProbeSection = (typeof PROBE_SECTIONS)[number];

const section = (name: ProbeSection): string => `echo "${PROBE_SECTION_PREFIX}${name}"`;

const PROBE_SCRIPT = [
  section("uname"),
  'u=$(uname -s 2>/dev/null)',
  'echo "$u"',
  `if [ "$u" != "Linux" ]; then ${section("end")}; exit 0; fi`,
  `${section("uptime")}; cat /proc/uptime`,
  `${section("loadavg")}; cat /proc/loadavg`,
  `${section("nproc")}; nproc 2>/dev/null || grep -c "^processor" /proc/cpuinfo`,
  `${section("stat1")}; grep "^cpu " /proc/stat`,
  "sleep 1",
  `${section("stat2")}; grep "^cpu " /proc/stat`,
  `${section("meminfo")}; cat /proc/meminfo`,
  // GNU df can exclude pseudo filesystems at the source; busybox df cannot, so fall back to plain `df -kP` (the
  // parser then filters tmpfs/devtmpfs/overlay/squashfs and system mount points itself).
  `${section("df")}; df -kPl -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null || df -kP 2>/dev/null`,
  `${section("netdev")}; cat /proc/net/dev`,
  // procps ps only: busybox ps rejects --sort / etimes, so the capture fails and the section stays empty.
  `${section("ps")}; p=$(ps -eo pid,user,pcpu,pmem,rss,etimes,comm --sort=-pcpu 2>/dev/null) && printf "%s\\n" "$p" | head -n 26`,
  `${section("systemctl")}; command -v systemctl >/dev/null 2>&1 && systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null | head -n 600`,
  section("end"),
].join("; ");

export const PROBE_COMMAND = `env LC_ALL=C sh -c '${PROBE_SCRIPT}'`;
