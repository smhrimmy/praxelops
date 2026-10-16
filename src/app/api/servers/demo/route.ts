import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";

export async function POST() {
  try {
    const demoServers = StorageService.loadDemoEnvironment();
    StorageService.logAuditEvent({
      actor: "operator",
      eventType: "server_created",
      targetServerId: demoServers[0].id,
      targetServerName: demoServers[0].name,
      status: "success",
      details: { isDemo: true, description: "Explicitly loaded demonstration sandbox" },
    });
    return NextResponse.json({ success: true, data: demoServers });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
