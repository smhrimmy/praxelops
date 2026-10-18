import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeDb, DatabaseOpenError, getDb, getDbPath, withTransaction } from "../db/database";
import { LATEST_VERSION, MIGRATIONS, runMigrations } from "../db/migrations";
import { StorageService } from "../storage";
import type { ServerHost } from "@/types/server";
import {
  clearVaultCache,
  decryptCredential,
  encryptCredential,
  getVaultDek,
  isEncryptedCredential,
  rotateVaultKey,
  VaultError,
} from "./vault";

const SECRET_A = "a".repeat(8) + crypto.randomBytes(24).toString("hex");
const SECRET_B = "b".repeat(8) + crypto.randomBytes(24).toString("hex");

function withFreshDataDir<T>(fn: (dir: string) => T, secret: string = SECRET_A): T {
  const previousDir = process.env.PRAXELOPS_DATA_DIR;
  const previousSecret = process.env.PRAXELOPS_SECRET;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "praxelops-vault-"));
  process.env.PRAXELOPS_DATA_DIR = dir;
  process.env.PRAXELOPS_SECRET = secret;
  try {
    return fn(dir);
  } finally {
    closeDb();
    process.env.PRAXELOPS_DATA_DIR = previousDir;
    process.env.PRAXELOPS_SECRET = previousSecret;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function makeServer(id: string, extra: Record<string, unknown> = {}): ServerHost {
  return {
    id,
    name: `Server ${id}`,
    host: "192.168.1.50",
    port: 22,
    username: "ubuntu",
    authType: "password" as const,
    tags: [],
    status: "online" as const,
    osType: "linux" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

/** Raw bytes of the database file plus its write-ahead log. */
function rawBytes(): Buffer {
  const base = getDbPath();
  return Buffer.concat(
    [base, `${base}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f))
  );
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  return db;
}

/** Flips one byte inside the nonce (0), ciphertext (1) or tag (2) segment of an `enc:v1:` value. */
function tamper(value: string, segment: 0 | 1 | 2): string {
  const parts = value.split(":");
  const index = 2 + segment;
  const bytes = Buffer.from(parts[index], "base64");
  bytes[0] ^= 0x01;
  parts[index] = bytes.toString("base64");
  return parts.join(":");
}

afterEach(() => {
  closeDb();
});

describe("vault: field encryption", () => {
  it("round-trips arbitrary credentials (unicode, multi-line keys) and uses the documented encoding", () => {
    const db = memoryDb();
    const dek = getVaultDek(db, SECRET_A);
    const values = ["hunter2", "pässwörd-🔐", "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\n"];
    for (const v of values) {
      const stored = encryptCredential(dek, "srv-1", "password", v);
      expect(stored).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
      expect(isEncryptedCredential(stored)).toBe(true);
      expect(stored).not.toContain(v);
      expect(decryptCredential(dek, "srv-1", "password", stored)).toBe(v);
    }
  });

  it("uses a fresh 12-byte nonce for every value (same plaintext never yields the same ciphertext)", () => {
    const dek = getVaultDek(memoryDb(), SECRET_A);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const stored = encryptCredential(dek, "srv-1", "password", "same-value");
      const [, , nonce, , tag] = stored.split(":");
      expect(Buffer.from(nonce, "base64")).toHaveLength(12);
      expect(Buffer.from(tag, "base64")).toHaveLength(16);
      seen.add(nonce);
      seen.add(stored);
    }
    expect(seen.size).toBe(100);
  });

  it("rejects tampered nonce, ciphertext or tag with a VaultError", () => {
    const dek = getVaultDek(memoryDb(), SECRET_A);
    const stored = encryptCredential(dek, "srv-1", "password", "top-secret");
    for (const segment of [0, 1, 2] as const) {
      expect(() => decryptCredential(dek, "srv-1", "password", tamper(stored, segment))).toThrow(VaultError);
    }
    expect(() => decryptCredential(dek, "srv-1", "password", tamper(stored, 1))).toThrow(/tampered/);
    // Truncated / malformed encodings fail closed too.
    expect(() => decryptCredential(dek, "srv-1", "password", stored.slice(0, -6))).toThrow(VaultError);
    expect(() => decryptCredential(dek, "srv-1", "password", "enc:v1:abc")).toThrow(VaultError);
  });

  it("binds each value to its row and column (swapping values between rows or columns fails)", () => {
    const dek = getVaultDek(memoryDb(), SECRET_A);
    const a = encryptCredential(dek, "srv-A", "password", "pw-of-A");
    const b = encryptCredential(dek, "srv-B", "password", "pw-of-B");
    expect(() => decryptCredential(dek, "srv-B", "password", a)).toThrow(VaultError); // row swap
    expect(() => decryptCredential(dek, "srv-A", "password", b)).toThrow(VaultError);
    expect(() => decryptCredential(dek, "srv-A", "private_key", a)).toThrow(VaultError); // column swap
    expect(() => decryptCredential(dek, "srv-A", "passphrase", a)).toThrow(VaultError);
    expect(decryptCredential(dek, "srv-A", "password", a)).toBe("pw-of-A");
  });

  it("refuses plaintext and empty values", () => {
    const dek = getVaultDek(memoryDb(), SECRET_A);
    expect(() => decryptCredential(dek, "srv-1", "password", "plaintext-password")).toThrow(/not in encrypted form/);
    expect(() => decryptCredential(dek, "srv-1", "password", "enc:v1:looks:encrypted:butnot")).toThrow(VaultError);
    expect(() => encryptCredential(dek, "srv-1", "password", "")).toThrow(VaultError);
  });
});

describe("vault: key hierarchy", () => {
  it("stores the DEK only wrapped, and detects a wrong secret via the key check before decrypting", () => {
    const db = memoryDb();
    const dek = getVaultDek(db, SECRET_A);
    const meta = Object.fromEntries(
      db.prepare("SELECT key, value FROM meta WHERE key LIKE 'vault_%'").all().map((r) => [String(r.key), String(r.value)])
    );
    expect(Object.keys(meta).sort()).toEqual(["vault_dek_v1", "vault_kek_salt", "vault_key_check"]);
    expect(meta.vault_dek_v1).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(meta.vault_kek_salt, "base64")).toHaveLength(32);
    for (const encoding of ["base64", "hex"] as const) {
      expect(JSON.stringify(meta)).not.toContain(dek.toString(encoding));
    }

    // Same secret again unwraps the same DEK; a different secret is a clear VaultError (not a GCM failure).
    expect(getVaultDek(db, SECRET_A).equals(dek)).toBe(true);
    expect(() => getVaultDek(db, SECRET_B)).toThrow(VaultError);
    expect(() => getVaultDek(db, SECRET_B)).toThrow(/cannot be unlocked.*PRAXELOPS_SECRET/);
  });

  it("fails closed when the vault metadata is incomplete or the wrapped key is tampered", () => {
    const db = memoryDb();
    getVaultDek(db, SECRET_A);
    const wrapped = String(db.prepare("SELECT value FROM meta WHERE key = 'vault_dek_v1'").get()?.value);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'vault_dek_v1'").run(tamper(wrapped.replace(/^v1:/, "enc:v1:"), 1).replace(/^enc:v1:/, "v1:"));
    expect(() => getVaultDek(db, SECRET_A)).toThrow(/tampered/);

    db.prepare("DELETE FROM meta WHERE key = 'vault_key_check'").run();
    expect(() => getVaultDek(db, SECRET_A)).toThrow(/incomplete/);
  });

  it("never persists the raw DEK anywhere in the database file or WAL", () => {
    withFreshDataDir(() => {
      StorageService.saveServer(makeServer("srv-1", { password: "PW-NEEDLE-1", privateKey: "KEY-NEEDLE-2", passphrase: "PP-NEEDLE-3" }));
      const dek = getVaultDek(getDb());
      const bytes = rawBytes();
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.includes(dek)).toBe(false);
      expect(bytes.includes(Buffer.from(dek.toString("hex")))).toBe(false);
      expect(bytes.includes(Buffer.from(dek.toString("base64")))).toBe(false);
      expect(bytes.includes(Buffer.from(SECRET_A))).toBe(false);
    });
  });
});

describe("storage integration", () => {
  it("encrypts on save, decrypts on read, and the raw db + WAL never contain the credentials", () => {
    withFreshDataDir(() => {
      StorageService.saveServer(
        makeServer("srv-1", { password: "PW-NEEDLE-1", privateKey: "KEY-NEEDLE-2\nline2", passphrase: "PP-NEEDLE-3" })
      );
      const back = StorageService.getServerById("srv-1") as unknown as Record<string, unknown>;
      expect(back.password).toBe("PW-NEEDLE-1");
      expect(back.privateKey).toBe("KEY-NEEDLE-2\nline2");
      expect(back.passphrase).toBe("PP-NEEDLE-3");

      const raw = rawBytes().toString("latin1");
      expect(raw.length).toBeGreaterThan(0);
      for (const needle of ["PW-NEEDLE-1", "KEY-NEEDLE-2", "PP-NEEDLE-3"]) expect(raw).not.toContain(needle);

      const row = getDb().prepare("SELECT password, private_key, passphrase FROM servers WHERE id = 'srv-1'").get();
      for (const col of ["password", "private_key", "passphrase"]) expect(String(row?.[col])).toMatch(/^enc:v1:/);
    });
  });

  it("stores empty / absent credentials as NULL (no encrypted empty strings) and keeps hasX flags correct", () => {
    withFreshDataDir(() => {
      StorageService.saveServer(makeServer("srv-1", { password: "", privateKey: "k" }));
      const row = getDb().prepare("SELECT password, private_key, passphrase FROM servers WHERE id = 'srv-1'").get();
      expect(row?.password).toBeNull();
      expect(String(row?.private_key)).toMatch(/^enc:v1:/);
      expect(row?.passphrase).toBeNull();
      const pub = StorageService.getPublicServerById("srv-1");
      expect(pub).toMatchObject({ hasPassword: false, hasPrivateKey: true, hasPassphrase: false });
      expect(pub).not.toHaveProperty("privateKey");
      expect(StorageService.getPublicServers()).toHaveLength(1);
    });
  });

  it("does not create a vault (or need a secret) for servers without credentials", () => {
    withFreshDataDir(() => {
      StorageService.saveServer(makeServer("srv-plain"));
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'vault_%'").get()?.n).toBe(0);
    });
  });

  it("updating a server re-encrypts with a fresh nonce and keeps the value", () => {
    withFreshDataDir(() => {
      StorageService.saveServer(makeServer("srv-1", { password: "same" }));
      const first = String(getDb().prepare("SELECT password FROM servers WHERE id = 'srv-1'").get()?.password);
      StorageService.saveServer(makeServer("srv-1", { password: "same" }));
      const second = String(getDb().prepare("SELECT password FROM servers WHERE id = 'srv-1'").get()?.password);
      expect(second).not.toBe(first);
      expect((StorageService.getServerById("srv-1") as unknown as Record<string, unknown>).password).toBe("same");
    });
  });

  it("a plaintext credential found after the migration is never accepted (fail closed)", () => {
    withFreshDataDir(() => {
      StorageService.saveServer(makeServer("srv-1", { password: "real" }));
      getDb().prepare("UPDATE servers SET password = 'smuggled-plaintext' WHERE id = 'srv-1'").run();
      expect(() => StorageService.getServerById("srv-1")).toThrow(VaultError);
      expect(() => StorageService.getServers()).toThrow(/not in encrypted form/);
      // The API-safe views never decrypt, so listing / deleting still works for an operator to clean up.
      expect(StorageService.getPublicServerById("srv-1")).toMatchObject({ hasPassword: true });
      expect(StorageService.deleteServer("srv-1")).toBe(true);
    });
  });

  it("swapping ciphertexts between rows or columns in the database makes reads fail", () => {
    withFreshDataDir(() => {
      StorageService.saveServer(makeServer("srv-A", { password: "pw-A", privateKey: "key-A" }));
      StorageService.saveServer(makeServer("srv-B", { password: "pw-B" }));
      const db = getDb();
      const a = db.prepare("SELECT password, private_key FROM servers WHERE id = 'srv-A'").get();

      db.prepare("UPDATE servers SET password = ? WHERE id = 'srv-B'").run(String(a?.password));
      expect(() => StorageService.getServerById("srv-B")).toThrow(VaultError);

      db.prepare("UPDATE servers SET password = ?, private_key = ? WHERE id = 'srv-A'").run(String(a?.private_key), String(a?.password));
      expect(() => StorageService.getServerById("srv-A")).toThrow(VaultError);
    });
  });

  it("a different PRAXELOPS_SECRET fails with a clear VaultError; the right one works again", () => {
    withFreshDataDir(() => {
      StorageService.saveServer(makeServer("srv-1", { password: "pw" }));
      closeDb();
      process.env.PRAXELOPS_SECRET = SECRET_B;
      expect(() => StorageService.getServerById("srv-1")).toThrow(VaultError);
      expect(() => StorageService.getServerById("srv-1")).toThrow(/PRAXELOPS_SECRET/);
      // Saving with credentials under the wrong secret must not silently create a second vault either.
      expect(() => StorageService.saveServer(makeServer("srv-2", { password: "x" }))).toThrow(VaultError);
      expect(StorageService.getPublicServerById("srv-1")).toBeDefined();
      closeDb();
      process.env.PRAXELOPS_SECRET = SECRET_A;
      expect((StorageService.getServerById("srv-1") as unknown as Record<string, unknown>).password).toBe("pw");
    });
  });

  it("a DEK created inside a transaction that rolls back is not cached or leaked into later writes", () => {
    withFreshDataDir(() => {
      expect(() =>
        withTransaction(() => {
          StorageService.saveServer(makeServer("srv-rolled-back", { password: "gone" }));
          throw new Error("abort");
        })
      ).toThrow(/abort/);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'vault_%'").get()?.n).toBe(0);
      expect(StorageService.getServerById("srv-rolled-back")).toBeUndefined();

      StorageService.saveServer(makeServer("srv-ok", { password: "kept" }));
      closeDb(); // fresh connection, fresh cache: the stored data must decrypt with the persisted vault alone
      expect((StorageService.getServerById("srv-ok") as unknown as Record<string, unknown>).password).toBe("kept");
    });
  });
});

describe("migration 2", () => {
  function seedSchemaV1(dir: string): void {
    const db = new DatabaseSync(path.join(dir, "praxelops.db"));
    db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db, [MIGRATIONS[0]]);
    const insert = db.prepare("INSERT INTO servers (id, data, password, private_key, passphrase) VALUES (?, ?, ?, ?, ?)");
    const data = JSON.stringify({ name: "Legacy", host: "10.1.1.1", port: 22, username: "root", authType: "password", tags: [] });
    insert.run("srv-p", data, "PLAIN-PW-NEEDLE", null, null);
    insert.run("srv-k", data, null, "PLAIN-KEY-NEEDLE", "PLAIN-PP-NEEDLE");
    insert.run("srv-none", data, null, null, null);
    insert.run("srv-empty", data, "", null, null);
    insert.run("srv-lookalike", data, "enc:v1:not-really-encrypted", null, null);
    db.close();
  }

  it("encrypts existing plaintext credentials in place; nothing plaintext remains in db + WAL", () => {
    withFreshDataDir((dir) => {
      seedSchemaV1(dir);
      const db = getDb(); // opens + migrates to the latest version (v2 encrypts the credentials)
      expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v).toBe(LATEST_VERSION);

      const row = (id: string) => db.prepare("SELECT password, private_key, passphrase FROM servers WHERE id = ?").get(id);
      expect(String(row("srv-p")?.password)).toMatch(/^enc:v1:/);
      expect(String(row("srv-k")?.private_key)).toMatch(/^enc:v1:/);
      expect(String(row("srv-k")?.passphrase)).toMatch(/^enc:v1:/);
      expect(row("srv-none")).toMatchObject({ password: null, private_key: null, passphrase: null });
      expect(row("srv-empty")?.password).toBeNull();
      // A plaintext that merely starts with the prefix is still plaintext (strict format check) and gets encrypted.
      expect(String(row("srv-lookalike")?.password)).not.toBe("enc:v1:not-really-encrypted");

      const get = (id: string) => StorageService.getServerById(id) as unknown as Record<string, unknown>;
      expect(get("srv-p").password).toBe("PLAIN-PW-NEEDLE");
      expect(get("srv-k").privateKey).toBe("PLAIN-KEY-NEEDLE");
      expect(get("srv-k").passphrase).toBe("PLAIN-PP-NEEDLE");
      expect(get("srv-lookalike").password).toBe("enc:v1:not-really-encrypted");

      // The replaced plaintext must not survive in free space or WAL frames (opening scrubs with VACUUM + TRUNCATE).
      const raw = rawBytes().toString("latin1");
      for (const needle of ["PLAIN-PW-NEEDLE", "PLAIN-KEY-NEEDLE", "PLAIN-PP-NEEDLE"]) expect(raw).not.toContain(needle);
    });
  });

  it("needs no secret (and creates no vault) when there is nothing to encrypt", () => {
    withFreshDataDir(
      (dir) => {
        const db = new DatabaseSync(path.join(dir, "praxelops.db"));
        runMigrations(db, [MIGRATIONS[0]]);
        db.close();
        delete process.env.PRAXELOPS_SECRET;
        expect(getDb().prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'vault_%'").get()?.n).toBe(0);
      },
      SECRET_A
    );
  });

  it("rolls back entirely (database refuses to open) if the secret cannot unlock an existing vault", () => {
    withFreshDataDir((dir) => {
      StorageService.saveServer(makeServer("srv-1", { password: "pw" }));
      closeDb();
      // Re-create a v1-shaped situation: roll the schema back one version and add a plaintext credential.
      const raw = new DatabaseSync(path.join(dir, "praxelops.db"));
      raw.prepare("DELETE FROM schema_migrations WHERE version >= 2").run();
      raw.prepare("INSERT INTO servers (id, data, password) VALUES ('srv-late', '{}', 'late-plaintext')").run();
      raw.close();
      process.env.PRAXELOPS_SECRET = SECRET_B;
      expect(() => getDb()).toThrow(DatabaseOpenError);
      const check = new DatabaseSync(path.join(dir, "praxelops.db"));
      expect(check.prepare("SELECT password FROM servers WHERE id = 'srv-late'").get()?.password).toBe("late-plaintext");
      expect(check.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 2").get()?.n).toBe(0);
      check.close();
    });
  });
});

describe("rotateVaultKey", () => {
  it("re-wraps the DEK under the new secret without touching the credentials", () => {
    withFreshDataDir(() => {
      StorageService.saveServer(makeServer("srv-1", { password: "pw-1", passphrase: "pp-1" }));
      StorageService.saveServer(makeServer("srv-2", { privateKey: "key-2" }));
      const db = getDb();
      const before = db.prepare("SELECT id, password, private_key, passphrase FROM servers ORDER BY id").all();
      const wrappedBefore = db.prepare("SELECT value FROM meta WHERE key = 'vault_dek_v1'").get()?.value;
      const dekBefore = Buffer.from(getVaultDek(db));

      const result = rotateVaultKey(db, SECRET_A, SECRET_B);
      expect(result).toEqual({ rotated: true, credentialsVerified: 3 });
      expect(db.prepare("SELECT id, password, private_key, passphrase FROM servers ORDER BY id").all()).toEqual(before);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'vault_dek_v1'").get()?.value).not.toBe(wrappedBefore);

      expect(() => getVaultDek(db, SECRET_A)).toThrow(VaultError);
      expect(getVaultDek(db, SECRET_B).equals(dekBefore)).toBe(true);

      closeDb();
      process.env.PRAXELOPS_SECRET = SECRET_B;
      expect((StorageService.getServerById("srv-1") as unknown as Record<string, unknown>).password).toBe("pw-1");
    });
  });

  it("with the wrong old secret, or an undecryptable credential, throws and changes nothing", () => {
    withFreshDataDir(() => {
      StorageService.saveServer(makeServer("srv-1", { password: "pw-1" }));
      StorageService.saveServer(makeServer("srv-2", { password: "pw-2" }));
      const db = getDb();
      const snapshot = () => JSON.stringify(db.prepare("SELECT key, value FROM meta ORDER BY key").all());
      const metaBefore = snapshot();

      expect(() => rotateVaultKey(db, SECRET_B, "c".repeat(40))).toThrow(/cannot be unlocked/);
      expect(snapshot()).toBe(metaBefore);

      db.prepare("UPDATE servers SET password = 'plaintext' WHERE id = 'srv-2'").run();
      expect(() => rotateVaultKey(db, SECRET_A, SECRET_B)).toThrow(VaultError);
      expect(snapshot()).toBe(metaBefore);
      clearVaultCache(db);
      expect(() => getVaultDek(db, SECRET_B)).toThrow(VaultError); // still the old secret
    });
  });

  it("is a no-op when no vault exists yet", () => {
    const db = memoryDb();
    expect(rotateVaultKey(db, SECRET_A, SECRET_B)).toEqual({ rotated: false, credentialsVerified: 0 });
  });
});
