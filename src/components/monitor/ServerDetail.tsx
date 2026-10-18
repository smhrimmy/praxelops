"use client";

import React, { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Info,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import type { FleetServer, HistoryResponse, LatestResponse, RefreshResponse } from "@/lib/fleet/types";
import { fetchApi } from "@/lib/fleet/client";
import { deriveServerStatus, liveAgeSeconds, TONE_CLASSES, type ServerStatusView } from "@/lib/fleet/health";
import {
  formatAge,
  formatBytes,
  formatClock,
  formatDuration,
  formatKb,
  formatLoad,
  formatPercent,
  formatRate,
  NO_VALUE,
} from "@/lib/fleet/format";
import { byteTicksFromZero, type SeriesPoint } from "@/lib/fleet/chart";
import { usePolling, POLL_INTERVAL_MS } from "./hooks";
import { AgeLabel, Panel, StateBadge } from "./ui";
import { LineChart, type ChartSeries } from "./LineChart";
import { DiskTable, ProcessTable, ServiceTable } from "./DetailTables";

const RANGES = [1, 6, 24] as const;
type Range = (typeof RANGES)[number];

interface ServerDetailProps {
  server: FleetServer;
  now: number;
  fetchedAt: number;
  onBack: () => void;
  onOpenTerminal: (server: FleetServer) => void;
  /** Re-reads the fleet listing (after a manual refresh, so the overview and top bar update too). */
  onFleetReload: () => Promise<void>;
}

type RefreshState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "ok"; at: number }
  | { phase: "failed"; message: string; at: number }
  | { phase: "error"; message: string; at: number };

const PERCENT_TICKS = [0, 25, 50, 75, 100];

export const ServerDetail: React.FC<ServerDetailProps> = ({ server, now, fetchedAt, onBack, onOpenTerminal, onFleetReload }) => {
  const [hours, setHours] = useState<Range>(1);
  const [latest, setLatest] = useState<LatestResponse | null>(null);
  const [latestAt, setLatestAt] = useState(0);
  const [latestError, setLatestError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyAt, setHistoryAt] = useState(0);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState<RefreshState>({ phase: "idle" });

  const id = server.id;

  const loadDetail = useCallback(
    async (signal?: AbortSignal) => {
      const base = `/api/servers/${encodeURIComponent(id)}/metrics`;
      const [latestResult, historyResult] = await Promise.allSettled([
        fetchApi<LatestResponse>(`${base}/latest`, { signal }),
        fetchApi<HistoryResponse>(`${base}?hours=${hours}`, { signal }),
      ]);
      if (signal?.aborted) return;
      if (latestResult.status === "fulfilled") {
        setLatest(latestResult.value);
        setLatestAt(Date.now());
        setLatestError(null);
      } else {
        setLatestError(latestResult.reason instanceof Error ? latestResult.reason.message : "Request failed");
      }
      if (historyResult.status === "fulfilled") {
        setHistory(historyResult.value);
        setHistoryAt(Date.now());
        setHistoryError(null);
      } else {
        setHistoryError(historyResult.reason instanceof Error ? historyResult.reason.message : "Request failed");
      }
    },
    [id, hours]
  );

  usePolling(loadDetail, POLL_INTERVAL_MS, `${id}:${hours}`);

  const onRefreshNow = async () => {
    if (refresh.phase === "running") return;
    setRefresh({ phase: "running" });
    try {
      const result = await fetchApi<RefreshResponse>(`/api/servers/${encodeURIComponent(id)}/metrics/refresh`, { method: "POST" });
      setRefresh(
        result.ok
          ? { phase: "ok", at: Date.now() }
          : { phase: "failed", message: `${result.reason}: ${result.message}`, at: Date.now() }
      );
    } catch (err) {
      setRefresh({ phase: "error", message: err instanceof Error ? err.message : "Request failed", at: Date.now() });
    }
    await Promise.all([loadDetail(), onFleetReload()]);
  };

  // Header state comes from the freshest health we have (the detail response, else the fleet listing).
  const status: ServerStatusView = useMemo(() => {
    const health = latest ? latest.health ?? undefined : server.health;
    const metrics = latest ? (latest.fresh && latest.metrics ? latest.metrics : undefined) : server.metrics;
    return deriveServerStatus({ ...server, health, metrics }, latest ? latestAt : fetchedAt, now);
  }, [latest, latestAt, server, fetchedAt, now]);

  const sample = latest?.sample ?? null;
  const sampleAge = latest ? liveAgeSeconds(latest.ageSeconds, latestAt, now) : status.sampleAgeSeconds;
  const lastKnown = sample !== null && status.state !== "reachable";
  const loadingFirst = latest === null && latestError === null;

  const historyForRange = history && history.hours === hours ? history : null;
  const series = useMemo(() => buildSeries(historyForRange), [historyForRange]);
  const xDomain: [number, number] = [(historyAt || now) - hours * 3_600_000, historyAt || now];
  const netMax = Math.max(0, ...series.rx.points.map((p) => p.v ?? 0), ...series.tx.points.map((p) => p.v ?? 0));
  const netTicks = useMemo(() => byteTicksFromZero(netMax), [netMax]);

  const emptyHistory = historyError
    ? `Could not load history: ${historyError}`
    : historyForRange === null
    ? "Loading history..."
    : `No successful samples were stored in the last ${hours}h. ${status.note}`;

  return (
    <div className="space-y-4 pb-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 rounded text-xs text-fg-muted hover:text-fg"
          >
            <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
            All servers
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-bold tracking-tight text-fg">{server.name}</h1>
            <StateBadge state={status.state} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-fg-muted">
            <span className="font-mono">
              {server.username}@{server.host}:{server.port}
            </span>
            <AgeLabel prefix={lastKnown ? "last good sample" : "sample"} seconds={sampleAge} stale={status.stale} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenTerminal(server)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sunken px-3 py-1.5 text-xs font-medium text-fg-2 transition-colors hover:bg-hover-strong hover:text-fg"
          >
            <Terminal aria-hidden="true" className="h-3.5 w-3.5" />
            Open terminal
          </button>
          <button
            type="button"
            onClick={() => void onRefreshNow()}
            disabled={refresh.phase === "running"}
            aria-busy={refresh.phase === "running"}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-70"
          >
            {refresh.phase === "running" ? (
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {refresh.phase === "running" ? "Sampling..." : "Refresh now"}
          </button>
        </div>
      </div>

      {/* Refresh result (live region) */}
      <div role="status" aria-live="polite" className="min-h-0 text-xs">
        {refresh.phase === "ok" && (
          <p className="flex items-center gap-1.5 text-success">
            <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
            Sampled at {formatClock(refresh.at, true)}.
          </p>
        )}
        {(refresh.phase === "failed" || refresh.phase === "error") && (
          <p className="flex items-start gap-1.5 rounded-lg border border-danger/40 bg-danger/10 p-2.5 text-danger">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {refresh.phase === "failed" ? "Sampling failed" : "Refresh request failed"} at {formatClock(refresh.at, true)}: {refresh.message}
            </span>
          </p>
        )}
      </div>

      <StateCallout server={server} status={status} onOpenTerminal={onOpenTerminal} />

      {latestError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Could not refresh this server ({latestError}).{" "}
            {latest ? `Showing data fetched ${formatAge(Math.floor((now - latestAt) / 1000))}.` : "Nothing is shown until a request succeeds."}
          </span>
        </div>
      )}

      {/* Current values */}
      <Panel
        title="Current"
        titleId="detail-current"
        actions={<AgeLabel prefix={lastKnown ? "last good sample" : "sample"} seconds={sampleAge} stale={status.stale} />}
      >
        {loadingFirst ? (
          <p className="text-xs text-fg-muted">Loading...</p>
        ) : sample === null ? (
          <p className="flex items-start gap-2 text-xs text-fg-2">
            <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-muted" />
            <span>No successful sample exists for this host, so there are no numbers to show. {status.note}</span>
          </p>
        ) : (
          <dl className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 ${lastKnown || status.stale ? "opacity-75" : ""}`}>
            <Tile label="CPU" value={formatPercent(sample.cpuPercent)} sub={`${sample.cpuCount} ${sample.cpuCount === 1 ? "core" : "cores"}`} />
            <Tile
              label="Memory"
              value={formatPercent(sample.memUsedPercent)}
              sub={`${formatKb(sample.memTotalKb - sample.memAvailableKb)} of ${formatKb(sample.memTotalKb)}`}
            />
            <Tile
              label="Root disk"
              value={sample.rootDiskUsedPercent === null ? NO_VALUE : formatPercent(sample.rootDiskUsedPercent)}
              sub={sample.rootDiskUsedPercent === null ? 'no "/" filesystem reported' : "mounted at /"}
            />
            <Tile
              label="Load (1/5/15m)"
              value={formatLoad(sample.load1)}
              sub={`${formatLoad(sample.load5)} / ${formatLoad(sample.load15)}`}
            />
            <Tile label="Uptime" value={formatDuration(sample.uptimeSeconds)} sub={`${sample.runningTasks} running / ${sample.totalTasks} tasks`} />
            <Tile
              label="Swap"
              value={sample.swapTotalKb === 0 ? "none" : formatPercent(((sample.swapTotalKb - sample.swapFreeKb) / sample.swapTotalKb) * 100)}
              sub={sample.swapTotalKb === 0 ? "no swap configured" : `of ${formatKb(sample.swapTotalKb)}`}
            />
            <Tile label="Network received" value={formatBytes(sample.netRxBytes)} sub="total since boot" />
            <Tile label="Network sent" value={formatBytes(sample.netTxBytes)} sub="total since boot" />
          </dl>
        )}
      </Panel>

      {/* History */}
      <Panel
        title="History"
        titleId="detail-history"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {historyForRange && (
              <span className="text-[11px] text-fg-muted">
                {historyForRange.rawCount} {historyForRange.rawCount === 1 ? "sample" : "samples"} &middot; updated{" "}
                {formatAge(Math.max(0, Math.floor((now - historyAt) / 1000)))}
              </span>
            )}
            <div role="group" aria-label="Time range" className="flex items-center gap-1">
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={hours === r}
                  onClick={() => setHours(r)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    hours === r ? "bg-accent text-accent-fg" : "bg-sunken text-fg-2 hover:text-fg"
                  }`}
                >
                  {r}h
                </button>
              ))}
            </div>
          </div>
        }
      >
        {historyError && historyForRange && (
          <p role="alert" className="mb-3 flex items-center gap-1.5 text-xs text-danger">
            <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
            Could not refresh history ({historyError}). Showing the last successful load.
          </p>
        )}
        <div className="grid gap-5 lg:grid-cols-2">
          <LineChart
            title="CPU %"
            series={[series.cpu]}
            xDomain={xDomain}
            yTicks={PERCENT_TICKS}
            formatTick={(v) => `${v}%`}
            formatValue={(v) => formatPercent(v)}
            emptyMessage={emptyHistory}
          />
          <LineChart
            title="Memory %"
            series={[series.mem]}
            xDomain={xDomain}
            yTicks={PERCENT_TICKS}
            formatTick={(v) => `${v}%`}
            formatValue={(v) => formatPercent(v)}
            emptyMessage={emptyHistory}
          />
          <LineChart
            title="Root disk %"
            series={[series.disk]}
            xDomain={xDomain}
            yTicks={PERCENT_TICKS}
            formatTick={(v) => `${v}%`}
            formatValue={(v) => formatPercent(v)}
            emptyMessage={emptyHistory}
          />
          <LineChart
            title="Network throughput (per second)"
            series={[series.rx, series.tx]}
            xDomain={xDomain}
            yTicks={netTicks}
            formatTick={(v) => formatBytes(v)}
            formatValue={(v) => formatRate(v)}
            emptyMessage={
              historyForRange && historyForRange.rawCount > 0
                ? "No throughput could be derived yet: a rate needs two consecutive samples without a counter reset."
                : emptyHistory
            }
          />
        </div>
        <p className="mt-3 text-[11px] text-fg-muted">
          Lines break where samples are missing or a value is unknown; they are never drawn across a gap. Hover or focus a chart and use the arrow keys to read exact values.
        </p>
      </Panel>

      <Panel title="Disks" titleId="detail-disks" actions={<AgeLabel prefix="sample" seconds={sampleAge} stale={status.stale} />}>
        <DiskTable disks={sample ? sample.disks : null} />
      </Panel>

      <Panel
        title="Processes"
        titleId="detail-processes"
        actions={
          <span className="text-[11px] text-fg-muted">
            top 25 by avg CPU &middot; avg CPU is the lifetime average reported by ps, not current usage
            {sample ? ` · sample ${formatAge(sampleAge)}` : ""}
          </span>
        }
      >
        {sample === null ? <p className="text-xs text-fg-muted">No sample yet.</p> : <ProcessTable processes={sample.processes} />}
      </Panel>

      <Panel
        title="Services"
        titleId="detail-services"
        actions={<span className="text-[11px] text-fg-muted">systemd units{sample ? ` · sample ${formatAge(sampleAge)}` : ""}</span>}
      >
        {sample === null ? <p className="text-xs text-fg-muted">No sample yet.</p> : <ServiceTable services={sample.services} />}
      </Panel>
    </div>
  );
};

const Tile: React.FC<{ label: string; value: string; sub: string }> = ({ label, value, sub }) => (
  <div className="rounded-lg bg-sunken p-3">
    <dt className="text-[11px] text-fg-muted">{label}</dt>
    <dd className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-fg">{value}</dd>
    <dd className="truncate text-[11px] text-fg-muted" title={sub}>
      {sub}
    </dd>
  </div>
);

function buildSeries(history: HistoryResponse | null): Record<"cpu" | "mem" | "disk" | "rx" | "tx", ChartSeries> {
  const pts = history ? history.points : [];
  const make = (pick: (p: HistoryResponse["points"][number]) => number | null): SeriesPoint[] =>
    pts.map((p) => ({ t: Date.parse(p.t), v: pick(p) }));
  return {
    cpu: { id: "cpu", label: "CPU", color: "var(--info)", points: make((p) => p.cpuPercent) },
    mem: { id: "mem", label: "Memory", color: "var(--violet)", points: make((p) => p.memUsedPercent) },
    disk: { id: "disk", label: "Root disk", color: "var(--teal)", points: make((p) => p.rootDiskUsedPercent) },
    rx: { id: "rx", label: "Received", color: "var(--info)", points: make((p) => p.netRxBytesPerSec) },
    tx: { id: "tx", label: "Sent", color: "var(--orange)", dashed: true, points: make((p) => p.netTxBytesPerSec) },
  };
}

/** Explains the current host state with the next step; security-relevant states are styled as alerts. */
const StateCallout: React.FC<{
  server: FleetServer;
  status: ServerStatusView;
  onOpenTerminal: (server: FleetServer) => void;
}> = ({ server, status, onOpenTerminal }) => {
  const { state, info } = status;
  if (state === "reachable") return null;
  const tone = TONE_CLASSES[info.tone];

  if (state === "host_key_mismatch") {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-xl border-2 border-danger bg-danger/10 p-4 text-xs text-fg">
        <ShieldAlert aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
        <div className="space-y-1">
          <p className="text-sm font-bold text-danger">Security alert: SSH host key mismatch</p>
          <p>
            {server.name} presented a different SSH host key than the one pinned for it. This can mean the host was re-installed, but it can also mean someone is intercepting the connection. Metrics collection and terminal access
            should be treated as unsafe until you have verified the new key out of band.
          </p>
          {status.reason && <p className="font-mono text-[11px] text-fg-2">{status.reason}</p>}
        </div>
      </div>
    );
  }

  if (state === "host_key_not_pinned") {
    return (
      <div role="status" className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 text-xs ${tone.badge}`}>
        <div className="flex min-w-0 items-start gap-2">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-fg">
            <strong className="font-semibold">Host key not pinned.</strong> Metrics are not collected until the SSH host key is verified. Open a terminal to this server once to verify and pin the key; sampling starts on the next collection cycle.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpenTerminal(server)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-fg hover:bg-accent-hover"
        >
          <Terminal aria-hidden="true" className="h-3.5 w-3.5" />
          Open terminal to verify host key
        </button>
      </div>
    );
  }

  if (state === "never_checked") {
    return (
      <div role="status" className="flex items-start gap-2 rounded-xl border border-line-strong bg-sunken p-4 text-xs text-fg-2">
        <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
        <p>
          <strong className="font-semibold text-fg">Never checked.</strong> The collector has not recorded a check for this server. If it is running (<code className="rounded bg-sunken-2 px-1 font-mono">npm run collector</code>) it will be sampled
          within a cycle; otherwise use <em>Refresh now</em>.
        </p>
      </div>
    );
  }

  return (
    <div role="alert" className={`flex items-start gap-2 rounded-xl border p-4 text-xs ${tone.badge}`}>
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="text-fg">
        <strong className={`font-semibold ${tone.text}`}>{info.label}.</strong> {status.note}
      </p>
    </div>
  );
};
