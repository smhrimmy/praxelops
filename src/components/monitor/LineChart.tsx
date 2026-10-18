"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  buildLineGeometry,
  defaultMaxGapMs,
  linearScale,
  nearestIndex,
  timeTicks,
  type SeriesPoint,
} from "@/lib/fleet/chart";
import { formatClock } from "@/lib/fleet/format";

export interface ChartSeries {
  id: string;
  label: string;
  /** CSS colour, normally a design token such as "var(--info)". */
  color: string;
  /** Draw dashed: a second encoding so two series stay distinguishable without colour. */
  dashed?: boolean;
  points: SeriesPoint[];
}

interface LineChartProps {
  title: string;
  series: ChartSeries[];
  /** [startMs, endMs] of the x axis. The axis always spans the whole selected range so missing data is visible. */
  xDomain: [number, number];
  /** Ascending y ticks; the first and last define the y domain. */
  yTicks: number[];
  formatTick: (value: number) => string;
  formatValue: (value: number) => string;
  height?: number;
  /** Shown instead of the plot when no series has a single real value. */
  emptyMessage: string;
}

const MARGIN = { top: 8, right: 14, bottom: 22, left: 58 };
const DEFAULT_WIDTH = 640;

function lastValue(points: readonly SeriesPoint[]): SeriesPoint | null {
  for (let i = points.length - 1; i >= 0; i -= 1) if (points[i].v !== null && Number.isFinite(points[i].v)) return points[i];
  return null;
}

/** Inline-SVG line chart: recessive grid, 2px lines, gaps at missing data, crosshair + tooltip on hover or arrow keys. */
export const LineChart: React.FC<LineChartProps> = ({
  title,
  series,
  xDomain,
  yTicks,
  formatTick,
  formatValue,
  height = 168,
  emptyMessage,
}) => {
  const uid = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [cursor, setCursor] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [x0, x1] = xDomain;
  const yMin = yTicks[0];
  const yMax = yTicks[yTicks.length - 1];
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const sx = useMemo(() => linearScale(x0, x1, MARGIN.left, MARGIN.left + plotW), [x0, x1, plotW]);
  const sy = useMemo(() => linearScale(yMin, yMax, MARGIN.top + plotH, MARGIN.top), [yMin, yMax, plotH]);

  const geometry = useMemo(
    () => series.map((s) => ({ id: s.id, ...buildLineGeometry(s.points, sx, sy, defaultMaxGapMs(s.points)) })),
    [series, sx, sy]
  );

  // Union of sample times (ascending) so the crosshair snaps to real samples only.
  const times = useMemo(() => {
    const set = new Set<number>();
    for (const s of series) for (const p of s.points) set.add(p.t);
    return [...set].sort((a, b) => a - b);
  }, [series]);

  const hasData = series.some((s) => s.points.some((p) => p.v !== null && Number.isFinite(p.v)));
  const ticksX = useMemo(() => timeTicks(x0, x1, Math.max(3, Math.floor(plotW / 90))), [x0, x1, plotW]);
  const maxGap = useMemo(() => Math.max(...series.map((s) => defaultMaxGapMs(s.points)), 90_000), [series]);

  const cursorTime = cursor !== null && cursor < times.length ? times[cursor] : null;

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGRectElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * plotW + MARGIN.left;
      const t = x0 + ((px - MARGIN.left) / plotW) * (x1 - x0);
      const idx = nearestIndex(times, t);
      if (idx < 0 || Math.abs(times[idx] - t) > maxGap) setCursor(null);
      else setCursor(idx);
    },
    [plotW, times, x0, x1, maxGap]
  );

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (times.length === 0) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      setCursor((c) => (c === null ? (dir < 0 ? times.length - 1 : 0) : Math.min(times.length - 1, Math.max(0, c + dir))));
    } else if (e.key === "Home") {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setCursor(times.length - 1);
    } else if (e.key === "Escape") {
      setCursor(null);
    }
  };

  const latest = series.length === 1 ? lastValue(series[0].points) : null;
  const summary = series
    .map((s) => {
      const vals = s.points.map((p) => p.v).filter((v): v is number => v !== null && Number.isFinite(v));
      if (vals.length === 0) return `${s.label}: no data`;
      const last = lastValue(s.points);
      return `${s.label}: latest ${formatValue(last ? (last.v as number) : vals[vals.length - 1])}, min ${formatValue(Math.min(...vals))}, max ${formatValue(Math.max(...vals))}`;
    })
    .join("; ");

  const tooltipX = cursorTime !== null ? sx(cursorTime) : 0;
  const tooltipOnLeft = tooltipX > width * 0.6;

  return (
    <figure className="m-0">
      <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs font-semibold text-fg">{title}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-muted">
          {series.length > 1 &&
            series.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1.5">
                <svg width="18" height="6" aria-hidden="true">
                  <line x1="0" y1="3" x2="18" y2="3" strokeWidth="2" strokeLinecap="round" strokeDasharray={s.dashed ? "5 3" : undefined} style={{ stroke: s.color }} />
                </svg>
                <span className="text-fg-2">{s.label}</span>
              </span>
            ))}
          {latest && (
            <span className="font-mono tabular-nums">
              latest <span className="text-fg">{formatValue(latest.v as number)}</span> at {formatClock(latest.t)}
            </span>
          )}
        </span>
      </figcaption>

      <div ref={wrapRef} className="relative" style={{ height }}>
        {!hasData ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-line px-4 text-center text-xs text-fg-muted">
            {emptyMessage}
          </div>
        ) : (
          <>
            <svg
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              tabIndex={0}
              aria-label={`${title}. ${summary}. Use left and right arrow keys to inspect samples.`}
              onKeyDown={onKeyDown}
              onBlur={() => setCursor(null)}
              onPointerLeave={() => setCursor(null)}
              className="block touch-pan-y select-none overflow-visible"
            >
              <title>{title}</title>
              {yTicks.map((t) => (
                <g key={t}>
                  <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={sy(t)} y2={sy(t)} strokeWidth="1" style={{ stroke: "var(--line)" }} />
                  <text x={MARGIN.left - 6} y={sy(t)} textAnchor="end" dominantBaseline="middle" fontSize="10" style={{ fill: "var(--fg-muted)" }}>
                    {formatTick(t)}
                  </text>
                </g>
              ))}
              {ticksX.map((t) => (
                <g key={t}>
                  <line x1={sx(t)} x2={sx(t)} y1={MARGIN.top + plotH} y2={MARGIN.top + plotH + 4} strokeWidth="1" style={{ stroke: "var(--line-strong)" }} />
                  <text x={sx(t)} y={MARGIN.top + plotH + 15} textAnchor="middle" fontSize="10" style={{ fill: "var(--fg-muted)" }}>
                    {formatClock(t)}
                  </text>
                </g>
              ))}

              {series.map((s, i) => (
                <g key={s.id}>
                  <path
                    d={geometry[i].d}
                    fill="none"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={s.dashed ? "5 3" : undefined}
                    style={{ stroke: s.color }}
                  />
                  {geometry[i].isolated.map((p, j) => (
                    <circle key={j} cx={p.x} cy={p.y} r="2.5" style={{ fill: s.color }} />
                  ))}
                </g>
              ))}

              {cursorTime !== null && (
                <g pointerEvents="none">
                  <line x1={tooltipX} x2={tooltipX} y1={MARGIN.top} y2={MARGIN.top + plotH} strokeWidth="1" style={{ stroke: "var(--fg-muted)" }} />
                  {series.map((s) => {
                    const p = s.points.find((q) => q.t === cursorTime);
                    if (!p || p.v === null || !Number.isFinite(p.v)) return null;
                    return <circle key={s.id} cx={tooltipX} cy={sy(p.v)} r="4" strokeWidth="2" style={{ fill: s.color, stroke: "var(--elevated)" }} />;
                  })}
                </g>
              )}

              <rect
                x={MARGIN.left}
                y={MARGIN.top}
                width={plotW}
                height={plotH}
                fill="transparent"
                onPointerMove={onPointerMove}
                onPointerDown={onPointerMove}
              />
            </svg>

            {cursorTime !== null && (
              <div
                id={`${uid}-tip`}
                role="status"
                className="pointer-events-none absolute top-1 z-10 min-w-[8rem] rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-[11px] shadow-lg"
                style={tooltipOnLeft ? { right: width - tooltipX + 10 } : { left: tooltipX + 10 }}
              >
                <div className="mb-1 font-mono text-fg-muted">{formatClock(cursorTime, true)}</div>
                {series.map((s) => {
                  const p = s.points.find((q) => q.t === cursorTime);
                  const known = p !== undefined && p.v !== null && Number.isFinite(p.v);
                  return (
                    <div key={s.id} className="flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 text-fg-2">
                        <svg width="12" height="6" aria-hidden="true">
                          <line x1="0" y1="3" x2="12" y2="3" strokeWidth="2" strokeLinecap="round" strokeDasharray={s.dashed ? "4 2" : undefined} style={{ stroke: s.color }} />
                        </svg>
                        {s.label}
                      </span>
                      <span className="font-mono tabular-nums text-fg">{known ? formatValue(p.v as number) : "no data"}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </figure>
  );
};
