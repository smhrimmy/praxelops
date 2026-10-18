import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { KnownHostsService } from "./knownHosts";
import { StorageService } from "@/lib/storage";
import { getDb } from "@/lib/db/database";
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
  it("does not write anything (pin row or audit log) on a successful verification", () => {
    KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    const selectPin = () =>
      getDb().prepare("SELECT * FROM known_hosts WHERE host_port = ?").get(`${host}:${port}`);
    const before = JSON.stringify(selectPin());
    const auditCountBefore = StorageService.getAuditEvents().length;
    const totalChangesBefore = Number(getDb().prepare("SELECT total_changes() AS n").get()?.n);

    const res = KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    expect(res.verified).toBe(true);
    expect(JSON.stringify(selectPin())).toBe(before);
    expect(StorageService.getAuditEvents().length).toBe(auditCountBefore);
    expect(Number(getDb().prepare("SELECT total_changes() AS n").get()?.n)).toBe(totalChangesBefore);
  });

  it("commits the enrollment audit event and the pin together", () => {
    const isEnrollment = (e: { details?: Record<string, unknown>; targetServerId?: string }) =>
      e.details?.alertType === "tofu_host_key_enrolled" && e.targetServerId === `${host}:${port}`;
    const before = StorageService.getAuditEvents().filter(isEnrollment).length;
    KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    expect(StorageService.getAuditEvents().filter(isEnrollment).length).toBe(before + 1);
    expect(KnownHostsService.getKnownHosts()[`${host}:${port}`]).toBeDefined();
  });

  it("rolls the enrollment audit event back when the pin cannot be written (atomic)", () => {
    const isEnrollment = (e: { details?: Record<string, unknown>; targetServerId?: string }) =>
      e.details?.alertType === "tofu_host_key_enrolled" && e.targetServerId === `${host}:${port}`;
    const before = StorageService.getAuditEvents().filter(isEnrollment).length;
    const db = getDb();
    db.exec("CREATE TRIGGER fail_pin_insert BEFORE INSERT ON known_hosts BEGIN SELECT RAISE(ABORT, 'pin write blocked'); END");
    try {
      expect(() => KnownHostsService.verifyHostKey(host, port, originalKeyBuffer)).toThrow(/pin write blocked/);
    } finally {
      db.exec("DROP TRIGGER fail_pin_insert");
    }
    expect(StorageService.getAuditEvents().filter(isEnrollment).length).toBe(before);
    expect(KnownHostsService.getKnownHosts()[`${host}:${port}`]).toBeUndefined();
  });

  it("removes a single pin and clears all", () => {
    KnownHostsService.verifyHostKey(host, port, originalKeyBuffer);
    KnownHostsService.verifyHostKey("other.example", 2222, originalKeyBuffer);
    KnownHostsService.removeHostKey(host, port);
    expect(Object.keys(KnownHostsService.getKnownHosts())).toEqual(["other.example:2222"]);
    KnownHostsService.clearKnownHosts();
    expect(KnownHostsService.getKnownHosts()).toEqual({});
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

    const key = `${host}:${port}`;
    const insertRaw = (hostPort: string, h: unknown, p: unknown, fp: unknown) =>
      getDb()
        .prepare(
          "INSERT INTO known_hosts (host_port, host, port, fingerprint, first_seen_at, last_verified_at) VALUES (?, ?, ?, ?, 'a', 'b')"
        )
        .run(hostPort, h as string, p as number, fp as string);

    it("rejects verification (throws) and does NOT replace the pin when its row has an empty fingerprint", () => {
      insertRaw(key, host, port, "");
      const auditsBefore = StorageService.getAuditEvents().length;

      expect(() => KnownHostsService.verifyHostKey(host, port, originalKeyBuffer)).toThrow(StorageCorruptError);
      // Row untouched: no enrollment over it, no audit event written.
      const row = getDb().prepare("SELECT fingerprint FROM known_hosts WHERE host_port = ?").get(key);
      expect(row?.fingerprint).toBe("");
      expect(StorageService.getAuditEvents().length).toBe(auditsBefore);
    });

    it("rejects verification when a pin row has wrong-typed or inconsistent columns", () => {
      insertRaw(key, host, "not-a-port", "SHA256:abc");
      expect(() => KnownHostsService.verifyHostKey(host, port, originalKeyBuffer)).toThrow(StorageCorruptError);
      expect(() => KnownHostsService.getKnownHosts()).toThrow(StorageCorruptError);

      KnownHostsService.clearKnownHosts();
      // host_port that does not match its host/port columns
      insertRaw(key, "evil.example", port, "SHA256:abc");
      expect(() => KnownHostsService.verifyHostKey(host, port, originalKeyBuffer)).toThrow(StorageCorruptError);
    });

    it("recovers via an explicit clear after corruption", () => {
      insertRaw(key, host, port, "");
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
