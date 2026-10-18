/**
 * Pure display formatters. Every function accepts null/undefined/NaN and returns the em dash placeholder rather than
 * a number: unknown is never rendered as zero.
 */

export const NO_VALUE = "—";

function isNum(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Binary (IEC) units: 1536 -> "1.5 KiB". */
export function formatBytes(bytes: number | null | undefined, maxDecimals = 1): string {
  if (!isNum(bytes) || bytes < 0) return NO_VALUE;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 ? 0 : value >= 100 ? 0 : maxDecimals;
  return `${trimZeros(value.toFixed(decimals))} ${BYTE_UNITS[unit]}`;
}

/** KiB (as /proc and ps report them) to a readable size. */
export function formatKb(kb: number | null | undefined, maxDecimals = 1): string {
  return isNum(kb) ? formatBytes(kb * 1024, maxDecimals) : NO_VALUE;
}

/** Bytes per second: 1536 -> "1.5 KiB/s". */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (!isNum(bytesPerSecond) || bytesPerSecond < 0) return NO_VALUE;
  return `${formatBytes(bytesPerSecond)}/s`;
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** Percent with fixed decimals: 12.345 -> "12.3%". */
export function formatPercent(value: number | null | undefined, decimals = 1): string {
  return isNum(value) ? `${value.toFixed(decimals)}%` : NO_VALUE;
}

/** Load average with two decimals. */
export function formatLoad(value: number | null | undefined): string {
  return isNum(value) ? value.toFixed(2) : NO_VALUE;
}

/**
 * Compact duration using the two largest non-zero units: 45 -> "45s", 3725 -> "1h 2m", 200000 -> "2d 7h".
 * Used for uptime and process elapsed time.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (!isNum(seconds) || seconds < 0) return NO_VALUE;
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** "12s ago", "3m ago", "2h 5m ago", "1d 3h ago"; null (no sample at all) -> placeholder. */
export function formatAge(seconds: number | null | undefined): string {
  if (!isNum(seconds) || seconds < 0) return NO_VALUE;
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s ago`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h ago` : `${hours}h ${rest}m ago`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d ago` : `${days}d ${restHours}h ago`;
}

/** Age of a timestamp relative to `nowMs`, in whole seconds; null when the timestamp is missing or unparsable. */
export function ageSecondsFromIso(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 1000));
}

/** HH:MM (24h, local) for chart axes and tooltips. */
export function formatClock(ms: number, withSeconds = false): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return withSeconds
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
