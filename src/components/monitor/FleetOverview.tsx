"use client";

import React, { useMemo } from "react";
import { Activity, AlertTriangle, Plus, Server, ServerOff } from "lucide-react";
import type { FleetServer } from "@/lib/fleet/types";
import type { NetRate } from "@/lib/fleet/rates";
import { collectorLooksStopped, deriveServerStatus, summarizeFleet } from "@/lib/fleet/health";
import { formatAge } from "@/lib/fleet/format";
import { FleetCard } from "./FleetCard";
import { ComparisonTable } from "./ComparisonTable";

interface FleetOverviewProps {
  servers: FleetServer[];
  rates: Record<string, NetRate | null>;
  fetchedAt: number;
  now: number;
  loaded: boolean;
  /** Message of the last failed listing request, if the latest poll failed. */
  loadError: string | null;
  onOpenServer: (serverId: string) => void;
  onOpenTerminal: (server: FleetServer) => void;
  onAddServer: () => void;
}

export const FleetOverview: React.FC<FleetOverviewProps> = ({
  servers,
  rates,
  fetchedAt,
  now,
  loaded,
  loadError,
  onOpenServer,
  onOpenTerminal,
  onAddServer,
}) => {
  const summary = useMemo(() => summarizeFleet(servers), [servers]);
  const stopped = loaded && collectorLooksStopped(servers, now);
  const statuses = useMemo(
    () => servers.map((server) => ({ server, status: deriveServerStatus(server, fetchedAt, now) })),
    [servers, fetchedAt, now]
  );
  const listingAge = fetchedAt > 0 ? Math.max(0, Math.floor((now - fetchedAt) / 1000)) : null;

  if (loaded && servers.length === 0) {
    return (
      <div className="flex min-h-[18rem] flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-line p-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sunken text-info">
          <ServerOff aria-hidden="true" className="h-6 w-6" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-sm font-semibold text-fg">No servers to monitor</h2>
          <p className="text-xs leading-relaxed text-fg-muted">
            Register an SSH host first. Once its host key is pinned (open a terminal to it once), the background collector samples CPU, memory, disk, network, processes and services.
          </p>
        </div>
        <button
          type="button"
          onClick={onAddServer}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-accent-fg shadow-sm hover:bg-accent-hover"
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          Register server host
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {loadError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Could not refresh the fleet ({loadError}). Showing the listing from {formatAge(listingAge)}; ages keep counting, nothing is shown as current that is not.
          </span>
        </div>
      )}

      {stopped && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-fg">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            <strong className="font-semibold text-warning">Background collector isn&apos;t running</strong> &mdash; no host has been checked recently. Start it with{" "}
            <code className="rounded bg-sunken-2 px-1 py-0.5 font-mono">npm run collector</code>, or use <em>Refresh now</em> on a server&apos;s detail page.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2" aria-live="polite">
        <span className="flex items-center gap-1.5">
          <Activity aria-hidden="true" className="h-3.5 w-3.5 text-info" />
          <strong className="font-semibold text-fg">{summary.total}</strong> {summary.total === 1 ? "server" : "servers"}
        </span>
        <span>
          <strong className="font-semibold text-success">{summary.reachable}</strong> reachable
        </span>
        <span>
          <strong className={`font-semibold ${summary.attention > 0 ? "text-danger" : "text-fg"}`}>{summary.attention}</strong> need attention
        </span>
        <span>
          <strong className="font-semibold text-fg">{summary.neverChecked}</strong> never checked
        </span>
        <span className="ml-auto text-[11px] text-fg-muted">
          Listing {listingAge === null ? "not loaded yet" : `updated ${formatAge(listingAge)}`} &middot; refreshes every 15s
        </span>
      </div>

      {!loaded && servers.length === 0 ? (
        <p className="py-10 text-center text-xs text-fg-muted">Loading fleet status...</p>
      ) : (
        <>
          <section aria-label="Servers">
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-4">
              {statuses.map(({ server, status }) => (
                <li key={server.id} className="flex">
                  <FleetCard
                    server={server}
                    status={status}
                    rate={rates[server.id]}
                    onOpen={() => onOpenServer(server.id)}
                    onOpenTerminal={() => onOpenTerminal(server)}
                  />
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="fleet-compare-title" className="space-y-2 pb-6">
            <h2 id="fleet-compare-title" className="flex items-center gap-1.5 text-sm font-semibold text-fg">
              <Server aria-hidden="true" className="h-4 w-4 text-fg-muted" />
              Comparison
            </h2>
            <ComparisonTable servers={servers} rates={rates} fetchedAt={fetchedAt} now={now} onOpen={onOpenServer} />
          </section>
        </>
      )}
    </div>
  );
};
