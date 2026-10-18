import { MAX_BACKOFF_MS } from "./config";
import type { SampleFailureReason } from "./types";

/**
 * Scheduling logic of the metrics collector process, written against injected time/randomness so it can be tested
 * deterministically with fake timers.
 */

/** Delay before a host is checked again: the interval while healthy, doubling per consecutive failure, capped. */
export function backoffDelayMs(consecutiveFailures: number, intervalMs: number, capMs: number = MAX_BACKOFF_MS): number {
  if (consecutiveFailures <= 0) return intervalMs;
  const delay = intervalMs * 2 ** Math.min(consecutiveFailures, 30);
  return Math.max(intervalMs, Math.min(capMs, delay));
}

/**
 * Failures that cost nothing on the remote side (no connection is attempted) must not escalate the backoff:
 * as soon as the operator pins the key or fixes the credential, the next cycle should notice.
 */
export function failureCountsForBackoff(reason: SampleFailureReason): boolean {
  return reason !== "host_key_not_pinned" && reason !== "credential_error";
}

/** Delay between cycle starts: the interval +/- `jitterFraction`, never below one second. */
export function cycleDelayMs(intervalMs: number, random: () => number, jitterFraction: number = 0.1): number {
  const factor = 1 + (random() * 2 - 1) * jitterFraction;
  return Math.max(1000, Math.round(intervalMs * factor));
}

export class BackoffTracker {
  private readonly failures = new Map<string, number>();
  private readonly nextDueAt = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly capMs: number = MAX_BACKOFF_MS
  ) {}

  isDue(id: string, now: number): boolean {
    const due = this.nextDueAt.get(id);
    return due === undefined || now >= due;
  }

  consecutiveFailures(id: string): number {
    return this.failures.get(id) ?? 0;
  }

  /** Records a finished check; returns the delay until the host is due again. */
  record(id: string, success: boolean, now: number, countsAsFailure: boolean = true): number {
    const previous = this.failures.get(id) ?? 0;
    const failures = success ? 0 : countsAsFailure ? previous + 1 : previous;
    this.failures.set(id, failures);
    // A healthy host (or a failure that cost nothing remotely) is due again on the next cycle; a failing one waits out its backoff.
    const delay = success || !countsAsFailure ? 0 : backoffDelayMs(failures, this.intervalMs, this.capMs);
    this.nextDueAt.set(id, now + delay);
    return delay;
  }

  /** Forgets hosts that no longer exist. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of [...this.failures.keys()]) {
      if (!ids.has(id)) {
        this.failures.delete(id);
        this.nextDueAt.delete(id);
      }
    }
  }
}

export interface CollectSummary {
  ok: boolean;
  reason?: SampleFailureReason;
}

export interface RunnerDeps {
  listServerIds: () => string[];
  collect: (serverId: string) => Promise<CollectSummary>;
  /** Called once at the end of every cycle (retention pruning). */
  afterCycle?: () => void;
  log: (line: string) => void;
  now: () => number;
  random: () => number;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface RunnerConfig {
  intervalMs: number;
  concurrency: number;
  backoffCapMs?: number;
}

export interface CycleStats {
  cycle: number;
  servers: number;
  checked: number;
  ok: number;
  failed: number;
  backingOff: number;
  durationMs: number;
}

export class MetricsRunner {
  private readonly backoff: BackoffTracker;
  private readonly abort = new AbortController();
  private cycleNumber = 0;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly config: RunnerConfig,
    private readonly deps: RunnerDeps
  ) {
    this.backoff = new BackoffTracker(config.intervalMs, config.backoffCapMs ?? MAX_BACKOFF_MS);
  }

  get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  /** Starts the loop (first cycle immediately). Resolves when stop() has been called and in-flight work finished. */
  start(): Promise<void> {
    if (!this.loop) this.loop = this.run();
    return this.loop;
  }

  /** Requests shutdown and waits for in-flight probes to finish. Idempotent. */
  async stop(): Promise<void> {
    this.abort.abort();
    if (this.loop) await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const startedAt = this.deps.now();
      try {
        await this.runCycle(startedAt);
      } catch (err) {
        this.deps.log(`[metrics-collector] cycle error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.stopped) break;
      const wait = cycleDelayMs(this.config.intervalMs, this.deps.random);
      const elapsed = this.deps.now() - startedAt;
      await this.deps.sleep(Math.max(0, wait - elapsed), this.abort.signal);
    }
  }

  /** One pass over the due servers with a bounded worker pool. Exposed for tests. */
  async runCycle(now: number = this.deps.now()): Promise<CycleStats> {
    this.cycleNumber += 1;
    const ids = this.deps.listServerIds();
    this.backoff.retain(new Set(ids));
    const due = ids.filter((id) => this.backoff.isDue(id, now));
    const queue = [...due];
    let ok = 0;
    let failed = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.stopped) return;
        const id = queue.shift();
        if (id === undefined) return;
        let summary: CollectSummary;
        try {
          summary = await this.deps.collect(id);
        } catch {
          summary = { ok: false };
        }
        if (summary.ok) ok += 1;
        else failed += 1;
        const counts = summary.ok || summary.reason === undefined ? true : failureCountsForBackoff(summary.reason);
        this.backoff.record(id, summary.ok, this.deps.now(), counts);
      }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(this.config.concurrency, due.length)) }, () => worker());
    if (due.length > 0) await Promise.all(workers);

    try {
      this.deps.afterCycle?.();
    } catch (err) {
      this.deps.log(`[metrics-collector] retention pruning failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const finishedAt = this.deps.now();
    const stats: CycleStats = {
      cycle: this.cycleNumber,
      servers: ids.length,
      checked: ok + failed,
      ok,
      failed,
      backingOff: ids.length - due.length,
      durationMs: finishedAt - now,
    };
    this.deps.log(
      `[metrics-collector] cycle=${stats.cycle} servers=${stats.servers} checked=${stats.checked} ok=${stats.ok} failed=${stats.failed} backing_off=${stats.backingOff} duration_ms=${stats.durationMs}`
    );
    return stats;
  }
}
