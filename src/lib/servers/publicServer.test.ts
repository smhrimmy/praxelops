import { describe, it, expect } from "vitest";
import { toPublicServer, toPublicServers, type StoredServer } from "./publicServer";

const base: StoredServer = {
  id: "srv-pub-01",
  name: "Public Test",
  host: "10.0.0.1",
  port: 22,
  username: "root",
  authType: "password",
  tags: ["a"],
  status: "online",
  osType: "linux",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("toPublicServer", () => {
  it("strips password, privateKey and passphrase and sets presence flags", () => {
    const pub = toPublicServer({
      ...base,
      password: "s3cret-pw",
      privateKey: "-----BEGIN KEY-----abc",
      passphrase: "s3cret-pp",
    });
    expect(pub).not.toHaveProperty("password");
    expect(pub).not.toHaveProperty("privateKey");
    expect(pub).not.toHaveProperty("passphrase");
    expect(pub.hasPassword).toBe(true);
    expect(pub.hasPrivateKey).toBe(true);
    expect(pub.hasPassphrase).toBe(true);
    const json = JSON.stringify(pub);
    expect(json).not.toContain("s3cret-pw");
    expect(json).not.toContain("BEGIN KEY");
    expect(json).not.toContain("s3cret-pp");
  });

  it("sets flags false when secrets are absent or empty and preserves other fields", () => {
    const pub = toPublicServer({ ...base, password: "" });
    expect(pub.hasPassword).toBe(false);
    expect(pub.hasPrivateKey).toBe(false);
    expect(pub.hasPassphrase).toBe(false);
    expect(pub).not.toHaveProperty("password");
    expect(pub.name).toBe(base.name);
    expect(pub.host).toBe(base.host);
    expect(pub.tags).toEqual(["a"]);
  });

  it("does not mutate the input", () => {
    const input: StoredServer = { ...base, password: "pw" };
    toPublicServer(input);
    expect(input.password).toBe("pw");
  });

  it("maps lists", () => {
    const list = toPublicServers([{ ...base, privateKey: "k" }, base]);
    expect(list.map((s) => s.hasPrivateKey)).toEqual([true, false]);
  });
});
