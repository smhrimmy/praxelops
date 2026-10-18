"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Server } from "lucide-react";
import type { FleetServer } from "@/lib/fleet/types";
import { summarizeFleet } from "@/lib/fleet/health";
import { formatAge } from "@/lib/fleet/format";
import { entryDescription, MAX_BAR_DOTS, orderEntries, type FleetEntry } from "@/lib/fleet/status";
import { StatusDot } from "@/components/monitor/ui";
import { useNow } from "@/components/monitor/hooks";

interface FleetStatusListProps {
  entries: FleetEntry[];
  onSelect: (serverId: string) => void;
  /** menu = items inside the "More" role=menu; list = inside the popover dialog. */
  variant: "menu" | "list";
}

/** One row per server: state dot, name, state label and sample age. Each row opens that server's monitor detail. */
export const FleetStatusList: React.FC<FleetStatusListProps> = ({ entries, onSelect, variant }) => (
  <ul className="max-h-64 overflow-y-auto" role={variant === "menu" ? "none" : undefined}>
    {entries.map((entry) => {
      const { server, status } = entry;
      return (
        <li key={server.id} role={variant === "menu" ? "none" : undefined}>
          <button
            type="button"
            role={variant === "menu" ? "menuitem" : undefined}
            onClick={() => onSelect(server.id)}
            aria-label={`${entryDescription(entry)}. Open in System Monitor`}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-hover"
          >
            <StatusDot tone={status.info.tone} shape={status.info.shape} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-fg">{server.name}</span>
              <span className="block truncate text-[11px] text-fg-muted">
                {status.info.label}
                {" · "}
                {status.sampleAgeSeconds === null ? "no sample" : `${status.stale ? "stale, " : ""}${formatAge(status.sampleAgeSeconds)}`}
              </span>
            </span>
          </button>
        </li>
      );
    })}
  </ul>
);

interface FleetStatusProps {
  servers: FleetServer[];
  fetchedAt: number;
  /** Opens the System Monitor on this server's detail page. */
  onOpenServer: (serverId: string) => void;
  /** Opens the System Monitor overview. */
  onOpenOverview: () => void;
}

/** Compact per-server status for the menu bar: one dot per server (max 6, then "+N"), popover with the full list. */
export const FleetStatus: React.FC<FleetStatusProps> = ({ servers, fetchedAt, onOpenServer, onOpenOverview }) => {
  const now = useNow(5000);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  const entries = useMemo(() => orderEntries(servers, fetchedAt, now), [servers, fetchedAt, now]);
  const summary = useMemo(() => summarizeFleet(servers), [servers]);
  const shown = entries.slice(0, MAX_BAR_DOTS);
  const hidden = entries.length - shown.length;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const summaryText =
    summary.total === 0
      ? "No hosts registered"
      : `${summary.total} ${summary.total === 1 ? "host" : "hosts"}: ${summary.reachable} reachable, ${summary.attention} need attention, ${summary.neverChecked} never checked`;
  const listingAge = fetchedAt > 0 ? Math.max(0, Math.floor((now - fetchedAt) / 1000)) : null;

  return (
    <div ref={rootRef} className="relative hidden sm:block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`Fleet status. ${summaryText}. ${open ? "Close" : "Open"} the server list`}
        className="flex items-center gap-1.5 rounded-full border border-line bg-sunken px-2 py-0.5 text-fg-2 transition-colors hover:bg-hover-strong"
      >
        <Server aria-hidden="true" className="h-3 w-3 shrink-0" />
        {summary.total === 0 ? (
          <span className="text-[11px] font-semibold">No hosts</span>
        ) : (
          <>
            <span className="flex items-center gap-1" aria-hidden="true">
              {shown.map((entry) => (
                <span key={entry.server.id} title={entryDescription(entry)} className="inline-flex p-0.5">
                  <StatusDot tone={entry.status.info.tone} shape={entry.status.info.shape} size="sm" />
                </span>
              ))}
              {hidden > 0 && <span className="text-[11px] font-semibold">+{hidden}</span>}
            </span>
            <span className="hidden text-[11px] font-semibold tabular-nums md:inline" aria-hidden="true">
              {summary.reachable}/{summary.total}
            </span>
          </>
        )}
      </button>

      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="Fleet status"
          className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-line bg-elevated shadow-2xl"
        >
          <div className="border-b border-line px-3 py-2 text-[11px] text-fg-muted">
            {summaryText}
            <br />
            {listingAge === null ? "Not loaded yet" : `Listing updated ${formatAge(listingAge)}`}
          </div>
          {entries.length === 0 ? (
            <p className="px-3 py-4 text-xs text-fg-muted">Register a server host to see its status here.</p>
          ) : (
            <FleetStatusList
              entries={entries}
              variant="list"
              onSelect={(id) => {
                setOpen(false);
                onOpenServer(id);
              }}
            />
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenOverview();
            }}
            className="w-full border-t border-line px-3 py-2 text-left text-xs font-medium text-info hover:bg-hover"
          >
            Open System Monitor
          </button>
        </div>
      )}
    </div>
  );
};
