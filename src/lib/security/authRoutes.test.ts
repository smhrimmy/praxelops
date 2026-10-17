import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as sessionGet } from "@/app/api/auth/session/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { GET as serversGet, POST as serversPost } from "@/app/api/servers/route";
import { AuthService } from "./auth";
import { createOperator } from "./operators";
import { StorageService } from "@/lib/storage";

const ORIGIN = "http://localhost:3000";
const USERNAME = "route-operator";
const PASSWORD = "route operator pass 123";

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function loginRequest(body: unknown, headers: Record<string, string> = {}, ip = freshIp()): Request {
  return new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Extracts "praxel_session=<token>" from a Set-Cookie header. */
function sessionTokenFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/praxel_session=([^;]+)/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("auth routes", () => {
  beforeAll(async () => {
    await createOperator(USERNAME, PASSWORD);
  });

  beforeEach(() => {
    AuthService.resetRateLimit("login-global");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("POST /api/auth/login", () => {
    it("sets a hardened session cookie and returns operatorId + csrfToken on success", async () => {
      const auditSpy = vi.spyOn(StorageService, "logAuditEvent");
      const res = await loginPost(loginRequest({ username: USERNAME, password: PASSWORD }, { origin: ORIGIN }));
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; operatorId: string; csrfToken: string };
      expect(body.success).toBe(true);
      expect(body.operatorId).toMatch(/^op_/);
      expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/^praxel_session=[0-9a-f]{64};/);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain("Max-Age=86400");
      expect(setCookie).not.toContain("Secure"); // test env, not production

      // The CSRF token in the body belongs to the cookie's session.
      expect(AuthService.computeCsrfToken(sessionTokenFrom(res))).toBe(body.csrfToken);

      const audit = auditSpy.mock.calls.map((c) => c[0]).find((e) => e.eventType === "auth_login" && e.status === "success");
      expect(audit?.actor).toBe(body.operatorId);
      expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    });

    it("marks the cookie Secure in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("PRAXELOPS_SECRET", "p".repeat(40));
      vi.stubEnv("ALLOWED_ORIGINS", "https://ops.example.com");
      const res = await loginPost(
        loginRequest({ username: USERNAME, password: PASSWORD }, { origin: "https://ops.example.com" })
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("Secure");
    });

    it("returns the same generic 401 for wrong password and unknown user, with no cookie, and audits without the password", async () => {
      const auditSpy = vi.spyOn(StorageService, "logAuditEvent");
      const wrongPw = await loginPost(loginRequest({ username: USERNAME, password: "definitely the wrong one" }));
      const unknown = await loginPost(loginRequest({ username: "nobody-here", password: "definitely the wrong one" }));

      for (const res of [wrongPw, unknown]) {
        expect(res.status).toBe(401);
        expect(res.headers.get("set-cookie")).toBeNull();
      }
      const a = (await wrongPw.json()) as { success: boolean; error: string };
      const b = (await unknown.json()) as { success: boolean; error: string };
      expect(a).toEqual(b);
      expect(a.success).toBe(false);
      expect(a.error).toBe("Invalid username or password");

      const failures = auditSpy.mock.calls.map((c) => c[0]).filter((e) => e.eventType === "auth_login" && e.status === "failure");
      expect(failures).toHaveLength(2);
      expect(JSON.stringify(failures)).not.toContain("definitely the wrong one");
    });

    it("rejects malformed bodies with 400 and oversized bodies with 413", async () => {
      expect((await loginPost(loginRequest("not json"))).status).toBe(400);
      expect((await loginPost(loginRequest({ username: USERNAME }))).status).toBe(400);
      expect((await loginPost(loginRequest({ username: 5, password: "x" }))).status).toBe(400);
      const big = await loginPost(loginRequest({ username: USERNAME, password: "p".repeat(5000) }));
      expect(big.status).toBe(413);
    });

    it("rejects a cross-site Origin with 403 before touching credentials", async () => {
      const res = await loginPost(
        loginRequest({ username: USERNAME, password: PASSWORD }, { origin: "http://evil.example" })
      );
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("rate-limits per username after 5 failures (even from rotating IPs), then blocks a correct password", async () => {
      const username = "rl-operator";
      await createOperator(username, PASSWORD);

      for (let i = 0; i < 5; i++) {
        const res = await loginPost(loginRequest({ username, password: `wrong password ${i} xx` }));
        expect(res.status, `attempt ${i + 1}`).toBe(401);
      }
      const blocked = await loginPost(loginRequest({ username, password: PASSWORD }));
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("60");
      expect(blocked.headers.get("set-cookie")).toBeNull();
    });

    it("rate-limits per IP after 5 attempts regardless of username", async () => {
      const ip = freshIp();
      for (let i = 0; i < 5; i++) {
        const res = await loginPost(loginRequest({ username: `ip-user-${i}`, password: "wrong wrong wrong" }, {}, ip));
        expect(res.status).toBe(401);
      }
      const blocked = await loginPost(loginRequest({ username: "ip-user-next", password: "wrong wrong wrong" }, {}, ip));
      expect(blocked.status).toBe(429);
    });

    it("clears the per-username counter after a successful login", async () => {
      const username = "reset-operator";
      await createOperator(username, PASSWORD);
      for (let i = 0; i < 4; i++) {
        await loginPost(loginRequest({ username, password: `wrong password ${i} xx` }));
      }
      expect((await loginPost(loginRequest({ username, password: PASSWORD }))).status).toBe(200);
      // Counter was reset, so four more failures are still allowed.
      for (let i = 0; i < 4; i++) {
        expect((await loginPost(loginRequest({ username, password: `wrong again ${i} xx` }))).status).toBe(401);
      }
    });
  });

  describe("GET /api/auth/session", () => {
    it("reports unauthenticated without a session", async () => {
      const res = await sessionGet(new Request("http://localhost:3000/api/auth/session"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ authenticated: false });
    });

    it("returns operatorId and csrfToken for a live cookie session", async () => {
      const login = await loginPost(loginRequest({ username: USERNAME, password: PASSWORD }));
      const token = sessionTokenFrom(login);
      const res = await sessionGet(
        new Request("http://localhost:3000/api/auth/session", { headers: { cookie: `praxel_session=${token}` } })
      );
      const body = (await res.json()) as { authenticated: boolean; operatorId: string; csrfToken: string };
      expect(body.authenticated).toBe(true);
      expect(body.operatorId).toMatch(/^op_/);
      expect(body.csrfToken).toBe(AuthService.computeCsrfToken(token));
    });
  });

  describe("POST /api/auth/logout", () => {
    async function loggedIn() {
      const login = await loginPost(loginRequest({ username: USERNAME, password: PASSWORD }));
      const body = (await login.json()) as { csrfToken: string };
      return { token: sessionTokenFrom(login), csrf: body.csrfToken };
    }

    it("requires CSRF and Origin", async () => {
      const { token, csrf } = await loggedIn();
      const cookie = `praxel_session=${token}`;

      const noCsrf = await logoutPost(
        new Request("http://localhost:3000/api/auth/logout", { method: "POST", headers: { cookie, origin: ORIGIN } })
      );
      expect(noCsrf.status).toBe(403);

      const noOrigin = await logoutPost(
        new Request("http://localhost:3000/api/auth/logout", {
          method: "POST",
          headers: { cookie, "x-csrf-token": csrf },
        })
      );
      expect(noOrigin.status).toBe(403);

      // Still logged in after the refused attempts.
      const still = await sessionGet(new Request("http://localhost:3000/api/auth/session", { headers: { cookie } }));
      expect(((await still.json()) as { authenticated: boolean }).authenticated).toBe(true);
    });

    it("destroys the session, clears the cookie, and audits", async () => {
      const auditSpy = vi.spyOn(StorageService, "logAuditEvent");
      const { token, csrf } = await loggedIn();
      const cookie = `praxel_session=${token}`;

      const res = await logoutPost(
        new Request("http://localhost:3000/api/auth/logout", {
          method: "POST",
          headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
        })
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toMatch(/praxel_session=;.*Max-Age=0/);
      expect(auditSpy.mock.calls.some((c) => c[0].eventType === "auth_logout")).toBe(true);

      const after = await sessionGet(new Request("http://localhost:3000/api/auth/session", { headers: { cookie } }));
      expect(((await after.json()) as { authenticated: boolean }).authenticated).toBe(false);
    });
  });

  describe("protected API routes end to end", () => {
    it("/api/servers rejects unauthenticated GET and POST with 401 (no localhost bypass)", async () => {
      const get = await serversGet(new Request("http://localhost:3000/api/servers"));
      expect(get.status).toBe(401);
      const post = await serversPost(
        new Request("http://localhost:3000/api/servers", {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: "{}",
        })
      );
      expect(post.status).toBe(401);
    });

    it("/api/servers POST returns 403 for a session without CSRF and 200-class once supplied", async () => {
      const login = await loginPost(loginRequest({ username: USERNAME, password: PASSWORD }));
      const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
      const cookie = `praxel_session=${sessionTokenFrom(login)}`;

      const noCsrf = await serversPost(
        new Request("http://localhost:3000/api/servers", {
          method: "POST",
          headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
          body: "{}",
        })
      );
      expect(noCsrf.status).toBe(403);

      // With valid CSRF + Origin the request is authenticated (body validation then fails with 400, not 401/403).
      const withCsrf = await serversPost(
        new Request("http://localhost:3000/api/servers", {
          method: "POST",
          headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json" },
          body: "{}",
        })
      );
      expect(withCsrf.status).toBe(400);
    });
  });
});
