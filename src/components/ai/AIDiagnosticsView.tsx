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
import { apiFetch } from "@/lib/client/api";

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
      const res = await apiFetch("/api/ai/diagnose", {
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
      const res = await apiFetch("/api/ai/approve", {
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
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase bg-blue-500/10 text-info border border-blue-500/20">
            Low Risk
          </span>
        );
      case "medium":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase bg-amber-500/10 text-warning border border-amber-500/20">
            Medium Risk
          </span>
        );
      case "high":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase bg-orange-500/10 text-orange border border-orange-500/20">
            High Risk
          </span>
        );
      case "critical":
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold uppercase bg-rose-500/10 text-danger border border-rose-500/20 animate-pulse">
            Critical
          </span>
        );
    }
  };

  if (servers.length === 0 || !currentServer) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-purple-500/10 flex items-center justify-center text-violet">
          <Bot className="w-6 h-6" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-sm font-semibold text-fg">
            No Servers Available for Diagnostics
          </h2>
          <p className="text-xs text-fg-muted leading-relaxed">
            Register a server host in Fleet first. Diagnostics review the metrics stored for a host and propose remediation commands that only run after you approve them.
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
    <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden p-3 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-fg flex items-center space-x-2">
            <Bot className="w-5 h-5 text-violet" />
            <span>AI Operations Copilot</span>
          </h1>
          <p className="text-xs text-fg-muted mt-0.5">
            Reviews the metrics stored for a host and proposes remediation commands. Nothing runs over SSH until you approve it and it passes the command policy.
          </p>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <select
            aria-label="Server"
            value={currentServer.id}
            onChange={(e) => {
              const s = servers.find((srv) => srv.id === e.target.value);
              if (s) {
                setCurrentServer(s);
                setReport(null);
                setErrorBanner(null);
              }
            }}
            className="px-3 py-1.5 rounded-lg bg-sunken border border-line-strong text-xs font-medium text-fg focus:outline-none focus:ring-2 focus:ring-purple-500 min-w-0 flex-1 sm:flex-none"
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
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-danger text-xs flex items-center space-x-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{errorBanner}</span>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
        {!report && !isScanning && (
          <div className="h-72 flex flex-col items-center justify-center rounded-2xl border border-dashed border-line text-fg-muted p-6 text-center">
            <Bot className="w-10 h-10 mb-3 text-purple-400/50" />
            <h3 className="text-sm font-semibold text-fg-2">
              Ready to Inspect {currentServer.name}
            </h3>
            <p className="text-xs max-w-sm mt-1 text-fg-muted">
              Click &quot;Run Diagnostics&quot; to analyze the metrics stored for this host. Hosts with no stored metrics report that no data is available; no metrics collector exists yet.
            </p>
          </div>
        )}

        {isScanning && (
          <div className="h-72 flex flex-col items-center justify-center space-y-3">
            <div className="w-8 h-8 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
            <p className="text-xs font-mono text-fg-muted">
              Analyzing stored metrics for {currentServer.name}...
            </p>
          </div>
        )}

        {report && (
          <div className="space-y-4">
            {/* Health Score Banner */}
            <div className="macos-card rounded-xl p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center space-x-2">
                  <span className="text-xs uppercase font-mono text-fg-muted">
                    Health Score
                  </span>
                  <span
                    className={`text-lg font-bold font-mono ${
                      report.healthScore > 80
                        ? "text-success"
                        : report.healthScore > 50
                        ? "text-warning"
                        : "text-danger"
                    }`}
                  >
                    {currentServer.metrics ? `${report.healthScore}/100` : "N/A"}
                  </span>
                </div>
                <p className="text-xs text-fg-2 font-medium">
                  {report.summary}
                </p>
              </div>

              <div className="flex items-center space-x-2 text-[11px] font-mono text-fg-muted">
                <ShieldCheck className="w-4 h-4 text-success" />
                <span>{currentServer.metrics ? "Based on stored host metrics" : "No metrics stored for this host"}</span>
              </div>
            </div>

            {/* Anomalies List */}
            {report.anomalies.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase font-mono text-fg-muted px-1">
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
                            ? "text-danger"
                            : "text-warning"
                        }`}
                      />
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className="text-xs font-semibold text-fg uppercase tracking-wide">
                            {anom.category} Bottleneck
                          </span>
                          {anom.metricValue && (
                            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-sunken text-fg-2">
                              {anom.metricValue}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-fg-2">
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
                <h3 className="text-xs font-semibold uppercase font-mono text-fg-muted px-1">
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
                            <span className="flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-500/10 text-violet">
                              <Lock className="w-2.5 h-2.5" />
                              <span>Requires Sudo</span>
                            </span>
                          )}
                          <h4 className="text-xs font-semibold text-fg">
                            {prop.title}
                          </h4>
                        </div>

                        <p className="text-xs text-fg-2">
                          {prop.rationale}
                        </p>

                        <div className="flex items-center space-x-2 font-mono text-[11px] text-fg-muted">
                          <span>Expected: {prop.expectedOutcome}</span>
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center space-x-2">
                        {prop.status === "executed" ? (
                          <span className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-success text-xs font-medium">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-md">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-gate-title"
            className="w-full max-w-xl bg-elevated rounded-2xl border border-line shadow-2xl overflow-hidden flex flex-col max-h-[calc(100dvh-1.5rem)]"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <div className="flex items-center space-x-2">
                <ShieldAlert className="w-5 h-5 text-warning" />
                <h2 id="approval-gate-title" className="text-sm font-semibold text-fg">
                  Explicit Operational Approval Gate
                </h2>
              </div>
              <button
                onClick={() => {
                  setSelectedProposal(null);
                  setExecutionResult(null);
                }}
                aria-label="Close approval dialog"
                className="p-1.5 rounded-lg hover:bg-hover text-fg-muted"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto">
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-warning text-xs">
                <strong>Safety Governance Invariant:</strong> AI recommendations
                will never run automatically. Review the target commands and risk
                assessment before authorizing execution.
              </div>

              <div>
                <span className="text-[10px] font-mono uppercase text-fg-muted">
                  Target Server Host
                </span>
                <p className="text-xs font-semibold text-fg">
                  {selectedProposal.targetServerName} ({selectedProposal.targetServerId})
                </p>
              </div>

              <div>
                <span className="text-[10px] font-mono uppercase text-fg-muted">
                  Proposal Rationale
                </span>
                <p className="text-xs text-fg-2">
                  {selectedProposal.rationale}
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono uppercase text-fg-muted">
                    Commands Dispatched via SSH
                  </span>
                  {getRiskBadge(selectedProposal.riskLevel)}
                </div>
                <div data-theme="dark" className="p-3 rounded-lg bg-neutral-950 font-mono text-xs text-emerald-400 border border-white/10 space-y-1">
                  {selectedProposal.commands.map((cmd, i) => (
                    <div key={i} className="flex items-start space-x-2">
                      <span className="text-fg-2 select-none">$</span>
                      <span>{cmd}</span>
                    </div>
                  ))}
                </div>
              </div>

              {selectedProposal.rollbackPlan && (
                <div>
                  <span className="text-[10px] font-mono uppercase text-fg-muted">
                    Documented Rollback Path
                  </span>
                  <p className="text-xs font-mono text-fg-2 bg-sunken p-2 rounded">
                    {selectedProposal.rollbackPlan}
                  </p>
                </div>
              )}

              {executionResult && (
                <div>
                  <span className="text-[10px] font-mono uppercase text-fg-muted">
                    Execution Output & Verification
                  </span>
                  <pre data-theme="dark" className="mt-1 p-3 rounded-lg bg-neutral-950 text-neutral-200 text-xs font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {executionResult}
                  </pre>
                </div>
              )}
            </div>

            <div className="p-4 bg-chrome border-t border-line flex items-center justify-end space-x-2">
              <button
                type="button"
                onClick={() => {
                  setSelectedProposal(null);
                  setExecutionResult(null);
                }}
                disabled={isExecuting}
                className="px-3 py-1.5 rounded-lg hover:bg-hover text-xs text-fg-2"
              >
                Cancel / Reject
              </button>

              <button
                type="button"
                onClick={handleApproveProposal}
                disabled={isExecuting || selectedProposal.status === "executed"}
                className="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-medium shadow-sm transition disabled:opacity-50"
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
