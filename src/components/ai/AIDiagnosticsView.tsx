"use client";

import React, { useState } from "react";
import {
  Bot,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  RefreshCw,
  Zap,
  Lock,
  X,
  Play,
  Plus,
} from "lucide-react";
import { ServerHost } from "@/types/server";
import {
  ServerDiagnosticReport,
  AIOperationProposal,
  RiskLevel,
} from "@/types/ai";

interface AIDiagnosticsViewProps {
  servers: ServerHost[];
  selectedServer?: ServerHost;
  onAddServerClick?: () => void;
}

export const AIDiagnosticsView: React.FC<AIDiagnosticsViewProps> = ({
  servers,
  selectedServer,
  onAddServerClick,
}) => {
  const [currentServer, setCurrentServer] = useState<ServerHost | undefined>(
    selectedServer || (servers.length > 0 ? servers[0] : undefined)
  );
  const [report, setReport] = useState<ServerDiagnosticReport | null>(null);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [selectedProposal, setSelectedProposal] =
    useState<AIOperationProposal | null>(null);
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [executionResult, setExecutionResult] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const runDiagnostics = async (srv: ServerHost) => {
    setIsScanning(true);
    setReport(null);
    setExecutionResult(null);
    setErrorBanner(null);

    try {
      const res = await fetch("/api/ai/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: srv.id }),
      });
      const data = await res.json();
      if (data.success) {
        setReport(data.data);
      } else {
        setErrorBanner(data.error || "Diagnostic analysis failed");
      }
    } catch (err) {
      setErrorBanner(`Network error: ${(err as Error).message}`);
    } finally {
      setIsScanning(false);
    }
  };

  const handleApproveProposal = async () => {
    if (!selectedProposal || isExecuting) return;

    setIsExecuting(true);
    setExecutionResult(null);

    try {
      const res = await fetch("/api/ai/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId: selectedProposal.id,
          targetServerId: selectedProposal.targetServerId,
          approvalToken: selectedProposal.approvalToken,
          confirmedByUser: true,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setExecutionResult(data.data.output);
        if (report) {
          setReport({
            ...report,
            proposals: report.proposals.map((p) =>
              p.id === selectedProposal.id
                ? { ...p, status: "executed", executionOutput: data.data.output }
                : p
            ),
          });
        }
      } else {
        setExecutionResult(`Authorization or execution error: ${data.error}`);
      }
    } catch (err) {
      setExecutionResult(`Network Failure: ${(err as Error).message}`);
    } finally {
      setIsExecuting(false);
    }
  };

  const getRiskBadge = (level: RiskLevel) => {
    switch (level) {
      case "low":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase bg-blue-500/10 text-blue-500 border border-blue-500/20">
            Low Risk
          </span>
        );
      case "medium":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase bg-amber-500/10 text-amber-500 border border-amber-500/20">
            Medium Risk
          </span>
        );
      case "high":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase bg-orange-500/10 text-orange-500 border border-orange-500/20">
            High Risk
          </span>
        );
      case "critical":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase bg-rose-500/10 text-rose-500 border border-rose-500/20 animate-pulse">
            Critical
          </span>
        );
    }
  };

  if (servers.length === 0 || !currentServer) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-purple-500/10 flex items-center justify-center text-purple-400">
          <Bot className="w-6 h-6" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            No Servers Available for Diagnostics
          </h2>
          <p className="text-xs text-neutral-500 leading-relaxed">
            Register a server host in Fleet to scan telemetry metrics, detect bottlenecks, and generate safe remedial playbooks.
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
    <div className="flex-1 flex flex-col h-full overflow-hidden p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100 flex items-center space-x-2">
            <Bot className="w-5 h-5 text-purple-500" />
            <span>AI Operations Copilot</span>
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Grounded telemetry diagnostics, anomaly detection, and human-in-the-loop operational playbooks.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <select
            value={currentServer.id}
            onChange={(e) => {
              const s = servers.find((srv) => srv.id === e.target.value);
              if (s) {
                setCurrentServer(s);
                setReport(null);
                setErrorBanner(null);
              }
            }}
            className="px-3 py-1.5 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-xs font-medium text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.host})
              </option>
            ))}
          </select>

          <button
            onClick={() => runDiagnostics(currentServer)}
            disabled={isScanning}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-medium shadow-sm transition shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? "animate-spin" : ""}`} />
            <span>{isScanning ? "Analyzing..." : "Run Diagnostics"}</span>
          </button>
        </div>
      </div>

      {errorBanner && (
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center space-x-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{errorBanner}</span>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto space-y-4 pr-1">
        {!report && !isScanning && (
          <div className="h-72 flex flex-col items-center justify-center rounded-2xl border border-dashed border-black/10 dark:border-white/10 text-neutral-400 p-6 text-center">
            <Bot className="w-10 h-10 mb-3 text-purple-400/50" />
            <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
              Ready to Inspect {currentServer.name}
            </h3>
            <p className="text-xs max-w-sm mt-1 text-neutral-500">
              Click &quot;Run Diagnostics&quot; to inspect real system telemetry, active services, memory pressures, and generate remedial playbooks.
            </p>
          </div>
        )}

        {isScanning && (
          <div className="h-72 flex flex-col items-center justify-center space-y-3">
            <div className="w-8 h-8 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
            <p className="text-xs font-mono text-neutral-500">
              Evaluating telemetry and service status on {currentServer.host}...
            </p>
          </div>
        )}

        {report && (
          <div className="space-y-4">
            {/* Health Score Banner */}
            <div className="macos-card rounded-xl p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center space-x-2">
                  <span className="text-xs uppercase font-mono text-neutral-400">
                    Health Score
                  </span>
                  <span
                    className={`text-lg font-bold font-mono ${
                      report.healthScore > 80
                        ? "text-emerald-500"
                        : report.healthScore > 50
                        ? "text-amber-500"
                        : "text-rose-500"
                    }`}
                  >
                    {report.healthScore}/100
                  </span>
                </div>
                <p className="text-xs text-neutral-700 dark:text-neutral-300 font-medium">
                  {report.summary}
                </p>
              </div>

              <div className="flex items-center space-x-2 text-[11px] font-mono text-neutral-400">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                <span>Grounded Evidence Inspection</span>
              </div>
            </div>

            {/* Anomalies List */}
            {report.anomalies.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase font-mono text-neutral-500 dark:text-neutral-400 px-1">
                  Detected Anomalies ({report.anomalies.length})
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {report.anomalies.map((anom, idx) => (
                    <div
                      key={idx}
                      className="macos-card rounded-xl p-3.5 flex items-start space-x-3"
                    >
                      <AlertTriangle
                        className={`w-4 h-4 mt-0.5 shrink-0 ${
                          anom.severity === "critical"
                            ? "text-rose-500"
                            : "text-amber-500"
                        }`}
                      />
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className="text-xs font-semibold text-neutral-900 dark:text-neutral-100 uppercase tracking-wide">
                            {anom.category} Bottleneck
                          </span>
                          {anom.metricValue && (
                            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-black/5 dark:bg-white/5 text-neutral-600 dark:text-neutral-300">
                              {anom.metricValue}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-neutral-600 dark:text-neutral-300">
                          {anom.detail}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Operational Proposals */}
            {report.proposals.length > 0 && (
              <div className="space-y-2 pt-2">
                <h3 className="text-xs font-semibold uppercase font-mono text-neutral-500 dark:text-neutral-400 px-1">
                  Remedial Operation Proposals ({report.proposals.length})
                </h3>

                <div className="space-y-3">
                  {report.proposals.map((prop) => (
                    <div
                      key={prop.id}
                      className="macos-card rounded-xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4"
                    >
                      <div className="space-y-1.5 max-w-2xl">
                        <div className="flex items-center space-x-2">
                          {getRiskBadge(prop.riskLevel)}
                          {prop.requiresSudo && (
                            <span className="flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-500/10 text-purple-600 dark:text-purple-400">
                              <Lock className="w-2.5 h-2.5" />
                              <span>Requires Sudo</span>
                            </span>
                          )}
                          <h4 className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">
                            {prop.title}
                          </h4>
                        </div>

                        <p className="text-xs text-neutral-600 dark:text-neutral-300">
                          {prop.rationale}
                        </p>

                        <div className="flex items-center space-x-2 font-mono text-[11px] text-neutral-400">
                          <span>Expected: {prop.expectedOutcome}</span>
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center space-x-2">
                        {prop.status === "executed" ? (
                          <span className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Executed</span>
                          </span>
                        ) : (
                          <button
                            onClick={() => {
                              setSelectedProposal(prop);
                              setExecutionResult(null);
                            }}
                            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition shadow-sm"
                          >
                            <Zap className="w-3.5 h-3.5" />
                            <span>Review & Authorize</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Explicit Human Approval Modal */}
      {selectedProposal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-150">
          <div className="w-full max-w-xl bg-white dark:bg-neutral-900 rounded-2xl border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-black/5 dark:border-white/10">
              <div className="flex items-center space-x-2">
                <ShieldAlert className="w-5 h-5 text-amber-500" />
                <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  Explicit Operational Approval Gate
                </h2>
              </div>
              <button
                onClick={() => {
                  setSelectedProposal(null);
                  setExecutionResult(null);
                }}
                className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-neutral-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto">
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs">
                <strong>Safety Governance Invariant:</strong> AI recommendations
                will never run automatically. Review the target commands and risk
                assessment before authorizing execution.
              </div>

              <div>
                <span className="text-[10px] font-mono uppercase text-neutral-400">
                  Target Server Host
                </span>
                <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">
                  {selectedProposal.targetServerName} ({selectedProposal.targetServerId})
                </p>
              </div>

              <div>
                <span className="text-[10px] font-mono uppercase text-neutral-400">
                  Proposal Rationale
                </span>
                <p className="text-xs text-neutral-700 dark:text-neutral-300">
                  {selectedProposal.rationale}
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono uppercase text-neutral-400">
                    Commands Dispatched via SSH
                  </span>
                  {getRiskBadge(selectedProposal.riskLevel)}
                </div>
                <div className="p-3 rounded-lg bg-neutral-950 font-mono text-xs text-emerald-400 border border-white/10 space-y-1">
                  {selectedProposal.commands.map((cmd, i) => (
                    <div key={i} className="flex items-start space-x-2">
                      <span className="text-neutral-600 select-none">$</span>
                      <span>{cmd}</span>
                    </div>
                  ))}
                </div>
              </div>

              {selectedProposal.rollbackPlan && (
                <div>
                  <span className="text-[10px] font-mono uppercase text-neutral-400">
                    Documented Rollback Path
                  </span>
                  <p className="text-xs font-mono text-neutral-600 dark:text-neutral-400 bg-black/5 dark:bg-white/5 p-2 rounded">
                    {selectedProposal.rollbackPlan}
                  </p>
                </div>
              )}

              {executionResult && (
                <div>
                  <span className="text-[10px] font-mono uppercase text-neutral-400">
                    Execution Output & Verification
                  </span>
                  <pre className="mt-1 p-3 rounded-lg bg-neutral-950 text-neutral-200 text-xs font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {executionResult}
                  </pre>
                </div>
              )}
            </div>

            <div className="p-4 bg-neutral-50 dark:bg-neutral-950/40 border-t border-black/5 dark:border-white/10 flex items-center justify-end space-x-2">
              <button
                type="button"
                onClick={() => {
                  setSelectedProposal(null);
                  setExecutionResult(null);
                }}
                disabled={isExecuting}
                className="px-3 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-xs text-neutral-600 dark:text-neutral-400"
              >
                Cancel / Reject
              </button>

              <button
                type="button"
                onClick={handleApproveProposal}
                disabled={isExecuting || selectedProposal.status === "executed"}
                className="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium shadow-sm transition disabled:opacity-50"
              >
                {isExecuting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Executing Remotely...</span>
                  </>
                ) : selectedProposal.status === "executed" ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Completed</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    <span>Authorize & Execute</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
