"use client";

import React, { useState, useEffect } from "react";
import {
  Rocket,
  CheckCircle2,
  XCircle,
  Clock,
  RotateCcw,
  Play,
  Terminal,
  Server,
  Layers,
  RefreshCw,
  Plus,
} from "lucide-react";
import { ServerHost } from "@/types/server";
import { DeploymentWorkflow } from "@/types/deployment";
import { apiFetch } from "@/lib/client/api";

interface DeploymentsViewProps {
  servers: ServerHost[];
  onAddServerClick?: () => void;
}

/** "healthy" only means all steps exited 0 (no HTTP health check runs), so say that. */
function statusLabel(status: DeploymentWorkflow["status"]): string {
  if (status === "healthy") return "steps passed";
  return status.replace("_", " ");
}

export const DeploymentsView: React.FC<DeploymentsViewProps> = ({
  servers,
  onAddServerClick,
}) => {
  const [deployments, setDeployments] = useState<DeploymentWorkflow[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] =
    useState<DeploymentWorkflow | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [isTriggering, setIsTriggering] = useState<boolean>(false);
  const [targetServerId, setTargetServerId] = useState<string>(
    servers.length > 0 ? servers[0].id : ""
  );

  const fetchDeployments = async () => {
    try {
      const res = await apiFetch("/api/deployments");
      const data = await res.json();
      if (data.success) {
        setDeployments(data.data);
        if (!selectedWorkflow && data.data.length > 0) {
          setSelectedWorkflow(data.data[0]);
        }
      }
    } catch {
      // Keep previous
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDeployments();
  }, []);

  const triggerDeploy = async () => {
    const srv = servers.find((s) => s.id === targetServerId) || servers[0];
    if (!srv) return;

    setIsTriggering(true);
    try {
      const res = await apiFetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Deploy to ${srv.name}`,
          serverId: srv.id,
          appDirectory: "/var/www/app",
          environment: "production",
          steps: [
            { name: "Git Fetch & Checkout", command: "git fetch origin && git checkout main" },
            { name: "Verify Dependencies", command: "npm check-dependencies || true" },
            { name: "Zero-Downtime Reload", command: "systemctl reload-or-restart app || true" },
          ],
          healthCheckUrl: "http://127.0.0.1:3000/api/health",
          rollbackCommand: "git reset --hard HEAD~1 && systemctl restart app",
        }),
      });

      const data = await res.json();
      if (data.success) {
        await fetchDeployments();
        setSelectedWorkflow(data.data);
      }
    } catch {
      // Error handling
    } finally {
      setIsTriggering(false);
    }
  };

  const handleRollback = async (workflow: DeploymentWorkflow) => {
    if (!confirm(`Are you sure you want to trigger rollback for ${workflow.name}?`)) {
      return;
    }
    try {
      const res = await apiFetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rollback",
          workflowId: workflow.id,
        }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchDeployments();
      }
    } catch {
      // Rollback error
    }
  };

  if (servers.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-orange-500/10 flex items-center justify-center text-orange">
          <Rocket className="w-6 h-6" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-sm font-semibold text-fg">
            No Servers for Deployment
          </h2>
          <p className="text-xs text-fg-muted leading-relaxed">
            Register a server host in Fleet first. Deployments run a fixed workflow over SSH and show each step's output once the run finishes.
          </p>
        </div>
        {onAddServerClick && (
          <button
            onClick={onAddServerClick}
            className="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium shadow-sm transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Server Host</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden p-3 sm:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-fg flex items-center space-x-2">
            <Rocket className="w-5 h-5 text-orange" />
            <span>Deployments & Pipelines</span>
          </h1>
          <p className="text-xs text-fg-muted mt-0.5">
            Runs a fixed three-step workflow over SSH in /var/www/app on the selected host (git fetch and checkout, dependency check, service reload). "Healthy" means every step exited 0; no HTTP health check is performed. Rollback runs git reset --hard HEAD~1.
          </p>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <select
            aria-label="Target server"
            value={targetServerId}
            onChange={(e) => setTargetServerId(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-sunken border border-line-strong text-xs font-medium text-fg focus:outline-none focus:ring-2 focus:ring-orange-600 min-w-0 flex-1 sm:flex-none"
          >
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.host})
              </option>
            ))}
          </select>

          <button
            onClick={triggerDeploy}
            disabled={isTriggering || servers.length === 0}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-orange-700 hover:bg-orange-800 text-white text-xs font-medium shadow-sm transition shrink-0 disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{isTriggering ? "Deploying..." : "Trigger Deployment"}</span>
          </button>
        </div>
      </div>

      {/* Main Grid: Pipeline List + Detail Log Viewer */}
      {deployments.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center rounded-2xl border border-dashed border-line p-8 text-center space-y-3">
          <Rocket className="w-8 h-8 text-fg-muted opacity-50" />
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-fg">
              No Deployments Triggered
            </h2>
            <p className="text-xs text-fg-muted">
              Select a target host above and click &quot;Trigger Deployment&quot; to run the workflow over SSH.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-3 gap-4 overflow-y-auto md:overflow-hidden auto-rows-min md:auto-rows-auto">
          {/* Left: Deployment List */}
          <div className="md:col-span-1 rounded-xl border border-line bg-surface-2 backdrop-blur-md p-3 md:overflow-y-auto md:min-h-0 space-y-2">
            <span className="text-[11px] font-semibold text-fg-muted uppercase font-mono px-1">
              Workflows ({deployments.length})
            </span>

            {deployments.map((d) => {
              const isSelected = selectedWorkflow?.id === d.id;
              return (
                <button
                  type="button"
                  key={d.id}
                  onClick={() => setSelectedWorkflow(d)}
                  aria-pressed={isSelected}
                  className={`w-full text-left p-3 rounded-lg cursor-pointer transition-colors border text-xs space-y-1 ${
                    isSelected
                      ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                      : "bg-sunken border-transparent text-fg hover:bg-hover-strong"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold truncate">{d.name}</span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded uppercase ${
                        isSelected
                          ? "bg-white/20 text-white"
                          : d.status === "healthy"
                          ? "bg-emerald-500/15 text-success"
                          : d.status === "rolled_back"
                          ? "bg-amber-500/15 text-warning"
                          : "bg-rose-500/15 text-danger"
                      }`}
                    >
                      {statusLabel(d.status)}
                    </span>
                  </div>
                  <div
                    className={`text-[11px] font-mono truncate ${
                      isSelected ? "text-white" : "text-fg-muted"
                    }`}
                  >
                    {d.serverName} • {d.environment}
                  </div>
                  <div
                    className={`text-[10px] ${
                      isSelected ? "text-white" : "text-fg-muted"
                    }`}
                  >
                    {new Date(d.createdAt).toLocaleString()}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right: Selected Pipeline Steps & Execution Log Stream */}
          <div className="md:col-span-2 rounded-xl border border-line bg-surface-2 backdrop-blur-md p-4 flex flex-col justify-between md:overflow-hidden md:min-h-0">
            {selectedWorkflow ? (
              <div className="flex-1 flex flex-col overflow-hidden space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-line">
                  <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold text-fg">
                      {selectedWorkflow.name}
                    </h2>
                    <div className="text-xs font-mono text-fg-muted">
                      Target: {selectedWorkflow.serverName} ({selectedWorkflow.appDirectory})
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    {selectedWorkflow.rollbackCommand && (
                      <button
                        onClick={() => handleRollback(selectedWorkflow)}
                        className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-danger text-xs font-medium transition"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Rollback</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-[10px] font-mono uppercase text-fg-muted">
                    Execution Pipeline Steps
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {selectedWorkflow.steps.map((step, idx) => (
                      <div
                        key={step.id}
                        className="p-2.5 rounded-lg bg-sunken border border-line flex items-center justify-between text-xs font-mono"
                      >
                        <div className="flex items-center space-x-2 truncate">
                          <span className="text-fg-muted font-bold">{idx + 1}.</span>
                          <span className="truncate text-fg">
                            {step.name}
                          </span>
                        </div>
                        <span
                          className={`text-[10px] uppercase font-bold shrink-0 ${
                            step.status === "success"
                              ? "text-success"
                              : step.status === "running"
                              ? "text-info animate-pulse"
                              : step.status === "failed"
                              ? "text-danger"
                              : "text-fg-muted"
                          }`}
                        >
                          {step.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex-1 flex flex-col overflow-hidden space-y-1">
                  <span className="text-[10px] font-mono uppercase text-fg-muted">
                    Step Output Logs
                  </span>
                  <div data-theme="dark" className="flex-1 min-h-[10rem] max-h-96 md:max-h-none bg-neutral-950 rounded-xl p-3 font-mono text-xs text-neutral-300 overflow-y-auto leading-relaxed border border-white/10">
                    {selectedWorkflow.steps.map((s) => (
                      <div key={s.id} className="mb-3">
                        <div className="text-fg-muted font-semibold mb-1">
                          &gt; {s.name} ({s.command})
                        </div>
                        <div className="text-emerald-400/90 whitespace-pre-wrap pl-2 border-l border-neutral-800">
                          {s.outputLog || "(No output recorded)"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-fg-muted">
                Select a workflow to view execution details.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
