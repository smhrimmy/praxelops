import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { AuthService } from "@/lib/security/auth";
import { toPublicServers } from "@/lib/servers/publicServer";

export async function POST(request: Request) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status ?? 401 });
    }

    const demoServers = StorageService.loadDemoEnvironment();
    StorageService.logAuditEvent({
      actor: auth.operatorId,
      eventType: "server_created",
      targetServerId: demoServers[0].id,
      targetServerName: demoServers[0].name,
      status: "success",
      details: { isDemo: true, description: "Explicitly loaded demonstration sandbox" },
    });
    return NextResponse.json({ success: true, data: toPublicServers(demoServers) });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
