import { z } from "zod";

/** Reasons a sampling attempt can fail (also the `reason` column of failed metrics_samples rows). */
export const SAMPLE_FAILURE_REASONS = [
  "unreachable",
  "timeout",
  "auth_failed",
  "host_key_mismatch",
  "host_key_not_pinned",
  "unsupported_os",
  "parse_error",
  "credential_error",
] as const;
export type SampleFailureReason = (typeof SAMPLE_FAILURE_REASONS)[number];

/** server_health.state values. */
export const HEALTH_STATES = [
  "reachable",
  "unreachable",
  "auth_failed",
  "host_key_mismatch",
  "host_key_not_pinned",
  "unsupported_os",
  "error",
] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export function healthStateForFailure(reason: SampleFailureReason): HealthState {
  switch (reason) {
    case "unreachable":
    case "timeout":
      return "unreachable";
    case "auth_failed":
      return "auth_failed";
    case "host_key_mismatch":
      return "host_key_mismatch";
    case "host_key_not_pinned":
      return "host_key_not_pinned";
    case "unsupported_os":
      return "unsupported_os";
    case "parse_error":
    case "credential_error":
      return "error";
  }
}

const nonNegative = z.number().finite().nonnegative();
const percent = z.number().finite().min(0).max(100);

export const DiskSchema = z
  .object({
    mount: z.string().min(1).max(256),
    totalKb: nonNegative,
    usedKb: nonNegative,
    usedPercent: percent,
  })
  .strict();
export type DiskUsage = z.infer<typeof DiskSchema>;

/** Maximum number of filesystems kept in one sample (root first, then largest). */
export const MAX_DISKS = 20;
export const MAX_PROCESSES = 25;
export const MAX_SERVICES = 300;

/** One row of `ps` (top processes by CPU). `cpu` is ps's %CPU (lifetime average of the process), `mem` is %MEM. */
export const ProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    user: z.string().min(1).max(64),
    cpu: z.number().finite().min(0),
    mem: z.number().finite().min(0).max(100),
    rssKb: nonNegative,
    elapsedSeconds: nonNegative,
    command: z.string().min(1).max(256),
  })
  .strict();
export type ProcessInfo = z.infer<typeof ProcessSchema>;

/** One systemd service unit from `systemctl list-units --type=service --all`. */
export const ServiceSchema = z
  .object({
    unit: z.string().min(1).max(256),
    load: z.string().min(1).max(32),
    active: z.string().min(1).max(32),
    sub: z.string().min(1).max(32),
    description: z.string().max(512),
  })
  .strict();
export type ServiceInfo = z.infer<typeof ServiceSchema>;

/** One validated reading of a Linux host. Memory/disk sizes are KiB; network counters are cumulative bytes. */
export const MetricsSampleSchema = z
  .object({
    cpuPercent: percent,
    load1: nonNegative,
    load5: nonNegative,
    load15: nonNegative,
    cpuCount: z.number().int().min(1).max(65536),
    /** Kernel scheduling entities (threads) currently runnable / existing, from the 4th field of /proc/loadavg. */
    runningTasks: z.number().int().nonnegative(),
    totalTasks: z.number().int().nonnegative(),
    memTotalKb: z.number().finite().positive(),
    memAvailableKb: nonNegative,
    memUsedPercent: percent,
    swapTotalKb: nonNegative,
    swapFreeKb: nonNegative,
    disks: z.array(DiskSchema).max(MAX_DISKS),
    /** usedPercent of the filesystem mounted at "/", or null when "/" is not among the (filtered) filesystems. */
    rootDiskUsedPercent: percent.nullable(),
    netRxBytes: nonNegative,
    netTxBytes: nonNegative,
    uptimeSeconds: nonNegative,
    /**
     * Top processes by CPU, or null when the host's ps cannot provide them (e.g. busybox). Only the LATEST stored
     * sample of a server keeps processes/services (older rows drop the keys to bound the database), so the keys are
     * optional when reading history.
     */
    processes: z.array(ProcessSchema).max(MAX_PROCESSES).nullable().optional(),
    /** systemd services, or null when systemctl is absent / systemd is not running. */
    services: z.array(ServiceSchema).max(MAX_SERVICES).nullable().optional(),
  })
  .strict()
  .refine((s) => s.memAvailableKb <= s.memTotalKb, { message: "MemAvailable exceeds MemTotal" })
  .refine((s) => s.swapFreeKb <= s.swapTotalKb, { message: "SwapFree exceeds SwapTotal" });
export type MetricsSample = z.infer<typeof MetricsSampleSchema>;

export type ParseResult =
  | { ok: true; sample: MetricsSample }
  | { ok: false; reason: "unsupported_os"; os: string; message: string }
  | { ok: false; reason: "parse_error"; message: string };

export type SampleOutcome =
  | { ok: true; sample: MetricsSample; collectedAt: string }
  | {
      ok: false;
      reason: SampleFailureReason;
      message: string;
      collectedAt: string;
      /** Present for host_key_mismatch: the pinned and the presented fingerprints (public information). */
      details?: { expectedFingerprint?: string; receivedFingerprint?: string };
    };

export interface ServerHealthView {
  state: HealthState;
  reason?: string;
  lastCheckedAt: string;
  lastOkAt: string | null;
  /** Age of the newest successful sample, or null if the host has never been sampled successfully. */
  sampleAgeSeconds: number | null;
}
