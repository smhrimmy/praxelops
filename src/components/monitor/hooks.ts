"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { apiFetch } from "@/lib/client/api";
import type { ApiEnvelope, FleetServer } from "@/lib/fleet/types";
import { NetRateTracker, type NetRate } from "@/lib/fleet/rates";

/** Re-renders every `intervalMs` with the current time so "Ns ago" labels keep counting between polls. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden) setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
  return now;
}

/**
 * Runs `task` immediately and then every `intervalMs`.
 *  - ticks are skipped while the document is hidden; it runs again as soon as it becomes visible
 *  - never overlaps: a tick is dropped while the previous run is still in flight
 *  - restarts (aborting the old run's signal) when `resetKey` changes or `enabled` flips
 */
export function usePolling(
  task: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  resetKey: string,
  enabled = true
): void {
  const taskRef = useRef(task);
  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let inFlight = false;

    const run = async (ignoreHidden = false) => {
      if (inFlight || controller.signal.aborted || (document.hidden && !ignoreHidden)) return;
      inFlight = true;
      try {
        await taskRef.current(controller.signal);
      } catch {
        // Tasks report their own errors; a thrown error must never kill the polling loop.
      } finally {
        inFlight = false;
      }
    };

    // The first load always happens (a tab opened in the background should not start empty); later ticks pause while hidden.
    void run(true);
    const timer = window.setInterval(() => void run(), intervalMs);
    const onVisible = () => {
      if (!document.hidden) void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, resetKey, enabled]);
}

export const POLL_INTERVAL_MS = 15_000;

export interface FleetData {
  servers: FleetServer[];
  setServers: Dispatch<SetStateAction<FleetServer[]>>;
  /** Epoch ms of the last successful listing; 0 before the first one. */
  fetchedAt: number;
  /** True once the first listing attempt finished (successfully or not). */
  loaded: boolean;
  /** Message of the last failed listing, cleared by the next success. */
  error: string | null;
  /** Network rates per server derived from consecutive samples; missing/null = unknown. */
  rates: Record<string, NetRate | null>;
  reload: () => Promise<void>;
}

/** Owns the server listing (GET /api/servers) with 15s polling, shared by the shell, the fleet view and the monitor. */
export function useFleetData(): FleetData {
  const [servers, setServers] = useState<FleetServer[]>([]);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rates, setRates] = useState<Record<string, NetRate | null>>({});
  const tracker = useRef(new NetRateTracker());

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await apiFetch("/api/servers", { signal });
      const body = (await res.json()) as ApiEnvelope<FleetServer[]>;
      if (!res.ok || !body.success || !body.data) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const list = body.data;
      const nextRates: Record<string, NetRate | null> = {};
      for (const server of list) {
        const m = server.metrics;
        if (m) {
          nextRates[server.id] = tracker.current.update(server.id, {
            reportedAt: m.reportedAt,
            rxBytes: m.networkRxBytes,
            txBytes: m.networkTxBytes,
          });
        } else {
          tracker.current.forget(server.id);
        }
      }
      tracker.current.retainOnly(new Set(list.map((s) => s.id)));
      setServers(list);
      setRates(nextRates);
      setFetchedAt(Date.now());
      setError(null);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      if (!signal?.aborted) setLoaded(true);
    }
  }, []);

  usePolling(load, POLL_INTERVAL_MS, "fleet");

  const reload = useCallback(() => load(), [load]);

  return { servers, setServers, fetchedAt, loaded, error, rates, reload };
}
