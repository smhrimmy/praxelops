import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
// NOTE: node builtins / relative .ts imports and erasable-only TypeScript syntax, so plain
// `node --experimental-strip-types` can load this module (scripts/*.ts, multi-process test fixtures).
import { getMasterSecret } from "./secret.ts";
import { runRawTransaction } from "../db/sqliteUtil.ts";

/**
 * Credential vault: envelope encryption for SSH credentials at rest (Milestone 7.2).
 *
 *   master secret (PRAXELOPS_SECRET)
 *     --HKDF-SHA256(salt = meta.vault_kek_salt, info = "praxelops/kek/v1")--> KEK (32 bytes, never stored)
 *   KEK --AES-256-GCM, aad "praxelops/dek/v1"--> wraps DEK (32 random bytes)  => meta.vault_dek_v1
 *   DEK --AES-256-GCM, random 12-byte nonce, aad "server:<id>:<column>"--> `enc:v1:<nonce>:<ct>:<tag>` per value
 *
 * The DEK exists on disk only wrapped. `meta.vault_key_check` (HMAC of a constant under the KEK) lets a wrong
 * secret be reported clearly before any decryption is attempted. Rotating the master secret re-wraps the DEK
 * (see rotateVaultKey) and never touches the credentials themselves.
 */

export const KEK_INFO = "praxelops/kek/v1";
export const DEK_AAD = "praxelops/dek/v1";
export const KEY_CHECK_LABEL = "praxelops/vault-key-check/v1";
export const ENC_PREFIX = "enc:v1:";
export const WRAPPED_DEK_PREFIX = "v1:";

export const META_KEK_SALT = "vault_kek_salt";
export const META_WRAPPED_DEK = "vault_dek_v1";
export const META_KEY_CHECK = "vault_key_check";

const KEY_BYTES = 32;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The credential columns of the servers table (their names are part of each ciphertext's AAD). */
export const CREDENTIAL_COLUMNS = ["password", "private_key", "passphrase"] as const;
export type CredentialColumn = (typeof CREDENTIAL_COLUMNS)[number];

/** Raised for every vault failure. Messages never contain key material or plaintext. */
export class VaultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultError";
  }
}

const DECRYPT_FAILED =
  "Credential decryption failed — PRAXELOPS_SECRET differs from the one used to encrypt, or data was tampered";
const WRONG_SECRET =
  "Credential vault cannot be unlocked — PRAXELOPS_SECRET differs from the one used to encrypt this database's credentials";

// ---------------------------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------------------------

const B64 = "[A-Za-z0-9+/]+={0,2}";
const ENCRYPTED_RE = new RegExp(`^enc:v1:(${B64}):(${B64}):(${B64})$`);
const WRAPPED_RE = new RegExp(`^v1:(${B64}):(${B64}):(${B64})$`);

interface Sealed {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function parseSealed(match: RegExpMatchArray | null): Sealed | null {
  if (match === null) return null;
  const nonce = Buffer.from(match[1], "base64");
  const ciphertext = Buffer.from(match[2], "base64");
  const tag = Buffer.from(match[3], "base64");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) return null;
  return { nonce, ciphertext, tag };
}

/** True iff `value` has the exact shape of an encrypted credential. Says nothing about whether it decrypts. */
export function isEncryptedCredential(value: string): boolean {
  return parseSealed(ENCRYPTED_RE.exec(value)) !== null;
}

function seal(key: Buffer, aad: string, plaintext: Buffer): Sealed {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/** Returns null when authentication fails (wrong key, wrong AAD, or tampered nonce/ciphertext/tag). */
function open(key: Buffer, aad: string, sealed: Sealed): Buffer | null {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

function encode(prefix: string, s: Sealed): string {
  return `${prefix}${s.nonce.toString("base64")}:${s.ciphertext.toString("base64")}:${s.tag.toString("base64")}`;
}

// ---------------------------------------------------------------------------------------------
// Key hierarchy
// ---------------------------------------------------------------------------------------------

function deriveKek(secret: string, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), salt, KEK_INFO, KEY_BYTES));
}

function keyCheckValue(kek: Buffer): string {
  return `v1:${crypto.createHmac("sha256", kek).update(KEY_CHECK_LABEL).digest("base64")}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

interface VaultMeta {
  salt: string;
  wrappedDek: string;
  keyCheck: string;
}

function readMetaValue(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return typeof row?.value === "string" ? row.value : undefined;
}

/** Null when the vault has never been created; throws if only part of it exists (corruption). */
function readVaultMeta(db: DatabaseSync): VaultMeta | null {
  const salt = readMetaValue(db, META_KEK_SALT);
  const wrappedDek = readMetaValue(db, META_WRAPPED_DEK);
  const keyCheck = readMetaValue(db, META_KEY_CHECK);
  if (salt === undefined && wrappedDek === undefined && keyCheck === undefined) return null;
  if (salt === undefined || wrappedDek === undefined || keyCheck === undefined) {
    throw new VaultError("Credential vault metadata is incomplete (database corrupted or partially restored)");
  }
  return { salt, wrappedDek, keyCheck };
}

function unwrapDek(meta: VaultMeta, secret: string): Buffer {
  const salt = Buffer.from(meta.salt, "base64");
  if (salt.length !== SALT_BYTES) throw new VaultError("Credential vault metadata is corrupted (bad KEK salt)");
  const kek = deriveKek(secret, salt);
  try {
    // Clear "wrong secret" error before any decryption is attempted.
    if (!safeEqual(keyCheckValue(kek), meta.keyCheck)) throw new VaultError(WRONG_SECRET);
    const sealed = parseSealed(WRAPPED_RE.exec(meta.wrappedDek));
    if (sealed === null) throw new VaultError("Credential vault metadata is corrupted (bad wrapped key encoding)");
    const dek = open(kek, DEK_AAD, sealed);
    if (dek === null || dek.length !== KEY_BYTES) throw new VaultError(DECRYPT_FAILED);
    return dek;
  } finally {
    kek.fill(0);
  }
}

function wrapDek(dek: Buffer, secret: string): VaultMeta {
  const salt = crypto.randomBytes(SALT_BYTES);
  const kek = deriveKek(secret, salt);
  try {
    return {
      salt: salt.toString("base64"),
      wrappedDek: encode(WRAPPED_DEK_PREFIX, seal(kek, DEK_AAD, dek)),
      keyCheck: keyCheckValue(kek),
    };
  } finally {
    kek.fill(0);
  }
}

function writeVaultMeta(db: DatabaseSync, meta: VaultMeta, mode: "insert" | "replace"): void {
  const verb = mode === "insert" ? "INSERT" : "INSERT OR REPLACE";
  const stmt = db.prepare(`${verb} INTO meta (key, value) VALUES (?, ?)`);
  stmt.run(META_KEK_SALT, meta.salt);
  stmt.run(META_WRAPPED_DEK, meta.wrappedDek);
  stmt.run(META_KEY_CHECK, meta.keyCheck);
}

/** Runs `fn` under the write lock: directly if the caller already holds a transaction, else BEGIN IMMEDIATE. */
function withWriteLock<T>(db: DatabaseSync, fn: () => T): T {
  return db.isTransaction ? fn() : runRawTransaction(db, fn);
}

// ---------------------------------------------------------------------------------------------
// DEK access
// ---------------------------------------------------------------------------------------------

const dekCache = new WeakMap<DatabaseSync, Buffer>();

/** Forgets the cached DEK for one connection (or all future lookups of it). Tests / rotation use this. */
export function clearVaultCache(db: DatabaseSync): void {
  const cached = dekCache.get(db);
  if (cached) cached.fill(0);
  dekCache.delete(db);
}

/**
 * Returns the data-encryption key, creating the vault on first use.
 *
 * Creation happens under BEGIN IMMEDIATE (or inside the caller's transaction) with a re-check, so two processes
 * first-starting at once produce exactly one DEK. The DEK is cached per connection after the first unwrap, but
 * only when no transaction is open: a DEK created inside a transaction that later rolls back must not outlive it.
 * `secret` defaults to getMasterSecret(); pass one explicitly only for tools (rotation) and tests.
 */
export function getVaultDek(db: DatabaseSync, secret?: string): Buffer {
  const cached = dekCache.get(db);
  if (cached !== undefined && secret === undefined) return cached;

  const master = secret ?? getMasterSecret();
  const existing = readVaultMeta(db);
  let dek: Buffer;
  if (existing !== null) {
    dek = unwrapDek(existing, master);
  } else {
    dek = withWriteLock(db, () => {
      const winner = readVaultMeta(db); // re-check under the write lock
      if (winner !== null) return unwrapDek(winner, master);
      const fresh = crypto.randomBytes(KEY_BYTES);
      writeVaultMeta(db, wrapDek(fresh, master), "insert");
      return fresh;
    });
  }
  if (secret === undefined && !db.isTransaction) dekCache.set(db, dek);
  return dek;
}

/** True once the vault metadata exists (does not need the master secret). */
export function vaultExists(db: DatabaseSync): boolean {
  return readVaultMeta(db) !== null;
}

// ---------------------------------------------------------------------------------------------
// Field encryption
// ---------------------------------------------------------------------------------------------

function aadFor(serverId: string, column: CredentialColumn): string {
  return `server:${serverId}:${column}`;
}

/** Encrypts one credential. Empty values must be stored as NULL by the caller (they are rejected here). */
export function encryptCredential(dek: Buffer, serverId: string, column: CredentialColumn, plaintext: string): string {
  if (plaintext.length === 0) throw new VaultError("Refusing to encrypt an empty credential (store NULL instead)");
  return encode(ENC_PREFIX, seal(dek, aadFor(serverId, column), Buffer.from(plaintext, "utf8")));
}

/**
 * Decrypts one stored credential. Fails closed: anything that is not a well-formed `enc:v1:` value (including
 * legacy plaintext) throws, as does any authentication failure (wrong key, wrong row/column, tampering).
 */
export function decryptCredential(dek: Buffer, serverId: string, column: CredentialColumn, stored: string): string {
  const sealed = parseSealed(ENCRYPTED_RE.exec(stored));
  if (sealed === null) {
    throw new VaultError(
      `Stored credential for server '${serverId}' (${column}) is not in encrypted form; refusing to use it`
    );
  }
  const plaintext = open(dek, aadFor(serverId, column), sealed);
  if (plaintext === null) throw new VaultError(DECRYPT_FAILED);
  return plaintext.toString("utf8");
}

// ---------------------------------------------------------------------------------------------
// Migration 2 helper + key rotation
// ---------------------------------------------------------------------------------------------

interface CredentialRow {
  id: string;
  password: string | null;
  private_key: string | null;
  passphrase: string | null;
}

function readCredentialRows(db: DatabaseSync): CredentialRow[] {
  return db
    .prepare("SELECT id, password, private_key, passphrase FROM servers ORDER BY rowid")
    .all()
    .map((row) => ({
      id: String(row.id),
      password: typeof row.password === "string" ? row.password : null,
      private_key: typeof row.private_key === "string" ? row.private_key : null,
      passphrase: typeof row.passphrase === "string" ? row.passphrase : null,
    }));
}

/**
 * Encrypts, in place, every credential that is not already in `enc:v1:` form. Runs inside the caller's
 * transaction. The vault (and therefore the master secret) is only touched if there is something to encrypt.
 * Returns how many values were encrypted. Empty strings become NULL.
 */
export function encryptPlaintextCredentials(db: DatabaseSync): number {
  let dek: Buffer | undefined;
  let count = 0;
  for (const row of readCredentialRows(db)) {
    for (const column of CREDENTIAL_COLUMNS) {
      const value = row[column];
      if (value === null || isEncryptedCredential(value)) continue;
      if (value.length === 0) {
        db.prepare(`UPDATE servers SET ${column} = NULL WHERE id = ?`).run(row.id);
        continue;
      }
      dek ??= getVaultDek(db);
      db.prepare(`UPDATE servers SET ${column} = ? WHERE id = ?`).run(
        encryptCredential(dek, row.id, column, value),
        row.id
      );
      count++;
    }
  }
  return count;
}

export interface RotationResult {
  /** False when the database has no vault yet (no credentials ever stored): nothing to re-wrap. */
  rotated: boolean;
  credentialsVerified: number;
}

/**
 * Re-wraps the DEK under a KEK derived from `newSecret`, in one transaction. Before touching anything it unlocks
 * the vault with `oldSecret` (clear error if wrong) and decrypts EVERY stored credential with it; any failure
 * aborts with nothing changed. The credentials themselves are not re-encrypted. A fresh KEK salt is generated.
 */
export function rotateVaultKey(db: DatabaseSync, oldSecret: string, newSecret: string): RotationResult {
  return withWriteLock(db, () => {
    const meta = readVaultMeta(db);
    if (meta === null) {
      // No vault means no encrypted credentials; refuse if plaintext ones exist (they would be unprotected).
      for (const row of readCredentialRows(db)) {
        for (const column of CREDENTIAL_COLUMNS) {
          if (row[column] !== null) {
            throw new VaultError(`Server '${row.id}' (${column}) has a credential but no vault exists`);
          }
        }
      }
      return { rotated: false, credentialsVerified: 0 };
    }
    const dek = unwrapDek(meta, oldSecret);
    let verified = 0;
    for (const row of readCredentialRows(db)) {
      for (const column of CREDENTIAL_COLUMNS) {
        const value = row[column];
        if (value === null) continue;
        decryptCredential(dek, row.id, column, value);
        verified++;
      }
    }
    writeVaultMeta(db, wrapDek(dek, newSecret), "replace");
    // Prove the new wrapping before the transaction can commit.
    const check = readVaultMeta(db);
    if (check === null || !unwrapDek(check, newSecret).equals(dek)) {
      throw new VaultError("Re-wrapped key failed verification; rotation aborted");
    }
    dek.fill(0);
    return { rotated: true, credentialsVerified: verified };
  });
}
