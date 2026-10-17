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
        <div className="w-12 h-12 rounded-2xl bg-orange-500/10 flex items-center justify-center text-orange-500">
          <Rocket className="w-6 h-6" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            No Servers for Deployment
          </h2>
          <p className="text-xs text-neutral-500 leading-relaxed">
            Register a server host in Fleet to configure release workflows, verify build steps, and stream real-time logs.
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
    <div className="flex-1 flex flex-col h-full overflow-hidden p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100 flex items-center space-x-2">
            <Rocket className="w-5 h-5 text-orange-500" />
            <span>Deployments & Pipelines</span>
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Automated production deployments, health verification, and rollback triggers.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <select
            value={targetServerId}
            onChange={(e) => setTargetServerId(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-xs font-medium text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-orange-500"
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
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 text-white text-xs font-medium shadow-sm transition shrink-0 disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{isTriggering ? "Deploying..." : "Trigger Deployment"}</span>
          </button>
        </div>
      </div>

      {/* Main Grid: Pipeline List + Detail Log Viewer */}
      {deployments.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center rounded-2xl border border-dashed border-black/10 dark:border-white/10 p-8 text-center space-y-3">
          <Rocket className="w-8 h-8 text-neutral-400 opacity-50" />
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
              No Deployments Triggered
            </h2>
            <p className="text-xs text-neutral-500">
              Select a target node above and click &quot;Trigger Deployment&quot; to execute remote pipeline steps.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4 overflow-hidden">
          {/* Left: Deployment List */}
          <div className="md:col-span-1 rounded-xl border border-black/5 dark:border-white/10 bg-white/50 dark:bg-neutral-900/50 backdrop-blur-md p-3 overflow-y-auto space-y-2">
            <span className="text-[11px] font-semibold text-neutral-400 uppercase font-mono px-1">
              Workflows ({deployments.length})
            </span>

            {deployments.map((d) => {
              const isSelected = selectedWorkflow?.id === d.id;
              return (
                <div
                  key={d.id}
                  onClick={() => setSelectedWorkflow(d)}
                  className={`p-3 rounded-lg cursor-pointer transition border text-xs space-y-1 ${
                    isSelected
                      ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                      : "bg-black/5 dark:bg-white/5 border-transparent text-neutral-800 dark:text-neutral-200 hover:bg-black/10 dark:hover:bg-white/10"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold truncate">{d.name}</span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.2 rounded uppercase ${
                        d.status === "healthy"
                          ? "bg-emerald-500/20 text-emerald-300"
                          : d.status === "rolled_back"
                          ? "bg-amber-500/20 text-amber-300"
                          : "bg-rose-500/20 text-rose-300"
                      }`}
                    >
                      {d.status}
                    </span>
                  </div>
                  <div
                    className={`text-[11px] font-mono truncate ${
                      isSelected ? "text-blue-100" : "text-neutral-500"
                    }`}
                  >
                    {d.serverName} • {d.environment}
                  </div>
                  <div
                    className={`text-[10px] ${
                      isSelected ? "text-blue-200" : "text-neutral-400"
                    }`}
                  >
                    {new Date(d.createdAt).toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right: Selected Pipeline Steps & Execution Log Stream */}
          <div className="md:col-span-2 rounded-xl border border-black/5 dark:border-white/10 bg-white/50 dark:bg-neutral-900/50 backdrop-blur-md p-4 flex flex-col justify-between overflow-hidden">
            {selectedWorkflow ? (
              <div className="flex-1 flex flex-col overflow-hidden space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-black/5 dark:border-white/10">
                  <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                      {selectedWorkflow.name}
                    </h2>
                    <div className="text-xs font-mono text-neutral-500">
                      Target: {selectedWorkflow.serverName} ({selectedWorkflow.appDirectory})
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    {selectedWorkflow.rollbackCommand && (
                      <button
                        onClick={() => handleRollback(selectedWorkflow)}
                        className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 text-xs font-medium transition"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Rollback</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <span className="text-[10px] font-mono uppercase text-neutral-400">
                    Execution Pipeline Steps
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {selectedWorkflow.steps.map((step, idx) => (
                      <div
                        key={step.id}
                        className="p-2.5 rounded-lg bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 flex items-center justify-between text-xs font-mono"
                      >
                        <div className="flex items-center space-x-2 truncate">
                          <span className="text-neutral-400 font-bold">{idx + 1}.</span>
                          <span className="truncate text-neutral-800 dark:text-neutral-200">
                            {step.name}
                          </span>
                        </div>
                        <span
                          className={`text-[10px] uppercase font-bold shrink-0 ${
                            step.status === "success"
                              ? "text-emerald-500"
                              : step.status === "running"
                              ? "text-blue-500 animate-pulse"
                              : step.status === "failed"
                              ? "text-rose-500"
                              : "text-neutral-400"
                          }`}
                        >
                          {step.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex-1 flex flex-col overflow-hidden space-y-1">
                  <span className="text-[10px] font-mono uppercase text-neutral-400">
                    Step Output Logs
                  </span>
                  <div className="flex-1 bg-neutral-950 rounded-xl p-3 font-mono text-xs text-neutral-300 overflow-y-auto leading-relaxed border border-white/10">
                    {selectedWorkflow.steps.map((s) => (
                      <div key={s.id} className="mb-3">
                        <div className="text-neutral-500 font-semibold mb-1">
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
              <div className="h-full flex items-center justify-center text-xs text-neutral-400">
                Select a workflow to view execution details.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
