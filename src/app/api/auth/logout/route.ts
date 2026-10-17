import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { AuthService } from "@/lib/security/auth";

export async function POST(request: Request) {
  try {
    // Requires a valid session plus Origin + CSRF (cookie auth), like every other mutation.
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated || !auth.token) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status ?? 401 });
    }

    AuthService.destroySession(auth.token);

    StorageService.logAuditEvent({
      actor: auth.operatorId,
      eventType: "auth_logout",
      status: "success",
      ipAddress: AuthService.getClientIp(request),
    });

    const response = NextResponse.json({ success: true });
    response.headers.append("Set-Cookie", AuthService.buildClearedSessionCookie());
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
