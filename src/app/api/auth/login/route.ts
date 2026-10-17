import { NextResponse } from "next/server";
import { z } from "zod";
import { StorageService } from "@/lib/storage";
import { AuthService } from "@/lib/security/auth";
import { verifyOperatorCredentials } from "@/lib/security/operators";

const LoginBodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});

const MAX_BODY_BYTES = 4096;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 60;
const GLOBAL_LOGIN_LIMIT = 30;

const GENERIC_FAILURE = "Invalid username or password";

function failure(status: number, error: string, headers?: Record<string, string>) {
  return NextResponse.json({ success: false, error }, { status, headers });
}

// Uses node:sqlite (via the storage layer), which only exists on the Node.js runtime.
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (!AuthService.checkOriginIfPresent(request)) {
      return failure(403, "Origin validation failed.");
    }

    if (!AuthService.checkPayloadSize(request, MAX_BODY_BYTES)) {
      return failure(413, "Payload too large");
    }

    const ip = AuthService.getClientIp(request);

    // Throttle before doing any (expensive) password hashing work.
    const ipRate = AuthService.checkRateLimit(`login-ip:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS);
    const globalRate = AuthService.checkRateLimit("login-global", GLOBAL_LOGIN_LIMIT, LOGIN_WINDOW_SECONDS);
    if (!ipRate.allowed || !globalRate.allowed) {
      return failure(429, "Too many login attempts. Try again later.", { "Retry-After": String(LOGIN_WINDOW_SECONDS) });
    }

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return failure(413, "Payload too large");
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return failure(400, "Invalid request body");
    }
    const parsed = LoginBodySchema.safeParse(json);
    if (!parsed.success) {
      return failure(400, "Invalid request body");
    }

    const username = parsed.data.username.trim().toLowerCase();
    const userRate = AuthService.checkRateLimit(`login-user:${username}`, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS);
    if (!userRate.allowed) {
      return failure(429, "Too many login attempts. Try again later.", { "Retry-After": String(LOGIN_WINDOW_SECONDS) });
    }

    const operator = await verifyOperatorCredentials(username, parsed.data.password);

    if (!operator) {
      StorageService.logAuditEvent({
        actor: "anonymous",
        eventType: "auth_login",
        status: "failure",
        ipAddress: ip,
        // Only the (length-capped) attempted username; never the password.
        details: { username: username.slice(0, 64), reason: "invalid_credentials" },
      });
      return failure(401, GENERIC_FAILURE);
    }

    AuthService.resetRateLimit(`login-user:${username}`);
    const session = AuthService.createOperatorSession(operator.id);

    StorageService.logAuditEvent({
      actor: operator.id,
      eventType: "auth_login",
      status: "success",
      ipAddress: ip,
      details: { username: operator.username },
    });

    const response = NextResponse.json({
      success: true,
      operatorId: operator.id,
      csrfToken: session.csrfToken,
    });
    response.headers.append("Set-Cookie", AuthService.buildSessionCookie(session.token));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return failure(500, "Login failed");
  }
}
