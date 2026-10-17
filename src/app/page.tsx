"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { PanelLeft } from "lucide-react";
import { MenuBar } from "@/components/macos/MenuBar";
import { Sidebar } from "@/components/macos/Sidebar";
import { TrafficLights } from "@/components/macos/TrafficLights";
import { CommandPalette } from "@/components/macos/CommandPalette";
import { WORKSPACES, workspaceLabel, type WorkspaceId } from "@/components/macos/workspaces";
import { useMediaQuery } from "@/components/macos/platform";
import { ServerGrid } from "@/components/servers/ServerGrid";
import { AddServerModal } from "@/components/servers/AddServerModal";
import { TerminalView } from "@/components/terminal/TerminalView";
import { SFTPView } from "@/components/sftp/SFTPView";
import { AIDiagnosticsView } from "@/components/ai/AIDiagnosticsView";
import { DeploymentsView } from "@/components/deployments/DeploymentsView";
import { AuditView } from "@/components/audit/AuditView";
import { LoginScreen } from "@/components/auth/LoginScreen";
import { ServerHost } from "@/types/server";
import { apiFetch, fetchSession, logout, UNAUTHORIZED_EVENT } from "@/lib/client/api";

const THEME_KEY = "praxelops-theme";
const SIDEBAR_KEY = "praxelops-sidebar";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the choice just won't persist.
  }
}

function isEditableTarget(el: HTMLElement | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function PraxelOpsWorkspace({ onLogout }: { onLogout: () => void }) {
  const [servers, setServers] = useState<ServerHost[]>([]);
  const [selectedServer, setSelectedServer] = useState<ServerHost | undefined>(undefined);
  const [activeView, setActiveView] = useState<WorkspaceId>("fleet");
  // This component only mounts on the client after the session check, so reading the DOM/localStorage here is safe.
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "light"
      ? "light"
      : "dark"
  );
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState<boolean>(false);
  const [isAddServerOpen, setIsAddServerOpen] = useState<boolean>(false);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => typeof window !== "undefined" && readStored(SIDEBAR_KEY) === "collapsed"
  );
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const isNarrow = useMediaQuery("(max-width: 899px)");
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);

  // Load server list
  const loadServers = async () => {
    try {
      const res = await apiFetch("/api/servers");
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

  const handleLoadDemo = async () => {
    try {
      const res = await apiFetch("/api/servers/demo", { method: "POST" });
      const data = await res.json();
      if (data.success && data.data) {
        setServers(data.data);
        setSelectedServer(data.data[0]);
      }
    } catch {
      // Error
    }
  };

  const handleDeleteServer = async (serverId: string) => {
    if (!confirm("Are you sure you want to remove this host from inventory?")) return;
    try {
      const res = await apiFetch(`/api/servers?id=${encodeURIComponent(serverId)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        const next = servers.filter((s) => s.id !== serverId);
        setServers(next);
        if (selectedServer?.id === serverId) {
          setSelectedServer(next[0]);
        }
      }
    } catch {
      // Fallback local filter
      const next = servers.filter((s) => s.id !== serverId);
      setServers(next);
    }
  };

  useEffect(() => {
    loadServers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme: persisted choice; follows the OS only while there is no stored choice.
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    writeStored(THEME_KEY, next);
  };

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      const stored = readStored(THEME_KEY);
      if (stored === "light" || stored === "dark") return;
      const next = mql.matches ? "light" : "dark";
      setTheme(next);
      document.documentElement.setAttribute("data-theme", next);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Sidebar: docked column / icon rail on wide screens, overlay drawer when narrow.
  const toggleSidebar = useCallback(() => {
    if (isNarrow) {
      setDrawerOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      writeStored(SIDEBAR_KEY, next ? "collapsed" : "expanded");
      return next;
    });
  }, [isNarrow]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    sidebarToggleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isNarrow) setDrawerOpen(false);
  }, [isNarrow]);

  // xterm fits to its container on window resize only, so nudge it after layout changes settle.
  useEffect(() => {
    const t = window.setTimeout(() => window.dispatchEvent(new Event("resize")), 260);
    return () => window.clearTimeout(t);
  }, [sidebarCollapsed, isMaximized, isNarrow]);

  // Keyboard: Cmd/Ctrl+K palette, +B sidebar, +1..6 workspaces.
  const modalOpen = isCommandPaletteOpen || isAddServerOpen;
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      const target = e.target instanceof HTMLElement ? e.target : null;
      const inTerminal = !!target?.closest(".xterm");
      // Inside the terminal Ctrl+<key> belongs to the shell (Ctrl+K kills a line, Ctrl+B moves back); only Cmd is ours.
      if (inTerminal && !e.metaKey) return;

      if (key === "k") {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
        return;
      }
      // Other shortcuts never fire while typing in a field or while a dialog is open.
      if ((isEditableTarget(target) && !inTerminal) || modalOpen) return;

      if (key === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      const index = Number(key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < WORKSPACES.length) {
        e.preventDefault();
        setActiveView(WORKSPACES[index].id);
        setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [modalOpen, toggleSidebar]);

  const sidebarExpanded = isNarrow ? drawerOpen : !sidebarCollapsed;
  const toggleLabel = isNarrow
    ? drawerOpen
      ? "Close navigation"
      : "Open navigation"
    : sidebarCollapsed
    ? "Expand sidebar"
    : "Collapse sidebar";

  return (
    <div className="app-bg flex flex-col h-dvh w-full overflow-hidden select-none">
      <a
        href="#workspace-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[60] focus:rounded-md focus:bg-elevated focus:px-3 focus:py-1.5 focus:text-xs focus:text-fg focus:ring-2 focus:ring-focus"
      >
        Skip to workspace
      </a>

      {/* Top macOS Menu Bar */}
      <MenuBar
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        activeView={activeView}
        onSelectView={(v) => setActiveView(v as WorkspaceId)}
        theme={theme}
        onToggleTheme={toggleTheme}
        totalServers={servers.length}
        onLogout={onLogout}
      />

      {/* Main macOS Desktop Window Stage */}
      <main
        className={`flex-1 min-h-0 min-w-0 flex items-center justify-center ${
          isMaximized ? "p-0" : "p-0 sm:p-3 lg:p-4"
        }`}
      >
        <div
          className={`w-full h-full macos-glass shadow-2xl flex flex-col overflow-hidden transition-[max-width] duration-200 ${
            isMaximized ? "max-w-none rounded-none border-none" : "max-w-7xl rounded-none sm:rounded-2xl"
          }`}
        >
          {/* macOS Window Title Bar */}
          <div className="h-10 px-2 sm:px-4 bg-chrome border-b border-line flex items-center gap-2 shrink-0">
            <div className="hidden sm:block">
              <TrafficLights
                onClose={() => setActiveView("fleet")}
                onMinimize={() => setIsMaximized(false)}
                onMaximize={() => setIsMaximized((prev) => !prev)}
                isMaximized={isMaximized}
              />
            </div>

            <button
              ref={sidebarToggleRef}
              type="button"
              onClick={toggleSidebar}
              aria-label={toggleLabel}
              aria-expanded={sidebarExpanded}
              aria-controls="app-sidebar"
              aria-keyshortcuts="Control+B Meta+B"
              title={`${toggleLabel} (Ctrl/⌘+B)`}
              className="p-1.5 rounded-md hover:bg-hover text-fg-2 hover:text-fg transition-colors shrink-0"
            >
              <PanelLeft aria-hidden="true" className="w-4 h-4" />
            </button>

            <div className="flex-1 min-w-0 text-xs font-semibold text-fg-2 tracking-tight flex items-center justify-center gap-1.5">
              <span className="hidden sm:inline whitespace-nowrap">PraxelOps Studio</span>
              <span className="text-fg-muted hidden sm:inline" aria-hidden="true">
                —
              </span>
              <span className="text-fg-muted truncate">{workspaceLabel(activeView)}</span>
            </div>

            <div className="hidden sm:block w-12 shrink-0" aria-hidden="true" />
          </div>

          {/* Window Body: Sidebar + Main Workspace */}
          <div className="relative flex-1 min-h-0 flex overflow-hidden">
            <Sidebar
              activeView={activeView}
              onSelectView={(v) => setActiveView(v as WorkspaceId)}
              serverCount={servers.length}
              onAddServerClick={() => {
                setIsAddServerOpen(true);
                setDrawerOpen(false);
              }}
              variant={isNarrow ? "drawer" : "docked"}
              collapsed={sidebarCollapsed}
              drawerOpen={drawerOpen}
              onToggle={toggleSidebar}
              onCloseDrawer={closeDrawer}
            />

            <section
              id="workspace-content"
              tabIndex={-1}
              aria-label={workspaceLabel(activeView)}
              className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-content outline-none"
            >
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
                  onLoadDemoEnvironment={handleLoadDemo}
                  onDeleteServer={handleDeleteServer}
                />
              )}

              {activeView === "terminal" && (
                <TerminalView
                  servers={servers}
                  selectedServer={selectedServer}
                  onAddServerClick={() => setIsAddServerOpen(true)}
                />
              )}

              {activeView === "sftp" && (
                <SFTPView
                  servers={servers}
                  selectedServer={selectedServer}
                  onAddServerClick={() => setIsAddServerOpen(true)}
                />
              )}

              {activeView === "ai-ops" && (
                <AIDiagnosticsView
                  servers={servers}
                  selectedServer={selectedServer}
                  onAddServerClick={() => setIsAddServerOpen(true)}
                />
              )}

              {activeView === "deployments" && (
                <DeploymentsView
                  servers={servers}
                  onAddServerClick={() => setIsAddServerOpen(true)}
                />
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
        onSelectView={(view) => setActiveView(view as WorkspaceId)}
        onAddServer={() => setIsAddServerOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        onToggleSidebar={toggleSidebar}
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

type AuthStatus = "loading" | "unauthenticated" | "authenticated";

export default function PraxelOpsStudioPage() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    fetchSession().then((session) => {
      if (!cancelled) setAuthStatus(session.authenticated ? "authenticated" : "unauthenticated");
    });
    const onUnauthorized = () => setAuthStatus("unauthenticated");
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);

  const handleLogout = async () => {
    await logout();
    setAuthStatus("unauthenticated");
  };

  if (authStatus === "loading") {
    return (
      <div className="app-bg flex h-dvh w-full items-center justify-center text-xs text-fg-muted">
        Loading...
      </div>
    );
  }

  if (authStatus === "unauthenticated") {
    return <LoginScreen onAuthenticated={() => setAuthStatus("authenticated")} />;
  }

  return <PraxelOpsWorkspace onLogout={handleLogout} />;
}
