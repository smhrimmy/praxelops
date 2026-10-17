import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";

function apiRequest(host: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/servers", { headers: { host } });
}

describe("proxy (Host allowlist for /api/*)", () => {
  it("matches only /api/:path*", () => {
    expect(config.matcher).toBe("/api/:path*");
  });

  it("passes allowed hosts through", async () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      const res = proxy(apiRequest(host));
      expect(res.status, host).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("rejects rebinding-style hosts with 421", async () => {
    for (const host of ["localhost.evil.example", "127.0.0.1.nip.io", "evil.example:3000", "localhost:9999"]) {
      const res = proxy(apiRequest(host));
      expect(res.status, host).toBe(421);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(false);
    }
  });
});
