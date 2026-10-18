"use client";

import React from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import {
  TONE_CLASSES,
  meterTone,
  stateInfo,
  type DisplayState,
  type DotShape,
  type Tone,
} from "@/lib/fleet/health";
import { ariaSort, type SortState } from "@/lib/fleet/sort";
import { formatAge } from "@/lib/fleet/format";

/** Status marker. Colour is never the only cue: the shape differs too (dot = healthy, ring = no data / action, diamond = failing). */
export const StatusDot: React.FC<{ tone: Tone; shape: DotShape; size?: "sm" | "md"; pulse?: boolean }> = ({
  tone,
  shape,
  size = "md",
  pulse = false,
}) => {
  const c = TONE_CLASSES[tone];
  const dim = size === "sm" ? "w-2 h-2" : "w-2.5 h-2.5";
  const shapeClass =
    shape === "dot"
      ? `rounded-full ${c.solid}`
      : shape === "ring"
      ? `rounded-full border-2 ${c.border} bg-transparent`
      : `rotate-45 scale-90 ${c.solid}`;
  return <span aria-hidden="true" className={`inline-block shrink-0 ${dim} ${shapeClass} ${pulse ? "animate-pulse" : ""}`} />;
};

export const StateDot: React.FC<{ state: DisplayState; size?: "sm" | "md" }> = ({ state, size }) => {
  const info = stateInfo(state);
  return <StatusDot tone={info.tone} shape={info.shape} size={size} />;
};

export const StateBadge: React.FC<{ state: DisplayState; className?: string }> = ({ state, className = "" }) => {
  const info = stateInfo(state);
  return (
    <span
      title={info.description}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASSES[info.tone].badge} ${className}`}
    >
      <StatusDot tone={info.tone} shape={info.shape} size="sm" />
      {info.label}
    </span>
  );
};

const FILL: Record<"ok" | "warn" | "bad", string> = { ok: "bg-info", warn: "bg-warning", bad: "bg-danger" };

/** Horizontal utilisation meter. The number is always printed; a missing value renders an empty track and a dash. */
export const Meter: React.FC<{
  label: string;
  icon?: React.ReactNode;
  percent: number | null | undefined;
  /** Text shown next to the label, e.g. "12.3%". */
  valueText: string;
  dim?: boolean;
}> = ({ label, icon, percent, valueText, dim = false }) => {
  const known = typeof percent === "number" && Number.isFinite(percent);
  const clamped = known ? Math.min(100, Math.max(0, percent)) : 0;
  return (
    <div className={`space-y-1 min-w-0 ${dim ? "opacity-70" : ""}`}>
      <div className="flex items-center justify-between gap-1 text-[11px]">
        <span className="flex items-center gap-1 text-fg-muted">
          {icon}
          <span>{label}</span>
        </span>
        <span className="font-mono font-medium text-fg tabular-nums">{valueText}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(clamped * 10) / 10 : undefined}
        aria-valuetext={valueText}
        className="h-1.5 w-full overflow-hidden rounded-full bg-track"
      >
        {known && <div className={`h-full ${FILL[meterTone(clamped)]}`} style={{ width: `${clamped}%` }} />}
      </div>
    </div>
  );
};

/** "updated 12s ago", with a visible "stale" tag when the sample is too old to count as current. */
export const AgeLabel: React.FC<{ prefix?: string; seconds: number | null; stale?: boolean; className?: string }> = ({
  prefix = "updated",
  seconds,
  stale = false,
  className = "",
}) => {
  if (seconds === null) {
    return <span className={`text-[11px] text-fg-muted ${className}`}>no successful sample yet</span>;
  }
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] ${stale ? "text-warning" : "text-fg-muted"} ${className}`}>
      <span className="font-mono tabular-nums">
        {prefix} {formatAge(seconds)}
      </span>
      {stale && (
        <span className="rounded border border-warning/40 bg-warning/10 px-1 text-[10px] font-semibold uppercase tracking-wide text-warning">
          stale
        </span>
      )}
    </span>
  );
};

/** Column header button for a sortable table. Keyboard accessible: it is a real button inside the th. */
export function SortableTh<K extends string>({
  label,
  columnKey,
  sort,
  onSort,
  align = "left",
  className = "",
}: {
  label: string;
  columnKey: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort.key === columnKey;
  return (
    <th
      scope="col"
      aria-sort={ariaSort(sort, columnKey)}
      className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted ${
        align === "right" ? "text-right" : "text-left"
      } ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        className={`inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-fg ${active ? "text-fg" : ""} ${
          align === "right" ? "flex-row-reverse" : ""
        }`}
      >
        <span>{label}</span>
        {active ? (
          sort.dir === "asc" ? (
            <ArrowUp aria-hidden="true" className="h-3 w-3" />
          ) : (
            <ArrowDown aria-hidden="true" className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown aria-hidden="true" className="h-3 w-3 opacity-50" />
        )}
        <span className="sr-only">
          {active ? (sort.dir === "asc" ? ", sorted ascending" : ", sorted descending") : ", not sorted"}
        </span>
      </button>
    </th>
  );
}

/** Panel wrapper used for the detail sections. */
export const Panel: React.FC<{
  title: string;
  titleId: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, titleId, actions, children, className = "" }) => (
  <section aria-labelledby={titleId} className={`macos-card rounded-xl ${className}`}>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
      <h2 id={titleId} className="text-sm font-semibold text-fg">
        {title}
      </h2>
      {actions}
    </div>
    <div className="p-4">{children}</div>
  </section>
);
