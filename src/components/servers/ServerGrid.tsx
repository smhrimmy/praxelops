"use client";

import React, { useState } from "react";
import {
  Server,
  Terminal,
  FolderTree,
  Bot,
  Activity,
  HardDrive,
  Cpu,
  Layers,
  Clock,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Plus,
} from "lucide-react";
import { ServerHost } from "@/types/server";

interface ServerGridProps {
  servers: ServerHost[];
  onConnectSSH: (server: ServerHost) => void;
  onOpenSFTP: (server: ServerHost) => void;
  onDiagnose: (server: ServerHost) => void;
  onAddServer: () => void;
  onDeleteServer?: (serverId: string) => void;
}

export const ServerGrid: React.FC<ServerGridProps> = ({
  servers,
  onConnectSSH,
  onOpenSFTP,
  onDiagnose,
  onAddServer,
  onDeleteServer,
}) => {
  const [selectedTag, setSelectedTag] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Extract all unique tags
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
    if (!seconds) return "Unknown";
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
          <h1 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
            Infrastructure Fleet
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Real-time monitoring, SSH terminal access, and AI diagnostics across {servers.length} managed nodes.
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

      {/* Server Cards Grid */}
      <div className="flex-1 overflow-y-auto pr-1">
        {filteredServers.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center rounded-2xl border border-dashed border-black/10 dark:border-white/10 text-neutral-400">
            <Server className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-xs">No server nodes match the current filter.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-6">
            {filteredServers.map((server) => {
              const m = server.metrics;
              const cpuPct = m?.cpuPercent ?? 0;
              const memPct = m?.memoryPercent ?? 0;
              const diskPct = m?.diskPercent ?? 0;

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
                                : "bg-rose-500"
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
                        <span
                          className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                            server.status === "online"
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                              : server.status === "degraded"
                              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                              : "bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20"
                          }`}
                        >
                          {server.status}
                        </span>
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

                    {/* Metrics Gauges */}
                    <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-black/5 dark:border-white/10">
                      {/* CPU */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-neutral-500 dark:text-neutral-400 flex items-center space-x-1">
                            <Cpu className="w-3 h-3" />
                            <span>CPU</span>
                          </span>
                          <span className="font-mono font-medium text-neutral-800 dark:text-neutral-200">
                            {cpuPct.toFixed(1)}%
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${
                              cpuPct > 85
                                ? "bg-rose-500"
                                : cpuPct > 60
                                ? "bg-amber-500"
                                : "bg-emerald-500"
                            }`}
                            style={{ width: `${Math.min(cpuPct, 100)}%` }}
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
                            {memPct.toFixed(1)}%
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${
                              memPct > 85
                                ? "bg-rose-500"
                                : memPct > 60
                                ? "bg-amber-500"
                                : "bg-blue-500"
                            }`}
                            style={{ width: `${Math.min(memPct, 100)}%` }}
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
                            {diskPct.toFixed(0)}%
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${
                              diskPct > 85
                                ? "bg-rose-500"
                                : diskPct > 60
                                ? "bg-amber-500"
                                : "bg-purple-500"
                            }`}
                            style={{ width: `${Math.min(diskPct, 100)}%` }}
                          />
                        </div>
                      </div>
                    </div>

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
