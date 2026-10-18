import { describe, it, expect } from "vitest";
import {
  NO_VALUE,
  ageSecondsFromIso,
  formatAge,
  formatBytes,
  formatDuration,
  formatKb,
  formatLoad,
  formatPercent,
  formatRate,
} from "./format";

describe("formatBytes / formatKb / formatRate", () => {
  it("uses binary units and trims trailing zeros", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 * 1024 * 3.25)).toBe("3.3 MiB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5 GiB");
  });

  it("drops decimals for values of 100 and above", () => {
    expect(formatBytes(150 * 1024)).toBe("150 KiB");
  });

  it("never turns unknown into zero", () => {
    expect(formatBytes(null)).toBe(NO_VALUE);
    expect(formatBytes(undefined)).toBe(NO_VALUE);
    expect(formatBytes(Number.NaN)).toBe(NO_VALUE);
    expect(formatBytes(-1)).toBe(NO_VALUE);
    expect(formatKb(null)).toBe(NO_VALUE);
    expect(formatRate(null)).toBe(NO_VALUE);
  });

  it("converts KiB and renders rates", () => {
    expect(formatKb(2048)).toBe("2 MiB");
    expect(formatRate(1536)).toBe("1.5 KiB/s");
    expect(formatRate(0)).toBe("0 B/s");
  });
});

describe("formatPercent / formatLoad", () => {
  it("formats with fixed decimals and a placeholder for unknown", () => {
    expect(formatPercent(12.345)).toBe("12.3%");
    expect(formatPercent(7, 0)).toBe("7%");
    expect(formatPercent(null)).toBe(NO_VALUE);
    expect(formatLoad(0.5)).toBe("0.50");
    expect(formatLoad(undefined)).toBe(NO_VALUE);
  });
});

describe("formatDuration", () => {
  it("keeps the two largest units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3725)).toBe("1h 2m");
    expect(formatDuration(200000)).toBe("2d 7h");
  });

  it("rejects negatives and unknowns", () => {
    expect(formatDuration(-5)).toBe(NO_VALUE);
    expect(formatDuration(null)).toBe(NO_VALUE);
  });
});

describe("formatAge / ageSecondsFromIso", () => {
  it("renders compact ages", () => {
    expect(formatAge(0)).toBe("0s ago");
    expect(formatAge(12)).toBe("12s ago");
    expect(formatAge(59.9)).toBe("59s ago");
    expect(formatAge(60)).toBe("1m ago");
    expect(formatAge(3 * 60 + 40)).toBe("3m ago");
    expect(formatAge(2 * 3600 + 5 * 60)).toBe("2h 5m ago");
    expect(formatAge(3 * 3600)).toBe("3h ago");
    expect(formatAge(27 * 3600)).toBe("1d 3h ago");
    expect(formatAge(48 * 3600)).toBe("2d ago");
  });

  it("returns a placeholder when there is no age", () => {
    expect(formatAge(null)).toBe(NO_VALUE);
    expect(formatAge(-1)).toBe(NO_VALUE);
  });

  it("computes the age of an ISO timestamp, clamped at zero", () => {
    const now = Date.parse("2026-01-01T00:01:00.000Z");
    expect(ageSecondsFromIso("2026-01-01T00:00:00.000Z", now)).toBe(60);
    expect(ageSecondsFromIso("2026-01-01T00:05:00.000Z", now)).toBe(0);
    expect(ageSecondsFromIso(null, now)).toBeNull();
    expect(ageSecondsFromIso("not a date", now)).toBeNull();
  });
});
