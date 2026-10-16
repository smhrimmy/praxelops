import { describe, it, expect } from "vitest";
import { AuthService } from "./auth";

describe("AuthService", () => {
  it("creates and validates operator sessions", () => {
    const session = AuthService.createOperatorSession("admin-operator", 1);
    expect(session.token).toBeDefined();
    expect(session.csrfToken).toBeDefined();
    expect(session.expiresAt).toBeGreaterThan(Date.now());

    // Valid header authentication
    const validReq = new Request("http://localhost:3000/api/servers", {
      headers: { "x-praxel-auth": session.token },
    });
    const auth = AuthService.authenticateRequest(validReq);
    expect(auth.authenticated).toBe(true);
    expect(auth.operatorId).toBe("admin-operator");
  });

  it("rejects invalid or expired session tokens", () => {
    const fakeReq = new Request("http://localhost:3000/api/servers", {
      headers: { "x-praxel-auth": "non-existent-token-12345678" },
    });
    const auth = AuthService.authenticateRequest(fakeReq);
    expect(auth.authenticated).toBe(false);
    expect(auth.error).toContain("invalid or expired");
  });

  it("enforces rate limits within sliding windows", () => {
    const clientId = `test-client-${Date.now()}`;
    // 3 requests allowed in 60s
    const r1 = AuthService.checkRateLimit(clientId, 3, 60);
    expect(r1.allowed).toBe(true);

    const r2 = AuthService.checkRateLimit(clientId, 3, 60);
    expect(r2.allowed).toBe(true);

    const r3 = AuthService.checkRateLimit(clientId, 3, 60);
    expect(r3.allowed).toBe(true);

    const r4 = AuthService.checkRateLimit(clientId, 3, 60);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
  });

  it("enforces request payload size limits", () => {
    const smallReq = new Request("http://localhost:3000/api/servers", {
      headers: { "content-length": "500" },
    });
    expect(AuthService.checkPayloadSize(smallReq, 1000)).toBe(true);

    const largeReq = new Request("http://localhost:3000/api/servers", {
      headers: { "content-length": "50000" },
    });
    expect(AuthService.checkPayloadSize(largeReq, 1000)).toBe(false);
  });

  it("redacts sensitive fields in nested log objects", () => {
    const raw = {
      username: "operator",
      password: "SuperSecretPassword123!",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret",
      metadata: {
        clientToken: "token-secret-999",
        safeNote: "Routine maintenance",
      },
    };

    const redacted = AuthService.redactSecrets(raw);
    expect(redacted.username).toBe("operator");
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.privateKey).toBe("[REDACTED]");
    expect(redacted.metadata.clientToken).toBe("[REDACTED]");
    expect(redacted.metadata.safeNote).toBe("Routine maintenance");
  });
});
