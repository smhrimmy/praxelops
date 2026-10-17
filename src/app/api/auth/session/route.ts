import { NextResponse } from "next/server";
import { AuthService } from "@/lib/security/auth";

export async function GET(request: Request) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated || !auth.token) {
      return NextResponse.json({ authenticated: false }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(
      {
        authenticated: true,
        operatorId: auth.operatorId,
        csrfToken: AuthService.computeCsrfToken(auth.token),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ authenticated: false }, { status: 500 });
  }
}
