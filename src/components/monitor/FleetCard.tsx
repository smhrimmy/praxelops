"use client";

import React from "react";
import { ArrowDownToLine, ArrowUpFromLine, Clock, Cpu, HardDrive, Info, Layers, ShieldAlert, Terminal } from "lucide-react";
import type { FleetServer } from "@/lib/fleet/types";
import type { NetRate } from "@/lib/fleet/rates";
import { TONE_CLASSES, type ServerStatusView } from "@/lib/fleet/health";
import { formatDuration, formatLoad, formatPercent, formatRate } from "@/lib/fleet/format";
import { AgeLabel, Meter, StateBadge } from "./ui";

interface FleetCardProps {
  server: FleetServer;
  status: ServerStatusView;
  rate: NetRate | null | undefined;
  onOpen: () => void;
  onOpenTerminal: () => void;
}

/** Overview card for one server in the System Monitor. Clicking anywhere (except the buttons) opens the detail. */
export const FleetCard: React.FC<FleetCardProps> = ({ server, status, rate, onOpen, onOpenTerminal }) => {
  const m = status.metrics;
  const tone = status.info.tone;
  const isAlert = tone === "alert";
  const needsPin = status.state === "host_key_not_pinned";

  return (
    <article
      aria-label={`${server.name}, ${status.info.label}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a")) return;
        onOpen();
      }}
      className={`macos-card group flex w-full cursor-pointer flex-col justify-between rounded-xl p-4 transition-colors hover:border-line-strong ${
        isAlert ? "border-danger! ring-1 ring-danger/50" : ""
      }`}
    >
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-fg">
              <button
                type="button"
                onClick={onOpen}
                className="max-w-full truncate rounded text-left hover:underline"
                aria-label={`Open ${server.name} details`}
              >
                {server.name}
              </button>
            </h3>
            <div className="truncate font-mono text-[11px] text-fg-muted">
              {server.username}@{server.host}:{server.port}
            </div>
          </div>
          <StateBadge state={status.state} />
        </div>

        {isAlert && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger bg-danger/10 p-2 text-[11px] text-danger">
            <ShieldAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Security alert: the host presented a different SSH key than the pinned one. Do not connect until you have verified why.</span>
          </div>
        )}

        {m ? (
          <>
            <div className="grid grid-cols-3 gap-2 border-t border-line pt-3">
              <Meter label="CPU" icon={<Cpu aria-hidden="true" className="h-3 w-3" />} percent={m.cpuPercent} valueText={formatPercent(m.cpuPercent)} dim={status.lastKnown} />
              <Meter label="Mem" icon={<Layers aria-hidden="true" className="h-3 w-3" />} percent={m.memoryPercent} valueText={formatPercent(m.memoryPercent)} dim={status.lastKnown} />
              <Meter label="Disk" icon={<HardDrive aria-hidden="true" className="h-3 w-3" />} percent={m.diskPercent} valueText={formatPercent(m.diskPercent, 0)} dim={status.lastKnown} />
            </div>
            <dl className={`grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] ${status.lastKnown ? "opacity-70" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-fg-muted">Load</dt>
                <dd className="text-fg tabular-nums">{formatLoad(m.loadAverage[0])}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1 text-fg-muted">
                  <Clock aria-hidden="true" className="h-3 w-3" />
                  Up
                </dt>
                <dd className="text-fg tabular-nums">{formatDuration(m.uptimeSeconds)}</dd>
              </div>
              <div className="flex items-center justify-between gap-2" title={rate ? undefined : "A rate needs two samples; waiting for the next one."}>
                <dt className="flex items-center gap-1 text-fg-muted">
                  <ArrowDownToLine aria-hidden="true" className="h-3 w-3" />
                  Rx
                </dt>
                <dd className="text-fg tabular-nums">{formatRate(rate?.rxBytesPerSec)}</dd>
              </div>
              <div className="flex items-center justify-between gap-2" title={rate ? undefined : "A rate needs two samples; waiting for the next one."}>
                <dt className="flex items-center gap-1 text-fg-muted">
                  <ArrowUpFromLine aria-hidden="true" className="h-3 w-3" />
                  Tx
                </dt>
                <dd className="text-fg tabular-nums">{formatRate(rate?.txBytesPerSec)}</dd>
              </div>
            </dl>
          </>
        ) : (
          // The alert strip above already explains a host key mismatch; every other state gets its note.
          !isAlert && (
            <div className="flex items-start gap-2 border-t border-line pt-3 text-xs">
              <Info aria-hidden="true" className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${TONE_CLASSES[tone].text}`} />
              <span className="text-fg-2">{status.note}</span>
            </div>
          )
        )}

        {m && status.lastKnown && (
          <p className="text-[11px] text-fg-2">
            <span className={`font-semibold ${TONE_CLASSES[tone].text}`}>{status.info.label}.</span> {status.note}
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
        <AgeLabel prefix={m && !status.lastKnown ? "updated" : "last sample"} seconds={status.sampleAgeSeconds} stale={status.stale} />
        <button
          type="button"
          onClick={onOpenTerminal}
          aria-label={needsPin ? `Open terminal to verify host key for ${server.name}` : `Open terminal for ${server.name}`}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
            needsPin ? "bg-warning/15 text-warning hover:bg-warning/25" : "bg-sunken text-fg-2 hover:bg-hover-strong hover:text-fg"
          }`}
        >
          <Terminal aria-hidden="true" className="h-3 w-3" />
          {needsPin ? "Open terminal to verify host key" : "Open terminal"}
        </button>
      </div>
    </article>
  );
};
