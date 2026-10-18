import { describe, it, expect } from "vitest";
import {
  buildLineGeometry,
  byteTicksFromZero,
  defaultMaxGapMs,
  linearScale,
  medianDelta,
  nearestIndex,
  niceStep,
  niceTicksFromZero,
  splitSegments,
  timeTicks,
  type SeriesPoint,
} from "./chart";

const pt = (t: number, v: number | null): SeriesPoint => ({ t, v });
const identity = (n: number) => n;

describe("linearScale", () => {
  it("maps the domain onto the range (including inverted ranges)", () => {
    const y = linearScale(0, 100, 200, 0);
    expect(y(0)).toBe(200);
    expect(y(100)).toBe(0);
    expect(y(50)).toBe(100);
  });

  it("does not divide by zero for a degenerate domain", () => {
    expect(linearScale(5, 5, 0, 10)(5)).toBe(5);
  });
});

describe("splitSegments", () => {
  it("breaks the line at null values instead of interpolating across them", () => {
    const segs = splitSegments([pt(0, 1), pt(10, 2), pt(20, null), pt(30, 3), pt(40, 4)], 1000);
    expect(segs.map((s) => s.map((p) => p.t))).toEqual([
      [0, 10],
      [30, 40],
    ]);
  });

  it("breaks the line across a long time gap even without nulls", () => {
    const segs = splitSegments([pt(0, 1), pt(10, 2), pt(5000, 3), pt(5010, 4)], 100);
    expect(segs).toHaveLength(2);
  });

  it("treats NaN as missing and returns nothing for an all-null series", () => {
    expect(splitSegments([pt(0, null), pt(1, Number.NaN)], 100)).toEqual([]);
  });
});

describe("buildLineGeometry", () => {
  it("builds one subpath per continuous run", () => {
    const g = buildLineGeometry([pt(0, 0), pt(10, 5), pt(20, null), pt(30, 1), pt(40, 2)], identity, identity, 1000);
    expect(g.d).toBe("M0,0L10,5M30,1L40,2");
    expect(g.isolated).toEqual([]);
  });

  it("reports single-point runs as isolated dots, not as lines", () => {
    const g = buildLineGeometry([pt(0, 1), pt(10, null), pt(20, 2), pt(30, null), pt(40, 3), pt(50, 4)], identity, identity, 1000);
    expect(g.d).toBe("M40,3L50,4");
    expect(g.isolated).toEqual([
      { x: 0, y: 1 },
      { x: 20, y: 2 },
    ]);
  });

  it("returns an empty path for no data", () => {
    expect(buildLineGeometry([], identity, identity, 1000)).toEqual({ d: "", isolated: [] });
  });

  it("applies the scales and rounds coordinates", () => {
    const g = buildLineGeometry([pt(0, 0), pt(3, 1)], (t) => t / 3, (v) => 100 - v * 33.333, 1000);
    expect(g.d).toBe("M0,100L1,66.67");
  });
});

describe("gap detection", () => {
  it("computes the median spacing", () => {
    expect(medianDelta([pt(0, 1)])).toBeNull();
    expect(medianDelta([pt(0, 1), pt(30, 1), pt(60, 1), pt(1000, 1)])).toBe(30);
  });

  it("uses 3x the median but never less than the floor", () => {
    expect(defaultMaxGapMs([pt(0, 1), pt(30_000, 1), pt(60_000, 1)])).toBe(90_000);
    expect(defaultMaxGapMs([pt(0, 1), pt(240_000, 1), pt(480_000, 1)])).toBe(720_000);
    expect(defaultMaxGapMs([])).toBe(90_000);
  });
});

describe("ticks", () => {
  it("picks nice steps", () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.4)).toBe(2);
    expect(niceStep(3.1)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(0)).toBe(1);
  });

  it("covers the maximum starting from zero", () => {
    expect(niceTicksFromZero(100)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicksFromZero(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicksFromZero(0)).toEqual([0, 1]);
    const ticks = niceTicksFromZero(0.37);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(0.37);
  });

  it("lands byte ticks on 1024-based boundaries", () => {
    const ticks = byteTicksFromZero(900 * 1024);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(900 * 1024);
    for (const t of ticks) expect(Number.isInteger(t / 1024)).toBe(true);
    expect(byteTicksFromZero(0)).toEqual([0, 1024]);
  });

  it("produces evenly spaced time ticks inside the range", () => {
    const start = Date.parse("2026-03-01T10:07:00Z");
    const end = start + 3600_000;
    const ticks = timeTicks(start, end, 6);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThanOrEqual(7);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThanOrEqual(end);
    }
    const steps = new Set(ticks.slice(1).map((t, i) => t - ticks[i]));
    expect(steps.size).toBe(1);
    expect(timeTicks(end, start)).toEqual([]);
  });
});

describe("nearestIndex", () => {
  it("finds the closest time", () => {
    const times = [0, 10, 20, 100];
    expect(nearestIndex(times, -5)).toBe(0);
    expect(nearestIndex(times, 4)).toBe(0);
    expect(nearestIndex(times, 6)).toBe(1);
    expect(nearestIndex(times, 61)).toBe(3);
    expect(nearestIndex(times, 500)).toBe(3);
    expect(nearestIndex([], 5)).toBe(-1);
  });
});
