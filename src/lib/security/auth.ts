import crypto from "crypto";
import { getMasterSecret } from "./secret";

export interface AuthContext {
  authenticated: boolean;
  operatorId: string;
  role: "operator" | "admin";
  token?: string;
  error?: string;
}

// In-memory sliding window rate limiter
interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const rateLimitMap = new Map<string, RateLimitEntry>();

// In-memory session store
const sessionStore = new Map<string, { operatorId: string; createdAt: number; expiresAt: number }>();

export class AuthService {
  /**
   * Generates a cryptographically secure session token for the operator
   */
  static createOperatorSession(operatorId: string = "operator", ttlHours: number = 24): {
    token: string;
    csrfToken: string;
    expiresAt: number;
  } {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + ttlHours * 3600 * 1000;
    sessionStore.set(rawToken, { operatorId, createdAt: Date.now(), expiresAt });

    const csrfToken = crypto
      .createHmac("sha256", getMasterSecret())
      .update(`${rawToken}:${expiresAt}`)
      .digest("hex");

    return { token: rawToken, csrfToken, expiresAt };
  }

  /**
   * Validates incoming request authentication and CSRF for state-mutating endpoints
   */
  static authenticateRequest(request: Request): AuthContext {
    // 1. Check Bearer or Custom Auth Header
    const authHeader = request.headers.get("x-praxel-auth") || request.headers.get("authorization");
    let token = "";

    if (authHeader) {
      if (authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7).trim();
      } else {
        token = authHeader.trim();
      }
    }

    // 2. Check HTTP-only Cookie fallback if header is absent
    if (!token) {
      const cookieHeader = request.headers.get("cookie") || "";
      const match = cookieHeader.match(/praxel_session=([^;]+)/);
      if (match) {
        token = match[1];
      }
    }

    // Single-tenant local bootstrap: In development / local workstation, allow local loopback
    // with generated session if no external token is provided, but reject remote unauthenticated access.
    const isLocalhost =
      request.headers.get("host")?.startsWith("localhost") ||
      request.headers.get("host")?.startsWith("127.0.0.1");

    if (!token) {
      if (isLocalhost && process.env.NODE_ENV !== "production") {
        return {
          authenticated: true,
          operatorId: "local-operator",
          role: "operator",
        };
      }
      return {
        authenticated: false,
        operatorId: "anonymous",
        role: "operator",
        error: "Missing authentication credentials. Provide X-Praxel-Auth header.",
      };
    }

    // Validate active session
    const session = sessionStore.get(token);
    if (!session || Date.now() > session.expiresAt) {
      if (session) sessionStore.delete(token);
      return {
        authenticated: false,
        operatorId: "anonymous",
        role: "operator",
        error: "Session token is invalid or expired.",
      };
    }

    // 3. For state-mutating methods (POST, PUT, DELETE), enforce CSRF verification if using cookie
    const method = request.method.toUpperCase();
    if (["POST", "PUT", "DELETE"].includes(method)) {
      const csrfHeader = request.headers.get("x-praxel-csrf");
      // If client is using explicit Bearer header, CSRF is inherently mitigated by CORS.
      // If using cookies, CSRF header is mandatory.
      const isCookieAuth = !authHeader && token;
      if (isCookieAuth) {
        const expectedCsrf = crypto
          .createHmac("sha256", getMasterSecret())
          .update(`${token}:${session.expiresAt}`)
          .digest("hex");
        if (csrfHeader !== expectedCsrf) {
          return {
            authenticated: false,
            operatorId: session.operatorId,
            role: "operator",
            error: "CSRF token validation failed.",
          };
        }
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
   * Rate limiting check per client IP
   */
  static checkRateLimit(
    clientId: string,
    maxRequests: number = 100,
    windowSeconds: number = 60
  ): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const entry = rateLimitMap.get(clientId);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(clientId, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: maxRequests - 1 };
    }

    entry.count += 1;
    if (entry.count > maxRequests) {
      return { allowed: false, remaining: 0 };
    }

    return { allowed: true, remaining: maxRequests - entry.count };
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
  static redactSecrets(obj: any): any {
    if (!obj || typeof obj !== "object") return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactSecrets(item));
    }

    const redacted: Record<string, any> = {};
    const sensitiveKeys = [
      "password",
      "privatekey",
      "passphrase",
      "secret",
      "token",
      "authorization",
      "clienttoken",
      "approvaltoken",
    ];

    for (const [key, val] of Object.entries(obj)) {
      if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
        redacted[key] = "[REDACTED]";
      } else if (typeof val === "object") {
        redacted[key] = this.redactSecrets(val);
      } else {
        redacted[key] = val;
      }
    }

    return redacted;
  }
}
