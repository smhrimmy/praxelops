"use client";

import React, { useState, useEffect, useRef } from "react";
import { Terminal, Sun, Moon, Search, LogOut, Server, Clock, MoreHorizontal } from "lucide-react";
import { WORKSPACES } from "./workspaces";
import { useModKeyLabel } from "./platform";
import { FleetStatus, FleetStatusList } from "./FleetStatus";
import { orderEntries } from "@/lib/fleet/status";
import { summarizeFleet } from "@/lib/fleet/health";
import type { FleetServer } from "@/lib/fleet/types";

interface MenuBarProps {
  onOpenCommandPalette: () => void;
  activeView: string;
  onSelectView: (view: string) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  /** Inventory with real health data; drives the per-server status indicator. */
  servers: FleetServer[];
  /** Epoch ms of the last successful server listing (0 = not loaded yet). */
  fleetFetchedAt: number;
  /** Open the System Monitor on one server's detail page. */
  onOpenMonitorServer: (serverId: string) => void;
  /** Open the System Monitor overview. */
  onOpenMonitor: () => void;
  onLogout: () => void;
}

export const MenuBar: React.FC<MenuBarProps> = ({
  onOpenCommandPalette,
  activeView,
  onSelectView,
  theme,
  onToggleTheme,
  servers,
  fleetFetchedAt,
  onOpenMonitorServer,
  onOpenMonitor,
  onLogout,
}) => {
  const [time, setTime] = useState<string>("");
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const modKey = useModKeyLabel();

  useEffect(() => {
    const updateTime = () => {
      setTime(
        new Date().toLocaleTimeString([], {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      );
    };
    updateTime();
    const timer = setInterval(updateTime, 15000);
    return () => clearInterval(timer);
  }, []);

  // Close the overflow menu on outside press or Escape.
  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMoreOpen(false);
        moreButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const summary = summarizeFleet(servers);
  const hostLabel = `${summary.total} ${summary.total === 1 ? "host" : "hosts"}`;
  const overflowSummary =
    summary.total === 0
      ? "No hosts registered"
      : `${hostLabel}: ${summary.reachable} reachable, ${summary.attention} need attention`;
  const iconBtn =
    "p-1.5 rounded-md hover:bg-hover text-fg-2 hover:text-fg transition-colors shrink-0";

  return (
    <header className="h-9 w-full bg-chrome backdrop-blur-md border-b border-line px-2 sm:px-3 flex items-center justify-between gap-2 text-xs font-medium select-none relative z-50">
      {/* Left: App Title and Menus */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-1.5 font-bold tracking-tight text-fg shrink-0">
          <Terminal aria-hidden="true" className="w-3.5 h-3.5 text-info" />
          <span>PraxelOps</span>
        </div>

        <nav aria-label="Workspace menu" className="hidden lg:flex items-center gap-1 text-fg-2">
          {WORKSPACES.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => onSelectView(w.id)}
              aria-current={activeView === w.id ? "page" : undefined}
              className={`px-2 py-0.5 rounded ${
                activeView === w.id
                  ? "bg-sunken-2 text-fg font-semibold"
                  : "hover:bg-hover hover:text-fg"
              }`}
            >
              {w.shortLabel}
            </button>
          ))}
        </nav>
      </div>

      {/* Right: Status Indicators & Quick Actions */}
      <div className="flex items-center gap-1 sm:gap-2 text-fg-2 min-w-0">
        {/* Per-server health: one dot per host (colour + shape), popover with the full list (sm and up). */}
        <FleetStatus servers={servers} fetchedAt={fleetFetchedAt} onOpenServer={onOpenMonitorServer} onOpenOverview={onOpenMonitor} />

        {/* Global Search / Command Palette shortcut */}
        <button
          type="button"
          onClick={onOpenCommandPalette}
          aria-label="Open command palette"
          aria-keyshortcuts="Control+K Meta+K"
          title={`Open command palette (${modKey}+K)`}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-sunken hover:bg-hover-strong transition-colors text-fg-2 shrink-0"
        >
          <Search aria-hidden="true" className="w-3.5 h-3.5" />
          <span className="hidden sm:inline text-[10px] font-mono">{modKey} K</span>
        </button>

        {/* Theme toggle */}
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          className={iconBtn}
        >
          {theme === "dark" ? (
            <Sun aria-hidden="true" className="w-3.5 h-3.5 text-warning" />
          ) : (
            <Moon aria-hidden="true" className="w-3.5 h-3.5" />
          )}
        </button>

        {/* Sign out (inline from sm up) */}
        <button
          type="button"
          onClick={onLogout}
          aria-label="Sign out"
          title="Sign out"
          className={`${iconBtn} hidden sm:inline-flex`}
        >
          <LogOut aria-hidden="true" className="w-3.5 h-3.5" />
        </button>

        {/* Clock (md and up) */}
        <span className="hidden md:inline font-mono text-[11px] text-fg-2 whitespace-nowrap tabular-nums">
          {time}
        </span>

        {/* Overflow menu below sm: secondary items collapse here */}
        <div ref={moreRef} className="relative sm:hidden">
          <button
            ref={moreButtonRef}
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-controls="menubar-overflow"
            className={iconBtn}
          >
            <MoreHorizontal aria-hidden="true" className="w-4 h-4" />
          </button>
          {moreOpen && (
            <div
              id="menubar-overflow"
              role="menu"
              aria-label="More"
              className="absolute right-0 top-full mt-1 w-56 rounded-lg border border-line bg-elevated shadow-2xl py-1 z-50"
            >
              <div role="presentation" className="px-3 py-1.5 flex items-center gap-2 text-fg-muted">
                <Server aria-hidden="true" className="w-3.5 h-3.5" />
                <span>{overflowSummary}</span>
              </div>
              {servers.length > 0 && (
                <FleetStatusList
                  variant="menu"
                  entries={orderEntries(servers, fleetFetchedAt, Date.now())}
                  onSelect={(id) => {
                    setMoreOpen(false);
                    onOpenMonitorServer(id);
                  }}
                />
              )}
              <div role="presentation" className="px-3 py-1.5 flex items-center gap-2 text-fg-muted">
                <Clock aria-hidden="true" className="w-3.5 h-3.5" />
                <span className="font-mono text-[11px]">{time}</span>
              </div>
              <div role="separator" className="my-1 border-t border-line" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false);
                  onLogout();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-fg hover:bg-hover"
              >
                <LogOut aria-hidden="true" className="w-3.5 h-3.5" />
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
