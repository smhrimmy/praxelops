/**
 * PraxelOps metrics collector process (`npm run collector`).
 *
 * Every METRICS_INTERVAL_SECONDS (default 30, minimum 10, +/-10% jitter) it samples each inventory server over SSH
 * with the fixed read-only probe, at most METRICS_CONCURRENCY (default 4) at a time, and stores the result in the
 * shared SQLite database (the web app reads it from there). Hosts that keep failing are retried with exponential
 * backoff (capped at 10 minutes). Samples older than METRICS_RETENTION_HOURS (default 24) are pruned each cycle.
 *
 * It only ever contacts hosts whose SSH host key is already pinned (see src/lib/metrics/collector.ts) and logs one
 * line per cycle with counts only - never credentials.
 */
import { collectAndStoreShared, ServerNotFoundError } from "@/lib/metrics/collector";
import { getConcurrency, getIntervalSeconds, getRetentionHours } from "@/lib/metrics/config";
import { MetricsRunner, type CollectSummary } from "@/lib/metrics/runner";
import { pruneSamples } from "@/lib/metrics/store";
import { closeDb } from "@/lib/db/database";
import { StorageService } from "@/lib/storage";

const SHUTDOWN_GRACE_MS = 20_000;

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function collectOne(serverId: string): Promise<CollectSummary> {
  try {
    const { outcome } = await collectAndStoreShared(serverId);
    return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
  } catch (err) {
    if (!(err instanceof ServerNotFoundError)) {
      log(`[metrics-collector] server check failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: false };
  }
}

async function main(): Promise<void> {
  const intervalSeconds = getIntervalSeconds();
  const concurrency = getConcurrency();
  const retentionHours = getRetentionHours();
  log(`[metrics-collector] starting interval=${intervalSeconds}s concurrency=${concurrency} retention=${retentionHours}h`);

  const runner = new MetricsRunner(
    { intervalMs: intervalSeconds * 1000, concurrency },
    {
      listServerIds: () => StorageService.getPublicServers().map((s) => s.id),
      collect: collectOne,
      afterCycle: () => {
        pruneSamples(retentionHours);
      },
      log,
      now: () => Date.now(),
      random: () => Math.random(),
      sleep: abortableSleep,
    }
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[metrics-collector] received ${signal}, finishing in-flight checks`);
    const force = setTimeout(() => {
      log("[metrics-collector] shutdown grace period exceeded, exiting");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    void runner.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await runner.start();
  closeDb();
  log("[metrics-collector] stopped");
}

// Run only when executed directly (never when imported, e.g. by a test).
if (process.argv[1] && /metricsCollector\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(`[metrics-collector] fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  );
}
