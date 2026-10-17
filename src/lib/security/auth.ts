import crypto from "crypto";
import { getMasterSecret } from "./secret";
import { isAllowedOrigin } from "./origins";

export const SESSION_COOKIE_NAME = "praxel_session";
export const CSRF_HEADER_NAME = "x-csrf-token";

/** Session lifetimes. Idle timeout slides on every authenticated request; the absolute cap never extends. */
export const SESSION_IDLE_TIMEOUT_MS = 8 * 3600 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 24 * 3600 * 1000;

export interface AuthContext {
  authenticated: boolean;
  operatorId: string;
  role: "operator" | "admin";
  token?: string;
  error?: string;
  /** HTTP status a route should use when authenticated is false (401 = no/invalid session, 403 = CSRF/Origin). */
  status?: 401 | 403;
}

// In-memory sliding window rate limiter
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface SessionRecord {
  operatorId: string;
  createdAt: number;
  lastSeenAt: number;
  /** Absolute expiry (epoch ms). */
  expiresAt: number;
}

interface AuthState {
  rateLimits: Map<string, RateLimitEntry>;
  /** Keyed by sha256(sessionToken) so raw tokens are never retained as map keys. */
  sessions: Map<string, SessionRecord>;
}

// Next.js may instantiate this module once per route bundle; pin the state to globalThis so
// every route in the process shares one session store and one rate-limit table.
const globalForAuth = globalThis as typeof globalThis & { __praxelAuthState?: AuthState };
const authState: AuthState =
  globalForAuth.__praxelAuthState ??
  (globalForAuth.__praxelAuthState = { rateLimits: new Map(), sessions: new Map() });

const MAX_RATE_LIMIT_ENTRIES = 10_000;

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

function sessionKey(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Length-independent constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

function extractCredentials(request: Request): { bearer?: string; cookie?: string } {
  let bearer: string | undefined;
  const authorization = request.headers.get("authorization")?.trim();
  if (authorization && /^Bearer\s+/i.test(authorization)) {
    bearer = authorization.replace(/^Bearer\s+/i, "").trim() || undefined;
  }
  if (!bearer) {
    // Legacy raw-token header for API clients.
    bearer = request.headers.get("x-praxel-auth")?.trim() || undefined;
  }
  const cookie = parseCookie(request.headers.get("cookie") ?? "", SESSION_COOKIE_NAME) || undefined;
  return { bearer, cookie };
}

function deny(status: 401 | 403, error: string): AuthContext {
  return { authenticated: false, operatorId: "anonymous", role: "operator", error, status };
}

export class AuthService {
  /**
   * Creates a session: 32 random bytes (hex), absolute lifetime <= 24h, 8h idle timeout.
   * Sessions live in this process's memory only: restarting the web server logs everyone out.
   */
  static createOperatorSession(
    operatorId: string = "operator",
    ttlHours: number = SESSION_ABSOLUTE_TIMEOUT_MS / 3600000
  ): {
    token: string;
    csrfToken: string;
    expiresAt: number;
  } {
    this.pruneSessions();
    const token = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    const ttlMs = Math.min(Math.max(ttlHours, 0) * 3600 * 1000, SESSION_ABSOLUTE_TIMEOUT_MS);
    const expiresAt = now + ttlMs;
    authState.sessions.set(sessionKey(token), { operatorId, createdAt: now, lastSeenAt: now, expiresAt });
    return { token, csrfToken: this.computeCsrfToken(token), expiresAt };
  }

  /** CSRF token for a session: base64url(HMAC-SHA256(masterSecret, sessionToken)). */
  static computeCsrfToken(sessionToken: string): string {
    return crypto.createHmac("sha256", getMasterSecret()).update(sessionToken).digest("base64url");
  }

  /** Deletes a session (logout). Returns whether it existed. */
  static destroySession(token: string): boolean {
    return authState.sessions.delete(sessionKey(token));
  }

  /** Looks up a live session, enforcing idle + absolute timeouts, and slides the idle window. */
  private static touchSession(token: string): SessionRecord | undefined {
    const key = sessionKey(token);
    const session = authState.sessions.get(key);
    if (!session) return undefined;
    const now = Date.now();
    if (now >= session.expiresAt || now - session.lastSeenAt > SESSION_IDLE_TIMEOUT_MS) {
      authState.sessions.delete(key);
      return undefined;
    }
    session.lastSeenAt = now;
    return session;
  }

  private static pruneSessions(): void {
    const now = Date.now();
    for (const [key, s] of authState.sessions) {
      if (now >= s.expiresAt || now - s.lastSeenAt > SESSION_IDLE_TIMEOUT_MS) {
        authState.sessions.delete(key);
      }
    }
  }

  /** Set-Cookie value that establishes the session cookie. */
  static buildSessionCookie(token: string): string {
    const attrs = [
      `${SESSION_COOKIE_NAME}=${token}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${SESSION_ABSOLUTE_TIMEOUT_MS / 1000}`,
    ];
    if (process.env.NODE_ENV === "production") attrs.push("Secure");
    return attrs.join("; ");
  }

  /** Set-Cookie value that clears the session cookie. */
  static buildClearedSessionCookie(): string {
    const attrs = [`${SESSION_COOKIE_NAME}=`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
    if (process.env.NODE_ENV === "production") attrs.push("Secure");
    return attrs.join("; ");
  }

  /**
   * Validates incoming request authentication.
   *
   *  - Session token comes from the `praxel_session` cookie or `Authorization: Bearer` (API clients).
   *  - Every non-GET/HEAD/OPTIONS request is additionally Origin-checked (exact allowlist match).
   *  - Cookie-authenticated mutations must also carry a valid `x-csrf-token` (constant-time compared).
   *  - Bearer-only requests skip CSRF but, if an Origin header is present, it must still be allowed.
   *
   * There is no development / loopback exemption of any kind.
   */
  static authenticateRequest(request: Request): AuthContext {
    const { bearer, cookie } = extractCredentials(request);
    const token = bearer ?? cookie;

    if (!token) {
      return deny(401, "Missing authentication credentials. Sign in or provide an Authorization: Bearer session token.");
    }

    const session = this.touchSession(token);
    if (!session) {
      return deny(401, "Session token is invalid or expired.");
    }

    const method = request.method.toUpperCase();
    if (!SAFE_METHODS.has(method)) {
      const origin = request.headers.get("origin");
      const usesCookie = cookie !== undefined;

      if (usesCookie) {
        if (!isAllowedOrigin(origin)) {
          return deny(403, "Origin validation failed.");
        }
        const csrfHeader = request.headers.get(CSRF_HEADER_NAME);
        if (!csrfHeader || !safeEqual(csrfHeader, this.computeCsrfToken(token))) {
          return deny(403, "CSRF token validation failed.");
        }
      } else if (origin !== null && !isAllowedOrigin(origin)) {
        return deny(403, "Origin validation failed.");
      }
    }

    return {
      authenticated: true,
      operatorId: session.operatorId,
      role: "operator",
      token,
    };
  }

  /**
   * Origin gate for unauthenticated state-changing endpoints (login). Browsers always send Origin on
   * cross-site POSTs, so "present => must be allowed" blocks cross-site form posts; non-browser
   * clients that send no Origin are unaffected.
   */
  static checkOriginIfPresent(request: Request): boolean {
    const origin = request.headers.get("origin");
    return origin === null || isAllowedOrigin(origin);
  }

  /** Best-effort client address for rate limiting / audit (headers only; spoofable without a trusted proxy). */
  static getClientIp(request: Request): string {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first.slice(0, 64);
    }
    const real = request.headers.get("x-real-ip")?.trim();
    return real ? real.slice(0, 64) : "unknown";
  }

  /**
   * Rate limiting check per client id (counts this call)
   */
  static checkRateLimit(
    clientId: string,
    maxRequests: number = 100,
    windowSeconds: number = 60
  ): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const limits = authState.rateLimits;

    if (limits.size >= MAX_RATE_LIMIT_ENTRIES) {
      for (const [key, e] of limits) {
        if (now > e.resetAt) limits.delete(key);
      }
    }

    const entry = limits.get(clientId);

    if (!entry || now > entry.resetAt) {
      limits.set(clientId, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: maxRequests - 1 };
    }

    entry.count += 1;
    if (entry.count > maxRequests) {
      return { allowed: false, remaining: 0 };
    }

    return { allowed: true, remaining: maxRequests - entry.count };
  }

  /** Forgets a rate-limit bucket (e.g. a per-username bucket after a successful login). */
  static resetRateLimit(clientId: string): void {
    authState.rateLimits.delete(clientId);
  }

  /**
   * Request payload size check
   */
  static checkPayloadSize(request: Request, maxBytes: number = 1048576): boolean {
    const contentLength = request.headers.get("content-length");
    if (contentLength) {
      const bytes = parseInt(contentLength, 10);
      if (!isNaN(bytes) && bytes > maxBytes) {
        return false;
      }
    }
    return true;
  }

  /**
   * Redacts sensitive fields (passwords, private keys, secrets) from objects before logging
   */
  static redactSecrets<T>(obj: T): T {
    return redactValue(obj) as T;
  }
}

const SENSITIVE_KEYS = [
  "password",
  "privatekey",
  "passphrase",
  "secret",
  "token",
  "authorization",
  "clienttoken",
  "approvaltoken",
];

function redactValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s))) {
      redacted[key] = "[REDACTED]";
    } else if (typeof val === "object") {
      redacted[key] = redactValue(val);
    } else {
      redacted[key] = val;
    }
  }
  return redacted;
}
