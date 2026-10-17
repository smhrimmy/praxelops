import { describe, it, expect, afterEach, vi } from "vitest";
import { AuthService, SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from "./auth";

const ORIGIN = "http://localhost:3000";

function req(
  method: string,
  headers: Record<string, string> = {},
  url = "http://localhost:3000/api/servers"
): Request {
  return new Request(url, { method, headers });
}

function cookieFor(token: string): string {
  return `praxel_session=${token}`;
}

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

describe("AuthService request authentication", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("rejects requests with no session regardless of Host (no loopback bypass)", () => {
    for (const host of ["localhost.evil.example", "127.0.0.1.nip.io", "localhost:3000", "127.0.0.1:3000", "localhost"]) {
      // undici forbids overriding Host on Request; the point is that no code path looks at it.
      const r = new Request(`http://${host}/api/servers`);
      const auth = AuthService.authenticateRequest(r);
      expect(auth.authenticated, host).toBe(false);
      expect(auth.status, host).toBe(401);

      const post = AuthService.authenticateRequest(new Request(`http://${host}/api/servers`, { method: "POST", headers: { origin: ORIGIN } }));
      expect(post.authenticated, `POST ${host}`).toBe(false);
      expect(post.status, `POST ${host}`).toBe(401);
    }
  });

  it("never accepts the legacy local-operator-token in any NODE_ENV", () => {
    for (const env of ["development", "test", "production"]) {
      vi.stubEnv("NODE_ENV", env);
      for (const headers of <Record<string, string>[]>[
        { authorization: "Bearer local-operator-token" },
        { "x-praxel-auth": "local-operator-token" },
        { cookie: cookieFor("local-operator-token") },
      ]) {
        const auth = AuthService.authenticateRequest(req("GET", headers));
        expect(auth.authenticated, `${env} ${Object.keys(headers)[0]}`).toBe(false);
        expect(auth.status).toBe(401);
      }
    }
  });

  it("authenticates a cookie session on GET without CSRF", () => {
    const session = AuthService.createOperatorSession("op-cookie");
    const auth = AuthService.authenticateRequest(req("GET", { cookie: cookieFor(session.token) }));
    expect(auth.authenticated).toBe(true);
    expect(auth.operatorId).toBe("op-cookie");
  });

  it("requires a valid CSRF token on cookie-authenticated mutations (403)", () => {
    const session = AuthService.createOperatorSession("op-csrf");
    const other = AuthService.createOperatorSession("op-other");
    const base = { cookie: cookieFor(session.token), origin: ORIGIN };

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const missing = AuthService.authenticateRequest(req(method, base));
      expect(missing.authenticated, `${method} missing`).toBe(false);
      expect(missing.status).toBe(403);

      const wrong = AuthService.authenticateRequest(req(method, { ...base, "x-csrf-token": "AAAA" }));
      expect(wrong.authenticated, `${method} wrong`).toBe(false);
      expect(wrong.status).toBe(403);

      // A CSRF token minted for a different session must not validate.
      const crossSession = AuthService.authenticateRequest(req(method, { ...base, "x-csrf-token": other.csrfToken }));
      expect(crossSession.authenticated, `${method} cross-session`).toBe(false);
      expect(crossSession.status).toBe(403);

      const ok = AuthService.authenticateRequest(req(method, { ...base, "x-csrf-token": session.csrfToken }));
      expect(ok.authenticated, `${method} ok`).toBe(true);
    }
  });

  it("derives the CSRF token as base64url HMAC-SHA256 of the session token", () => {
    const session = AuthService.createOperatorSession("op-hmac");
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(AuthService.computeCsrfToken(session.token)).toBe(session.csrfToken);
  });

  it("rejects wrong, absent and null Origin on cookie-authenticated mutations (403)", () => {
    const session = AuthService.createOperatorSession("op-origin");
    const base = { cookie: cookieFor(session.token), "x-csrf-token": session.csrfToken };

    for (const origin of [
      "http://evil.example",
      "null",
      "http://localhost:3000.evil.example",
      "http://localhost:3001",
      "https://localhost:3000",
    ]) {
      const auth = AuthService.authenticateRequest(req("POST", { ...base, origin }));
      expect(auth.authenticated, `origin=${origin}`).toBe(false);
      expect(auth.status).toBe(403);
    }

    // No Origin header at all.
    const absent = AuthService.authenticateRequest(req("POST", base));
    expect(absent.authenticated).toBe(false);
    expect(absent.status).toBe(403);

    const ok = AuthService.authenticateRequest(req("POST", { ...base, origin: ORIGIN }));
    expect(ok.authenticated).toBe(true);
    const ok2 = AuthService.authenticateRequest(req("POST", { ...base, origin: "http://127.0.0.1:3000" }));
    expect(ok2.authenticated).toBe(true);
  });

  it("honors ALLOWED_ORIGINS and only allows loopback origins outside production", () => {
    vi.stubEnv("ALLOWED_ORIGINS", "https://ops.example.com, https://other.example.com:8443/path");
    const session = AuthService.createOperatorSession("op-env");
    const headers = (origin: string) => ({
      cookie: cookieFor(session.token),
      "x-csrf-token": session.csrfToken,
      origin,
    });

    expect(AuthService.authenticateRequest(req("POST", headers("https://ops.example.com"))).authenticated).toBe(true);
    expect(AuthService.authenticateRequest(req("POST", headers("https://other.example.com:8443"))).authenticated).toBe(true);
    expect(
      AuthService.authenticateRequest(req("POST", headers("https://ops.example.com.evil.example"))).authenticated
    ).toBe(false);

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PRAXELOPS_SECRET", "x".repeat(40));
    const prod = AuthService.createOperatorSession("op-prod");
    const prodHeaders = (origin: string) => ({
      cookie: cookieFor(prod.token),
      "x-csrf-token": prod.csrfToken,
      origin,
    });
    expect(AuthService.authenticateRequest(req("POST", prodHeaders("https://ops.example.com"))).authenticated).toBe(true);
    // Loopback origins are not implicitly trusted in production.
    expect(AuthService.authenticateRequest(req("POST", prodHeaders(ORIGIN))).authenticated).toBe(false);
  });

  it("lets bearer-only API clients skip CSRF but still enforces Origin when one is present", () => {
    const session = AuthService.createOperatorSession("op-bearer");
    const bearer = { authorization: `Bearer ${session.token}` };

    expect(AuthService.authenticateRequest(req("POST", bearer)).authenticated).toBe(true);
    expect(AuthService.authenticateRequest(req("POST", { ...bearer, origin: ORIGIN })).authenticated).toBe(true);

    const evil = AuthService.authenticateRequest(req("POST", { ...bearer, origin: "http://evil.example" }));
    expect(evil.authenticated).toBe(false);
    expect(evil.status).toBe(403);
    const nul = AuthService.authenticateRequest(req("POST", { ...bearer, origin: "null" }));
    expect(nul.authenticated).toBe(false);
    expect(nul.status).toBe(403);
  });

  it("destroySession invalidates the session", () => {
    const session = AuthService.createOperatorSession("op-logout");
    const headers = { cookie: cookieFor(session.token) };
    expect(AuthService.authenticateRequest(req("GET", headers)).authenticated).toBe(true);
    expect(AuthService.destroySession(session.token)).toBe(true);
    const after = AuthService.authenticateRequest(req("GET", headers));
    expect(after.authenticated).toBe(false);
    expect(after.status).toBe(401);
  });

  it("expires sessions after 8h idle and 24h absolute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));

    // Idle: activity within the window keeps it alive; a long gap kills it.
    const idle = AuthService.createOperatorSession("op-idle");
    const idleHeaders = { cookie: cookieFor(idle.token) };
    vi.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS - 1000);
    expect(AuthService.authenticateRequest(req("GET", idleHeaders)).authenticated).toBe(true);
    vi.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS - 1000);
    expect(AuthService.authenticateRequest(req("GET", idleHeaders)).authenticated).toBe(true);
    vi.advanceTimersByTime(SESSION_IDLE_TIMEOUT_MS + 1000);
    expect(AuthService.authenticateRequest(req("GET", idleHeaders)).authenticated).toBe(false);

    // Absolute: constant activity cannot extend past 24h.
    const abs = AuthService.createOperatorSession("op-abs");
    const absHeaders = { cookie: cookieFor(abs.token) };
    const step = SESSION_IDLE_TIMEOUT_MS / 2;
    let elapsed = 0;
    while (elapsed + step < SESSION_ABSOLUTE_TIMEOUT_MS) {
      vi.advanceTimersByTime(step);
      elapsed += step;
      expect(AuthService.authenticateRequest(req("GET", absHeaders)).authenticated).toBe(true);
    }
    vi.advanceTimersByTime(SESSION_ABSOLUTE_TIMEOUT_MS - elapsed + 1000);
    expect(AuthService.authenticateRequest(req("GET", absHeaders)).authenticated).toBe(false);
  });

  it("builds a hardened session cookie", () => {
    const dev = AuthService.buildSessionCookie("abc");
    expect(dev).toContain("praxel_session=abc");
    expect(dev).toContain("HttpOnly");
    expect(dev).toContain("SameSite=Strict");
    expect(dev).toContain("Path=/");
    expect(dev).toContain("Max-Age=86400");
    expect(dev).not.toContain("Secure");

    vi.stubEnv("NODE_ENV", "production");
    expect(AuthService.buildSessionCookie("abc")).toContain("Secure");
    expect(AuthService.buildClearedSessionCookie()).toContain("Max-Age=0");
  });
});
