import { describe, it, expect } from "vitest";
import { getAllowedHosts, getAllowedOrigins, getAppPort, isAllowedHost, isAllowedOrigin } from "./origins";

describe("isAllowedHost (DNS-rebinding defense)", () => {
  const env = { NODE_ENV: "development" } as const;

  it("accepts the exact loopback hosts on the app port", () => {
    expect(isAllowedHost("localhost:3000", env)).toBe(true);
    expect(isAllowedHost("127.0.0.1:3000", env)).toBe(true);
    expect(isAllowedHost("[::1]:3000", env)).toBe(true);
    expect(isAllowedHost("LOCALHOST:3000", env)).toBe(true);
  });

  it("rejects prefix / suffix / wrong-port / missing hosts", () => {
    for (const host of [
      "localhost.evil.example",
      "localhost.evil.example:3000",
      "127.0.0.1.nip.io",
      "127.0.0.1.nip.io:3000",
      "evil.example",
      "localhost",
      "localhost:3001",
      "xlocalhost:3000",
      "localhost:3000.evil.example",
      "localhost:3000@evil.example",
      "",
      null,
      undefined,
    ]) {
      expect(isAllowedHost(host, env), String(host)).toBe(false);
    }
  });

  it("follows PORT", () => {
    expect(isAllowedHost("localhost:4000", { PORT: "4000" })).toBe(true);
    expect(isAllowedHost("localhost:3000", { PORT: "4000" })).toBe(false);
    expect(getAppPort({ PORT: "not-a-port" })).toBe(3000);
    expect(getAppPort({ PORT: "99999" })).toBe(3000);
    expect(getAppPort({})).toBe(3000);
  });

  it("adds hosts from ALLOWED_ORIGINS and ALLOWED_HOSTS (exact match only)", () => {
    const e = {
      ALLOWED_ORIGINS: "https://ops.example.com, http://intranet.local:8080",
      ALLOWED_HOSTS: "Admin.Example.com:9000 , 10.0.0.5:3000",
    };
    expect(isAllowedHost("ops.example.com", e)).toBe(true);
    expect(isAllowedHost("intranet.local:8080", e)).toBe(true);
    expect(isAllowedHost("admin.example.com:9000", e)).toBe(true);
    expect(isAllowedHost("10.0.0.5:3000", e)).toBe(true);
    expect(isAllowedHost("ops.example.com:8443", e)).toBe(false);
    expect(isAllowedHost("evil.ops.example.com", e)).toBe(false);
    expect(isAllowedHost("ops.example.com.evil.example", e)).toBe(false);
    expect(getAllowedHosts(e)).toContain("localhost:3000");
  });
});

describe("isAllowedOrigin", () => {
  it("allows loopback origins only outside production", () => {
    expect(isAllowedOrigin("http://localhost:3000", { NODE_ENV: "development" })).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3000", { NODE_ENV: "test" })).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", { NODE_ENV: "production" })).toBe(false);
    expect(getAllowedOrigins({ NODE_ENV: "production" })).toEqual([]);
  });

  it("normalizes ALLOWED_ORIGINS via new URL().origin and matches the header exactly", () => {
    const env = { NODE_ENV: "production", ALLOWED_ORIGINS: "https://Ops.Example.com/some/path, not a url, ftp://x.example" };
    expect(getAllowedOrigins(env)).toEqual(["https://ops.example.com"]);
    expect(isAllowedOrigin("https://ops.example.com", env)).toBe(true);
    expect(isAllowedOrigin("https://ops.example.com/", env)).toBe(false);
    expect(isAllowedOrigin("http://ops.example.com", env)).toBe(false);
    expect(isAllowedOrigin("https://ops.example.com:8443", env)).toBe(false);
    expect(isAllowedOrigin("https://ops.example.com.evil.example", env)).toBe(false);
  });

  it("rejects null, empty and missing origins", () => {
    const env = { NODE_ENV: "development" };
    expect(isAllowedOrigin("null", env)).toBe(false);
    expect(isAllowedOrigin("", env)).toBe(false);
    expect(isAllowedOrigin(null, env)).toBe(false);
    expect(isAllowedOrigin(undefined, env)).toBe(false);
  });
});
