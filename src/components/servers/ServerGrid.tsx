"use client";

import React, { useState } from "react";
import {
  Server,
  Terminal,
  FolderTree,
  Bot,
  HardDrive,
  Cpu,
  Layers,
  Clock,
  Trash2,
  Plus,
  AlertCircle,
  FlaskConical,
} from "lucide-react";
import { ServerHost } from "@/types/server";

interface ServerGridProps {
  servers: ServerHost[];
  onConnectSSH: (server: ServerHost) => void;
  onOpenSFTP: (server: ServerHost) => void;
  onDiagnose: (server: ServerHost) => void;
  onAddServer: () => void;
  onLoadDemoEnvironment?: () => void;
  onDeleteServer?: (serverId: string) => void;
}

export const ServerGrid: React.FC<ServerGridProps> = ({
  servers,
  onConnectSSH,
  onOpenSFTP,
  onDiagnose,
  onAddServer,
  onLoadDemoEnvironment,
  onDeleteServer,
}) => {
  const [selectedTag, setSelectedTag] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const allTags = Array.from(
    new Set(servers.flatMap((s) => s.tags || []))
  );

  const filteredServers = servers.filter((s) => {
    const matchesTag =
      selectedTag === "all" || s.tags.includes(selectedTag);
    const matchesSearch =
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.host.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesTag && matchesSearch;
  });

  const formatUptime = (seconds?: number) => {
    if (!seconds || seconds === 0) return "n/a";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h`;
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden p-3 sm:p-6 space-y-4 sm:space-y-5">
      {/* Top Controls: Header, Tag Filter & Search */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-fg flex items-center space-x-2">
            <span>Infrastructure Fleet</span>
            <span className="text-xs font-mono font-normal px-2 py-0.5 rounded-full bg-sunken-2 text-fg-muted">
              {servers.length} configured
            </span>
          </h1>
          <p className="text-xs text-fg-muted mt-0.5">
            SSH hosts you have registered. Open a terminal, browse files over SFTP, or run an AI diagnostic.
          </p>
        </div>

        <div className="flex items-center space-x-2 w-full sm:w-auto">
          <input
            type="text"
            aria-label="Filter hosts"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by name, IP, or tag..."
            className="px-3 py-1.5 rounded-lg bg-sunken border border-line-strong text-xs text-fg placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-blue-500 w-full sm:w-64"
          />

          <button
            onClick={onAddServer}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium shadow-sm transition shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Host</span>
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      {servers.length > 0 && (
        <div className="flex items-center space-x-1.5 overflow-x-auto pb-1 shrink-0">
          <button
            onClick={() => setSelectedTag("all")}
            aria-pressed={selectedTag === "all"}
            className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              selectedTag === "all"
                ? "bg-blue-600 text-white"
                : "bg-sunken text-fg-2 hover:text-fg"
            }`}
          >
            All Nodes ({servers.length})
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setSelectedTag(tag)}
              aria-pressed={selectedTag === tag}
              className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                selectedTag === tag
                  ? "bg-blue-600 text-white"
                  : "bg-sunken text-fg-2 hover:text-fg"
              }`}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}

      {/* Server Cards Grid / Empty State */}
      <div className="flex-1 overflow-y-auto pr-1">
        {servers.length === 0 ? (
          <div className="h-full min-h-[300px] flex flex-col items-center justify-center rounded-2xl border border-dashed border-line p-8 text-center space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-blue-500/10 flex items-center justify-center text-info">
              <Server className="w-6 h-6" />
            </div>
            <div className="max-w-md space-y-1">
              <h2 className="text-sm font-semibold text-fg">
                No Infrastructure Nodes Registered
              </h2>
              <p className="text-xs text-fg-muted leading-relaxed">
                Register a Linux or macOS host with its SSH credentials. Once added you can open an interactive SSH terminal, browse files over SFTP, and run AI diagnostics. Live CPU, memory and disk metrics are not collected yet.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-2 pt-2">
              <button
                onClick={onAddServer}
                className="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium shadow-sm transition"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Register Server Host</span>
              </button>

              {onLoadDemoEnvironment && (
                <button
                  onClick={onLoadDemoEnvironment}
                  className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-sunken hover:bg-hover-strong text-xs font-mono text-fg-2 transition"
                  title="Loads a sandbox environment explicitly marked as [DEMO]"
                >
                  <FlaskConical className="w-3.5 h-3.5" />
                  <span>Load [DEMO] Sandbox</span>
                </button>
              )}
            </div>
          </div>
        ) : filteredServers.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center rounded-2xl border border-dashed border-line text-fg-muted">
            <Server className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-xs">No server nodes match the current filter &quot;{searchQuery}&quot;.</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4 pb-6">
            {filteredServers.map((server) => {
              const m = server.metrics;
              const hasMetrics = m && m.reportedAt && !m.isStale;
              const isDemo = server.tags.includes("demo") || server.name.startsWith("[DEMO]");

              return (
                <div
                  key={server.id}
                  className="macos-card rounded-xl p-4 flex flex-col justify-between hover:border-line-strong transition-all duration-150 group"
                >
                  <div>
                    {/* Header: Status + Name + IP */}
                    <div className="flex items-start justify-between">
                      <div className="space-y-0.5 min-w-0 truncate pr-2">
                        <div className="flex items-center space-x-2">
                          <span
                            aria-hidden="true"
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              server.status === "online"
                                ? "bg-emerald-500"
                                : server.status === "degraded"
                                ? "bg-amber-500"
                                : "bg-neutral-400"
                            }`}
                          />
                          <h3 className="text-sm font-semibold text-fg truncate">
                            {server.name}
                          </h3>
                        </div>
                        <div className="text-[11px] font-mono text-fg-muted truncate">
                          {server.username}@{server.host}:{server.port}
                        </div>
                      </div>

                      <div className="flex items-center space-x-1 shrink-0">
                        {onDeleteServer && (
                          <button
                            onClick={() => onDeleteServer(server.id)}
                            title="Remove host"
                            aria-label={`Remove host ${server.name}`}
                            className="p-1.5 rounded sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100 hover:bg-rose-500/10 text-fg-muted hover:text-danger transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {isDemo ? (
                          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-purple-500/10 text-violet border border-purple-500/20 font-bold">
                            DEMO
                          </span>
                        ) : (
                          <span
                            className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                              server.status === "online"
                                ? "bg-emerald-500/10 text-success border border-emerald-500/20"
                                : server.status === "degraded"
                                ? "bg-amber-500/10 text-warning border border-amber-500/20"
                                : "bg-neutral-500/10 text-fg-2 border border-neutral-500/20"
                            }`}
                          >
                            {server.status === "checking" ? "unchecked" : `last known: ${server.status}`}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Tags */}
                    {server.tags && server.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2.5">
                        {server.tags.map((tag) => (
                          <span
                            key={tag}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-sunken text-fg-2 font-mono"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Metrics Gauges or Honest Unpolled State */}
                    {hasMetrics ? (
                      <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-line">
                        {/* CPU */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-fg-muted flex items-center space-x-1">
                              <Cpu className="w-3 h-3" />
                              <span>CPU</span>
                            </span>
                            <span className="font-mono font-medium text-fg">
                              {m.cpuPercent.toFixed(1)}%
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-track rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all duration-300 ${
                                m.cpuPercent > 85
                                  ? "bg-rose-500"
                                  : m.cpuPercent > 60
                                  ? "bg-amber-500"
                                  : "bg-emerald-500"
                              }`}
                              style={{ width: `${Math.min(m.cpuPercent, 100)}%` }}
                            />
                          </div>
                        </div>

                        {/* Memory */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-fg-muted flex items-center space-x-1">
                              <Layers className="w-3 h-3" />
                              <span>RAM</span>
                            </span>
                            <span className="font-mono font-medium text-fg">
                              {m.memoryPercent.toFixed(1)}%
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-track rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all duration-300 ${
                                m.memoryPercent > 85
                                  ? "bg-rose-500"
                                  : m.memoryPercent > 60
                                  ? "bg-amber-500"
                                  : "bg-blue-500"
                              }`}
                              style={{ width: `${Math.min(m.memoryPercent, 100)}%` }}
                            />
                          </div>
                        </div>

                        {/* Disk */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-fg-muted flex items-center space-x-1">
                              <HardDrive className="w-3 h-3" />
                              <span>Disk</span>
                            </span>
                            <span className="font-mono font-medium text-fg">
                              {m.diskPercent.toFixed(0)}%
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-track rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all duration-300 ${
                                m.diskPercent > 85
                                  ? "bg-rose-500"
                                  : m.diskPercent > 60
                                  ? "bg-amber-500"
                                  : "bg-purple-500"
                              }`}
                              style={{ width: `${Math.min(m.diskPercent, 100)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 pt-3 border-t border-line flex items-center space-x-2 text-xs text-fg-muted bg-sunken p-2.5 rounded-lg">
                        <AlertCircle className="w-4 h-4 shrink-0 text-warning" />
                        <span>No metrics collected for this host (a metrics collector is not available yet).</span>
                      </div>
                    )}

                    {/* Metadata Footer */}
                    <div className="flex items-center justify-between text-[10px] text-fg-muted mt-3 font-mono">
                      <span className="flex items-center space-x-1">
                        <Clock className="w-2.5 h-2.5" />
                        <span>Uptime {formatUptime(m?.uptimeSeconds)}</span>
                      </span>
                      <span>{server.osVersion || "Linux"}</span>
                    </div>
                  </div>

                  {/* Actions Bar */}
                  <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-line">
                    <button
                      onClick={() => onConnectSSH(server)}
                      className="flex items-center justify-center space-x-1 px-2 py-1.5 rounded-lg bg-emerald-600/10 hover:bg-emerald-600/20 text-success text-xs font-medium transition"
                    >
                      <Terminal className="w-3 h-3" />
                      <span>SSH</span>
                    </button>

                    <button
                      onClick={() => onOpenSFTP(server)}
                      className="flex items-center justify-center space-x-1 px-2 py-1.5 rounded-lg bg-blue-600/10 hover:bg-blue-600/20 text-info text-xs font-medium transition"
                    >
                      <FolderTree className="w-3 h-3" />
                      <span>SFTP</span>
                    </button>

                    <button
                      onClick={() => onDiagnose(server)}
                      className="flex items-center justify-center space-x-1 px-2 py-1.5 rounded-lg bg-purple-600/10 hover:bg-purple-600/20 text-violet text-xs font-medium transition"
                    >
                      <Bot className="w-3 h-3" />
                      <span>AI Fix</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
