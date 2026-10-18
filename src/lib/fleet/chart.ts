/**
 * Pure geometry for the inline-SVG line charts: scales, tick generation and a path builder that breaks the line at
 * missing values and at long gaps in time (a line is never drawn across data that is not there).
 */

export interface SeriesPoint {
  /** Epoch milliseconds. */
  t: number;
  /** null = no value at this time (shown as a gap). */
  v: number | null;
}

export interface XY {
  x: number;
  y: number;
}

export function linearScale(d0: number, d1: number, r0: number, r1: number): (value: number) => number {
  if (d1 === d0) return () => (r0 + r1) / 2;
  const k = (r1 - r0) / (d1 - d0);
  return (value) => r0 + (value - d0) * k;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Median spacing between consecutive points; null with fewer than two points. */
export function medianDelta(points: readonly SeriesPoint[]): number | null {
  if (points.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < points.length; i += 1) deltas.push(points[i].t - points[i - 1].t);
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 === 1 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
}

/** A gap larger than 3x the median spacing (and at least `floorMs`) is treated as missing data. */
export function defaultMaxGapMs(points: readonly SeriesPoint[], floorMs = 90_000): number {
  const median = medianDelta(points);
  return Math.max(floorMs, median === null ? 0 : median * 3);
}

export interface ValuedPoint {
  t: number;
  v: number;
}

/** Splits the series into continuous runs: a null value or a time gap > maxGapMs starts a new run. */
export function splitSegments(points: readonly SeriesPoint[], maxGapMs: number): ValuedPoint[][] {
  const segments: ValuedPoint[][] = [];
  let current: ValuedPoint[] = [];
  let prevT: number | null = null;
  for (const p of points) {
    if (p.v === null || !Number.isFinite(p.v)) {
      if (current.length > 0) segments.push(current);
      current = [];
      prevT = null;
      continue;
    }
    if (prevT !== null && p.t - prevT > maxGapMs && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push({ t: p.t, v: p.v });
    prevT = p.t;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export interface LineGeometry {
  /** SVG path data; one "M ... L ..." subpath per continuous run of at least two points. */
  d: string;
  /** Runs with a single point cannot be a line; they are drawn as dots. */
  isolated: XY[];
}

export function buildLineGeometry(
  points: readonly SeriesPoint[],
  scaleX: (t: number) => number,
  scaleY: (v: number) => number,
  maxGapMs: number
): LineGeometry {
  const parts: string[] = [];
  const isolated: XY[] = [];
  for (const run of splitSegments(points, maxGapMs)) {
    if (run.length === 1) {
      isolated.push({ x: round2(scaleX(run[0].t)), y: round2(scaleY(run[0].v)) });
      continue;
    }
    parts.push(run.map((p, i) => `${i === 0 ? "M" : "L"}${round2(scaleX(p.t))},${round2(scaleY(p.v))}`).join(""));
  }
  return { d: parts.join(""), isolated };
}

const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** Smallest "nice" step (1/2/2.5/5 x 10^k) that is >= rawStep. */
export function niceStep(rawStep: number): number {
  if (!(rawStep > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  for (const f of NICE_STEPS) if (f * magnitude >= rawStep * (1 - 1e-9)) return f * magnitude;
  return 10 * magnitude;
}

/** Ticks from 0 up to a nice value >= max (about `target` intervals). max <= 0 gives [0, 1]. */
export function niceTicksFromZero(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const step = niceStep(max / target);
  const count = Math.ceil(max / step - 1e-9);
  return Array.from({ length: count + 1 }, (_, i) => round6(i * step));
}

/** Like niceTicksFromZero but in 1024-based units, so ticks land on 256 KiB, 1 MiB, ... instead of 97.7 KiB. */
export function byteTicksFromZero(maxBytes: number, target = 4): number[] {
  if (!(maxBytes > 0)) return [0, 1024];
  let unit = 1;
  while (maxBytes / unit >= 1024 && unit < 1024 ** 5) unit *= 1024;
  return niceTicksFromZero(maxBytes / unit, target).map((t) => t * unit);
}

const MINUTE = 60_000;
const TIME_STEPS_MS = [
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  60 * MINUTE,
  120 * MINUTE,
  180 * MINUTE,
  360 * MINUTE,
  720 * MINUTE,
];

/** Evenly spaced ticks inside [startMs, endMs], aligned to local clock boundaries. */
export function timeTicks(startMs: number, endMs: number, target = 6): number[] {
  if (!(endMs > startMs)) return [];
  const span = endMs - startMs;
  const step = TIME_STEPS_MS.find((s) => span / s <= target) ?? TIME_STEPS_MS[TIME_STEPS_MS.length - 1];
  const offset = -new Date(startMs).getTimezoneOffset() * MINUTE;
  const first = Math.ceil((startMs + offset) / step) * step - offset;
  const ticks: number[] = [];
  for (let t = first; t <= endMs; t += step) ticks.push(t);
  return ticks;
}

/** Index of the time in `times` (ascending) nearest to `t`; -1 for an empty list. */
export function nearestIndex(times: readonly number[], t: number): number {
  if (times.length === 0) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t)) return lo - 1;
  return lo;
}
