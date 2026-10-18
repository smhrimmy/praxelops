"use client";

import React from "react";
import { Activity } from "lucide-react";
import type { FleetServer } from "@/lib/fleet/types";
import type { NetRate } from "@/lib/fleet/rates";
import { useNow } from "./hooks";
import { FleetOverview } from "./FleetOverview";
import { ServerDetail } from "./ServerDetail";

interface SystemMonitorViewProps {
  servers: FleetServer[];
  rates: Record<string, NetRate | null>;
  fetchedAt: number;
  loaded: boolean;
  loadError: string | null;
  /** Server whose detail page is open; null shows the fleet overview. */
  selectedId: string | null;
  onSelect: (serverId: string | null) => void;
  onOpenTerminal: (server: FleetServer) => void;
  onAddServer: () => void;
  onFleetReload: () => Promise<void>;
}

/** System Monitor workspace: fleet overview (cards + comparison table) and per-server detail. */
export const SystemMonitorView: React.FC<SystemMonitorViewProps> = ({
  servers,
  rates,
  fetchedAt,
  loaded,
  loadError,
  selectedId,
  onSelect,
  onOpenTerminal,
  onAddServer,
  onFleetReload,
}) => {
  const now = useNow(1000);
  const selected = selectedId ? servers.find((s) => s.id === selectedId) : undefined;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-3 sm:p-6">
        {selected ? (
          <ServerDetail
            key={selected.id}
            server={selected}
            now={now}
            fetchedAt={fetchedAt}
            onBack={() => onSelect(null)}
            onOpenTerminal={onOpenTerminal}
            onFleetReload={onFleetReload}
          />
        ) : (
          <div className="space-y-4">
            <div>
              <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-fg">
                <Activity aria-hidden="true" className="h-5 w-5 text-info" />
                System Monitor
              </h1>
              <p className="mt-0.5 text-xs text-fg-muted">
                Real samples collected over SSH. Every number shows its age; hosts that cannot be sampled show why instead of zeros.
              </p>
              {selectedId && (
                <p role="status" className="mt-2 text-xs text-warning">
                  The selected server is no longer in the inventory.
                </p>
              )}
            </div>
            <FleetOverview
              servers={servers}
              rates={rates}
              fetchedAt={fetchedAt}
              now={now}
              loaded={loaded}
              loadError={loadError}
              onOpenServer={onSelect}
              onOpenTerminal={onOpenTerminal}
              onAddServer={onAddServer}
            />
          </div>
        )}
      </div>
    </div>
  );
};
