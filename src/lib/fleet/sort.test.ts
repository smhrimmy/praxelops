import { describe, it, expect } from "vitest";
import { ariaSort, compareValues, nextSort, sortRows } from "./sort";

describe("compareValues", () => {
  it("orders numbers and strings in both directions", () => {
    expect(compareValues(1, 2, "asc")).toBeLessThan(0);
    expect(compareValues(1, 2, "desc")).toBeGreaterThan(0);
    expect(compareValues("alpha", "Beta", "asc")).toBeLessThan(0);
  });

  it("uses numeric collation for names", () => {
    expect(compareValues("web-2", "web-10", "asc")).toBeLessThan(0);
  });

  it("always sorts missing values last, in either direction", () => {
    expect(compareValues(null, 5, "asc")).toBeGreaterThan(0);
    expect(compareValues(null, 5, "desc")).toBeGreaterThan(0);
    expect(compareValues(5, undefined, "desc")).toBeLessThan(0);
    expect(compareValues(Number.NaN, 5, "asc")).toBeGreaterThan(0);
    expect(compareValues(null, null, "asc")).toBe(0);
  });
});

describe("sortRows", () => {
  const rows = [
    { id: "a", cpu: 30 as number | null },
    { id: "b", cpu: null },
    { id: "c", cpu: 10 },
    { id: "d", cpu: 30 },
  ];

  it("sorts ascending with nulls last and is stable for ties", () => {
    expect(sortRows(rows, (r) => r.cpu, "asc").map((r) => r.id)).toEqual(["c", "a", "d", "b"]);
  });

  it("sorts descending with nulls still last", () => {
    expect(sortRows(rows, (r) => r.cpu, "desc").map((r) => r.id)).toEqual(["a", "d", "c", "b"]);
  });

  it("does not mutate the input", () => {
    const copy = [...rows];
    sortRows(rows, (r) => r.cpu, "desc");
    expect(rows).toEqual(copy);
  });
});

describe("nextSort / ariaSort", () => {
  it("flips the active column and resets for a new one", () => {
    const start = { key: "name", dir: "asc" } as const;
    expect(nextSort(start, "name")).toEqual({ key: "name", dir: "desc" });
    expect(nextSort({ key: "name", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort(start, "cpu", "desc")).toEqual({ key: "cpu", dir: "desc" });
  });

  it("maps to aria-sort values", () => {
    expect(ariaSort({ key: "cpu", dir: "desc" }, "cpu")).toBe("descending");
    expect(ariaSort({ key: "cpu", dir: "asc" }, "cpu")).toBe("ascending");
    expect(ariaSort({ key: "cpu", dir: "asc" }, "mem")).toBe("none");
  });
});
