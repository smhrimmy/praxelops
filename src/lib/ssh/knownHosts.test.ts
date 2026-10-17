import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { KnownHostsService } from "./knownHosts";
import { StorageService } from "@/lib/storage";
import { getDataDir } from "@/lib/storage/dataDir";
import { StorageCorruptError } from "@/lib/storage/atomicFile";
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
        e.details?.alertType === "tofu_host_key_enrolled" &&
        e.targetServerId === `${host}:${port}`
    );
    expect(enrollmentEvent).toBeDefined();
    expect(enrollmentEvent?.status).toBe("success");
    expect(enrollmentEvent?.details?.fingerprint).toBe(res.fingerprint);
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
        e.details?.alertType === "host_key_mismatch" &&
        e.targetServerId === `${host}:${port}`
    );
    expect(mismatchEvent).toBeDefined();
    expect(mismatchEvent?.status).toBe("denied");
  });
  it("does not rewrite the known_hosts file on a successful verification", () => {
    KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    const file = path.join(getDataDir(), "known_hosts.json");
    const before = fs.readFileSync(file, "utf-8");
    const mtimeBefore = fs.statSync(file).mtimeMs;
    const res = KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    expect(res.verified).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore);
  });

  it("treats a second enrollment of the same host with a different key as a mismatch", () => {
    expect(KnownHostsService.verifyHostKey(host, port, originalKeyBuffer).verified).toBe(true);
    const second = KnownHostsService.verifyHostKey(host, port, changedKeyBuffer);
    expect(second.verified).toBe(false);
    expect(second.isNew).toBe(false);
    // First pin survives
    const known = KnownHostsService.getKnownHosts();
    expect(known[`${host}:${port}`].fingerprint).toBe(
      KnownHostsService.computeFingerprint(originalKeyBuffer)
    );
  });

  describe("fail-closed behaviour", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("rejects verification (throws) and does NOT enroll when known_hosts is corrupt", () => {
      const file = path.join(getDataDir(), "known_hosts.json");
      fs.writeFileSync(file, '{"192.168.1.5:22": {"host": "192.', "utf-8"); // truncated JSON
      const corrupt = fs.readFileSync(file, "utf-8");

      expect(() => KnownHostsService.verifyHostKey(host, port, originalKeyBuffer)).toThrow(
        StorageCorruptError
      );
      // File untouched: no enrollment, no overwrite of other pins
      expect(fs.readFileSync(file, "utf-8")).toBe(corrupt);
    });

    it("rejects verification when known_hosts has a wrong-shaped but parseable payload", () => {
      const file = path.join(getDataDir(), "known_hosts.json");
      fs.writeFileSync(file, "[]", "utf-8");
      expect(() => KnownHostsService.verifyHostKey(host, port, originalKeyBuffer)).toThrow(
        StorageCorruptError
      );
      fs.writeFileSync(file, '{"h:22": {"fingerprint": 5}}', "utf-8");
      expect(() => KnownHostsService.verifyHostKey(host, port, originalKeyBuffer)).toThrow(
        StorageCorruptError
      );
    });

    it("recovers via an explicit clear after corruption", () => {
      const file = path.join(getDataDir(), "known_hosts.json");
      fs.writeFileSync(file, "", "utf-8");
      expect(() => KnownHostsService.getKnownHosts()).toThrow(StorageCorruptError);
      KnownHostsService.clearKnownHosts();
      expect(KnownHostsService.getKnownHosts()).toEqual({});
    });

    it("fails closed (throws, no pin written) when the enrollment audit cannot be written", () => {
      vi.spyOn(StorageService, "logAuditEvent").mockImplementation(() => {
        throw new Error("disk full");
      });
      expect(() => KnownHostsService.verifyHostKey(host, port, originalKeyBuffer)).toThrow(
        /disk full/
      );
      expect(KnownHostsService.getKnownHosts()[`${host}:${port}`]).toBeUndefined();
    });

    it("still rejects a mismatched key when the mismatch audit fails, and logs to console.error", () => {
      KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
      vi.spyOn(StorageService, "logAuditEvent").mockImplementation(() => {
        throw new Error("audit down");
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = KnownHostsService.verifyHostKey(host, port, changedKeyBuffer);
      expect(res.verified).toBe(false);
      expect(errSpy).toHaveBeenCalled();
    });
  });
});
