import { describe, it, expect } from "vitest";
import { entryDescription, MAX_BAR_DOTS, orderEntries, overflowCount } from "./status";
import type { FleetServer } from "./types";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const iso = (ago: number) => new Date(NOW - ago * 1000).toISOString();

function srv(id: string, state?: "reachable" | "unreachable" | "host_key_mismatch", sampleAge: number | null = 5): FleetServer {
  return {
    id,
    name: `srv-${id}`,
    host: "h",
    port: 22,
    username: "u",
    authType: "password",
    tags: [],
    status: "checking",
    osType: "linux",
    createdAt: iso(10),
    updatedAt: iso(10),
    ...(state
      ? { health: { state, lastCheckedAt: iso(3), lastOkAt: sampleAge === null ? null : iso(sampleAge), sampleAgeSeconds: sampleAge } }
      : {}),
  };
}

describe("orderEntries", () => {
  it("puts the most urgent states first and keeps the original order among equals", () => {
    const entries = orderEntries([srv("a", "reachable"), srv("b"), srv("c", "unreachable", null), srv("d", "host_key_mismatch", null), srv("e", "reachable")], NOW, NOW);
    expect(entries.map((e) => e.server.id)).toEqual(["d", "c", "b", "a", "e"]);
  });
});

describe("entryDescription", () => {
  it("includes name, state and sample age", () => {
    const [entry] = orderEntries([srv("a", "reachable", 12)], NOW, NOW);
    expect(entryDescription(entry)).toBe("srv-a: Reachable, sample 12s ago");
  });

  it("says when there is no sample and flags stale samples", () => {
    const [none] = orderEntries([srv("a")], NOW, NOW);
    expect(entryDescription(none)).toBe("srv-a: Never checked, no successful sample");
    const [stale] = orderEntries([srv("b", "reachable", 300)], NOW, NOW);
    expect(entryDescription(stale)).toBe("srv-b: Reachable, stale sample 5m ago");
  });
});

describe("overflowCount", () => {
  it("collapses everything beyond six dots into +N", () => {
    expect(MAX_BAR_DOTS).toBe(6);
    expect(overflowCount(3)).toBe(0);
    expect(overflowCount(6)).toBe(0);
    expect(overflowCount(9)).toBe(3);
  });
});
