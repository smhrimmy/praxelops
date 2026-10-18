/**
 * Probe output fixtures written from the documented kernel / coreutils / busybox formats of /proc and df
 * (Ubuntu 22.04, Debian 12 and Alpine 3.19 style hosts). Used by the parser tests, the collector tests, the in-process
 * test SSH server and the end-to-end test. Test support only; nothing in production imports this module.
 */
import { PROBE_SECTION_PREFIX, type ProbeSection } from "./probe";

export interface ProbeParts {
  uname: string;
  uptime: string;
  loadavg: string;
  nproc: string;
  stat1: string;
  stat2: string;
  meminfo: string;
  df: string;
  netdev: string;
  /** ps output (header + rows); empty/undefined = busybox-style host where ps rejected the options. */
  ps?: string;
  /** systemctl output; empty/undefined = no systemd. */
  systemctl?: string;
}

/** Joins section bodies exactly the way the probe script prints them. */
export function assembleProbeOutput(parts: ProbeParts): string {
  const order: Exclude<ProbeSection, "end">[] = ["uname", "uptime", "loadavg", "nproc", "stat1", "stat2", "meminfo", "df", "netdev", "ps", "systemctl"];
  const body = order
    .map((name) => {
      const text = (parts[name] ?? "").replace(/\n+$/, "");
      return text === "" ? `${PROBE_SECTION_PREFIX}${name}\n` : `${PROBE_SECTION_PREFIX}${name}\n${text}\n`;
    })
    .join("");
  return `${body}${PROBE_SECTION_PREFIX}end\n`;
}

/** Output of a non-Linux host: the probe prints the OS name and stops. */
export function nonLinuxProbeOutput(osName: string): string {
  return `${PROBE_SECTION_PREFIX}uname\n${osName}\n${PROBE_SECTION_PREFIX}end\n`;
}

const NETDEV_HEADER = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
`;

const MEMINFO_TAIL = `Active(anon):     172140 kB
Inactive(anon):   402316 kB
Active(file):    1553120 kB
Inactive(file):  1204100 kB
Unevictable:       27688 kB
Mlocked:           27688 kB
SwapTotal:       SWAPTOTAL kB
SwapFree:        SWAPFREE kB
Zswap:                 0 kB
Zswapped:              0 kB
Dirty:               412 kB
Writeback:             0 kB
AnonPages:        561840 kB
Mapped:           411272 kB
Shmem:              3120 kB
KReclaimable:     312044 kB
Slab:             502812 kB
SReclaimable:     312044 kB
SUnreclaim:       190768 kB
KernelStack:        6800 kB
PageTables:        10112 kB
NFS_Unstable:          0 kB
Bounce:                0 kB
WritebackTmp:          0 kB
CommitLimit:     6168320 kB
Committed_AS:    3128440 kB
VmallocTotal:   34359738367 kB
VmallocUsed:       36012 kB
VmallocChunk:          0 kB
Percpu:             3840 kB
HardwareCorrupted:     0 kB
AnonHugePages:         0 kB
ShmemHugePages:        0 kB
ShmemPmdMapped:        0 kB
FileHugePages:         0 kB
FilePmdMapped:         0 kB
HugePages_Total:       0
HugePages_Free:        0
HugePages_Rsvd:        0
HugePages_Surp:        0
Hugepagesize:       2048 kB
Hugetlb:               0 kB
DirectMap4k:      239544 kB
DirectMap2M:     8149000 kB
DirectMap1G:           0 kB`;

function meminfo(total: number, free: number, available: number, buffers: number, cached: number, swapTotal: number, swapFree: number): string {
  const head = `MemTotal:        ${total} kB
MemFree:         ${free} kB
MemAvailable:    ${available} kB
Buffers:          ${buffers} kB
Cached:          ${cached} kB
SwapCached:            0 kB`;
  return `${head}\n${MEMINFO_TAIL.replace("SWAPTOTAL", String(swapTotal)).replace("SWAPFREE", String(swapFree))}`;
}

/**
 * Ubuntu 22.04, 4 vCPU, 8 GiB RAM, 2 GiB swap, GNU df (pseudo filesystems already excluded by `-x`).
 * Expected: cpu 25.0%, mem 34.6%, root disk 33.8%, rx 8484063403 B, tx 1923847211 B (+docker0 counters), uptime 351735.
 */
export const UBUNTU_2204_PARTS: ProbeParts = {
  uname: "Linux",
  uptime: "351735.47 1394232.01",
  loadavg: "0.52 0.58 0.59 1/467 123456",
  nproc: "4",
  stat1: "cpu  1523948 12011 487233 66243311 41230 0 14892 0 0 0",
  stat2: "cpu  1524028 12011 487253 66243601 41240 0 14892 0 0 0",
  meminfo: meminfo(8142344, 1203408, 5321672, 312044, 3984228, 2097148, 2097148),
  df: `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         63341436 21405968  41918084      34% /
/dev/sda15          106858     6186    100673       6% /boot/efi`,
  netdev: `${NETDEV_HEADER}    lo: 1129382   12345    0    0    0     0          0         0  1129382   12345    0    0    0     0       0          0
  eth0: 8482934021 7382911    0    0    0     0          0         0 1923847211 5821934    0    0    0     0       0          0
docker0:  1129382   12345    0    0    0     0          0         0        0       0    0    0    0     0       0          0`,
  ps: `    PID USER     %CPU %MEM   RSS ELAPSED COMMAND
   1204 postgres  12.4  3.1 253112  351000 postgres
   2210 www-data   4.2  1.2  98304  340000 nginx
    877 root       1.1  0.4  32768  351500 containerd
      1 root       0.0  0.1  12288  351735 systemd
   3333 deploy     0.3  0.2  16384    1200 tmux: server`,
  systemctl: `  accounts-daemon.service            loaded    active   running Accounts Service
  cron.service                       loaded    active   running Regular background program processing daemon
  nginx.service                      loaded    active   running A high performance web server and a reverse proxy server
  postgresql@14-main.service         loaded    failed   failed  PostgreSQL Cluster 14-main
  ssh.service                        loaded    active   running OpenBSD Secure Shell server
  systemd-networkd-wait-online.service loaded  inactive dead    Wait for Network to be Configured
  unattended-upgrades.service        loaded    active   exited  Unattended Upgrades Shutdown`,
};
export const UBUNTU_2204_OUTPUT = assembleProbeOutput(UBUNTU_2204_PARTS);

/**
 * Debian 12, 2 vCPU, 2 GiB RAM, no swap, plain `df -kP` (the fallback path) so the parser must drop udev, tmpfs and
 * /dev/shm itself. Expected: cpu 50.0%, mem 66.0%, root disk 16.9%.
 */
export const DEBIAN_12_PARTS: ProbeParts = {
  uname: "Linux",
  uptime: "86412.88 170000.12",
  loadavg: "1.20 0.95 0.80 3/212 8841",
  nproc: "2",
  stat1: "cpu  412398 211 98121 1543221 8120 0 3012 0 0 0",
  stat2: "cpu  412478 211 98141 1543321 8120 0 3012 0 0 0",
  meminfo: meminfo(2014956, 130200, 685000, 90112, 701244, 0, 0),
  df: `Filesystem     1024-blocks    Used Available Capacity Mounted on
udev                   1000264       0   1000264       0% /dev
tmpfs                   201496     572    200924       1% /run
/dev/vda1             20134592 3231216  15864968      17% /
tmpfs                  1007476       0   1007476       0% /dev/shm
tmpfs                     5120       0      5120       0% /run/lock
/dev/vda15              126710   11840    114870      10% /boot/efi
tmpfs                   201494       0    201494       0% /run/user/1000`,
  netdev: `${NETDEV_HEADER}    lo:  908112    3011    0    0    0     0          0         0   908112    3011    0    0    0     0       0          0
 ens3: 412983220  421887    0    0    0     0          0         0 98212003  301223    0    0    0     0       0          0`,
  ps: `    PID USER     %CPU %MEM   RSS ELAPSED COMMAND
    412 redis      2.0  1.0  20480   86000 redis-server`,
  // systemctl missing (e.g. a container with an init other than systemd): both optional sections empty.
};
export const DEBIAN_12_OUTPUT = assembleProbeOutput(DEBIAN_12_PARTS);

/**
 * Alpine 3.19 VM with busybox df (1K-blocks / Use% header, no `-x`/`-l`, so the GNU attempt failed and the fallback ran),
 * a docker overlay mount and a shm mount. Expected: cpu 12.5%, mem 60.0%, root disk 45.0%, swap 512 MiB.
 */
export const ALPINE_319_PARTS: ProbeParts = {
  uname: "Linux",
  uptime: "5120.04 10100.77",
  loadavg: "0.08 0.05 0.01 2/131 4410",
  nproc: "2",
  stat1: "cpu  21041 0 8330 301120 410 0 220 0 0 0",
  stat2: "cpu  21051 0 8340 301260 410 0 220 0 0 0",
  meminfo: meminfo(1005000, 71000, 402000, 20100, 301000, 524284, 524284),
  df: `Filesystem           1K-blocks      Used Available Use% Mounted on
devtmpfs                 10240         0     10240   0% /dev
shm                     502500         0    502500   0% /dev/shm
/dev/vda3              9854256   4434415   5419841  45% /
tmpfs                   502500       252    502248   0% /run
/dev/vda1               505580     83102    422478  16% /boot
overlay                9854256   4434415   5419841  45% /var/lib/docker/overlay2/3f1a/merged`,
  netdev: `${NETDEV_HEADER}    lo:   55120     600    0    0    0     0          0         0    55120     600    0    0    0     0       0          0
  eth0: 3849920    5120    0    0    0     0          0         0   802311    3980    0    0    0     0       0          0`,
};
export const ALPINE_319_OUTPUT = assembleProbeOutput(ALPINE_319_PARTS);

/** Default output of the in-process test SSH server (the Ubuntu fixture). */
export const DEFAULT_TEST_PROBE_OUTPUT = UBUNTU_2204_OUTPUT;
