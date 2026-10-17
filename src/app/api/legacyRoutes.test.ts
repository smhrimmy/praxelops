import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("legacy API routes", () => {
  it("does not ship the removed /api/ssh/session route", () => {
    const dir = path.resolve(__dirname, "ssh/session");
    expect(fs.existsSync(path.join(dir, "route.ts"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "route.js"))).toBe(false);
  });
});
