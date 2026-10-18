import type { ServerHost } from "@/types/server";
import type { MetricsSample, ServerHealthView } from "@/lib/metrics/types";
import type { HistoryPoint, LatestView } from "@/lib/metrics/view";

/** A server as returned by GET /api/servers: the stored host plus real health and (only when fresh) telemetry. */
export type FleetServer = ServerHost & {
  /** Absent = the host has never been checked. */
  health?: ServerHealthView;
  /** Latest fresh sample without processes/services (disks, swap, cpu count, ...). */
  metricsDetail?: Omit<MetricsSample, "processes" | "services">;
};

export type { HistoryPoint, LatestView };

/** Standard `{ success, data | error }` envelope of the JSON API. */
export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** GET /api/servers/[id]/metrics */
export interface HistoryResponse {
  serverId: string;
  hours: number;
  maxPoints: number;
  rawCount: number;
  points: HistoryPoint[];
  health?: ServerHealthView;
}

/** GET /api/servers/[id]/metrics/latest */
export type LatestResponse = LatestView & { serverId: string };

/** POST /api/servers/[id]/metrics/refresh */
export type RefreshResponse =
  | { ok: true; collectedAt: string; stored: boolean; health?: ServerHealthView }
  | { ok: false; reason: string; message: string; collectedAt: string; stored: boolean; health?: ServerHealthView };
