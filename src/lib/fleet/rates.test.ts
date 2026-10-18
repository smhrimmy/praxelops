import { describe, it, expect } from "vitest";
import { MAX_RATE_GAP_MS, NetRateTracker, computeNetRate, type CounterSample } from "./rates";

const at = (iso: string, rx: number, tx: number): CounterSample => ({ reportedAt: iso, rxBytes: rx, txBytes: tx });

describe("computeNetRate", () => {
  it("derives bytes per second from two samples", () => {
    const rate = computeNetRate(at("2026-01-01T00:00:00Z", 1000, 0), at("2026-01-01T00:00:10Z", 6000, 500));
    expect(rate).toEqual({ rxBytesPerSec: 500, txBytesPerSec: 50 });
  });

  it("returns null for a counter reset, an identical timestamp or a long gap", () => {
    const base = at("2026-01-01T00:00:00Z", 1000, 1000);
    expect(computeNetRate(base, at("2026-01-01T00:00:10Z", 10, 2000))).toBeNull();
    expect(computeNetRate(base, at("2026-01-01T00:00:00Z", 2000, 2000))).toBeNull();
    expect(computeNetRate(base, at("2025-12-31T23:59:00Z", 2000, 2000))).toBeNull();
    const later = new Date(Date.parse(base.reportedAt) + MAX_RATE_GAP_MS + 1000).toISOString();
    expect(computeNetRate(base, at(later, 5000, 5000))).toBeNull();
  });
});

describe("NetRateTracker", () => {
  it("reports unknown for the first sample, then a rate for a new sample", () => {
    const tracker = new NetRateTracker();
    expect(tracker.update("a", at("2026-01-01T00:00:00Z", 0, 0))).toBeNull();
    expect(tracker.update("a", at("2026-01-01T00:00:30Z", 3000, 600))).toEqual({ rxBytesPerSec: 100, txBytesPerSec: 20 });
  });

  it("keeps the last rate while the same sample is polled again", () => {
    const tracker = new NetRateTracker();
    tracker.update("a", at("2026-01-01T00:00:00Z", 0, 0));
    const first = tracker.update("a", at("2026-01-01T00:00:30Z", 3000, 600));
    expect(tracker.update("a", at("2026-01-01T00:00:30Z", 3000, 600))).toEqual(first);
  });

  it("tracks servers independently and can forget one", () => {
    const tracker = new NetRateTracker();
    tracker.update("a", at("2026-01-01T00:00:00Z", 0, 0));
    tracker.update("b", at("2026-01-01T00:00:00Z", 0, 0));
    tracker.forget("a");
    expect(tracker.update("a", at("2026-01-01T00:00:30Z", 3000, 0))).toBeNull();
    expect(tracker.update("b", at("2026-01-01T00:00:30Z", 3000, 0))).toEqual({ rxBytesPerSec: 100, txBytesPerSec: 0 });
  });

  it("drops servers that are no longer listed", () => {
    const tracker = new NetRateTracker();
    tracker.update("a", at("2026-01-01T00:00:00Z", 0, 0));
    tracker.retainOnly(new Set(["b"]));
    expect(tracker.update("a", at("2026-01-01T00:00:30Z", 3000, 0))).toBeNull();
  });
});
