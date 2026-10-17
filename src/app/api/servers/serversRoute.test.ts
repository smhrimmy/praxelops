import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as serversGet, POST as serversPost } from "@/app/api/servers/route";
import { createOperator } from "@/lib/security/operators";
import { StorageService } from "@/lib/storage";

const ORIGIN = "http://localhost:3000";
const USERNAME = "servers-route-operator";
const PASSWORD = "servers route operator pass 123";
const SECRET_KEYS = /"(password|privateKey|passphrase)"\s*:/;

let cookie = "";
let csrf = "";
const createdIds: string[] = [];

describe("/api/servers responses never contain secrets", () => {
  beforeAll(async () => {
    await createOperator(USERNAME, PASSWORD);
    const login = await loginPost(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77", origin: ORIGIN },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      })
    );
    expect(login.status).toBe(200);
    csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
    const match = (login.headers.get("set-cookie") ?? "").match(/praxel_session=([^;]+)/);
    expect(match).not.toBeNull();
    cookie = `praxel_session=${match![1]}`;
  });

  afterAll(() => {
    for (const id of createdIds) StorageService.deleteServer(id);
  });

  it("POST 201 body omits password/privateKey/passphrase and reports presence flags", async () => {
    const res = await serversPost(
      new Request("http://localhost:3000/api/servers", {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Secret Holder",
          host: "192.0.2.10",
          port: 22,
          username: "deploy",
          authType: "privateKey",
          password: "leak-pw-123",
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----leak",
          passphrase: "leak-pp-456",
        }),
      })
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toMatch(SECRET_KEYS);
    expect(text).not.toContain("leak-pw-123");
    expect(text).not.toContain("BEGIN OPENSSH");
    expect(text).not.toContain("leak-pp-456");
    const body = JSON.parse(text) as { data: { id: string; hasPassword: boolean; hasPrivateKey: boolean; hasPassphrase: boolean } };
    createdIds.push(body.data.id);
    expect(body.data.hasPassword).toBe(true);
    expect(body.data.hasPrivateKey).toBe(true);
    expect(body.data.hasPassphrase).toBe(true);

    // Secrets remain stored server-side so SSH can still authenticate.
    const stored = StorageService.getServerById(body.data.id) as unknown as Record<string, unknown>;
    expect(stored.privateKey).toBe("-----BEGIN OPENSSH PRIVATE KEY-----leak");
  });

  it("GET list body omits password/privateKey/passphrase", async () => {
    const res = await serversGet(
      new Request("http://localhost:3000/api/servers", { headers: { cookie, origin: ORIGIN } })
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(SECRET_KEYS);
    expect(text).not.toContain("leak-pw-123");
    expect(text).not.toContain("leak-pp-456");
    const body = JSON.parse(text) as { data: Array<{ id: string; hasPrivateKey: boolean }> };
    const mine = body.data.find((s) => s.id === createdIds[0]);
    expect(mine?.hasPrivateKey).toBe(true);
  });
});
