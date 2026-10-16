import crypto from "crypto";
import fs from "fs";
import path from "path";

const CONFIG_DIR = path.resolve(process.cwd(), ".peos", "config");
const KEY_FILE = path.join(CONFIG_DIR, "master.key");

/**
 * Retrieves the authoritative server-side HMAC & encryption master secret.
 * In production: Requires PRAXELOPS_SECRET or existing local master.key.
 * In development: Auto-generates a secure 256-bit key in .peos/config/master.key.
 * NEVER returns a hardcoded plaintext fallback secret.
 */
export function getMasterSecret(): string {
  // 1. Explicit Environment Variable
  const envSecret = process.env.PRAXELOPS_SECRET;
  if (envSecret && envSecret.trim().length >= 32) {
    return envSecret.trim();
  }

  // 2. Persistent Key File
  if (fs.existsSync(KEY_FILE)) {
    try {
      const stored = fs.readFileSync(KEY_FILE, "utf-8").trim();
      if (stored.length >= 32) {
        return stored;
      }
    } catch {}
  }

  // 3. In production, fail safely if secret is missing
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "FATAL SECURITY CONFIGURATION: PRAXELOPS_SECRET environment variable must be set (min 32 chars) in production."
    );
  }

  // 4. In development, generate and persist a strong random key
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const generatedKey = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(KEY_FILE, generatedKey, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // If filesystem is read-only, return memory key
  }

  return generatedKey;
}
