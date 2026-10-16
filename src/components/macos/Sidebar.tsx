"use client";

import React from "react";
import {
  Server,
  Terminal,
  FolderTree,
  Bot,
  Rocket,
  ShieldCheck,
  Settings,
  Plus,
  Activity,
} from "lucide-react";

interface SidebarProps {
  activeView: string;
  onSelectView: (view: string) => void;
  serverCount: number;
  openTerminalsCount: number;
  pendingApprovalsCount: number;
  onAddServerClick: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  onSelectView,
  serverCount,
  openTerminalsCount,
  pendingApprovalsCount,
  onAddServerClick,
}) => {
  const navItems = [
    {
      id: "fleet",
      label: "Server Fleet",
      icon: Server,
      badge: serverCount,
      color: "text-blue-500",
    },
    {
      id: "terminal",
      label: "Interactive SSH",
      icon: Terminal,
      badge: openTerminalsCount > 0 ? openTerminalsCount : undefined,
      color: "text-emerald-500",
    },
    {
      id: "sftp",
      label: "Remote SFTP",
      icon: FolderTree,
      color: "text-amber-500",
    },
    {
      id: "ai-ops",
      label: "AI Copilot",
      icon: Bot,
      badge: pendingApprovalsCount > 0 ? pendingApprovalsCount : undefined,
      badgeAlert: pendingApprovalsCount > 0,
      color: "text-purple-500",
    },
    {
      id: "deployments",
      label: "Deployments",
      icon: Rocket,
      color: "text-orange-500",
    },
    {
      id: "audit",
      label: "Security Audit",
      icon: ShieldCheck,
      color: "text-teal-500",
    },
  ];

  return (
    <aside className="w-60 h-full flex flex-col justify-between border-r border-black/5 dark:border-white/10 bg-neutral-100/70 dark:bg-neutral-900/70 backdrop-blur-xl p-3 select-none">
      <div className="space-y-6">
        {/* Navigation Section */}
        <div>
          <div className="flex items-center justify-between px-2 mb-2">
            <span className="text-[11px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-wider">
              Workspaces
            </span>
            <button
              onClick={onAddServerClick}
              title="Add Server Host"
              className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeView === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onSelectView(item.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
                    isActive
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-neutral-700 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                >
                  <div className="flex items-center space-x-2.5 truncate">
                    <Icon
                      className={`w-4 h-4 ${
                        isActive ? "text-white" : item.color
                      }`}
                    />
                    <span className="truncate">{item.label}</span>
                  </div>

                  {item.badge !== undefined && (
                    <span
                      className={`px-1.5 py-0.2 rounded-full text-[10px] font-semibold ${
                        item.badgeAlert
                          ? "bg-rose-500 text-white animate-pulse"
                          : isActive
                          ? "bg-white/20 text-white"
                          : "bg-neutral-200 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300"
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <div className="pt-3 border-t border-black/5 dark:border-white/10 text-neutral-500 dark:text-neutral-400">
        <div className="flex items-center justify-between px-2 text-[11px]">
          <div className="flex items-center space-x-1.5">
            <Activity className="w-3.5 h-3.5 text-emerald-500" />
            <span className="font-mono">PEOS-v2 Core</span>
          </div>
          <span className="text-[10px] font-mono text-neutral-400">v1.0.0</span>
        </div>
      </div>
    </aside>
  );
};
