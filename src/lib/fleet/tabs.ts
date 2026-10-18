/** Pure helpers for per-server terminal tabs. */

/** Smallest positive integer not yet used by the other tabs of the same server (1 for the first tab). */
export function nextOrdinal(usedOrdinals: readonly number[]): number {
  const used = new Set(usedOrdinals);
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

/** Tab label: the server name, numbered ("web-1 (2)") only when the server has more than one open tab. */
export function tabLabel(serverName: string, ordinal: number, tabsForServer: number): string {
  return tabsForServer > 1 ? `${serverName} (${ordinal})` : serverName;
}

/** Index after moving `dir` steps from `current`, wrapping around; -1 for an empty list. */
export function cycleIndex(current: number, length: number, dir: 1 | -1): number {
  if (length <= 0) return -1;
  const from = current < 0 ? (dir === 1 ? -1 : 0) : current;
  return (from + dir + length) % length;
}

/** Which tab becomes active after closing the one at `closedIndex`: the neighbour that slides into its place, else the previous one. */
export function indexAfterClose(closedIndex: number, remaining: number): number {
  if (remaining <= 0) return -1;
  return Math.min(closedIndex, remaining - 1);
}

export interface TabKeyEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  code: string;
}

/**
 * Ctrl/Cmd+Shift+[ (previous) and Ctrl/Cmd+Shift+] (next). Uses `code` so it works on layouts where Shift turns the
 * bracket into a brace. Returns 0 for any other key, so everything else keeps flowing to the shell.
 */
export function tabSwitchDirection(e: TabKeyEventLike): -1 | 0 | 1 {
  if (e.altKey || !e.shiftKey || !(e.ctrlKey || e.metaKey)) return 0;
  if (e.code === "BracketLeft") return -1;
  if (e.code === "BracketRight") return 1;
  return 0;
}
