import type { SystemMetrics } from "@/types/server";
import type { HealthState } from "@/lib/metrics/types";
import type { FleetServer } from "./types";
import { formatAge } from "./format";

/**
 * Client-side interpretation of the server health data. Nothing here invents a value: where there is no data the
 * result says so, and says why.
 */

/** A host that has no `health` row at all. */
export type DisplayState = HealthState | "never_checked";

/** alert = security-relevant (host key mismatch), bad = failing, warn = needs operator action, muted = no data. */
export type Tone = "ok" | "warn" | "bad" | "alert" | "muted";
/** Shape is a second, colour-independent cue: dot = healthy, ring = no data / action needed, diamond = failing. */
export type DotShape = "dot" | "ring" | "diamond";

export interface StateInfo {
  label: string;
  tone: Tone;
  shape: DotShape;
  /** One sentence explaining what the state means. */
  description: string;
}

const STATE_INFO: Record<DisplayState, StateInfo> = {
  reachable: { label: "Reachable", tone: "ok", shape: "dot", description: "The last check connected and collected metrics." },
  unreachable: {
    label: "Unreachable",
    tone: "bad",
    shape: "diamond",
    description: "The host could not be reached over SSH (connection refused or timed out).",
  },
  auth_failed: {
    label: "Auth failed",
    tone: "bad",
    shape: "diamond",
    description: "The host was reached but the SSH credentials were rejected.",
  },
  host_key_mismatch: {
    label: "Host key mismatch",
    tone: "alert",
    shape: "diamond",
    description:
      "The host presented a different SSH key than the one pinned. This can indicate a man-in-the-middle attack or a re-installed host.",
  },
  host_key_not_pinned: {
    label: "Host key not pinned",
    tone: "warn",
    shape: "ring",
    description:
      "The SSH host key has not been verified yet. Open a terminal once to verify and pin it; metrics are not collected before that.",
  },
  unsupported_os: {
    label: "Unsupported OS",
    tone: "warn",
    shape: "ring",
    description: "The metrics probe only supports Linux hosts.",
  },
  error: {
    label: "Check error",
    tone: "bad",
    shape: "diamond",
    description: "The last check failed for a reason on the collector side (parse or credential error).",
  },
  never_checked: {
    label: "Never checked",
    tone: "muted",
    shape: "ring",
    description: "No health check has been recorded for this host yet.",
  },
};

export function stateInfo(state: DisplayState): StateInfo {
  return STATE_INFO[state];
}

/** Lower = more urgent. Used to sort worst-first and to pick the top-level fleet state. */
export function stateSeverity(state: DisplayState): number {
  switch (state) {
    case "host_key_mismatch":
      return 0;
    case "auth_failed":
      return 1;
    case "unreachable":
      return 2;
    case "error":
      return 3;
    case "host_key_not_pinned":
      return 4;
    case "unsupported_os":
      return 5;
    case "never_checked":
      return 6;
    case "reachable":
      return 7;
  }
}

export const ASSUMED_INTERVAL_SECONDS = 30;
export const FRESHNESS_INTERVALS = 3;
/**
 * The collector's failing-host backoff cap (10 minutes) plus one interval: a failing host is legitimately not checked
 * more often than this, so it is not evidence that the collector stopped.
 */
export const FAILING_HOST_CHECK_WINDOW_SECONDS = 10 * 60 + ASSUMED_INTERVAL_SECONDS;

/** Seconds after which a sample counts as stale (> 3x the collection interval). */
export function staleThresholdSeconds(intervalSeconds: number = ASSUMED_INTERVAL_SECONDS): number {
  return intervalSeconds * FRESHNESS_INTERVALS;
}

/** True when there IS a sample but it is older than 3x the interval. A missing sample (null) is not "stale", it is absent. */
export function isStale(ageSeconds: number | null, intervalSeconds: number = ASSUMED_INTERVAL_SECONDS): boolean {
  return ageSeconds !== null && ageSeconds > staleThresholdSeconds(intervalSeconds);
}

/** Age that keeps growing between polls: the age reported at fetch time plus the time elapsed since the fetch. */
export function liveAgeSeconds(reportedAgeSeconds: number | null, fetchedAtMs: number, nowMs: number): number | null {
  if (reportedAgeSeconds === null) return null;
  return reportedAgeSeconds + Math.max(0, Math.floor((nowMs - fetchedAtMs) / 1000));
}

export interface ServerStatusView {
  state: DisplayState;
  info: StateInfo;
  /** Raw failure reason from the collector, if any. */
  reason?: string;
  /** Age of the newest successful sample; null when the host never produced one. */
  sampleAgeSeconds: number | null;
  /** Age of the last check attempt (successful or not); null when never checked. */
  checkedAgeSeconds: number | null;
  /** True when a successful sample exists but is older than 3x the interval. */
  stale: boolean;
  /** Metrics are shown only when the API returned them (fresh) and they have not aged out since. */
  metrics: SystemMetrics | undefined;
  /** True when metrics are present but the check state is a failure: the numbers are the last good sample. */
  lastKnown: boolean;
  /** Plain-language note about the data, empty when the numbers are current and healthy. */
  note: string;
}

/** Derives everything a card/row needs from one server entry. `fetchedAtMs` is when the listing was received. */
export function deriveServerStatus(server: FleetServer, fetchedAtMs: number, nowMs: number): ServerStatusView {
  const health = server.health;
  const state: DisplayState = health ? health.state : "never_checked";
  const info = stateInfo(state);
  const sampleAgeSeconds = health ? liveAgeSeconds(health.sampleAgeSeconds, fetchedAtMs, nowMs) : null;
  const lastChecked = health ? Date.parse(health.lastCheckedAt) : NaN;
  const checkedAgeSeconds = Number.isFinite(lastChecked) ? Math.max(0, Math.floor((nowMs - lastChecked) / 1000)) : null;
  const stale = isStale(sampleAgeSeconds);
  const metrics = server.metrics && !stale ? server.metrics : undefined;
  const lastKnown = metrics !== undefined && state !== "reachable";

  let note = "";
  if (state === "never_checked") {
    note = "Not checked yet. The collector has not recorded a check for this host.";
  } else if (state === "reachable") {
    if (metrics === undefined) {
      note =
        sampleAgeSeconds === null
          ? "Reachable, but no successful sample has been stored yet."
          : `Stale: the last sample is ${formatAge(sampleAgeSeconds)}, older than 3x the collection interval. Numbers are hidden rather than shown as current.`;
    }
  } else {
    note = health?.reason ? `${info.description} (${health.reason})` : info.description;
    if (metrics !== undefined) note += ` Showing the last good sample from ${formatAge(sampleAgeSeconds)}.`;
    else if (sampleAgeSeconds !== null) note += ` Last good sample was ${formatAge(sampleAgeSeconds)}; it is too old to show.`;
    else note += " No successful sample has ever been collected.";
  }

  return { state, info, reason: health?.reason, sampleAgeSeconds, checkedAgeSeconds, stale, metrics, lastKnown, note };
}

/**
 * The collector looks stopped when no host has been checked recently. A reachable (or unchecked) host is checked every
 * interval, so its check is overdue after 3x the interval; a failing host backs off up to 10 minutes, so it only
 * counts as overdue after that. Requires at least one host.
 */
export function collectorLooksStopped(
  servers: readonly FleetServer[],
  nowMs: number,
  intervalSeconds: number = ASSUMED_INTERVAL_SECONDS
): boolean {
  if (servers.length === 0) return false;
  return servers.every((server) => {
    const health = server.health;
    if (!health) return true;
    const checkedMs = Date.parse(health.lastCheckedAt);
    if (!Number.isFinite(checkedMs)) return true;
    const age = Math.max(0, (nowMs - checkedMs) / 1000);
    const window = health.state === "reachable" ? staleThresholdSeconds(intervalSeconds) : FAILING_HOST_CHECK_WINDOW_SECONDS;
    return age > window;
  });
}

export interface FleetSummary {
  total: number;
  reachable: number;
  attention: number;
  neverChecked: number;
  /** The most urgent state present, or null for an empty fleet. */
  worst: DisplayState | null;
}

export function summarizeFleet(servers: readonly FleetServer[]): FleetSummary {
  let reachable = 0;
  let attention = 0;
  let neverChecked = 0;
  let worst: DisplayState | null = null;
  for (const server of servers) {
    const state: DisplayState = server.health ? server.health.state : "never_checked";
    if (state === "reachable") reachable += 1;
    else if (state === "never_checked") neverChecked += 1;
    else attention += 1;
    if (worst === null || stateSeverity(state) < stateSeverity(worst)) worst = state;
  }
  return { total: servers.length, reachable, attention, neverChecked, worst };
}

/** Tailwind token classes per tone (literal strings so Tailwind generates them). */
export const TONE_CLASSES: Record<Tone, { text: string; bg: string; badge: string; solid: string; border: string }> = {
  ok: {
    text: "text-success",
    bg: "bg-success/10",
    badge: "bg-success/10 text-success border-success/30",
    solid: "bg-success",
    border: "border-success",
  },
  warn: {
    text: "text-warning",
    bg: "bg-warning/10",
    badge: "bg-warning/10 text-warning border-warning/30",
    solid: "bg-warning",
    border: "border-warning",
  },
  bad: {
    text: "text-danger",
    bg: "bg-danger/10",
    badge: "bg-danger/10 text-danger border-danger/30",
    solid: "bg-danger",
    border: "border-danger",
  },
  alert: {
    text: "text-danger",
    bg: "bg-danger/15",
    badge: "bg-danger/15 text-danger border-danger font-semibold",
    solid: "bg-danger",
    border: "border-danger",
  },
  muted: {
    text: "text-fg-muted",
    bg: "bg-sunken",
    badge: "bg-sunken text-fg-2 border-line-strong",
    solid: "bg-fg-muted",
    border: "border-fg-muted",
  },
};

/** Tone for a utilisation percentage (the number is always printed next to the meter). */
export function meterTone(percent: number): "ok" | "warn" | "bad" {
  if (percent >= 90) return "bad";
  if (percent >= 75) return "warn";
  return "ok";
}
