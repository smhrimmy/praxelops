import { describe, it, expect } from "vitest";
import { WORKSPACES, workspaceLabel } from "./workspaces";

describe("workspaces registry", () => {
  it("defines the seven workspaces in shortcut order (Ctrl/Cmd+1..7)", () => {
    expect(WORKSPACES.map((w) => w.id)).toEqual([
      "fleet",
      "terminal",
      "sftp",
      "ai-ops",
      "deployments",
      "audit",
      "monitor",
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
    expect(workspaceLabel("monitor")).toBe("System Monitor");
    expect(workspaceLabel("nope")).toBe("nope");
  });
});
