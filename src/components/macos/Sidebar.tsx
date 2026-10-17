"use client";

import React, { useEffect, useRef } from "react";
import { Plus, PanelLeft } from "lucide-react";
import { WORKSPACES } from "./workspaces";

export type SidebarVariant = "docked" | "drawer";

interface SidebarProps {
  activeView: string;
  onSelectView: (view: string) => void;
  serverCount: number;
  pendingApprovalsCount?: number;
  onAddServerClick: () => void;
  /** docked: inline column (expanded or icon rail). drawer: overlay for narrow viewports. */
  variant: SidebarVariant;
  /** Docked only: render as a 56px icon rail. */
  collapsed: boolean;
  /** Drawer only: whether the drawer is open. */
  drawerOpen: boolean;
  onToggle: () => void;
  onCloseDrawer: () => void;
}

/** Tooltip shown next to an icon-only (rail) control. Purely visual: the control carries aria-label. */
const RailTip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    aria-hidden="true"
    className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-elevated px-2 py-1 text-[11px] font-medium text-fg opacity-0 shadow-lg ring-1 ring-line transition-opacity group-hover/tip:opacity-100 group-focus-visible/tip:opacity-100"
  >
    {children}
  </span>
);

export const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  onSelectView,
  serverCount,
  pendingApprovalsCount = 0,
  onAddServerClick,
  variant,
  collapsed,
  drawerOpen,
  onToggle,
  onCloseDrawer,
}) => {
  const isDrawer = variant === "drawer";
  const rail = !isDrawer && collapsed;
  const asideRef = useRef<HTMLElement>(null);

  // Move focus into the drawer when it opens; Escape closes it.
  useEffect(() => {
    if (!isDrawer || !drawerOpen) return;
    const active = asideRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDrawer, drawerOpen, onCloseDrawer]);

  const badgeFor = (id: string): number | undefined => {
    if (id === "fleet" && serverCount > 0) return serverCount;
    if (id === "ai-ops" && pendingApprovalsCount > 0) return pendingApprovalsCount;
    return undefined;
  };

  const widthClass = isDrawer ? "w-64" : rail ? "w-14" : "w-60";
  const positionClass = isDrawer
    ? `absolute inset-y-0 left-0 z-40 shadow-2xl transition-transform duration-200 ${
        drawerOpen ? "translate-x-0" : "-translate-x-full"
      }`
    : "relative z-20 shrink-0 transition-[width] duration-200";

  return (
    <>
      {isDrawer && (
        <div
          aria-hidden="true"
          onClick={onCloseDrawer}
          className={`absolute inset-0 z-30 bg-black/50 transition-opacity duration-200 ${
            drawerOpen ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        />
      )}
      <aside
        id="app-sidebar"
        ref={asideRef}
        aria-label="Sidebar"
        inert={isDrawer && !drawerOpen}
        className={`${widthClass} ${positionClass} h-full flex flex-col justify-between border-r border-line select-none ${
          isDrawer ? "bg-elevated" : "bg-sidebar backdrop-blur-xl"
        } ${rail ? "p-2" : "p-3"}`}
      >
        <nav aria-label="Workspaces" className="space-y-4 min-h-0">
          <div
            className={`flex items-center ${
              rail ? "flex-col gap-1" : "justify-between px-2"
            } mb-2`}
          >
            {!rail && (
              <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">
                Workspaces
              </span>
            )}
            <div className={`flex items-center ${rail ? "flex-col gap-1" : "gap-0.5"}`}>
              <button
                type="button"
                onClick={onAddServerClick}
                aria-label="Add server host"
                title="Add server host"
                className="group/tip relative p-1.5 rounded-md hover:bg-hover text-fg-muted hover:text-fg transition-colors"
              >
                <Plus className="w-4 h-4" />
                {rail && <RailTip>Add server host</RailTip>}
              </button>
              {rail && (
                <button
                  type="button"
                  onClick={onToggle}
                  aria-label="Expand sidebar"
                  aria-expanded={false}
                  aria-controls="app-sidebar"
                  title="Expand sidebar (Ctrl/⌘+B)"
                  className="group/tip relative p-1.5 rounded-md hover:bg-hover text-fg-muted hover:text-fg transition-colors"
                >
                  <PanelLeft className="w-4 h-4" />
                  <RailTip>Expand sidebar (Ctrl/⌘+B)</RailTip>
                </button>
              )}
            </div>
          </div>

          <ul className="space-y-1">
            {WORKSPACES.map((item, index) => {
              const Icon = item.icon;
              const isActive = activeView === item.id;
              const badge = badgeFor(item.id);
              const shortcut = `Ctrl/⌘+${index + 1}`;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectView(item.id);
                      if (isDrawer) onCloseDrawer();
                    }}
                    aria-current={isActive ? "page" : undefined}
                    aria-label={rail ? `${item.label}${badge !== undefined ? ` (${badge})` : ""}` : undefined}
                    title={rail ? undefined : `${item.label} (${shortcut})`}
                    className={`group/tip relative w-full flex items-center ${
                      rail ? "justify-center px-0" : "justify-between px-2.5"
                    } py-2 rounded-lg text-xs font-medium ${
                      isActive
                        ? "bg-blue-600 text-white shadow-sm"
                        : "text-fg-2 hover:bg-hover hover:text-fg"
                    }`}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <Icon
                        aria-hidden="true"
                        className={`w-4 h-4 shrink-0 ${isActive ? "text-white" : item.tint}`}
                      />
                      {!rail && <span className="truncate">{item.label}</span>}
                    </span>

                    {badge !== undefined && !rail && (
                      <span
                        className={`px-1.5 rounded-full text-[10px] font-semibold leading-4 ${
                          isActive
                            ? "bg-white/20 text-white"
                            : "bg-sunken-2 text-fg-2"
                        }`}
                      >
                        {badge}
                      </span>
                    )}
                    {badge !== undefined && rail && (
                      <span
                        aria-hidden="true"
                        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-rose-500"
                      />
                    )}
                    {rail && (
                      <RailTip>
                        {item.label} <span className="text-fg-muted">{shortcut}</span>
                      </RailTip>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Footer: collapse control + product label */}
        <div className="pt-3 border-t border-line text-fg-muted">
          <div className={`flex items-center ${rail ? "justify-center" : "justify-between px-1"}`}>
            {!rail && (
              <span className="text-[11px] font-mono truncate">PraxelOps v1.0.0</span>
            )}
            {!isDrawer && !rail && (
              <button
                type="button"
                onClick={onToggle}
                aria-label="Collapse sidebar"
                aria-expanded={true}
                aria-controls="app-sidebar"
                title="Collapse sidebar (Ctrl/⌘+B)"
                className="p-1.5 rounded-md hover:bg-hover text-fg-muted hover:text-fg transition-colors"
              >
                <PanelLeft className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};
