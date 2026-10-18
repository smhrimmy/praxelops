"use client";

import React, { useMemo, useState } from "react";
import { buildRows, sortFleetRows, type FleetColumn } from "@/lib/fleet/rows";
import type { FleetServer } from "@/lib/fleet/types";
import type { NetRate } from "@/lib/fleet/rates";
import { formatAge, formatLoad, formatPercent, formatRate, NO_VALUE } from "@/lib/fleet/format";
import { nextSort, type SortState } from "@/lib/fleet/sort";
import { SortableTh, StateBadge } from "./ui";

interface ComparisonTableProps {
  servers: FleetServer[];
  rates: Record<string, NetRate | null>;
  fetchedAt: number;
  now: number;
  onOpen: (serverId: string) => void;
}

/** Columns that start descending on first click (biggest first is what an operator wants). */
const DESC_FIRST: ReadonlySet<FleetColumn> = new Set(["cpu", "mem", "disk", "load", "rx", "tx"]);

const numCell = "px-3 py-2 text-right font-mono text-xs tabular-nums";

export const ComparisonTable: React.FC<ComparisonTableProps> = ({ servers, rates, fetchedAt, now, onOpen }) => {
  const [sort, setSort] = useState<SortState<FleetColumn>>({ key: "name", dir: "asc" });

  const rows = useMemo(() => sortFleetRows(buildRows(servers, rates, fetchedAt, now), sort.key, sort.dir), [servers, rates, fetchedAt, now, sort]);

  const onSort = (key: FleetColumn) => setSort((s) => nextSort(s, key, DESC_FIRST.has(key) ? "desc" : "asc"));

  return (
    <div className="macos-card overflow-hidden rounded-xl">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-collapse">
          <caption className="sr-only">
            Fleet comparison. Column headers are buttons that sort the table. Unknown values are shown as a dash and always sort last.
          </caption>
          <thead className="border-b border-line bg-chrome">
            <tr>
              <SortableTh label="Name" columnKey="name" sort={sort} onSort={onSort} />
              <SortableTh label="State" columnKey="state" sort={sort} onSort={onSort} />
              <SortableTh label="CPU" columnKey="cpu" sort={sort} onSort={onSort} align="right" />
              <SortableTh label="Mem" columnKey="mem" sort={sort} onSort={onSort} align="right" />
              <SortableTh label="Disk" columnKey="disk" sort={sort} onSort={onSort} align="right" />
              <SortableTh label="Load" columnKey="load" sort={sort} onSort={onSort} align="right" />
              <SortableTh label="Rx" columnKey="rx" sort={sort} onSort={onSort} align="right" />
              <SortableTh label="Tx" columnKey="tx" sort={sort} onSort={onSort} align="right" />
              <SortableTh label="Sample age" columnKey="age" sort={sort} onSort={onSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const { server, status } = row;
              const hasNumbers = status.metrics !== undefined;
              const whyEmpty = hasNumbers ? undefined : status.note;
              const dim = status.lastKnown ? "opacity-70" : "";
              return (
                <tr key={server.id} className="border-b border-line last:border-b-0 hover:bg-hover">
                  <td className="max-w-[14rem] px-3 py-2">
                    <button
                      type="button"
                      onClick={() => onOpen(server.id)}
                      className="max-w-full truncate rounded text-left text-xs font-semibold text-fg hover:underline"
                    >
                      {server.name}
                    </button>
                    <div className="truncate font-mono text-[10px] text-fg-muted">{server.host}</div>
                  </td>
                  <td className="px-3 py-2">
                    <StateBadge state={status.state} />
                  </td>
                  <td className={`${numCell} ${dim}`} title={whyEmpty}>
                    {formatPercent(row.cpu)}
                  </td>
                  <td className={`${numCell} ${dim}`} title={whyEmpty}>
                    {formatPercent(row.mem)}
                  </td>
                  <td className={`${numCell} ${dim}`} title={whyEmpty}>
                    {formatPercent(row.disk)}
                  </td>
                  <td className={`${numCell} ${dim}`} title={whyEmpty}>
                    {formatLoad(row.load1)}
                  </td>
                  <td className={`${numCell} ${dim}`} title={hasNumbers ? "A rate needs two samples of the same host." : whyEmpty}>
                    {formatRate(row.rx)}
                  </td>
                  <td className={`${numCell} ${dim}`} title={hasNumbers ? "A rate needs two samples of the same host." : whyEmpty}>
                    {formatRate(row.tx)}
                  </td>
                  <td className={`${numCell} ${status.stale ? "text-warning" : "text-fg-2"}`}>
                    {row.ageSeconds === null ? (
                      <span title="No successful sample has been stored">{NO_VALUE}</span>
                    ) : (
                      <>
                        {formatAge(row.ageSeconds)}
                        {status.stale && <span className="ml-1.5 rounded border border-warning/40 bg-warning/10 px-1 text-[10px] font-semibold uppercase">stale</span>}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
