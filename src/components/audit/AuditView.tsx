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
        <span className="flex items-center space-x-1 text-emerald-500 font-mono text-[11px]">
          <Terminal className="w-3 h-3" />
          <span>{type}</span>
        </span>
      );
    }
    if (type.startsWith("ai_")) {
      return (
        <span className="flex items-center space-x-1 text-purple-500 font-mono text-[11px]">
          <Bot className="w-3 h-3" />
          <span>{type}</span>
        </span>
      );
    }
    if (type.startsWith("deployment_")) {
      return (
        <span className="flex items-center space-x-1 text-orange-500 font-mono text-[11px]">
          <Rocket className="w-3 h-3" />
          <span>{type}</span>
        </span>
      );
    }
    return (
      <span className="flex items-center space-x-1 text-blue-500 font-mono text-[11px]">
        <Key className="w-3 h-3" />
        <span>{type}</span>
      </span>
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100 flex items-center space-x-2">
            <ShieldCheck className="w-5 h-5 text-teal-500" />
            <span>Immutable Security Audit Log</span>
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Tamper-evident operational audit trail covering all SSH sessions, AI commands, approvals and deployments.
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search actor, server, command..."
            className="px-3 py-1.5 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-xs text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500 w-56"
          />

          <button
            onClick={exportAuditJson}
            title="Export Audit Trail"
            className="flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-xs text-neutral-700 dark:text-neutral-300 transition"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Export JSON</span>
          </button>

          <button
            onClick={fetchAuditEvents}
            disabled={loading}
            className="p-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-neutral-700 dark:text-neutral-300 transition"
            title="Refresh Logs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Filter Chips */}
      <div className="flex items-center space-x-1.5 overflow-x-auto shrink-0 select-none">
        <button
          onClick={() => setFilterType("all")}
          className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
            filterType === "all"
              ? "bg-blue-600 text-white"
              : "bg-black/5 dark:bg-white/5 text-neutral-600 dark:text-neutral-400"
          }`}
        >
          All Events ({events.length})
        </button>
        <button
          onClick={() => setFilterType("command_exec")}
          className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
            filterType === "command_exec"
              ? "bg-blue-600 text-white"
              : "bg-black/5 dark:bg-white/5 text-neutral-600 dark:text-neutral-400"
          }`}
        >
          Commands
        </button>
        <button
          onClick={() => setFilterType("ai_")}
          className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
            filterType === "ai_"
              ? "bg-blue-600 text-white"
              : "bg-black/5 dark:bg-white/5 text-neutral-600 dark:text-neutral-400"
          }`}
        >
          AI Approvals & Actions
        </button>
        <button
          onClick={() => setFilterType("deployment_")}
          className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
            filterType === "deployment_"
              ? "bg-blue-600 text-white"
              : "bg-black/5 dark:bg-white/5 text-neutral-600 dark:text-neutral-400"
          }`}
        >
          Deployments
        </button>
      </div>

      {/* Audit Log Table */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-black/5 dark:border-white/10 bg-white/50 dark:bg-neutral-900/50 backdrop-blur-md">
        <table className="w-full text-left text-xs">
          <thead className="bg-black/5 dark:bg-white/5 border-b border-black/5 dark:border-white/10 text-neutral-500 dark:text-neutral-400 font-medium select-none sticky top-0">
            <tr>
              <th className="py-2.5 px-4">Timestamp</th>
              <th className="py-2.5 px-4">Actor</th>
              <th className="py-2.5 px-4">Event Type</th>
              <th className="py-2.5 px-4">Target Host</th>
              <th className="py-2.5 px-4">Command / Detail</th>
              <th className="py-2.5 px-4 text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/5 dark:divide-white/5 font-mono">
            {filteredEvents.map((evt) => (
              <tr
                key={evt.id}
                className="hover:bg-black/5 dark:hover:bg-white/5 transition"
              >
                <td className="py-2 px-4 text-neutral-500 whitespace-nowrap">
                  {new Date(evt.timestamp).toLocaleString()}
                </td>
                <td className="py-2 px-4 text-neutral-800 dark:text-neutral-200">
                  {evt.actor}
                </td>
                <td className="py-2 px-4">{getEventBadge(evt.eventType)}</td>
                <td className="py-2 px-4 text-neutral-700 dark:text-neutral-300">
                  {evt.targetServerName || "—"}
                </td>
                <td className="py-2 px-4 text-neutral-600 dark:text-neutral-400 max-w-xs truncate">
                  {evt.command ||
                    JSON.stringify(evt.details) ||
                    "—"}
                </td>
                <td className="py-2 px-4 text-right">
                  <span
                    className={`inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold ${
                      evt.status === "success"
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
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
