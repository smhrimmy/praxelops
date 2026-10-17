import crypto from "node:crypto";
import { StorageService } from "@/lib/storage";
import { getDb, prepare, withTransaction } from "@/lib/db/database";
import {
  KNOWN_HOST_INSERT_SQL,
  knownHostToParams,
  rowToKnownHost,
  type KnownHostEntry,
  type SqlRow,
} from "@/lib/db/records";

const SELECT_ONE_SQL =
  "SELECT host_port, host, port, fingerprint, first_seen_at, last_verified_at FROM known_hosts WHERE host_port = ?";
const SELECT_ALL_SQL =
  "SELECT host_port, host, port, fingerprint, first_seen_at, last_verified_at FROM known_hosts ORDER BY host_port";

type VerifyResult = { verified: boolean; isNew: boolean; fingerprint: string; error?: string };

type EnrollOutcome = { kind: "existing"; entry: KnownHostEntry } | { kind: "enrolled" };

export class KnownHostsService {
  /**
   * Computes SHA-256 fingerprint of a public key buffer
   */
  static computeFingerprint(keyBuffer: Buffer): string {
    return "SHA256:" + crypto.createHash("sha256").update(keyBuffer).digest("base64");
  }

  /**
   * Verifies the host key against the known-hosts table.
   * Enforces Trust-On-First-Use (TOFU) and rejects any changed key.
   *
   * Fails closed: if the pin row is malformed, or an enrollment cannot be durably recorded AND audited,
   * this THROWS (ssh2 turns a hostVerifier throw into a connection error before user authentication).
   * Successful verification of an existing pin performs no write.
   */
  static verifyHostKey(host: string, port: number, keyBuffer: Buffer): VerifyResult {
    const key = `${host}:${port}`;
    const currentFingerprint = this.computeFingerprint(keyBuffer);

    // Lock-free fast path: a plain read (WAL gives a consistent snapshot).
    const row = prepare(getDb(), SELECT_ONE_SQL).get(key);
    if (row !== undefined) {
      return this.evaluatePin(rowToKnownHost(row as SqlRow), host, port, key, currentFingerprint);
    }

    // Unknown host: decide and enroll in ONE transaction, re-reading inside it so a concurrent enrollment
    // from another process is observed (and never overwritten). The audit event and the pin commit together:
    // if either cannot be written neither is, and the caller rejects the connection.
    const outcome = withTransaction((db): EnrollOutcome => {
      const existingRow = prepare(db, SELECT_ONE_SQL).get(key);
      if (existingRow !== undefined) {
        return { kind: "existing", entry: rowToKnownHost(existingRow as SqlRow) };
      }

      const now = new Date().toISOString();
      StorageService.logAuditEvent({
        actor: "system",
        eventType: "security_alert",
        targetServerId: key,
        status: "success",
        details: {
          alertType: "tofu_host_key_enrolled",
          host,
          port,
          fingerprint: currentFingerprint,
        },
      });

      prepare(db, KNOWN_HOST_INSERT_SQL).run(
        ...knownHostToParams(key, {
          host,
          port,
          fingerprint: currentFingerprint,
          firstSeenAt: now,
          lastVerifiedAt: now,
        })
      );
      return { kind: "enrolled" };
    });

    if (outcome.kind === "existing") {
      return this.evaluatePin(outcome.entry, host, port, key, currentFingerprint);
    }
    return { verified: true, isNew: true, fingerprint: currentFingerprint };
  }

  private static evaluatePin(
    existing: KnownHostEntry,
    host: string,
    port: number,
    key: string,
    currentFingerprint: string
  ): VerifyResult {
    if (existing.fingerprint === currentFingerprint) {
      return { verified: true, isNew: false, fingerprint: currentFingerprint };
    }

    try {
      StorageService.logAuditEvent({
        actor: "system",
        eventType: "security_alert",
        targetServerId: key,
        status: "denied",
        details: {
          alertType: "host_key_mismatch",
          host,
          port,
          expectedFingerprint: existing.fingerprint,
          receivedFingerprint: currentFingerprint,
        },
      });
    } catch (err) {
      // The connection is rejected regardless; surface the audit failure loudly.
      console.error(
        `[KnownHosts] CRITICAL: failed to audit host key mismatch for ${key}:`,
        err
      );
    }

    return {
      verified: false,
      isNew: false,
      fingerprint: currentFingerprint,
      error: `SECURITY ALERT: Host key mismatch for ${host}:${port}! Expected '${existing.fingerprint}', but received '${currentFingerprint}'. Possible man-in-the-middle attack.`,
    };
  }

  /**
   * Reset / clear known hosts (used for testing or explicit host rotation).
   * Intentionally does not read the old rows, so it also recovers a store containing malformed rows.
   */
  static clearKnownHosts(): void {
    withTransaction((db) => {
      prepare(db, "DELETE FROM known_hosts").run();
    });
  }

  /**
   * Remove a single host key entry
   */
  static removeHostKey(host: string, port: number): void {
    const key = `${host}:${port}`;
    withTransaction((db) => {
      prepare(db, "DELETE FROM known_hosts WHERE host_port = ?").run(key);
    });
  }

  static getKnownHosts(): Record<string, KnownHostEntry> {
    const rows = prepare(getDb(), SELECT_ALL_SQL).all();
    const result: Record<string, KnownHostEntry> = {};
    for (const row of rows) {
      const entry = rowToKnownHost(row as SqlRow);
      result[`${entry.host}:${entry.port}`] = entry;
    }
    return result;
  }
}
