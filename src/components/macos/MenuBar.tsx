"use client";

import React, { useState, useEffect } from "react";
import {
  Terminal,
  Wifi,
  Sun,
  Moon,
  Search,
  ShieldCheck,
  Server,
  Zap,
  LogOut,
} from "lucide-react";

interface MenuBarProps {
  onOpenCommandPalette: () => void;
  activeView: string;
  onSelectView: (view: string) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onlineCount: number;
  totalServers: number;
  onLogout: () => void;
}

export const MenuBar: React.FC<MenuBarProps> = ({
  onOpenCommandPalette,
  activeView,
  onSelectView,
  theme,
  onToggleTheme,
  onlineCount,
  totalServers,
  onLogout,
}) => {
  const [time, setTime] = useState<string>("");

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTime(
        now.toLocaleTimeString([], {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      );
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="h-8 w-full bg-white/70 dark:bg-black/60 backdrop-blur-md border-b border-black/5 dark:border-white/10 px-3 flex items-center justify-between text-xs font-medium select-none z-50">
      {/* Left: App Title and Menus */}
      <div className="flex items-center space-x-4">
        <div className="flex items-center space-x-1.5 font-bold tracking-tight text-neutral-900 dark:text-neutral-100 cursor-pointer">
          <Terminal className="w-3.5 h-3.5 text-blue-500" />
          <span>PraxelOps</span>
        </div>

        <nav className="hidden sm:flex items-center space-x-3 text-neutral-600 dark:text-neutral-300">
          <button
            onClick={() => onSelectView("fleet")}
            className={`px-1.5 py-0.5 rounded transition ${
              activeView === "fleet"
                ? "bg-black/10 dark:bg-white/10 text-neutral-950 dark:text-white font-semibold"
                : "hover:text-neutral-950 dark:hover:text-white"
            }`}
          >
            Fleet
          </button>
          <button
            onClick={() => onSelectView("terminal")}
            className={`px-1.5 py-0.5 rounded transition ${
              activeView === "terminal"
                ? "bg-black/10 dark:bg-white/10 text-neutral-950 dark:text-white font-semibold"
                : "hover:text-neutral-950 dark:hover:text-white"
            }`}
          >
            Terminal
          </button>
          <button
            onClick={() => onSelectView("sftp")}
            className={`px-1.5 py-0.5 rounded transition ${
              activeView === "sftp"
                ? "bg-black/10 dark:bg-white/10 text-neutral-950 dark:text-white font-semibold"
                : "hover:text-neutral-950 dark:hover:text-white"
            }`}
          >
            SFTP
          </button>
          <button
            onClick={() => onSelectView("ai-ops")}
            className={`px-1.5 py-0.5 rounded transition ${
              activeView === "ai-ops"
                ? "bg-black/10 dark:bg-white/10 text-neutral-950 dark:text-white font-semibold"
                : "hover:text-neutral-950 dark:hover:text-white"
            }`}
          >
            AI Copilot
          </button>
          <button
            onClick={() => onSelectView("deployments")}
            className={`px-1.5 py-0.5 rounded transition ${
              activeView === "deployments"
                ? "bg-black/10 dark:bg-white/10 text-neutral-950 dark:text-white font-semibold"
                : "hover:text-neutral-950 dark:hover:text-white"
            }`}
          >
            Deploy
          </button>
          <button
            onClick={() => onSelectView("audit")}
            className={`px-1.5 py-0.5 rounded transition ${
              activeView === "audit"
                ? "bg-black/10 dark:bg-white/10 text-neutral-950 dark:text-white font-semibold"
                : "hover:text-neutral-950 dark:hover:text-white"
            }`}
          >
            Audit
          </button>
        </nav>
      </div>

      {/* Right: Status Indicators & Quick Actions */}
      <div className="flex items-center space-x-3 text-neutral-600 dark:text-neutral-300">
        {/* Fleet health badge */}
        <div
          title={`${onlineCount} of ${totalServers} servers online`}
          className="flex items-center space-x-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span className="font-semibold text-[11px]">
            {onlineCount}/{totalServers} Online
          </span>
        </div>

        {/* Global Search / Command Palette shortcut */}
        <button
          onClick={onOpenCommandPalette}
          className="flex items-center space-x-1.5 px-2 py-0.5 rounded bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 transition text-neutral-500 dark:text-neutral-400"
          title="Open Command Palette (Cmd/Ctrl + K)"
        >
          <Search className="w-3 h-3" />
          <span className="text-[10px] font-mono">⌘K</span>
        </button>

        {/* Theme toggle */}
        <button
          onClick={onToggleTheme}
          aria-label="Toggle theme"
          className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition text-neutral-600 dark:text-neutral-300"
          title={`Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`}
        >
          {theme === "dark" ? (
            <Sun className="w-3.5 h-3.5 text-amber-400" />
          ) : (
            <Moon className="w-3.5 h-3.5 text-neutral-700" />
          )}
        </button>

        {/* Sign out */}
        <button
          onClick={onLogout}
          aria-label="Sign out"
          className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition text-neutral-600 dark:text-neutral-300"
          title="Sign out"
        >
          <LogOut className="w-3.5 h-3.5" />
        </button>

        {/* Live Clock */}
        <span className="font-mono text-[11px] text-neutral-700 dark:text-neutral-300">
          {time || "Loading..."}
        </span>
      </div>
    </header>
  );
};
