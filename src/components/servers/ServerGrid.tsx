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
    if (!seconds || seconds === 0) return "Not available";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h`;
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden p-6 space-y-5">
      {/* Top Controls: Header, Tag Filter & Search */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100 flex items-center space-x-2">
            <span>Infrastructure Fleet</span>
            <span className="text-xs font-mono font-normal px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/10 text-neutral-500">
              {servers.length} configured
            </span>
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Real SSH endpoints, authentic system metrics, and grounded operational playbooks.
          </p>
        </div>

        <div className="flex items-center space-x-2 w-full sm:w-auto">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by name, IP, or tag..."
            className="px-3 py-1.5 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-xs text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500 w-full sm:w-64"
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
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
              selectedTag === "all"
                ? "bg-blue-600 text-white"
                : "bg-black/5 dark:bg-white/5 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
            }`}
          >
            All Nodes ({servers.length})
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setSelectedTag(tag)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                selectedTag === tag
                  ? "bg-blue-600 text-white"
                  : "bg-black/5 dark:bg-white/5 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
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
          <div className="h-full min-h-[300px] flex flex-col items-center justify-center rounded-2xl border border-dashed border-black/10 dark:border-white/10 p-8 text-center space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-500">
              <Server className="w-6 h-6" />
            </div>
            <div className="max-w-md space-y-1">
              <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                No Infrastructure Nodes Registered
              </h2>
              <p className="text-xs text-neutral-500 leading-relaxed">
                Connect your first Linux or macOS server using standard SSH credentials. Real CPU, memory, and disk telemetry will be polled directly from the host.
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
                  className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-xs font-mono text-neutral-600 dark:text-neutral-400 transition"
                  title="Loads a sandbox environment explicitly marked as [DEMO]"
                >
                  <FlaskConical className="w-3.5 h-3.5" />
                  <span>Load [DEMO] Sandbox</span>
                </button>
              )}
            </div>
          </div>
        ) : filteredServers.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center rounded-2xl border border-dashed border-black/10 dark:border-white/10 text-neutral-400">
            <Server className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-xs">No server nodes match the current filter &quot;{searchQuery}&quot;.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-6">
            {filteredServers.map((server) => {
              const m = server.metrics;
              const hasMetrics = m && m.reportedAt && !m.isStale;
              const isDemo = server.tags.includes("demo") || server.name.startsWith("[DEMO]");

              return (
                <div
                  key={server.id}
                  className="macos-card rounded-xl p-4 flex flex-col justify-between hover:border-black/20 dark:hover:border-white/20 transition-all duration-150 group"
                >
                  <div>
                    {/* Header: Status + Name + IP */}
                    <div className="flex items-start justify-between">
                      <div className="space-y-0.5 truncate pr-2">
                        <div className="flex items-center space-x-2">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              server.status === "online"
                                ? "bg-emerald-500 animate-pulse"
                                : server.status === "degraded"
                                ? "bg-amber-500 animate-pulse"
                                : "bg-neutral-400"
                            }`}
                          />
                          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                            {server.name}
                          </h3>
                        </div>
                        <div className="text-[11px] font-mono text-neutral-500 dark:text-neutral-400 truncate">
                          {server.username}@{server.host}:{server.port}
                        </div>
                      </div>

                      <div className="flex items-center space-x-1 shrink-0">
                        {onDeleteServer && (
                          <button
                            onClick={() => onDeleteServer(server.id)}
                            title="Remove host"
                            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-rose-500/10 text-neutral-400 hover:text-rose-500 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {isDemo ? (
                          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 font-bold">
                            DEMO
                          </span>
                        ) : (
                          <span
                            className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                              server.status === "online"
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                                : server.status === "degraded"
                                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                                : "bg-neutral-500/10 text-neutral-600 dark:text-neutral-400 border border-neutral-500/20"
                            }`}
                          >
                            {server.status}
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
                            className="text-[10px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 text-neutral-600 dark:text-neutral-400 font-mono"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Metrics Gauges or Honest Unpolled State */}
                    {hasMetrics ? (
                      <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-black/5 dark:border-white/10">
                        {/* CPU */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-neutral-500 dark:text-neutral-400 flex items-center space-x-1">
                              <Cpu className="w-3 h-3" />
                              <span>CPU</span>
                            </span>
                            <span className="font-mono font-medium text-neutral-800 dark:text-neutral-200">
                              {m.cpuPercent.toFixed(1)}%
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden">
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
                            <span className="text-neutral-500 dark:text-neutral-400 flex items-center space-x-1">
                              <Layers className="w-3 h-3" />
                              <span>RAM</span>
                            </span>
                            <span className="font-mono font-medium text-neutral-800 dark:text-neutral-200">
                              {m.memoryPercent.toFixed(1)}%
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden">
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
                            <span className="text-neutral-500 dark:text-neutral-400 flex items-center space-x-1">
                              <HardDrive className="w-3 h-3" />
                              <span>Disk</span>
                            </span>
                            <span className="font-mono font-medium text-neutral-800 dark:text-neutral-200">
                              {m.diskPercent.toFixed(0)}%
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden">
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
                      <div className="mt-4 pt-3 border-t border-black/5 dark:border-white/10 flex items-center space-x-2 text-xs text-neutral-500 bg-black/5 dark:bg-white/5 p-2.5 rounded-lg">
                        <AlertCircle className="w-4 h-4 shrink-0 text-amber-500" />
                        <span>Telemetry unpolled. Connect via SSH to collect live metrics.</span>
                      </div>
                    )}

                    {/* Metadata Footer */}
                    <div className="flex items-center justify-between text-[10px] text-neutral-400 mt-3 font-mono">
                      <span className="flex items-center space-x-1">
                        <Clock className="w-2.5 h-2.5" />
                        <span>Up {formatUptime(m?.uptimeSeconds)}</span>
                      </span>
                      <span>{server.osVersion || "Linux"}</span>
                    </div>
                  </div>

                  {/* Actions Bar */}
                  <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-black/5 dark:border-white/10">
                    <button
                      onClick={() => onConnectSSH(server)}
                      className="flex items-center justify-center space-x-1 px-2 py-1.5 rounded-lg bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-600 dark:text-emerald-400 text-xs font-medium transition"
                    >
                      <Terminal className="w-3 h-3" />
                      <span>SSH</span>
                    </button>

                    <button
                      onClick={() => onOpenSFTP(server)}
                      className="flex items-center justify-center space-x-1 px-2 py-1.5 rounded-lg bg-blue-600/10 hover:bg-blue-600/20 text-blue-600 dark:text-blue-400 text-xs font-medium transition"
                    >
                      <FolderTree className="w-3 h-3" />
                      <span>SFTP</span>
                    </button>

                    <button
                      onClick={() => onDiagnose(server)}
                      className="flex items-center justify-center space-x-1 px-2 py-1.5 rounded-lg bg-purple-600/10 hover:bg-purple-600/20 text-purple-600 dark:text-purple-400 text-xs font-medium transition"
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
