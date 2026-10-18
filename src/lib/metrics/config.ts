/**
 * Metrics settings read from the environment. The collector process and the web process should be started with the
 * same values (the web side only uses the interval to decide whether a sample is still fresh).
 */

export const DEFAULT_INTERVAL_SECONDS = 30;
export const MIN_INTERVAL_SECONDS = 10;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 64;
export const DEFAULT_RETENTION_HOURS = 24;
export const MAX_BACKOFF_MS = 10 * 60 * 1000;
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
/** A sample is fresh while it is at most this many intervals old. */
export const FRESHNESS_INTERVALS = 3;

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function getIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env, "METRICS_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, 86_400);
}

export function getConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env, "METRICS_CONCURRENCY", DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
}

export function getRetentionHours(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env, "METRICS_RETENTION_HOURS", DEFAULT_RETENTION_HOURS, 1, 24 * 365);
}

/** Maximum age (ms) of a sample for it to count as fresh. */
export function getFreshnessWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return getIntervalSeconds(env) * FRESHNESS_INTERVALS * 1000;
}
