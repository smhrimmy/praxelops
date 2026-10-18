import type { FleetServer } from "./types";
import { deriveServerStatus, stateSeverity, type ServerStatusView } from "./health";
import { formatAge } from "./format";

/** Dots shown in the top bar before the rest collapse into "+N". */
export const MAX_BAR_DOTS = 6;

export interface FleetEntry {
  server: FleetServer;
  status: ServerStatusView;
}

/** Entries with the most urgent states first (stable), so problems stay visible when only a few dots fit. */
export function orderEntries(servers: readonly FleetServer[], fetchedAt: number, now: number): FleetEntry[] {
  return servers
    .map((server, index) => ({ server, status: deriveServerStatus(server, fetchedAt, now), index }))
    .sort((a, b) => stateSeverity(a.status.state) - stateSeverity(b.status.state) || a.index - b.index)
    .map(({ server, status }) => ({ server, status }));
}

/** "web-1: Reachable, sample 12s ago" / "db-1: Never checked, no successful sample". */
export function entryDescription(entry: FleetEntry): string {
  const { server, status } = entry;
  const age =
    status.sampleAgeSeconds === null
      ? "no successful sample"
      : `${status.stale ? "stale " : ""}sample ${formatAge(status.sampleAgeSeconds)}`;
  return `${server.name}: ${status.info.label}, ${age}`;
}

/** How many servers do not fit as dots and are summarised as "+N". */
export function overflowCount(total: number, max: number = MAX_BAR_DOTS): number {
  return Math.max(0, total - max);
}
