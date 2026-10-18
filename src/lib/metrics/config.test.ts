import { describe, expect, it } from "vitest";
import { getConcurrency, getFreshnessWindowMs, getIntervalSeconds, getRetentionHours } from "./config";

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as unknown as NodeJS.ProcessEnv;

describe("metrics configuration", () => {
  it("uses the documented defaults", () => {
    expect(getIntervalSeconds(env({}))).toBe(30);
    expect(getConcurrency(env({}))).toBe(4);
    expect(getRetentionHours(env({}))).toBe(24);
    expect(getFreshnessWindowMs(env({}))).toBe(90_000);
  });

  it("enforces the 10 second minimum interval and ignores junk", () => {
    expect(getIntervalSeconds(env({ METRICS_INTERVAL_SECONDS: "5" }))).toBe(10);
    expect(getIntervalSeconds(env({ METRICS_INTERVAL_SECONDS: "10" }))).toBe(10);
    expect(getIntervalSeconds(env({ METRICS_INTERVAL_SECONDS: "45" }))).toBe(45);
    expect(getIntervalSeconds(env({ METRICS_INTERVAL_SECONDS: "abc" }))).toBe(30);
    expect(getIntervalSeconds(env({ METRICS_INTERVAL_SECONDS: "-4" }))).toBe(30);
    expect(getIntervalSeconds(env({ METRICS_INTERVAL_SECONDS: "" }))).toBe(30);
  });

  it("reads concurrency and retention, clamped to sane bounds", () => {
    expect(getConcurrency(env({ METRICS_CONCURRENCY: "8" }))).toBe(8);
    expect(getConcurrency(env({ METRICS_CONCURRENCY: "0" }))).toBe(1);
    expect(getConcurrency(env({ METRICS_CONCURRENCY: "100000" }))).toBe(64);
    expect(getRetentionHours(env({ METRICS_RETENTION_HOURS: "48" }))).toBe(48);
    expect(getRetentionHours(env({ METRICS_RETENTION_HOURS: "0" }))).toBe(1);
  });

  it("a sample is fresh for three intervals", () => {
    expect(getFreshnessWindowMs(env({ METRICS_INTERVAL_SECONDS: "10" }))).toBe(30_000);
    expect(getFreshnessWindowMs(env({ METRICS_INTERVAL_SECONDS: "60" }))).toBe(180_000);
  });
});
