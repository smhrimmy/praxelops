import { z } from "zod";
import { getDb, prepare, withTransaction } from "@/lib/db/database";
import { DEFAULT_RETENTION_HOURS } from "./config";
import {
  HEALTH_STATES,
  MetricsSampleSchema,
  SAMPLE_FAILURE_REASONS,
  healthStateForFailure,
  type HealthState,
  type MetricsSample,
  type SampleFailureReason,
  type SampleOutcome,
} from "./types";

/**
 * SQLite persistence for metrics_samples and server_health (migration 3). Everything read back is validated, so a
 * tampered row can never turn into a number shown to an operator or fed to the AI diagnostics.
 */

const MAX_REASON_CHARS = 500;

export interface HealthRecord {
  serverId: string;
  lastCheckedAt: string;
  lastOkAt: string | null;
  state: HealthState;
  reason: string | null;
}

export interface StoredSample {
  id: number;
  serverId: string;
  collectedAt: string;
  ok: boolean;
  failureReason: SampleFailureReason | null;
  /** Present for ok samples whose stored JSON still validates. */
  sample?: MetricsSample;
  /** Present for failed samples. */
  message?: string;
}

export interface RecordResult {
  previousState: HealthState | null;
  state: HealthState;
}

const HealthRowSchema = z.object({
  server_id: z.string(),
  last_checked_at: z.string(),
  last_ok_at: z.string().nullable(),
  state: z.enum(HEALTH_STATES),
  reason: z.string().nullable(),
});

const SampleRowSchema = z.object({
  id: z.number(),
  server_id: z.string(),
  collected_at: z.string(),
  ok: z.number(),
  reason: z.string().nullable(),
  data: z.string().nullable(),
});

const FailureDataSchema = z.object({ message: z.string() }).passthrough();
const FailureReasonSchema = z.enum(SAMPLE_FAILURE_REASONS);

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

function rowToHealth(row: unknown): HealthRecord | undefined {
  const parsed = HealthRowSchema.safeParse(row);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  return { serverId: r.server_id, lastCheckedAt: r.last_checked_at, lastOkAt: r.last_ok_at, state: r.state, reason: r.reason };
}

function rowToSample(row: unknown): StoredSample | undefined {
  const parsed = SampleRowSchema.safeParse(row);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const base = { id: r.id, serverId: r.server_id, collectedAt: r.collected_at };
  if (r.ok === 1) {
    if (r.data === null) return { ...base, ok: true, failureReason: null };
    try {
      const sample = MetricsSampleSchema.safeParse(JSON.parse(r.data));
      return sample.success ? { ...base, ok: true, failureReason: null, sample: sample.data } : { ...base, ok: true, failureReason: null };
    } catch {
      return { ...base, ok: true, failureReason: null };
    }
  }
  const reason = FailureReasonSchema.safeParse(r.reason);
  let message: string | undefined;
  if (r.data !== null) {
    try {
      const data = FailureDataSchema.safeParse(JSON.parse(r.data));
      if (data.success) message = data.data.message;
    } catch {
      // keep message undefined
    }
  }
  return { ...base, ok: false, failureReason: reason.success ? reason.data : null, message };
}

/**
 * Stores one sampling result and updates the host's health row, atomically. Also prunes samples older than the
 * retention window. `onTransition` runs inside the same transaction (so an audit event commits with the state change)
 * and is only called when the health state actually changed (or on the very first observation).
 */
export function recordSampleResult(
  serverId: string,
  outcome: SampleOutcome,
  options: { retentionHours?: number; onTransition?: (result: RecordResult) => void } = {}
): RecordResult {
  const retentionHours = options.retentionHours ?? DEFAULT_RETENTION_HOURS;
  return withTransaction((db) => {
    if (outcome.ok) {
      const inserted = prepare(db, "INSERT INTO metrics_samples (server_id, collected_at, ok, reason, data) VALUES (?, ?, 1, NULL, ?)").run(
        serverId,
        outcome.collectedAt,
        JSON.stringify(outcome.sample)
      );
      // Only the LATEST sample of a server keeps the (bulky) process and service lists: drop them from older rows.
      stripBulkyFields(db, serverId, Number(inserted.lastInsertRowid));
    } else {
      prepare(db, "INSERT INTO metrics_samples (server_id, collected_at, ok, reason, data) VALUES (?, ?, 0, ?, ?)").run(
        serverId,
        outcome.collectedAt,
        outcome.reason,
        JSON.stringify({ message: truncate(outcome.message, MAX_REASON_CHARS) })
      );
    }

    const previousRow = prepare(
      db,
      "SELECT server_id, last_checked_at, last_ok_at, state, reason FROM server_health WHERE server_id = ?"
    ).get(serverId);
    const previous = previousRow === undefined ? undefined : rowToHealth(previousRow);

    const state: HealthState = outcome.ok ? "reachable" : healthStateForFailure(outcome.reason);
    const lastOkAt = outcome.ok ? outcome.collectedAt : (previous?.lastOkAt ?? null);
    const reason = outcome.ok ? null : truncate(outcome.message, MAX_REASON_CHARS);
    prepare(
      db,
      "INSERT INTO server_health (server_id, last_checked_at, last_ok_at, state, reason) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(server_id) DO UPDATE SET last_checked_at = excluded.last_checked_at, " +
        "last_ok_at = excluded.last_ok_at, state = excluded.state, reason = excluded.reason"
    ).run(serverId, outcome.collectedAt, lastOkAt, state, reason);

    pruneSamples(retentionHours);

    const result: RecordResult = { previousState: previous?.state ?? null, state };
    if (result.previousState !== result.state) options.onTransition?.(result);
    return result;
  });
}

/**
 * Removes the processes / services keys from the sample that was the server's newest successful one before
 * `keepId` was inserted, so the database holds one full process + service listing per server (the latest). Each
 * insert strips exactly its predecessor, so the cost stays O(log n) per insert instead of rescanning the history.
 */
function stripBulkyFields(db: ReturnType<typeof getDb>, serverId: string, keepId: number): void {
  prepare(
    db,
    "UPDATE metrics_samples SET data = json_remove(data, '$.processes', '$.services') " +
      "WHERE id = (SELECT MAX(id) FROM metrics_samples WHERE server_id = ? AND ok = 1 AND id < ?) AND data IS NOT NULL"
  ).run(serverId, keepId);
}

/** Deletes raw samples older than the retention window. Returns the number of rows removed. */
export function pruneSamples(retentionHours: number = DEFAULT_RETENTION_HOURS, nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs - retentionHours * 3600 * 1000).toISOString();
  const result = prepare(getDb(), "DELETE FROM metrics_samples WHERE collected_at < ?").run(cutoff);
  return Number(result.changes);
}

export function getHealth(serverId: string): HealthRecord | undefined {
  const row = prepare(
    getDb(),
    "SELECT server_id, last_checked_at, last_ok_at, state, reason FROM server_health WHERE server_id = ?"
  ).get(serverId);
  return row === undefined ? undefined : rowToHealth(row);
}

export function getAllHealth(): Map<string, HealthRecord> {
  const rows = prepare(getDb(), "SELECT server_id, last_checked_at, last_ok_at, state, reason FROM server_health").all();
  const map = new Map<string, HealthRecord>();
  for (const row of rows) {
    const health = rowToHealth(row);
    if (health) map.set(health.serverId, health);
  }
  return map;
}

/** The newest sample row (ok or failed) for a server, or undefined if it was never sampled. */
export function getLatestSample(serverId: string): StoredSample | undefined {
  const row = prepare(
    getDb(),
    "SELECT id, server_id, collected_at, ok, reason, data FROM metrics_samples WHERE server_id = ? " +
      "ORDER BY collected_at DESC, id DESC LIMIT 1"
  ).get(serverId);
  return row === undefined ? undefined : rowToSample(row);
}

/** Successful samples collected at or after `sinceIso`, oldest first. */
export function getOkSamplesSince(serverId: string, sinceIso: string): Array<{ collectedAt: string; sample: MetricsSample }> {
  const rows = prepare(
    getDb(),
    "SELECT id, server_id, collected_at, ok, reason, data FROM metrics_samples " +
      "WHERE server_id = ? AND ok = 1 AND collected_at >= ? ORDER BY collected_at ASC, id ASC"
  ).all(serverId, sinceIso);
  const out: Array<{ collectedAt: string; sample: MetricsSample }> = [];
  for (const row of rows) {
    const stored = rowToSample(row);
    if (stored?.sample) out.push({ collectedAt: stored.collectedAt, sample: stored.sample });
  }
  return out;
}

export function countSamples(serverId: string): number {
  const row = prepare(getDb(), "SELECT COUNT(*) AS n FROM metrics_samples WHERE server_id = ?").get(serverId);
  return Number(row?.n ?? 0);
}

/** The newest SUCCESSFUL sample (with processes/services, which only the latest row keeps), or undefined. */
export function getLatestOkSample(serverId: string): StoredSample | undefined {
  const rows = prepare(
    getDb(),
    "SELECT id, server_id, collected_at, ok, reason, data FROM metrics_samples WHERE server_id = ? AND ok = 1 " +
      "ORDER BY collected_at DESC, id DESC LIMIT 5"
  ).all(serverId);
  for (const row of rows) {
    const stored = rowToSample(row);
    if (stored?.sample) return stored;
  }
  return undefined;
}
