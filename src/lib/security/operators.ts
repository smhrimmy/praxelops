import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
// NOTE: relative imports WITH .ts extensions and erasable-only TypeScript syntax, so that plain
// `node --experimental-strip-types scripts/create-operator.ts` can load this module.
import { getDataDir } from "../storage/dataDir.ts";
import { atomicWriteFileSync, readJsonStrict, StorageCorruptError, withFileLockSync } from "../storage/atomicFile.ts";

/** scrypt cost parameters for NEW hashes. Existing hashes carry their own parameters. */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 32;
const KEY_BYTES = 64;
const HASH_PREFIX = "scrypt";

/** Upper bounds accepted from a stored hash, so a tampered file cannot make verification exhaust memory/CPU. */
const MAX_N = 1 << 20;
const MAX_R = 16;
const MAX_P = 4;

export const UsernameSchema = z
  .string()
  .regex(/^[a-z0-9_.-]{3,32}$/, "Username must be 3-32 characters of a-z, 0-9, '_', '.', '-'");

export const MIN_PASSWORD_LENGTH = 12;
/** Upper bound only limits hashing cost for oversized inputs. */
export const MAX_PASSWORD_LENGTH = 1024;

export const PasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);

const OperatorRecordSchema = z.object({
  id: z.string().min(1),
  username: UsernameSchema,
  passwordHash: z.string().min(1),
  createdAt: z.string().min(1),
});

const OperatorsFileSchema = z.array(OperatorRecordSchema);

export type OperatorRecord = z.infer<typeof OperatorRecordSchema>;

/** Operator data that is safe to hand to callers (never includes the hash). */
export interface OperatorIdentity {
  id: string;
  username: string;
}

export class OperatorExistsError extends Error {
  constructor(username: string) {
    super(`Operator '${username}' already exists (use --reset to replace its password)`);
    this.name = "OperatorExistsError";
  }
}

function scryptAsync(password: string, salt: Buffer, keylen: number, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // scrypt needs ~128 * N * r bytes; give it 2x headroom (default maxmem is 32 MiB, i.e. too small for N=2^15, r=8).
    const maxmem = 256 * n * r + 1024 * 1024;
    crypto.scrypt(password.normalize("NFKC"), salt, keylen, { N: n, r, p, maxmem }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** Returns `scrypt$N$r$p$saltB64$hashB64`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_BYTES, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [HASH_PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), key.toString("base64")].join("$");
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | undefined {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) return undefined;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || n < 2 || n > MAX_N || (n & (n - 1)) !== 0) return undefined;
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) return undefined;
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) return undefined;
  const salt = Buffer.from(parts[4], "base64");
  const key = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || key.length === 0) return undefined;
  return { n, r, p, salt, key };
}

/**
 * Constant-time password check against a stored hash. A malformed stored hash returns false
 * (after doing equivalent scrypt work) rather than throwing.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) {
    await verifyAgainstDummy(password);
    return false;
  }
  const candidate = await scryptAsync(password, parsed.salt, parsed.key.length, parsed.n, parsed.r, parsed.p);
  return candidate.length === parsed.key.length && crypto.timingSafeEqual(candidate, parsed.key);
}

/** Fixed, well-formed hash with current cost parameters; its only job is to burn the same CPU as a real check. */
const DUMMY_HASH = [
  HASH_PREFIX,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  Buffer.alloc(SALT_BYTES, 0x5a).toString("base64"),
  Buffer.alloc(KEY_BYTES, 0xa5).toString("base64"),
].join("$");

async function verifyAgainstDummy(password: string): Promise<void> {
  const parsed = parseHash(DUMMY_HASH);
  if (!parsed) return;
  await scryptAsync(password, parsed.salt, parsed.key.length, parsed.n, parsed.r, parsed.p);
}

export function getOperatorsFilePath(): string {
  return path.join(getDataDir(), "operators.json");
}

function readOperators(file: string): OperatorRecord[] {
  const raw = readJsonStrict<unknown>(file);
  if (raw === undefined) return [];
  const parsed = OperatorsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StorageCorruptError(file, parsed.error);
  }
  return parsed.data;
}

export function findOperatorByUsername(username: string): OperatorRecord | undefined {
  return readOperators(getOperatorsFilePath()).find((o) => o.username === username);
}

export function listOperators(): OperatorIdentity[] {
  return readOperators(getOperatorsFilePath()).map((o) => ({ id: o.id, username: o.username }));
}

export interface CreateOperatorOptions {
  /** Replace the password of an existing operator instead of failing. */
  reset?: boolean;
}

export interface CreateOperatorResult {
  operator: OperatorIdentity;
  created: boolean;
}

/** Creates (or, with reset, re-passwords) an operator. Input is validated with Zod; storage is locked + atomic. */
export async function createOperator(
  usernameInput: string,
  passwordInput: string,
  options: CreateOperatorOptions = {}
): Promise<CreateOperatorResult> {
  const username = UsernameSchema.parse(usernameInput);
  const password = PasswordSchema.parse(passwordInput);
  // Hash outside the (synchronous) file lock; scrypt is slow.
  const passwordHash = await hashPassword(password);
  const file = getOperatorsFilePath();

  return withFileLockSync(file, () => {
    const operators = readOperators(file);
    const existing = operators.find((o) => o.username === username);
    if (existing && !options.reset) {
      throw new OperatorExistsError(username);
    }
    let record: OperatorRecord;
    if (existing) {
      record = { ...existing, passwordHash };
      operators[operators.indexOf(existing)] = record;
    } else {
      record = {
        id: `op_${crypto.randomBytes(6).toString("hex")}`,
        username,
        passwordHash,
        createdAt: new Date().toISOString(),
      };
      operators.push(record);
    }
    atomicWriteFileSync(file, JSON.stringify(operators, null, 2));
    return { operator: { id: record.id, username: record.username }, created: !existing };
  });
}

/**
 * Checks operator credentials. Always performs exactly one scrypt derivation, whether or not
 * the username exists, so response time does not reveal valid usernames.
 */
export async function verifyOperatorCredentials(username: string, password: string): Promise<OperatorIdentity | null> {
  if (password.length > MAX_PASSWORD_LENGTH) {
    await verifyAgainstDummy("");
    return null;
  }
  let record: OperatorRecord | undefined;
  if (UsernameSchema.safeParse(username).success) {
    record = findOperatorByUsername(username);
  }
  if (!record) {
    await verifyAgainstDummy(password);
    return null;
  }
  const ok = await verifyPassword(password, record.passwordHash);
  return ok ? { id: record.id, username: record.username } : null;
}
