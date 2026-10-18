"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Search,
  Terminal,
  FolderTree,
  Sun,
  Moon,
  Plus,
  PanelLeft,
  Activity,
  X,
} from "lucide-react";
import { ServerHost } from "@/types/server";
import { WORKSPACES } from "./workspaces";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  servers: ServerHost[];
  onSelectServer: (server: ServerHost) => void;
  onConnectSSH: (server: ServerHost) => void;
  onOpenSFTP: (server: ServerHost) => void;
  onOpenMonitor: (server: ServerHost) => void;
  onSelectView: (view: string) => void;
  onAddServer: () => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  servers,
  onSelectServer,
  onConnectSSH,
  onOpenSFTP,
  onOpenMonitor,
  onSelectView,
  onAddServer,
  theme,
  onToggleTheme,
  onToggleSidebar,
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
  const workspaceActions = WORKSPACES.map((w, index) => ({
    id: `ws-${w.id}`,
    title: `Go to ${w.label}`,
    subtitle: `Open the ${w.label} workspace (Ctrl/⌘+${index + 1})`,
    icon: w.icon,
    category: "Workspaces",
    action: () => {
      onSelectView(w.id);
      onClose();
    },
  }));

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
      id: "act-sidebar",
      title: "Toggle Sidebar",
      subtitle: "Collapse or expand the workspace sidebar (Ctrl/⌘+B)",
      icon: PanelLeft,
      category: "Preferences",
      action: () => {
        onToggleSidebar();
        onClose();
      },
    },
    {
      id: "act-theme",
      title: `Switch to ${theme === "dark" ? "Light" : "Dark"} Theme`,
      subtitle: "Toggle the dark/light appearance",
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
      subtitle: `${s.username}@${s.host}:${s.port}`,
      icon: Terminal,
      category: "Servers",
      action: () => {
        onConnectSSH(s);
        onClose();
      },
    },
    {
      id: `srv-mon-${s.id}`,
      title: `System Monitor: ${s.name}`,
      subtitle: "Live CPU, memory, disk, processes and services",
      icon: Activity,
      category: "Servers",
      action: () => {
        onOpenMonitor(s);
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

  const allItems = [...workspaceActions, ...serverActions, ...baseActions];

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
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-16 sm:pt-20 bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl bg-elevated rounded-xl border border-line shadow-2xl overflow-hidden flex flex-col max-h-[70dvh]"
        onKeyDown={handleKeyDown}
      >
        {/* Search Input Bar */}
        <div className="flex items-center px-4 py-3 border-b border-line">
          <Search className="w-4 h-4 text-fg-muted mr-2.5 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            aria-label="Search commands"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Type a server, SSH command, or action..."
            className="w-full bg-transparent text-sm text-fg placeholder:text-fg-muted focus:outline-none"
          />
          <button
            onClick={onClose}
            aria-label="Close command palette"
            className="p-1.5 rounded hover:bg-hover text-fg-muted"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results List */}
        <div className="overflow-y-auto p-2 space-y-1">
          {filteredItems.length === 0 ? (
            <div className="py-8 text-center text-xs text-fg-muted">
              No matching servers or operations found.
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const Icon = item.icon;
              const isSelected = index === selectedIndex;
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    if (isSelected) el?.scrollIntoView({ block: "nearest" });
                  }}
                  onClick={item.action}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left transition-colors ${
                    isSelected
                      ? "bg-blue-600 text-white"
                      : "hover:bg-hover text-fg"
                  }`}
                >
                  <div className="flex items-center space-x-3 truncate">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isSelected
                          ? "text-white"
                          : "text-fg-muted"
                      }`}
                    />
                    <div className="truncate">
                      <div className="text-xs font-semibold truncate">
                        {item.title}
                      </div>
                      <div
                        className={`text-[11px] truncate ${
                          isSelected
                            ? "text-white"
                            : "text-fg-muted"
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
                        : "bg-sunken-2 text-fg-muted"
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
        <div className="px-4 py-2 bg-chrome border-t border-line flex items-center justify-between text-[11px] text-fg-muted">
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
