"use client";

import React, { useState, useEffect } from "react";
import {
  ShieldCheck,
  Search,
  Filter,
  Download,
  RefreshCw,
  Terminal,
  Bot,
  Rocket,
  Key,
  AlertOctagon,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { AuditEvent, AuditEventType } from "@/types/audit";
import { apiFetch } from "@/lib/client/api";

export const AuditView: React.FC = () => {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [filterType, setFilterType] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  const fetchAuditEvents = async () => {
    try {
      const res = await apiFetch("/api/audit?limit=200");
      const data = await res.json();
      if (data.success) {
        setEvents(data.data);
      }
    } catch {
      // Keep previous
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditEvents();
  }, []);

  const filteredEvents = events.filter((e) => {
    const matchesFilter = filterType === "all" || e.eventType.startsWith(filterType);
    const matchesSearch =
      e.actor.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (e.targetServerName && e.targetServerName.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (e.command && e.command.toLowerCase().includes(searchQuery.toLowerCase())) ||
      e.eventType.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const exportAuditJson = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `praxelops-audit-log-${new Date().toISOString().substring(0, 10)}.json`;
    a.click();
  };

  const getEventBadge = (type: AuditEventType) => {
    if (type.startsWith("ssh_")) {
      return (
        <span className="flex items-center space-x-1 text-success font-mono text-[11px]">
          <Terminal className="w-3 h-3" />
          <span>{type}</span>
        </span>
      );
    }
    if (type.startsWith("ai_")) {
      return (
        <span className="flex items-center space-x-1 text-violet font-mono text-[11px]">
          <Bot className="w-3 h-3" />
          <span>{type}</span>
        </span>
      );
    }
    if (type.startsWith("deployment_")) {
      return (
        <span className="flex items-center space-x-1 text-orange font-mono text-[11px]">
          <Rocket className="w-3 h-3" />
          <span>{type}</span>
        </span>
      );
    }
    return (
      <span className="flex items-center space-x-1 text-info font-mono text-[11px]">
        <Key className="w-3 h-3" />
        <span>{type}</span>
      </span>
    );
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden p-3 sm:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-fg flex items-center space-x-2">
            <ShieldCheck className="w-5 h-5 text-teal" />
            <span>Security Audit Log</span>
          </h1>
          <p className="text-xs text-fg-muted mt-0.5">
            Operational audit trail of sign-ins, SSH sessions, SFTP access, AI proposals and approvals, deployments and host changes.
          </p>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <input
            type="text"
            aria-label="Search audit events"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search actor, server, command..."
            className="px-3 py-1.5 rounded-lg bg-sunken border border-line-strong text-xs text-fg placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0 flex-1 sm:flex-none sm:w-56"
          />

          <button
            onClick={exportAuditJson}
            title="Export Audit Trail"
            aria-label="Export audit trail as JSON"
            className="flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-sunken hover:bg-hover-strong text-xs text-fg-2 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Export JSON</span>
          </button>

          <button
            onClick={fetchAuditEvents}
            disabled={loading}
            className="p-2 rounded-lg bg-sunken hover:bg-hover-strong text-fg-2 transition"
            title="Refresh Logs"
            aria-label="Refresh audit log"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Filter Chips */}
      <div className="flex items-center gap-1.5 overflow-x-auto shrink-0 select-none pb-1">
        <button
          onClick={() => setFilterType("all")}
          aria-pressed={filterType === "all"}
          className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
            filterType === "all"
              ? "bg-blue-600 text-white"
              : "bg-sunken text-fg-2"
          }`}
        >
          All Events ({events.length})
        </button>
        <button
          onClick={() => setFilterType("command_exec")}
          aria-pressed={filterType === "command_exec"}
          className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
            filterType === "command_exec"
              ? "bg-blue-600 text-white"
              : "bg-sunken text-fg-2"
          }`}
        >
          Commands
        </button>
        <button
          onClick={() => setFilterType("ai_")}
          aria-pressed={filterType === "ai_"}
          className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
            filterType === "ai_"
              ? "bg-blue-600 text-white"
              : "bg-sunken text-fg-2"
          }`}
        >
          AI Approvals & Actions
        </button>
        <button
          onClick={() => setFilterType("deployment_")}
          aria-pressed={filterType === "deployment_"}
          className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
            filterType === "deployment_"
              ? "bg-blue-600 text-white"
              : "bg-sunken text-fg-2"
          }`}
        >
          Deployments
        </button>
      </div>

      {/* Audit Log Table */}
      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-line bg-surface-2 backdrop-blur-md">
        <table className="w-full min-w-[46rem] text-left text-xs">
          <thead className="bg-elevated border-b border-line text-fg-muted font-medium select-none sticky top-0 z-10">
            <tr>
              <th className="py-2.5 px-4">Timestamp</th>
              <th className="py-2.5 px-4">Actor</th>
              <th className="py-2.5 px-4">Event Type</th>
              <th className="py-2.5 px-4">Target Host</th>
              <th className="py-2.5 px-4">Command / Detail</th>
              <th className="py-2.5 px-4 text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line font-mono">
            {!loading && filteredEvents.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 px-4 text-center text-fg-muted font-sans">
                  No audit events match the current filter.
                </td>
              </tr>
            )}
            {filteredEvents.map((evt) => (
              <tr
                key={evt.id}
                className="hover:bg-hover transition"
              >
                <td className="py-2 px-4 text-fg-muted whitespace-nowrap">
                  {new Date(evt.timestamp).toLocaleString()}
                </td>
                <td className="py-2 px-4 text-fg">
                  {evt.actor}
                </td>
                <td className="py-2 px-4">{getEventBadge(evt.eventType)}</td>
                <td className="py-2 px-4 text-fg-2">
                  {evt.targetServerName || "—"}
                </td>
                <td className="py-2 px-4 text-fg-2 max-w-xs truncate">
                  {evt.command ||
                    JSON.stringify(evt.details) ||
                    "—"}
                </td>
                <td className="py-2 px-4 text-right">
                  <span
                    className={`inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold ${
                      evt.status === "success"
                        ? "bg-emerald-500/10 text-success"
                        : "bg-rose-500/10 text-danger"
                    }`}
                  >
                    {evt.status === "success" ? (
                      <CheckCircle2 className="w-2.5 h-2.5" />
                    ) : (
                      <XCircle className="w-2.5 h-2.5" />
                    )}
                    <span>{evt.status}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
