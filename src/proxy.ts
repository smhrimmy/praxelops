import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAllowedHost } from "@/lib/security/origins";

/**
 * DNS-rebinding defense: every /api/* request must carry a Host header that exactly matches
 * the allowlist (see lib/security/origins.ts). A rebound attacker domain resolving to
 * 127.0.0.1 sends its own hostname in Host, so it is rejected before reaching any route.
 */
export function proxy(request: NextRequest): NextResponse {
  if (!isAllowedHost(request.headers.get("host"))) {
    return NextResponse.json(
      { success: false, error: "Host not allowed. Set ALLOWED_HOSTS or ALLOWED_ORIGINS to permit it." },
      { status: 421 }
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
