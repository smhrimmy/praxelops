"use client";

import React, { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { DiskUsage, ProcessInfo, ServiceInfo } from "@/lib/metrics/types";
import { formatDuration, formatKb, formatPercent } from "@/lib/fleet/format";
import { nextSort, sortRows, type SortState } from "@/lib/fleet/sort";
import { filterServices, serviceCounts, type ServiceFilter } from "@/lib/fleet/services";
import { Meter, SortableTh } from "./ui";

export const NOT_AVAILABLE_MESSAGE = "Not available on this host (busybox ps / no systemd).";

const emptyBox = "rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-fg-muted";

/** Per-mount disk usage from the latest sample. */
export const DiskTable: React.FC<{ disks: readonly DiskUsage[] | null }> = ({ disks }) => {
  if (disks === null) return <p className={emptyBox}>No sample yet, so disk usage is unknown.</p>;
  if (disks.length === 0) return <p className={emptyBox}>The host reported no filesystems.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] border-collapse text-xs">
        <caption className="sr-only">Disk usage per mount</caption>
        <thead className="border-b border-line text-left text-[11px] uppercase tracking-wide text-fg-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">
              Mount
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Used
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Total
            </th>
            <th scope="col" className="w-48 px-3 py-2 font-semibold">
              Usage
            </th>
          </tr>
        </thead>
        <tbody>
          {disks.map((d) => (
            <tr key={d.mount} className="border-b border-line last:border-b-0">
              <td className="px-3 py-2 font-mono text-fg">{d.mount}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-2">{formatKb(d.usedKb)}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-fg-2">{formatKb(d.totalKb)}</td>
              <td className="px-3 py-2">
                <Meter label={`${d.mount} usage`} percent={d.usedPercent} valueText={formatPercent(d.usedPercent)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

type ProcessColumn = "pid" | "user" | "cpu" | "mem" | "rss" | "elapsed" | "command";

function processValue(p: ProcessInfo, column: ProcessColumn): number | string {
  switch (column) {
    case "pid":
      return p.pid;
    case "user":
      return p.user;
    case "cpu":
      return p.cpu;
    case "mem":
      return p.mem;
    case "rss":
      return p.rssKb;
    case "elapsed":
      return p.elapsedSeconds;
    case "command":
      return p.command;
  }
}

/** Top processes. %CPU from ps is the process's lifetime average (cputime / elapsed), so the column says so. */
export const ProcessTable: React.FC<{ processes: readonly ProcessInfo[] | null | undefined }> = ({ processes }) => {
  const [sort, setSort] = useState<SortState<ProcessColumn>>({ key: "cpu", dir: "desc" });
  const sorted = useMemo(
    () => (processes ? sortRows(processes, (p) => processValue(p, sort.key), sort.dir) : []),
    [processes, sort]
  );
  const onSort = (key: ProcessColumn) =>
    setSort((s) => nextSort(s, key, key === "pid" || key === "user" || key === "command" ? "asc" : "desc"));

  if (processes === null || processes === undefined) return <p className={emptyBox}>{NOT_AVAILABLE_MESSAGE}</p>;
  if (processes.length === 0) return <p className={emptyBox}>The host returned an empty process list.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-xs">
        <caption className="sr-only">
          Top {processes.length} processes by average CPU. Avg CPU is the lifetime average of each process as reported by ps, not its current usage.
        </caption>
        <thead className="border-b border-line">
          <tr>
            <SortableTh label="PID" columnKey="pid" sort={sort} onSort={onSort} align="right" />
            <SortableTh label="User" columnKey="user" sort={sort} onSort={onSort} />
            <SortableTh label="Avg CPU %" columnKey="cpu" sort={sort} onSort={onSort} align="right" />
            <SortableTh label="Mem %" columnKey="mem" sort={sort} onSort={onSort} align="right" />
            <SortableTh label="RSS" columnKey="rss" sort={sort} onSort={onSort} align="right" />
            <SortableTh label="Elapsed" columnKey="elapsed" sort={sort} onSort={onSort} align="right" />
            <SortableTh label="Command" columnKey="command" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.pid} className="border-b border-line last:border-b-0 hover:bg-hover">
              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-fg-2">{p.pid}</td>
              <td className="px-3 py-1.5 font-mono text-fg-2">{p.user}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-fg">{formatPercent(p.cpu)}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-fg-2">{formatPercent(p.mem)}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-fg-2">{formatKb(p.rssKb)}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-fg-2">{formatDuration(p.elapsedSeconds)}</td>
              <td className="max-w-[22rem] px-3 py-1.5 font-mono text-fg" title={p.command}>
                <span className="block truncate">{p.command}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const FILTERS: ReadonlyArray<{ id: ServiceFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "failed", label: "Failed" },
];

/** systemd units with a text filter and an active/failed filter; failed units are highlighted and listed first. */
export const ServiceTable: React.FC<{ services: readonly ServiceInfo[] | null | undefined }> = ({ services }) => {
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<ServiceFilter>("all");
  const counts = useMemo(() => serviceCounts(services ?? []), [services]);
  const rows = useMemo(() => filterServices(services ?? [], text, filter), [services, text, filter]);

  if (services === null || services === undefined) return <p className={emptyBox}>{NOT_AVAILABLE_MESSAGE}</p>;
  if (services.length === 0) return <p className={emptyBox}>systemd reported no service units.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <span className="sr-only">Filter services by name or description</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter services..."
            className="w-full rounded-lg border border-line-strong bg-input py-1.5 pl-8 pr-2 text-xs text-fg placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-focus"
          />
        </label>
        <div role="group" aria-label="Filter by state" className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                filter === f.id ? "bg-accent text-accent-fg" : "bg-sunken text-fg-2 hover:text-fg"
              } ${f.id === "failed" && counts.failed > 0 && filter !== f.id ? "text-danger!" : ""}`}
            >
              {f.label} ({counts[f.id]})
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className={emptyBox}>No services match the current filter.</p>
      ) : (
        <div className="max-h-96 overflow-auto rounded-lg border border-line">
          <table className="w-full min-w-[36rem] border-collapse text-xs">
            <caption className="sr-only">systemd service units. Failed units are listed first.</caption>
            <thead className="sticky top-0 border-b border-line bg-elevated text-left text-[11px] uppercase tracking-wide text-fg-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Unit
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Active
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Sub
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Description
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const failed = s.active === "failed";
                return (
                  <tr key={s.unit} className={`border-b border-line last:border-b-0 ${failed ? "bg-danger/10" : "hover:bg-hover"}`}>
                    <td className={`px-3 py-1.5 font-mono ${failed ? "font-semibold text-danger" : "text-fg"}`}>{s.unit}</td>
                    <td className="px-3 py-1.5">
                      <span
                        className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                          failed
                            ? "border-danger bg-danger/15 text-danger"
                            : s.active === "active"
                            ? "border-success/30 bg-success/10 text-success"
                            : "border-line-strong bg-sunken text-fg-2"
                        }`}
                      >
                        {failed ? "failed" : s.active}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-fg-2">{s.sub}</td>
                    <td className="max-w-[24rem] px-3 py-1.5 text-fg-2" title={s.description}>
                      <span className="block truncate">{s.description || "—"}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
