import { describe, it, expect, beforeEach } from "vitest";
import { KnownHostsService } from "./knownHosts";
import { StorageService } from "@/lib/storage";
import crypto from "crypto";

describe("KnownHostsService", () => {
  beforeEach(() => {
    KnownHostsService.clearKnownHosts();
  });

  const host = "192.168.1.100";
  const port = 22;
  const originalKeyBuffer = crypto.randomBytes(128);
  const changedKeyBuffer = crypto.randomBytes(128);

  it("trusts, records, and audits host key on first use (TOFU)", () => {
    const res = KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    expect(res.verified).toBe(true);
    expect(res.isNew).toBe(true);
    expect(res.fingerprint).toMatch(/^SHA256:/);

    const known = KnownHostsService.getKnownHosts();
    expect(known[`${host}:${port}`]).toBeDefined();
    expect(known[`${host}:${port}`].fingerprint).toBe(res.fingerprint);

    // Verify auditable event was recorded
    const auditLogs = StorageService.getAuditEvents();
    const enrollmentEvent = auditLogs.find(
      (e) =>
        e.eventType === "security_alert" &&
        (e.details as any)?.alertType === "tofu_host_key_enrolled" &&
        e.targetServerId === `${host}:${port}`
    );
    expect(enrollmentEvent).toBeDefined();
    expect(enrollmentEvent?.status).toBe("success");
    expect((enrollmentEvent?.details as any)?.fingerprint).toBe(res.fingerprint);
  });

  it("verifies matching host key on subsequent connections without duplicate alert", () => {
    KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    const res = KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    expect(res.verified).toBe(true);
    expect(res.isNew).toBe(false);
  });

  it("rejects connection immediately and logs security alert when host key changes", () => {
    // Register initial key
    KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);

    // Attempt connection with changed rogue key
    const res = KnownHostsService.verifyHostKey(host, port, changedKeyBuffer);
    expect(res.verified).toBe(false);
    expect(res.error).toContain("Host key mismatch");
    expect(res.error).toContain("Possible man-in-the-middle attack");

    // Verify MITM security alert event was recorded
    const auditLogs = StorageService.getAuditEvents();
    const mismatchEvent = auditLogs.find(
      (e) =>
        e.eventType === "security_alert" &&
        (e.details as any)?.alertType === "host_key_mismatch" &&
        e.targetServerId === `${host}:${port}`
    );
    expect(mismatchEvent).toBeDefined();
    expect(mismatchEvent?.status).toBe("denied");
  });
});
