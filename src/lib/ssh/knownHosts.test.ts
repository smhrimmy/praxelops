import { describe, it, expect, beforeEach } from "vitest";
import { KnownHostsService } from "./knownHosts";
import crypto from "crypto";

describe("KnownHostsService", () => {
  beforeEach(() => {
    KnownHostsService.clearKnownHosts();
  });

  const host = "192.168.1.100";
  const port = 22;
  const originalKeyBuffer = crypto.randomBytes(128);
  const changedKeyBuffer = crypto.randomBytes(128);

  it("trusts and records host key on first use (TOFU)", () => {
    const res = KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    expect(res.verified).toBe(true);
    expect(res.isNew).toBe(true);
    expect(res.fingerprint).toMatch(/^SHA256:/);

    const known = KnownHostsService.getKnownHosts();
    expect(known[`${host}:${port}`]).toBeDefined();
    expect(known[`${host}:${port}`].fingerprint).toBe(res.fingerprint);
  });

  it("verifies matching host key on subsequent connections", () => {
    KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    const res = KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    expect(res.verified).toBe(true);
    expect(res.isNew).toBe(false);
  });

  it("rejects connection immediately when host key changes", () => {
    // Register initial key
    KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);

    // Attempt connection with changed rogue key
    const res = KnownHostsService.verifyHostKey(host, port, changedKeyBuffer);
    expect(res.verified).toBe(false);
    expect(res.error).toContain("Host key mismatch");
    expect(res.error).toContain("Possible man-in-the-middle attack");
  });
});
