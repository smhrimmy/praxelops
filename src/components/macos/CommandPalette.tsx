"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Search,
  Server,
  Terminal,
  FolderTree,
  Bot,
  Rocket,
  ShieldCheck,
  Sun,
  Moon,
  Plus,
  X,
} from "lucide-react";
import { ServerHost } from "@/types/server";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  servers: ServerHost[];
  onSelectServer: (server: ServerHost) => void;
  onConnectSSH: (server: ServerHost) => void;
  onOpenSFTP: (server: ServerHost) => void;
  onSelectView: (view: string) => void;
  onAddServer: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  servers,
  onSelectServer,
  onConnectSSH,
  onOpenSFTP,
  onSelectView,
  onAddServer,
  theme,
  onToggleTheme,
}) => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Construct searchable action items
  const baseActions = [
    {
      id: "act-add-server",
      title: "Add New Server Host",
      subtitle: "Register an SSH endpoint with credentials or keys",
      icon: Plus,
      category: "Operations",
      action: () => {
        onAddServer();
        onClose();
      },
    },
    {
      id: "act-ai-diagnose",
      title: "Run Fleet AI Diagnostics",
      subtitle: "Scan all active nodes for anomalies and bottlenecks",
      icon: Bot,
      category: "Operations",
      action: () => {
        onSelectView("ai-ops");
        onClose();
      },
    },
    {
      id: "act-deployments",
      title: "Open Deployments & Workflows",
      subtitle: "View active pipelines, build logs and rollback triggers",
      icon: Rocket,
      category: "Navigation",
      action: () => {
        onSelectView("deployments");
        onClose();
      },
    },
    {
      id: "act-audit",
      title: "View Security Audit Log",
      subtitle: "Inspect authenticated sessions, approvals and commands",
      icon: ShieldCheck,
      category: "Navigation",
      action: () => {
        onSelectView("audit");
        onClose();
      },
    },
    {
      id: "act-theme",
      title: `Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`,
      subtitle: "Toggle macOS dark/light glass appearance",
      icon: theme === "dark" ? Sun : Moon,
      category: "Preferences",
      action: () => {
        onToggleTheme();
        onClose();
      },
    },
  ];

  const serverActions = servers.flatMap((s) => [
    {
      id: `srv-ssh-${s.id}`,
      title: `Connect SSH Terminal: ${s.name}`,
      subtitle: `${s.username}@${s.host}:${s.port} (${s.status})`,
      icon: Terminal,
      category: "Servers",
      action: () => {
        onConnectSSH(s);
        onClose();
      },
    },
    {
      id: `srv-sftp-${s.id}`,
      title: `Browse SFTP Files: ${s.name}`,
      subtitle: `Explore remote filesystem on ${s.host}`,
      icon: FolderTree,
      category: "Servers",
      action: () => {
        onOpenSFTP(s);
        onClose();
      },
    },
  ]);

  const allItems = [...serverActions, ...baseActions];

  const filteredItems = allItems.filter(
    (item) =>
      item.title.toLowerCase().includes(query.toLowerCase()) ||
      item.subtitle.toLowerCase().includes(query.toLowerCase()) ||
      item.category.toLowerCase().includes(query.toLowerCase())
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        prev < filteredItems.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        prev > 0 ? prev - 1 : filteredItems.length - 1
      );
    } else if (e.key === "Enter" && filteredItems[selectedIndex]) {
      e.preventDefault();
      filteredItems[selectedIndex].action();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-xl bg-white/90 dark:bg-neutral-900/95 backdrop-blur-2xl rounded-xl border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[70vh]"
        onKeyDown={handleKeyDown}
      >
        {/* Search Input Bar */}
        <div className="flex items-center px-4 py-3 border-b border-black/5 dark:border-white/10">
          <Search className="w-4 h-4 text-neutral-400 mr-2.5 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Type a server, SSH command, or action..."
            className="w-full bg-transparent text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none"
          />
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 text-neutral-400"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results List */}
        <div className="overflow-y-auto p-2 space-y-1">
          {filteredItems.length === 0 ? (
            <div className="py-8 text-center text-xs text-neutral-400">
              No matching servers or operations found.
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const Icon = item.icon;
              const isSelected = index === selectedIndex;
              return (
                <button
                  key={item.id}
                  onClick={item.action}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left transition ${
                    isSelected
                      ? "bg-blue-600 text-white"
                      : "hover:bg-black/5 dark:hover:bg-white/5 text-neutral-800 dark:text-neutral-200"
                  }`}
                >
                  <div className="flex items-center space-x-3 truncate">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isSelected
                          ? "text-white"
                          : "text-neutral-400 dark:text-neutral-500"
                      }`}
                    />
                    <div className="truncate">
                      <div className="text-xs font-semibold truncate">
                        {item.title}
                      </div>
                      <div
                        className={`text-[11px] truncate ${
                          isSelected
                            ? "text-blue-100"
                            : "text-neutral-400 dark:text-neutral-500"
                        }`}
                      >
                        {item.subtitle}
                      </div>
                    </div>
                  </div>

                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0 ${
                      isSelected
                        ? "bg-white/20 text-white"
                        : "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
                    }`}
                  >
                    {item.category}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Footer shortcuts */}
        <div className="px-4 py-2 bg-neutral-50/60 dark:bg-neutral-950/40 border-t border-black/5 dark:border-white/10 flex items-center justify-between text-[11px] text-neutral-400">
          <span>
            Navigate with <kbd className="font-mono font-semibold">↑</kbd>{" "}
            <kbd className="font-mono font-semibold">↓</kbd>
          </span>
          <span>
            Select with <kbd className="font-mono font-semibold">Enter</kbd>
          </span>
        </div>
      </div>
    </div>
  );
};
