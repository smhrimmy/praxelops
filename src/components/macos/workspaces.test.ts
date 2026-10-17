import { describe, it, expect } from "vitest";
import { WORKSPACES, workspaceLabel } from "./workspaces";

describe("workspaces registry", () => {
  it("defines the six workspaces in shortcut order (Ctrl/Cmd+1..6)", () => {
    expect(WORKSPACES.map((w) => w.id)).toEqual([
      "fleet",
      "terminal",
      "sftp",
      "ai-ops",
      "deployments",
      "audit",
    ]);
  });

  it("has unique ids and non-empty labels", () => {
    expect(new Set(WORKSPACES.map((w) => w.id)).size).toBe(WORKSPACES.length);
    for (const w of WORKSPACES) {
      expect(w.label.length).toBeGreaterThan(0);
      expect(w.shortLabel.length).toBeGreaterThan(0);
    }
  });

  it("resolves labels and falls back to the id for unknown views", () => {
    expect(workspaceLabel("audit")).toBe("Security Audit");
    expect(workspaceLabel("nope")).toBe("nope");
  });
});
