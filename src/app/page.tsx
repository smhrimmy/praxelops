"use client";

import React, { useState, useEffect } from "react";
import { MenuBar } from "@/components/macos/MenuBar";
import { Sidebar } from "@/components/macos/Sidebar";
import { TrafficLights } from "@/components/macos/TrafficLights";
import { CommandPalette } from "@/components/macos/CommandPalette";
import { ServerGrid } from "@/components/servers/ServerGrid";
import { AddServerModal } from "@/components/servers/AddServerModal";
import { TerminalView } from "@/components/terminal/TerminalView";
import { SFTPView } from "@/components/sftp/SFTPView";
import { AIDiagnosticsView } from "@/components/ai/AIDiagnosticsView";
import { DeploymentsView } from "@/components/deployments/DeploymentsView";
import { AuditView } from "@/components/audit/AuditView";
import { ServerHost } from "@/types/server";

export default function PraxelOpsStudioPage() {
  const [servers, setServers] = useState<ServerHost[]>([]);
  const [selectedServer, setSelectedServer] = useState<ServerHost | undefined>(undefined);
  const [activeView, setActiveView] = useState<string>("fleet");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState<boolean>(false);
  const [isAddServerOpen, setIsAddServerOpen] = useState<boolean>(false);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);

  // Load server list
  const loadServers = async () => {
    try {
      const res = await fetch("/api/servers");
      const data = await res.json();
      if (data.success && data.data) {
        setServers(data.data);
        if (!selectedServer && data.data.length > 0) {
          setSelectedServer(data.data[0]);
        }
      }
    } catch {
      // Keep state
    }
  };

  useEffect(() => {
    loadServers();
  }, []);

  // Theme synchronization
  const toggleTheme = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
  };

  // Keyboard shortcut for Command Palette (Cmd/Ctrl + K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const onlineCount = servers.filter((s) => s.status === "online").length;

  return (
    <div className="flex flex-col h-screen w-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-900/10 via-neutral-900/20 to-neutral-950 overflow-hidden select-none">
      {/* Top macOS Menu Bar */}
      <MenuBar
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        activeView={activeView}
        onSelectView={(v) => setActiveView(v)}
        theme={theme}
        onToggleTheme={toggleTheme}
        onlineCount={onlineCount}
        totalServers={servers.length}
      />

      {/* Main macOS Desktop Window Stage */}
      <main className="flex-1 p-2 sm:p-4 flex items-center justify-center overflow-hidden">
        <div
          className={`w-full h-full macos-glass rounded-2xl shadow-2xl flex flex-col overflow-hidden transition-all duration-200 ${
            isMaximized ? "max-w-none max-h-none rounded-none border-none" : "max-w-7xl"
          }`}
        >
          {/* macOS Window Title Bar */}
          <div className="h-10 px-4 bg-white/40 dark:bg-black/30 border-b border-black/5 dark:border-white/10 flex items-center justify-between shrink-0">
            {/* Traffic Lights */}
            <TrafficLights
              onClose={() => setActiveView("fleet")}
              onMinimize={() => setIsMaximized(false)}
              onMaximize={() => setIsMaximized((prev) => !prev)}
              isMaximized={isMaximized}
            />

            {/* Window Center Title */}
            <div className="text-xs font-semibold text-neutral-700 dark:text-neutral-300 tracking-tight flex items-center space-x-1.5">
              <span>PraxelOps Studio</span>
              <span className="text-neutral-400">—</span>
              <span className="text-neutral-500 capitalize">{activeView}</span>
            </div>

            {/* Window Right Dummy Spacer */}
            <div className="w-12" />
          </div>

          {/* Window Body: Sidebar + Main Workspace */}
          <div className="flex-1 flex overflow-hidden">
            {/* Sidebar Navigation */}
            <Sidebar
              activeView={activeView}
              onSelectView={(v) => setActiveView(v)}
              serverCount={servers.length}
              openTerminalsCount={1}
              pendingApprovalsCount={1}
              onAddServerClick={() => setIsAddServerOpen(true)}
            />

            {/* Active Content Viewport */}
            <section className="flex-1 flex flex-col overflow-hidden bg-white/40 dark:bg-black/20">
              {activeView === "fleet" && (
                <ServerGrid
                  servers={servers}
                  onConnectSSH={(srv) => {
                    setSelectedServer(srv);
                    setActiveView("terminal");
                  }}
                  onOpenSFTP={(srv) => {
                    setSelectedServer(srv);
                    setActiveView("sftp");
                  }}
                  onDiagnose={(srv) => {
                    setSelectedServer(srv);
                    setActiveView("ai-ops");
                  }}
                  onAddServer={() => setIsAddServerOpen(true)}
                />
              )}

              {activeView === "terminal" && (
                <TerminalView
                  servers={servers}
                  selectedServer={selectedServer}
                />
              )}

              {activeView === "sftp" && (
                <SFTPView
                  servers={servers}
                  selectedServer={selectedServer}
                />
              )}

              {activeView === "ai-ops" && (
                <AIDiagnosticsView
                  servers={servers}
                  selectedServer={selectedServer}
                />
              )}

              {activeView === "deployments" && (
                <DeploymentsView servers={servers} />
              )}

              {activeView === "audit" && <AuditView />}
            </section>
          </div>
        </div>
      </main>

      {/* Global Command Palette Modal */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        servers={servers}
        onSelectServer={(srv) => {
          setSelectedServer(srv);
          setActiveView("fleet");
        }}
        onConnectSSH={(srv) => {
          setSelectedServer(srv);
          setActiveView("terminal");
        }}
        onOpenSFTP={(srv) => {
          setSelectedServer(srv);
          setActiveView("sftp");
        }}
        onSelectView={(view) => setActiveView(view)}
        onAddServer={() => setIsAddServerOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {/* Add Server Host Modal */}
      <AddServerModal
        isOpen={isAddServerOpen}
        onClose={() => setIsAddServerOpen(false)}
        onServerCreated={(newSrv) => {
          setServers((prev) => [...prev, newSrv]);
          setSelectedServer(newSrv);
        }}
      />
    </div>
  );
}
