import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { StorageService } from "@/lib/storage";
import { getDataDir } from "@/lib/storage/dataDir";
import {
  atomicWriteFileSync,
  readJsonStrict,
  StorageCorruptError,
  withFileLockSync,
} from "@/lib/storage/atomicFile";

const KnownHostEntrySchema = z.object({
  host: z.string(),
  port: z.number(),
  fingerprint: z.string().min(1),
  firstSeenAt: z.string(),
  // Written once at enrollment. Deliberately NOT updated on successful verification:
  // rewriting the store on every connection maximises cross-process contention for no security value.
  lastVerifiedAt: z.string(),
});

const KnownHostsSchema = z.record(z.string(), KnownHostEntrySchema);

type KnownHostEntry = z.infer<typeof KnownHostEntrySchema>;
type KnownHostsMap = Record<string, KnownHostEntry>;

function knownHostsFile(): string {
  return path.join(getDataDir(), "known_hosts.json");
}

/**
 * Reads the pin store. A missing file is an empty store (first run); anything that is present
 * but unparseable / wrong-shaped throws StorageCorruptError so callers fail CLOSED
 * (a corrupt store must never be interpreted as "no pins, enroll whatever key is presented").
 */
function readKnownHosts(file: string): KnownHostsMap {
  const raw = readJsonStrict<unknown>(file);
  if (raw === undefined) return {};
  const parsed = KnownHostsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StorageCorruptError(file, parsed.error.message);
  }
  return parsed.data;
}

function writeKnownHostsLocked(file: string, data: KnownHostsMap): void {
  atomicWriteFileSync(file, JSON.stringify(data, null, 2));
}

export class KnownHostsService {
  /**
   * Computes SHA-256 fingerprint of a public key buffer
   */
  static computeFingerprint(keyBuffer: Buffer): string {
    return "SHA256:" + crypto.createHash("sha256").update(keyBuffer).digest("base64");
  }

  /**
   * Verifies the host key against known-hosts database.
   * Enforces Trust-On-First-Use (TOFU) and rejects any changed key.
   *
   * Fails closed: if the store is corrupt/unreadable, or an enrollment cannot be durably
   * recorded AND audited, this THROWS (ssh2 turns a hostVerifier throw into a connection error
   * before user authentication). Successful verification of an existing pin performs no write.
   */
  static verifyHostKey(
    host: string,
    port: number,
    keyBuffer: Buffer
  ): { verified: boolean; isNew: boolean; fingerprint: string; error?: string } {
    const key = `${host}:${port}`;
    const currentFingerprint = this.computeFingerprint(keyBuffer);
    const file = knownHostsFile();

    // Lock-free fast path: writes are atomic renames, so this is a consistent snapshot.
    const snapshot = readKnownHosts(file);
    if (snapshot[key]) {
      return this.evaluatePin(snapshot[key], host, port, key, currentFingerprint);
    }

    // Unknown host: decide and enroll under the lock, re-reading inside it so concurrent
    // enrollments from other processes are observed (and never overwritten).
    return withFileLockSync(file, () => {
      const knownHosts = readKnownHosts(file);
      const existing = knownHosts[key];
      if (existing) {
        return this.evaluatePin(existing, host, port, key, currentFingerprint);
      }

      const now = new Date().toISOString();
      // Audit first: if the enrollment cannot be audited we must not pin, and the caller rejects.
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

      knownHosts[key] = {
        host,
        port,
        fingerprint: currentFingerprint,
        firstSeenAt: now,
        lastVerifiedAt: now,
      };
      writeKnownHostsLocked(file, knownHosts);

      return { verified: true, isNew: true, fingerprint: currentFingerprint };
    });
  }

  private static evaluatePin(
    existing: KnownHostEntry,
    host: string,
    port: number,
    key: string,
    currentFingerprint: string
  ): { verified: boolean; isNew: boolean; fingerprint: string; error?: string } {
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
   * Intentionally does not read the old contents, so it also recovers a corrupt store.
   */
  static clearKnownHosts(): void {
    const file = knownHostsFile();
    withFileLockSync(file, () => {
      writeKnownHostsLocked(file, {});
    });
  }

  /**
   * Remove a single host key entry
   */
  static removeHostKey(host: string, port: number): void {
    const key = `${host}:${port}`;
    const file = knownHostsFile();
    withFileLockSync(file, () => {
      const knownHosts = readKnownHosts(file);
      if (!(key in knownHosts)) return;
      delete knownHosts[key];
      writeKnownHostsLocked(file, knownHosts);
    });
  }

  static getKnownHosts(): Record<string, KnownHostEntry> {
    return readKnownHosts(knownHostsFile());
  }
}
