import fs from "fs";
import path from "path";
import crypto from "crypto";
import { StorageService } from "@/lib/storage";

const DATA_DIR = path.resolve(process.cwd(), ".peos", "data");
const KNOWN_HOSTS_FILE = path.join(DATA_DIR, "known_hosts.json");

interface KnownHostEntry {
  host: string;
  port: number;
  fingerprint: string;
  firstSeenAt: string;
  lastVerifiedAt: string;
}

function readKnownHosts(): Record<string, KnownHostEntry> {
  if (!fs.existsSync(KNOWN_HOSTS_FILE)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(KNOWN_HOSTS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeKnownHosts(data: Record<string, KnownHostEntry>): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(KNOWN_HOSTS_FILE, JSON.stringify(data, null, 2), "utf-8");
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
   */
  static verifyHostKey(
    host: string,
    port: number,
    keyBuffer: Buffer
  ): { verified: boolean; isNew: boolean; fingerprint: string; error?: string } {
    const key = `${host}:${port}`;
    const currentFingerprint = this.computeFingerprint(keyBuffer);
    const knownHosts = readKnownHosts();
    const existing = knownHosts[key];

    if (!existing) {
      // Trust on first use: explicitly enrolled and audited
      knownHosts[key] = {
        host,
        port,
        fingerprint: currentFingerprint,
        firstSeenAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
      };
      writeKnownHosts(knownHosts);

      try {
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
      } catch {}

      return { verified: true, isNew: true, fingerprint: currentFingerprint };
    }

    if (existing.fingerprint !== currentFingerprint) {
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
      } catch {}

      return {
        verified: false,
        isNew: false,
        fingerprint: currentFingerprint,
        error: `SECURITY ALERT: Host key mismatch for ${host}:${port}! Expected '${existing.fingerprint}', but received '${currentFingerprint}'. Possible man-in-the-middle attack.`,
      };
    }

    existing.lastVerifiedAt = new Date().toISOString();
    writeKnownHosts(knownHosts);
    return { verified: true, isNew: false, fingerprint: currentFingerprint };
  }

  /**
   * Reset / clear known hosts (used for testing or explicit host rotation)
   */
  static clearKnownHosts(): void {
    writeKnownHosts({});
  }

  /**
   * Remove a single host key entry
   */
  static removeHostKey(host: string, port: number): void {
    const key = `${host}:${port}`;
    const knownHosts = readKnownHosts();
    delete knownHosts[key];
    writeKnownHosts(knownHosts);
  }

  static getKnownHosts(): Record<string, KnownHostEntry> {
    return readKnownHosts();
  }
}
