import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BACKOFF_MS } from "./config";
import { BackoffTracker, MetricsRunner, backoffDelayMs, cycleDelayMs, failureCountsForBackoff, type CollectSummary } from "./runner";

describe("backoffDelayMs", () => {
  it("is the plain interval while healthy and doubles per consecutive failure up to the 10 minute cap", () => {
    const interval = 30_000;
    expect(backoffDelayMs(0, interval)).toBe(30_000);
    expect(backoffDelayMs(1, interval)).toBe(60_000);
    expect(backoffDelayMs(2, interval)).toBe(120_000);
    expect(backoffDelayMs(3, interval)).toBe(240_000);
    expect(backoffDelayMs(4, interval)).toBe(480_000);
    expect(backoffDelayMs(5, interval)).toBe(MAX_BACKOFF_MS);
    expect(backoffDelayMs(50, interval)).toBe(MAX_BACKOFF_MS);
    expect(MAX_BACKOFF_MS).toBe(600_000);
  });

  it("never goes below the interval, even when the interval exceeds the cap", () => {
    expect(backoffDelayMs(1, 900_000)).toBe(900_000);
  });
});

describe("cycleDelayMs", () => {
  it("applies +/-10% jitter around the interval and never less than one second", () => {
    expect(cycleDelayMs(30_000, () => 0)).toBe(27_000);
    expect(cycleDelayMs(30_000, () => 0.5)).toBe(30_000);
    expect(cycleDelayMs(30_000, () => 1)).toBe(33_000);
    expect(cycleDelayMs(500, () => 0)).toBe(1000);
  });
});

describe("failureCountsForBackoff", () => {
  it("does not escalate backoff for failures that cost nothing remotely", () => {
    expect(failureCountsForBackoff("host_key_not_pinned")).toBe(false);
    expect(failureCountsForBackoff("credential_error")).toBe(false);
    expect(failureCountsForBackoff("unreachable")).toBe(true);
    expect(failureCountsForBackoff("timeout")).toBe(true);
    expect(failureCountsForBackoff("host_key_mismatch")).toBe(true);
  });
});

describe("BackoffTracker", () => {
  it("makes a failing host due only after its backoff, and resets on success", () => {
    const tracker = new BackoffTracker(30_000);
    expect(tracker.isDue("a", 0)).toBe(true);
    expect(tracker.record("a", false, 0)).toBe(60_000);
    expect(tracker.isDue("a", 59_999)).toBe(false);
    expect(tracker.isDue("a", 60_000)).toBe(true);
    expect(tracker.record("a", false, 60_000)).toBe(120_000);
    expect(tracker.consecutiveFailures("a")).toBe(2);
    expect(tracker.record("a", true, 180_000)).toBe(0);
    expect(tracker.consecutiveFailures("a")).toBe(0);
    expect(tracker.isDue("a", 180_000)).toBe(true);
  });

  it("forgets removed hosts", () => {
    const tracker = new BackoffTracker(30_000);
    tracker.record("gone", false, 0);
    tracker.retain(new Set(["other"]));
    expect(tracker.consecutiveFailures("gone")).toBe(0);
    expect(tracker.isDue("gone", 0)).toBe(true);
  });
});

describe("MetricsRunner with fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRunner(options: {
    ids: () => string[];
    collect: (id: string) => Promise<CollectSummary>;
    concurrency?: number;
    intervalMs?: number;
  }) {
    const lines: string[] = [];
    const runner = new MetricsRunner(
      { intervalMs: options.intervalMs ?? 30_000, concurrency: options.concurrency ?? 4 },
      {
        listServerIds: options.ids,
        collect: options.collect,
        log: (line) => lines.push(line),
        now: () => Date.now(),
        random: () => 0.5,
        sleep: (ms, signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            const timer = setTimeout(resolve, ms);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          }),
      }
    );
    return { runner, lines };
  }

  it("skips a backing-off host until its delay has elapsed (exponential, per host)", async () => {
    const calls: string[] = [];
    const { runner } = makeRunner({
      ids: () => ["good", "bad"],
      collect: async (id) => {
        calls.push(id);
        return id === "good" ? { ok: true } : { ok: false, reason: "unreachable" };
      },
    });

    await runner.runCycle(); // t=0: both checked; bad now waits 60s
    expect(calls).toEqual(["good", "bad"]);

    vi.setSystemTime(Date.now() + 30_000);
    await runner.runCycle(); // t=30s: bad still backing off
    expect(calls).toEqual(["good", "bad", "good"]);

    vi.setSystemTime(Date.now() + 30_000);
    await runner.runCycle(); // t=60s: bad due again, then waits 120s
    expect(calls).toEqual(["good", "bad", "good", "good", "bad"]);

    vi.setSystemTime(Date.now() + 60_000);
    await runner.runCycle(); // t=120s: bad still waiting (due at 180s)
    expect(calls.filter((c) => c === "bad")).toHaveLength(2);

    vi.setSystemTime(Date.now() + 60_000);
    await runner.runCycle(); // t=180s
    expect(calls.filter((c) => c === "bad")).toHaveLength(3);
  });

  it("does not back off hosts that only fail with host_key_not_pinned", async () => {
    let calls = 0;
    const { runner } = makeRunner({
      ids: () => ["unpinned"],
      collect: async () => {
        calls += 1;
        return { ok: false, reason: "host_key_not_pinned" };
      },
    });
    await runner.runCycle();
    vi.setSystemTime(Date.now() + 30_000);
    await runner.runCycle();
    expect(calls).toBe(2);
  });

  it("caps the number of concurrent probes at the configured concurrency", async () => {
    let active = 0;
    let peak = 0;
    const { runner } = makeRunner({
      ids: () => Array.from({ length: 10 }, (_, i) => `s${i}`),
      concurrency: 3,
      collect: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 1000));
        active -= 1;
        return { ok: true };
      },
    });
    const cycle = runner.runCycle();
    await vi.advanceTimersByTimeAsync(10_000);
    const stats = await cycle;
    expect(peak).toBe(3);
    expect(stats.checked).toBe(10);
    expect(stats.ok).toBe(10);
  });

  it("logs exactly one line per cycle, with counts only", async () => {
    const { runner, lines } = makeRunner({
      ids: () => ["a", "b"],
      collect: async (id) => (id === "a" ? { ok: true } : { ok: false, reason: "auth_failed" }),
    });
    await runner.runCycle();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/cycle=1 servers=2 checked=2 ok=1 failed=1 backing_off=0/);
    await runner.runCycle(); // b is backing off now
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/cycle=2 servers=2 checked=1 ok=1 failed=0 backing_off=1/);
  });

  it("treats a thrown collect() as a failure and keeps going", async () => {
    const { runner } = makeRunner({
      ids: () => ["boom", "fine"],
      collect: async (id) => {
        if (id === "boom") throw new Error("unexpected");
        return { ok: true };
      },
    });
    const stats = await runner.runCycle();
    expect(stats).toMatchObject({ checked: 2, ok: 1, failed: 1 });
  });

  it("runs cycles on the (jittered) interval and stops gracefully, waiting for in-flight work", async () => {
    let cycles = 0;
    let finishProbe: (() => void) | undefined;
    const { runner, lines } = makeRunner({
      ids: () => ["a"],
      collect: async () => {
        cycles += 1;
        if (cycles === 3) await new Promise<void>((resolve) => (finishProbe = resolve));
        return { ok: true };
      },
    });
    const done = runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(cycles).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(cycles).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cycles).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cycles).toBe(3); // probe 3 is in flight

    let stopped = false;
    const stopping = runner.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(false); // waits for the in-flight probe
    finishProbe?.();
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    await done;
    expect(stopped).toBe(true);
    expect(runner.stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(cycles).toBe(3); // no further cycles after stop
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("stops promptly while sleeping between cycles", async () => {
    const { runner } = makeRunner({ ids: () => [], collect: async () => ({ ok: true }) });
    const done = runner.start();
    await vi.advanceTimersByTimeAsync(0);
    await runner.stop();
    await done;
    expect(runner.stopped).toBe(true);
  });
});
