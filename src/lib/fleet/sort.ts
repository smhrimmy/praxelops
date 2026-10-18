export type SortDir = "asc" | "desc";

export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

export type SortValue = number | string | null | undefined;

/** Clicking the active column flips the direction; clicking another column starts at `defaultDir`. */
export function nextSort<K extends string>(current: SortState<K>, key: K, defaultDir: SortDir = "asc"): SortState<K> {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: defaultDir };
}

export function ariaSort<K extends string>(state: SortState<K>, key: K): "ascending" | "descending" | "none" {
  if (state.key !== key) return "none";
  return state.dir === "asc" ? "ascending" : "descending";
}

function isMissing(value: SortValue): value is null | undefined {
  return value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value));
}

/**
 * Comparator for one column. Missing values (null / undefined / NaN) always sort last, whichever the direction, so
 * "unknown" never masquerades as the smallest or largest value. Strings compare case-insensitively with numeric
 * collation ("web-2" < "web-10").
 */
export function compareValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const aMissing = isMissing(a);
  const bMissing = isMissing(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  let result: number;
  if (typeof a === "number" && typeof b === "number") {
    result = a - b;
  } else {
    result = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }
  return dir === "asc" ? result : -result;
}

/** Stable sort by an accessor; returns a new array. */
export function sortRows<T>(rows: readonly T[], accessor: (row: T) => SortValue, dir: SortDir): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => compareValues(accessor(x.row), accessor(y.row), dir) || x.index - y.index)
    .map((entry) => entry.row);
}
