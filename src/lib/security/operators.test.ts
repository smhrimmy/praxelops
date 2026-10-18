import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { getDb } from "../db/database";
import { StorageCorruptError } from "../storage/atomicFile";
import {
  createOperator,
  findOperatorByUsername,
  getOperatorsFilePath,
  hashPassword,
  listOperators,
  OperatorExistsError,
  PasswordSchema,
  UsernameSchema,
  verifyOperatorCredentials,
  verifyPassword,
} from "./operators";

const GOOD_PASSWORD = "correct horse battery staple";

describe("operator password hashing", () => {
  it("round-trips and uses the documented scrypt$N$r$p$salt$hash format", async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    const parts = hash.split("$");
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(["scrypt", String(1 << 15), "8", "1"]);
    expect(Buffer.from(parts[4], "base64")).toHaveLength(32);
    expect(Buffer.from(parts[5], "base64")).toHaveLength(64);

    expect(await verifyPassword(GOOD_PASSWORD, hash)).toBe(true);
  });

  it("rejects a wrong password and salts each hash uniquely", async () => {
    const h1 = await hashPassword(GOOD_PASSWORD);
    const h2 = await hashPassword(GOOD_PASSWORD);
    expect(h1).not.toBe(h2);
    expect(await verifyPassword("correct horse battery stapl", h1)).toBe(false);
    expect(await verifyPassword("", h1)).toBe(false);
  });

  it("treats malformed or abusive stored hashes as a failed verification, not a crash", async () => {
    expect(await verifyPassword(GOOD_PASSWORD, "garbage")).toBe(false);
    expect(await verifyPassword(GOOD_PASSWORD, "scrypt$3$8$1$AAAA$AAAA")).toBe(false); // N not a power of two
    expect(await verifyPassword(GOOD_PASSWORD, `scrypt$${2 ** 30}$8$1$AAAA$AAAA`)).toBe(false); // N over cap
    expect(await verifyPassword(GOOD_PASSWORD, "bcrypt$1$2$3$AAAA$AAAA")).toBe(false);
  });
});

describe("operator input validation", () => {
  it("accepts only [a-z0-9_.-]{3,32} usernames", () => {
    for (const ok of ["abc", "op.erator_1-x", "a".repeat(32), "123"]) {
      expect(UsernameSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["ab", "a".repeat(33), "Admin", "has space", "semi;colon", "slash/", "unié", "", "new\nline"]) {
      expect(UsernameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("requires passwords of at least 12 characters", () => {
    expect(PasswordSchema.safeParse("a".repeat(11)).success).toBe(false);
    expect(PasswordSchema.safeParse("a".repeat(12)).success).toBe(true);
  });
});

describe("operator store", () => {
  it("creates, stores a hash (never the password), verifies, and refuses duplicates without reset", async () => {
    const { operator, created } = await createOperator("store-alice", GOOD_PASSWORD);
    expect(created).toBe(true);
    expect(operator.username).toBe("store-alice");

    // Scan the raw database file and its write-ahead log: the password must not be on disk anywhere.
    const dbFile = getOperatorsFilePath();
    const raw = [dbFile, `${dbFile}-wal`]
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f).toString("latin1"))
      .join(" ");
    expect(raw).not.toContain(GOOD_PASSWORD);
    expect(raw).toContain("scrypt$");
    expect(findOperatorByUsername("store-alice")?.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(listOperators().map((o) => o.username)).toContain("store-alice");

    const ok = await verifyOperatorCredentials("store-alice", GOOD_PASSWORD);
    expect(ok?.id).toBe(operator.id);

    expect(await verifyOperatorCredentials("store-alice", "wrong password 123")).toBeNull();

    await expect(createOperator("store-alice", "another long password")).rejects.toBeInstanceOf(OperatorExistsError);
    // Original credential still works after the refused overwrite.
    expect(await verifyOperatorCredentials("store-alice", GOOD_PASSWORD)).not.toBeNull();
  });

  it("--reset replaces the password but keeps the operator id", async () => {
    const first = await createOperator("store-bob", GOOD_PASSWORD);
    const second = await createOperator("store-bob", "brand new passphrase!", { reset: true });
    expect(second.created).toBe(false);
    expect(second.operator.id).toBe(first.operator.id);
    expect(await verifyOperatorCredentials("store-bob", GOOD_PASSWORD)).toBeNull();
    expect(await verifyOperatorCredentials("store-bob", "brand new passphrase!")).not.toBeNull();
  });

  it("rejects invalid usernames/passwords at creation", async () => {
    await expect(createOperator("Bad Name", GOOD_PASSWORD)).rejects.toThrow();
    await expect(createOperator("store-carol", "short")).rejects.toThrow();
    expect(findOperatorByUsername("store-carol")).toBeUndefined();
  });

  it("returns null for unknown users but still spends scrypt time (timing equalization)", async () => {
    await createOperator("store-dave", GOOD_PASSWORD);

    const time = async (fn: () => Promise<unknown>) => {
      const t0 = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };

    const unknown = await time(() => verifyOperatorCredentials("no-such-user", GOOD_PASSWORD));
    const wrong = await time(() => verifyOperatorCredentials("store-dave", "wrong password 123"));

    expect(await verifyOperatorCredentials("no-such-user", GOOD_PASSWORD)).toBeNull();
    // Both paths run exactly one scrypt (tens of ms); the unknown-user path must not be near-instant.
    expect(unknown).toBeGreaterThan(wrong * 0.3);
    expect(unknown).toBeGreaterThan(10);
  });

  it("lets exactly one of two concurrent creations of the same username win", async () => {
    const results = await Promise.allSettled([
      createOperator("store-erin", GOOD_PASSWORD),
      createOperator("store-erin", "a different long password"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(OperatorExistsError);
    expect(listOperators().filter((o) => o.username === "store-erin")).toHaveLength(1);
  });

  it("fails closed (throws) when an operator row is malformed instead of treating it as absent", async () => {
    await createOperator("store-frank", GOOD_PASSWORD);
    getDb().prepare("UPDATE operators SET password_hash = '' WHERE username = ?").run("store-frank");
    expect(() => findOperatorByUsername("store-frank")).toThrow(StorageCorruptError);
    await expect(verifyOperatorCredentials("store-frank", GOOD_PASSWORD)).rejects.toThrow(StorageCorruptError);
    getDb().prepare("DELETE FROM operators WHERE username = ?").run("store-frank");
  });
});
