import { ServerHost } from "@/types/server";
import { ServerDiagnosticReport, AIOperationProposal } from "@/types/ai";

export class AIDiagnosticsEngine {
  /**
   * Generates grounded diagnostic reports and operational proposals from server evidence
   */
  static analyzeServer(server: ServerHost): ServerDiagnosticReport {
    const metrics = server.metrics;
    const anomalies: ServerDiagnosticReport["anomalies"] = [];
    const proposals: AIOperationProposal[] = [];

    let healthScore = 100;

    // 1. CPU Analysis
    if (metrics && metrics.cpuPercent > 85) {
      healthScore -= 25;
      anomalies.push({
        category: "cpu",
        severity: "critical",
        detail: `Sustained high CPU utilization (${metrics.cpuPercent}%). System responsiveness is severely degraded.`,
        metricValue: `${metrics.cpuPercent}%`,
      });

      proposals.push({
        id: `prop-cpu-${Date.now()}`,
        targetServerId: server.id,
        targetServerName: server.name,
        title: "Throttle rogue runaway processes and optimize worker pool",
        rationale: `CPU load exceeds 85% threshold. Identify top CPU-consuming process and reload configuration.`,
        riskLevel: "medium",
        commands: [
          "ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%cpu | head -n 6",
          "systemctl reload-or-restart nginx || true",
        ],
        requiresSudo: true,
        rollbackPlan: "systemctl restart nginx",
        expectedOutcome: "Lowers CPU usage below 50% and clears stuck worker sockets.",
        isDestructive: false,
        status: "pending_approval",
        createdAt: new Date().toISOString(),
      });
    } else if (metrics && metrics.cpuPercent > 60) {
      healthScore -= 10;
      anomalies.push({
        category: "cpu",
        severity: "warning",
        detail: `Elevated CPU usage (${metrics.cpuPercent}%). Potential batch processing or queue backlog.`,
        metricValue: `${metrics.cpuPercent}%`,
      });
    }

    // 2. Memory Analysis
    if (metrics && metrics.memoryPercent > 85) {
      healthScore -= 30;
      anomalies.push({
        category: "memory",
        severity: "critical",
        detail: `High RAM exhaustion (${metrics.memoryPercent}% used, only ${(
          metrics.memoryTotalGB - metrics.memoryUsedGB
        ).toFixed(1)}GB free). Risk of Linux OOM killer invocation.`,
        metricValue: `${metrics.memoryPercent}%`,
      });

      proposals.push({
        id: `prop-mem-${Date.now()}`,
        targetServerId: server.id,
        targetServerName: server.name,
        title: "Flush OS page caches and recycle idle workers",
        rationale: "Mitigate immediate OOM pressure before vital database or API processes are killed.",
        riskLevel: "high",
        commands: [
          "sync",
          "echo 3 > /proc/sys/vm/drop_caches",
          "systemctl restart redis-server || true",
        ],
        requiresSudo: true,
        rollbackPlan: "Re-enable standard cache memory allocation.",
        expectedOutcome: "Recovers 15-30% buffer/cache memory immediately.",
        isDestructive: false,
        status: "pending_approval",
        createdAt: new Date().toISOString(),
      });
    }

    // 3. Disk Analysis
    if (metrics && metrics.diskPercent > 85) {
      healthScore -= 30;
      anomalies.push({
        category: "disk",
        severity: "critical",
        detail: `Root partition storage almost full (${metrics.diskPercent}%). Logs or core dumps accumulating rapidly.`,
        metricValue: `${metrics.diskPercent}%`,
      });

      proposals.push({
        id: `prop-disk-${Date.now()}`,
        targetServerId: server.id,
        targetServerName: server.name,
        title: "Clean rotated systemd journals and old docker layers",
        rationale: "Frees several gigabytes of inactive journal logs and dangling container images.",
        riskLevel: "medium",
        commands: [
          "journalctl --vacuum-time=3d",
          "docker system prune -f --filter 'until=48h' || true",
        ],
        requiresSudo: true,
        rollbackPlan: "Logs older than 3 days will remain purged.",
        expectedOutcome: "Restores disk free margin above 25%.",
        isDestructive: false,
        status: "pending_approval",
        createdAt: new Date().toISOString(),
      });
    }

    // 4. Default healthy summary if no critical threshold exceeded
    if (anomalies.length === 0) {
      proposals.push({
        id: `prop-opt-${Date.now()}`,
        targetServerId: server.id,
        targetServerName: server.name,
        title: "Routine kernel security patch check and cache check",
        rationale: "Node is healthy. Verify pending apt/dnf security updates.",
        riskLevel: "low",
        commands: ["apt-get update --dry-run || dnf check-update || true"],
        requiresSudo: false,
        rollbackPlan: "No system state modified.",
        expectedOutcome: "Identifies whether reboot or package upgrades are pending.",
        isDestructive: false,
        status: "pending_approval",
        createdAt: new Date().toISOString(),
      });
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
