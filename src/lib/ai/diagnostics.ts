import crypto from "crypto";
import { ServerHost } from "@/types/server";
import { ServerDiagnosticReport, AIOperationProposal } from "@/types/ai";
import { ApprovalSecurityService } from "./approval";

export class AIDiagnosticsEngine {
  /**
   * Generates grounded diagnostic reports and signed operational proposals from actual server telemetry
   */
  static analyzeServer(server: ServerHost): ServerDiagnosticReport {
    const metrics = server.metrics;
    const anomalies: ServerDiagnosticReport["anomalies"] = [];
    const proposals: AIOperationProposal[] = [];

    // If server has no metrics reported yet, return honest unpolled status
    if (!metrics) {
      return {
        id: `diag-${server.id}-${Date.now()}`,
        serverId: server.id,
        serverName: server.name,
        timestamp: new Date().toISOString(),
        healthScore: 50,
        summary: `No live telemetry available for ${server.name}. Establish an SSH connection to gather genuine resource metrics.`,
        anomalies: [
          {
            category: "service",
            severity: "warning",
            detail: "Telemetry collector has not yet captured metrics from this host.",
          },
        ],
        proposals: [],
      };
    }

    let healthScore = 100;

    // Helper to construct cryptographically signed proposals
    const createProposal = (
      idSuffix: string,
      title: string,
      rationale: string,
      riskLevel: AIOperationProposal["riskLevel"],
      commands: string[],
      requiresSudo: boolean,
      expectedOutcome: string,
      rollbackPlan?: string,
      isDestructive: boolean = false
    ): AIOperationProposal => {
      const id = `prop-${idSuffix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const commandsHash = ApprovalSecurityService.hashCommands(commands);
      const expiresAt = Date.now() + 15 * 60 * 1000; // 15 min window
      const signature = ApprovalSecurityService.signProposal(
        id,
        server.id,
        commandsHash,
        expiresAt
      );
      const approvalToken = crypto.randomBytes(24).toString("hex");

      return {
        id,
        targetServerId: server.id,
        targetServerName: server.name,
        title,
        rationale,
        riskLevel,
        commands,
        commandsHash,
        requiresSudo,
        rollbackPlan,
        expectedOutcome,
        isDestructive,
        status: "pending_approval",
        createdAt: new Date().toISOString(),
        expiresAt,
        signature,
        approvalToken,
      };
    };

    // 1. CPU Analysis
    if (metrics.cpuPercent > 85) {
      healthScore -= 25;
      anomalies.push({
        category: "cpu",
        severity: "critical",
        detail: `Sustained high CPU utilization (${metrics.cpuPercent}%). System responsiveness is severely degraded.`,
        metricValue: `${metrics.cpuPercent}%`,
      });

      proposals.push(
        createProposal(
          "cpu",
          "Throttle runaway processes and inspect top consumers",
          "CPU load exceeds 85% threshold. Identify top CPU-consuming process and reload worker configuration.",
          "medium",
          [
            "ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%cpu | head -n 6",
            "systemctl reload-or-restart nginx || true",
          ],
          true,
          "Lowers CPU usage below 50% and clears stuck worker sockets.",
          "systemctl restart nginx"
        )
      );
    } else if (metrics.cpuPercent > 60) {
      healthScore -= 10;
      anomalies.push({
        category: "cpu",
        severity: "warning",
        detail: `Elevated CPU usage (${metrics.cpuPercent}%). Potential batch processing or queue backlog.`,
        metricValue: `${metrics.cpuPercent}%`,
      });
    }

    // 2. Memory Analysis
    if (metrics.memoryPercent > 85) {
      healthScore -= 30;
      anomalies.push({
        category: "memory",
        severity: "critical",
        detail: `High RAM exhaustion (${metrics.memoryPercent}% used). Risk of Linux OOM killer invocation.`,
        metricValue: `${metrics.memoryPercent}%`,
      });

      proposals.push(
        createProposal(
          "mem",
          "Flush OS page caches and recycle idle workers",
          "Mitigate immediate OOM pressure before vital database or API processes are killed.",
          "high",
          [
            "sync",
            "echo 3 > /proc/sys/vm/drop_caches",
            "systemctl restart redis-server || true",
          ],
          true,
          "Recovers 15-30% buffer/cache memory immediately.",
          "Re-enable standard cache memory allocation."
        )
      );
    }

    // 3. Disk Analysis
    if (metrics.diskPercent > 85) {
      healthScore -= 30;
      anomalies.push({
        category: "disk",
        severity: "critical",
        detail: `Root partition storage almost full (${metrics.diskPercent}%). Logs or core dumps accumulating rapidly.`,
        metricValue: `${metrics.diskPercent}%`,
      });

      proposals.push(
        createProposal(
          "disk",
          "Clean rotated systemd journals and old container layers",
          "Frees several gigabytes of inactive journal logs and dangling container images.",
          "medium",
          [
            "journalctl --vacuum-time=3d",
            "docker system prune -f --filter 'until=48h' || true",
          ],
          true,
          "Restores disk free margin above 25%.",
          "Logs older than 3 days will remain purged."
        )
      );
    }

    // 4. Default healthy summary if no critical threshold exceeded
    if (anomalies.length === 0) {
      proposals.push(
        createProposal(
          "opt",
          "Routine kernel security patch check and cache check",
          "Node is healthy. Verify pending apt/dnf security updates.",
          "low",
          ["apt-get update --dry-run || dnf check-update || true"],
          false,
          "Identifies whether reboot or package upgrades are pending.",
          "No system state modified."
        )
      );
    }

    const report: ServerDiagnosticReport = {
      id: `diag-${server.id}-${Date.now()}`,
      serverId: server.id,
      serverName: server.name,
      timestamp: new Date().toISOString(),
      healthScore: Math.max(15, healthScore),
      summary:
        anomalies.length > 0
          ? `Detected ${anomalies.length} operational bottlenecks requiring administrative attention.`
          : `System telemetry operates within normal operational parameters. No urgent risks detected.`,
      anomalies,
      proposals,
    };

    return report;
  }
}
