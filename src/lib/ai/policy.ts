import { z } from "zod";

export type OperationKind =
  | "SERVICE_ACTION"
  | "JOURNAL_VACUUM"
  | "CACHE_TRIM"
  | "PROCESS_SNAPSHOT"
  | "DISK_AUDIT"
  | "CONTAINER_PRUNE"
  | "PACKAGE_AUDIT";

export interface TypedOperation {
  kind: OperationKind;
  params: Record<string, string | number | boolean>;
  riskLevel: "low" | "medium" | "high" | "critical";
  requiresSudo: boolean;
  expectedOutcome: string;
  rollbackPlan?: string;
}

// Validation schemas for typed operational parameters
const ServiceActionSchema = z.object({
  action: z.enum(["reload", "restart", "status"]),
  service: z.string().regex(/^[a-zA-Z0-9_\-\.@]+$/, "Invalid service name identifier"),
});

const JournalVacuumSchema = z.object({
  retention: z.string().regex(/^[0-9]+[dhmy]$/, "Invalid retention format (e.g. 2d, 1w)"),
});

const CacheTrimSchema = z.object({
  level: z.enum(["1", "2", "3"]),
});

const ProcessSnapshotSchema = z.object({
  sortField: z.enum(["%cpu", "%mem"]),
  limit: z.number().int().min(1).max(50),
});

const ContainerPruneSchema = z.object({
  untilHours: z.number().int().min(1).max(720),
});

const PackageAuditSchema = z.object({
  manager: z.enum(["apt", "dnf", "yum"]),
  dryRun: z.literal(true),
});

export class OperationPolicyEngine {
  /**
   * Compiles and strictly validates a typed operational action into safe canonical shell commands
   */
  static compileTypedOperation(op: TypedOperation): {
    valid: boolean;
    commands: string[];
    error?: string;
  } {
    try {
      switch (op.kind) {
        case "SERVICE_ACTION": {
          const parsed = ServiceActionSchema.parse(op.params);
          const cmd =
            parsed.action === "status"
              ? `systemctl status ${parsed.service}`
              : `systemctl ${parsed.action} ${parsed.service}`;
          return { valid: true, commands: [cmd] };
        }

        case "JOURNAL_VACUUM": {
          const parsed = JournalVacuumSchema.parse(op.params);
          return {
            valid: true,
            commands: [`journalctl --vacuum-time=${parsed.retention}`],
          };
        }

        case "CACHE_TRIM": {
          const parsed = CacheTrimSchema.parse(op.params);
          return {
            valid: true,
            commands: ["sync", `echo ${parsed.level} > /proc/sys/vm/drop_caches`],
          };
        }

        case "PROCESS_SNAPSHOT": {
          const parsed = ProcessSnapshotSchema.parse(op.params);
          return {
            valid: true,
            commands: [
              `ps -eo pid,ppid,cmd,%mem,%cpu --sort=-${parsed.sortField} | head -n ${parsed.limit + 1}`,
            ],
          };
        }

        case "CONTAINER_PRUNE": {
          const parsed = ContainerPruneSchema.parse(op.params);
          return {
            valid: true,
            commands: [`docker system prune -f --filter "until=${parsed.untilHours}h"`],
          };
        }

        case "PACKAGE_AUDIT": {
          const parsed = PackageAuditSchema.parse(op.params);
          const cmd =
            parsed.manager === "apt"
              ? "apt-get update --dry-run"
              : `${parsed.manager} check-update`;
          return { valid: true, commands: [cmd] };
        }

        default:
          return { valid: false, commands: [], error: `Unknown operation kind '${op.kind}'` };
      }
    } catch (err) {
      return {
        valid: false,
        commands: [],
        error: `Policy validation failed for kind '${op.kind}': ${(err as Error).message}`,
      };
    }
  }

  /**
   * Validates whether a command matches the authorized typed operation syntax
   */
  static validateCommandConformity(command: string): { conforming: boolean; matchedKind?: OperationKind; reason?: string } {
    const trimmed = command.trim();

    // 1. Rejection of unconstrained subshells, pipes to external binaries, or backticks
    if (/[;&|`$]/.test(trimmed)) {
      // Allowed controlled pipes: 'ps ... | head -n ...' or 'sync'
      if (
        !trimmed.startsWith("ps -eo") &&
        !trimmed.startsWith("echo 3 > /proc/sys/vm/drop_caches") &&
        trimmed !== "sync"
      ) {
        return {
          conforming: false,
          reason: "Command contains unauthorized chaining or metacharacters (; & | ` $)",
        };
      }
    }

    if (trimmed.startsWith("systemctl (reload|restart|status) ") || /^systemctl (reload|restart|status) [a-zA-Z0-9_\-\.@]+$/.test(trimmed)) {
      return { conforming: true, matchedKind: "SERVICE_ACTION" };
    }
    if (/^journalctl --vacuum-time=[0-9]+[dhmy]$/.test(trimmed)) {
      return { conforming: true, matchedKind: "JOURNAL_VACUUM" };
    }
    if (trimmed === "sync" || /^echo [1-3] > \/proc\/sys\/vm\/drop_caches$/.test(trimmed)) {
      return { conforming: true, matchedKind: "CACHE_TRIM" };
    }
    if (/^ps -eo pid,ppid,cmd,%mem,%cpu --sort=-(%cpu|%mem) \| head -n [0-9]+$/.test(trimmed)) {
      return { conforming: true, matchedKind: "PROCESS_SNAPSHOT" };
    }
    if (/^docker system prune -f --filter "until=[0-9]+h"$/.test(trimmed)) {
      return { conforming: true, matchedKind: "CONTAINER_PRUNE" };
    }
    if (trimmed === "apt-get update --dry-run" || trimmed === "dnf check-update" || trimmed === "yum check-update") {
      return { conforming: true, matchedKind: "PACKAGE_AUDIT" };
    }

    return {
      conforming: false,
      reason: "Command does not conform to any whitelisted typed operational policy.",
    };
  }
}
