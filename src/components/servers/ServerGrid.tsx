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
  Plus,
  AlertCircle,
  FlaskConical,
  ShieldAlert,
} from "lucide-react";
import type { FleetServer } from "@/lib/fleet/types";
import { deriveServerStatus, TONE_CLASSES } from "@/lib/fleet/health";
import { formatDuration, formatLoad, formatPercent } from "@/lib/fleet/format";
import { useNow } from "@/components/monitor/hooks";
import { AgeLabel, Meter, StateBadge, StateDot } from "@/components/monitor/ui";

interface ServerGridProps {
  servers: FleetServer[];
  /** Epoch ms of the last successful listing; ages count up from it between polls. */
  fetchedAt: number;
  /** Opens the Terminal workspace with a NEW tab for this server. */
  onConnectSSH: (server: FleetServer) => void;
  onOpenSFTP: (server: FleetServer) => void;
  onDiagnose: (server: FleetServer) => void;
  onOpenMonitor: (server: FleetServer) => void;
  onAddServer: () => void;
  onLoadDemoEnvironment?: () => void;
  onDeleteServer?: (serverId: string) => void;
}

export const ServerGrid: React.FC<ServerGridProps> = ({
  servers,
  fetchedAt,
  onConnectSSH,
  onOpenSFTP,
  onDiagnose,
  onOpenMonitor,
  onAddServer,
  onLoadDemoEnvironment,
  onDeleteServer,
}) => {
  const [selectedTag, setSelectedTag] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const now = useNow(1000);

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
            SSH hosts you have registered, with their real health. Open a terminal, watch live metrics, browse files over SFTP, or run an AI diagnostic.
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
                Register a Linux or macOS host with its SSH credentials. Once added you can open an interactive SSH terminal, browse files over SFTP, and run AI diagnostics. After its host key is pinned, the background collector (npm run collector) samples CPU, memory, disk and network.
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
              const status = deriveServerStatus(server, fetchedAt, now);
              const m = status.metrics;
              const isDemo = server.tags.includes("demo") || server.name.startsWith("[DEMO]");
              const isAlert = status.info.tone === "alert";

              return (
                <div
                  key={server.id}
                  className={`macos-card rounded-xl p-4 flex flex-col justify-between hover:border-line-strong transition-all duration-150 group ${
                    isAlert ? "border-danger! ring-1 ring-danger/50" : ""
                  }`}
                >
                  <div>
                    {/* Header: health state + Name + IP */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-0.5 min-w-0 flex-1 pr-2">
                        <div className="flex items-center space-x-2">
                          <StateDot state={status.state} />
                          <h3 className="text-sm font-semibold text-fg truncate">
                            {server.name}
                          </h3>
                        </div>
                        <div className="text-[11px] font-mono text-fg-muted truncate">
                          {server.username}@{server.host}:{server.port}
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <div className="flex items-center space-x-1">
                          {onDeleteServer && (
                            <button
                              onClick={() => onDeleteServer(server.id)}
                              title="Remove host"
                              aria-label={`Remove host ${server.name}`}
                              className="p-1.5 rounded sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100 hover:bg-danger/10 text-fg-muted hover:text-danger transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {isDemo && (
                            <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-violet/10 text-violet border border-violet/30 font-bold">
                              DEMO
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2">
                      <StateBadge state={status.state} />
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

                    {isAlert && (
                      <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-danger bg-danger/10 p-2 text-[11px] text-danger">
                        <ShieldAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>Security alert: the host presented a different SSH key than the pinned one.</span>
                      </div>
                    )}

                    {/* Real metrics, or the reason there are none */}
                    {m ? (
                      <div className="mt-4 pt-3 border-t border-line space-y-3">
                        <div className="grid grid-cols-3 gap-2">
                          <Meter label="CPU" icon={<Cpu className="w-3 h-3" aria-hidden="true" />} percent={m.cpuPercent} valueText={formatPercent(m.cpuPercent)} dim={status.lastKnown} />
                          <Meter label="RAM" icon={<Layers className="w-3 h-3" aria-hidden="true" />} percent={m.memoryPercent} valueText={formatPercent(m.memoryPercent)} dim={status.lastKnown} />
                          <Meter label="Disk" icon={<HardDrive className="w-3 h-3" aria-hidden="true" />} percent={m.diskPercent} valueText={formatPercent(m.diskPercent, 0)} dim={status.lastKnown} />
                        </div>
                        {status.lastKnown && (
                          <p className="text-[11px] text-fg-2">
                            <span className={`font-semibold ${TONE_CLASSES[status.info.tone].text}`}>{status.info.label}.</span> {status.note}
                          </p>
                        )}
                      </div>
                    ) : (
                      !isAlert && (
                        <div className="mt-4 pt-3 border-t border-line">
                          <div className="flex items-start space-x-2 text-xs text-fg-2 bg-sunken p-2.5 rounded-lg">
                            <AlertCircle aria-hidden="true" className={`w-4 h-4 shrink-0 ${TONE_CLASSES[status.info.tone].text}`} />
                            <span>{status.note}</span>
                          </div>
                        </div>
                      )
                    )}

                    {/* Metadata Footer */}
                    <div className="flex items-center justify-between gap-2 text-[10px] text-fg-muted mt-3 font-mono">
                      <span className="flex items-center space-x-1">
                        <Clock className="w-2.5 h-2.5" aria-hidden="true" />
                        <span>
                          Up {m ? formatDuration(m.uptimeSeconds) : "—"} · Load {m ? formatLoad(m.loadAverage[0]) : "—"}
                        </span>
                      </span>
                      <span className="truncate">{server.osVersion || "Linux"}</span>
                    </div>
                    <div className="mt-1">
                      <AgeLabel prefix={m && !status.lastKnown ? "updated" : "last sample"} seconds={status.sampleAgeSeconds} stale={status.stale} />
                    </div>
                  </div>

                  {/* Actions Bar */}
                  <div className="grid grid-cols-2 gap-2 mt-4 pt-3 border-t border-line">
                    <button
                      onClick={() => onConnectSSH(server)}
                      aria-label={`Open terminal for ${server.name}`}
                      className="flex items-center justify-center space-x-1 px-2 py-1.5 rounded-lg bg-success/10 hover:bg-success/20 text-success text-xs font-medium transition"
                    >
                      <Terminal className="w-3 h-3" aria-hidden="true" />
                      <span>Open terminal</span>
                    </button>

                    <button
                      onClick={() => onOpenMonitor(server)}
                      aria-label={`Open System Monitor for ${server.name}`}
                      className="flex items-center justify-center space-x-1 px-2 py-1.5 rounded-lg bg-info/10 hover:bg-info/20 text-info text-xs font-medium transition"
                    >
                      <Activity className="w-3 h-3" aria-hidden="true" />
                      <span>Monitor</span>
                    </button>

                    <button
                      onClick={() => onOpenSFTP(server)}
                      className="flex items-center justify-center space-x-1 px-2 py-1.5 rounded-lg bg-sunken hover:bg-hover-strong text-fg-2 text-xs font-medium transition"
                    >
                      <FolderTree className="w-3 h-3" aria-hidden="true" />
                      <span>SFTP</span>
                    </button>

                    <button
                      onClick={() => onDiagnose(server)}
                      className="flex items-center justify-center space-x-1 px-2 py-1.5 rounded-lg bg-violet/10 hover:bg-violet/20 text-violet text-xs font-medium transition"
                    >
                      <Bot className="w-3 h-3" aria-hidden="true" />
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
