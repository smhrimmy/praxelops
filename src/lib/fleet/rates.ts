/**
 * GET /api/servers returns cumulative network counters, not rates. A rate is only real when it is derived from two
 * different samples of the same host; this tracker does that and otherwise reports "unknown" (null).
 */

export interface CounterSample {
  /** Timestamp of the sample the counters came from (SystemMetrics.reportedAt). */
  reportedAt: string;
  rxBytes: number;
  txBytes: number;
}

export interface NetRate {
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

/** A gap longer than this means the host was not being sampled; the delta is not a meaningful rate. */
export const MAX_RATE_GAP_MS = 15 * 60 * 1000;

/** Rate between two samples; null for identical/backwards timestamps, long gaps or counter resets. */
export function computeNetRate(prev: CounterSample, cur: CounterSample, maxGapMs: number = MAX_RATE_GAP_MS): NetRate | null {
  const dtMs = Date.parse(cur.reportedAt) - Date.parse(prev.reportedAt);
  if (!Number.isFinite(dtMs) || dtMs <= 0 || dtMs > maxGapMs) return null;
  if (cur.rxBytes < prev.rxBytes || cur.txBytes < prev.txBytes) return null;
  return {
    rxBytesPerSec: ((cur.rxBytes - prev.rxBytes) * 1000) / dtMs,
    txBytesPerSec: ((cur.txBytes - prev.txBytes) * 1000) / dtMs,
  };
}

interface Entry {
  last: CounterSample;
  rate: NetRate | null;
}

/** Remembers the previous counters per server. Polling the same sample twice keeps the previously computed rate. */
export class NetRateTracker {
  private readonly entries = new Map<string, Entry>();

  update(serverId: string, sample: CounterSample): NetRate | null {
    const entry = this.entries.get(serverId);
    if (!entry) {
      this.entries.set(serverId, { last: sample, rate: null });
      return null;
    }
    if (entry.last.reportedAt === sample.reportedAt) return entry.rate;
    const rate = computeNetRate(entry.last, sample);
    this.entries.set(serverId, { last: sample, rate });
    return rate;
  }

  /** Drops a server whose sample disappeared (stale / removed) so a later sample does not span the gap. */
  forget(serverId: string): void {
    this.entries.delete(serverId);
  }

  retainOnly(serverIds: ReadonlySet<string>): void {
    for (const id of [...this.entries.keys()]) if (!serverIds.has(id)) this.entries.delete(id);
  }
}
