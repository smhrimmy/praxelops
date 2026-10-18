import { describe, it, expect } from "vitest";
import { cycleIndex, indexAfterClose, nextOrdinal, tabLabel, tabSwitchDirection } from "./tabs";

describe("nextOrdinal", () => {
  it("starts at 1 and fills the lowest free number", () => {
    expect(nextOrdinal([])).toBe(1);
    expect(nextOrdinal([1])).toBe(2);
    expect(nextOrdinal([1, 2, 4])).toBe(3);
    expect(nextOrdinal([2, 3])).toBe(1);
  });
});

describe("tabLabel", () => {
  it("numbers tabs only when a server has several", () => {
    expect(tabLabel("web-1", 1, 1)).toBe("web-1");
    expect(tabLabel("web-1", 1, 2)).toBe("web-1 (1)");
    expect(tabLabel("web-1", 2, 2)).toBe("web-1 (2)");
  });
});

describe("cycleIndex", () => {
  it("wraps in both directions", () => {
    expect(cycleIndex(0, 3, 1)).toBe(1);
    expect(cycleIndex(2, 3, 1)).toBe(0);
    expect(cycleIndex(0, 3, -1)).toBe(2);
    expect(cycleIndex(1, 3, -1)).toBe(0);
  });

  it("handles a single tab, no tabs and an unknown current tab", () => {
    expect(cycleIndex(0, 1, 1)).toBe(0);
    expect(cycleIndex(0, 0, 1)).toBe(-1);
    expect(cycleIndex(-1, 3, 1)).toBe(0);
    expect(cycleIndex(-1, 3, -1)).toBe(2);
  });
});

describe("indexAfterClose", () => {
  it("selects the neighbour that takes the closed tab's place", () => {
    expect(indexAfterClose(0, 2)).toBe(0);
    expect(indexAfterClose(1, 2)).toBe(1);
    expect(indexAfterClose(2, 2)).toBe(1);
    expect(indexAfterClose(0, 0)).toBe(-1);
  });
});

describe("tabSwitchDirection", () => {
  const base = { ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, code: "BracketRight" };

  it("recognises Ctrl+Shift+[ and ]", () => {
    expect(tabSwitchDirection({ ...base, ctrlKey: true, code: "BracketLeft" })).toBe(-1);
    expect(tabSwitchDirection({ ...base, ctrlKey: true, code: "BracketRight" })).toBe(1);
  });

  it("recognises Cmd+Shift+[ and ]", () => {
    expect(tabSwitchDirection({ ...base, metaKey: true, code: "BracketLeft" })).toBe(-1);
    expect(tabSwitchDirection({ ...base, metaKey: true })).toBe(1);
  });

  it("ignores everything else so the shell keeps its keys", () => {
    expect(tabSwitchDirection({ ...base, code: "BracketRight" })).toBe(0); // no modifier
    expect(tabSwitchDirection({ ...base, ctrlKey: true, shiftKey: false })).toBe(0);
    expect(tabSwitchDirection({ ...base, ctrlKey: true, altKey: true })).toBe(0);
    expect(tabSwitchDirection({ ...base, ctrlKey: true, code: "KeyC" })).toBe(0);
    expect(tabSwitchDirection({ ...base, ctrlKey: true, code: "Tab" })).toBe(0);
  });
});
