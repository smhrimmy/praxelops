import type { NetRate } from "./rates";
import { deriveServerStatus, stateSeverity, type ServerStatusView } from "./health";
import { sortRows, type SortDir, type SortValue } from "./sort";
import type { FleetServer } from "./types";

/** One server flattened for the comparison table. Numeric fields are null when there is no current number. */
export interface FleetRow {
  server: FleetServer;
  status: ServerStatusView;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  load1: number | null;
  rx: number | null;
  tx: number | null;
  uptimeSeconds: number | null;
  ageSeconds: number | null;
}

export type FleetColumn = "name" | "state" | "cpu" | "mem" | "disk" | "load" | "rx" | "tx" | "age";

export function buildRows(
  servers: readonly FleetServer[],
  rates: Readonly<Record<string, NetRate | null | undefined>>,
  fetchedAtMs: number,
  nowMs: number
): FleetRow[] {
  return servers.map((server) => {
    const status = deriveServerStatus(server, fetchedAtMs, nowMs);
    const m = status.metrics;
    const rate = m ? rates[server.id] ?? null : null;
    return {
      server,
      status,
      cpu: m ? m.cpuPercent : null,
      mem: m ? m.memoryPercent : null,
      disk: m ? m.diskPercent : null,
      load1: m ? m.loadAverage[0] : null,
      rx: rate ? rate.rxBytesPerSec : null,
      tx: rate ? rate.txBytesPerSec : null,
      uptimeSeconds: m ? m.uptimeSeconds : null,
      ageSeconds: status.sampleAgeSeconds,
    };
  });
}

export function columnValue(row: FleetRow, column: FleetColumn): SortValue {
  switch (column) {
    case "name":
      return row.server.name;
    case "state":
      return stateSeverity(row.status.state);
    case "cpu":
      return row.cpu;
    case "mem":
      return row.mem;
    case "disk":
      return row.disk;
    case "load":
      return row.load1;
    case "rx":
      return row.rx;
    case "tx":
      return row.tx;
    case "age":
      return row.ageSeconds;
  }
}

export function sortFleetRows(rows: readonly FleetRow[], column: FleetColumn, dir: SortDir): FleetRow[] {
  return sortRows(rows, (row) => columnValue(row, column), dir);
}
